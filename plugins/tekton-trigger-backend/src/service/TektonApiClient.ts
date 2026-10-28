import fs from 'fs/promises';
import https from 'https';
import fetch, { RequestInit, Response } from 'node-fetch';
import {
  AuthenticationError,
  ConflictError,
  ForwardedError,
  NotAllowedError,
  NotFoundError,
  ServiceUnavailableError,
} from '@backstage/errors';
import { LoggerService } from '@backstage/backend-plugin-api';
import { ClusterConfig } from './config';
import {
  PipelineResource,
  PipelineRunResource,
  TaskRunResource,
  TektonList,
} from './tektonTypes';

const TEKTON_API = '/apis/tekton.dev/v1';

/** Label Tekton sets on every TaskRun belonging to a PipelineRun. */
export const PIPELINE_RUN_LABEL = 'tekton.dev/pipelineRun';

/**
 * Minimal Tekton client for one cluster.
 *
 * Talks to the OpenShift API server directly rather than going through the
 * Kubernetes plugin's cluster suppliers, so the trigger path works even when
 * the Kubernetes plugin is not installed.
 */
export class TektonApiClient {
  #agent?: https.Agent;

  constructor(
    readonly cluster: ClusterConfig,
    private readonly logger: LoggerService,
  ) {}

  async getPipeline(
    namespace: string,
    name: string,
  ): Promise<PipelineResource> {
    return await this.#request<PipelineResource>(
      'GET',
      `${TEKTON_API}/namespaces/${enc(namespace)}/pipelines/${enc(name)}`,
    );
  }

  async createPipelineRun(
    namespace: string,
    body: PipelineRunResource,
  ): Promise<PipelineRunResource> {
    return await this.#request<PipelineRunResource>(
      'POST',
      `${TEKTON_API}/namespaces/${enc(namespace)}/pipelineruns`,
      { body },
    );
  }

  async getPipelineRun(
    namespace: string,
    name: string,
  ): Promise<PipelineRunResource> {
    return await this.#request<PipelineRunResource>(
      'GET',
      `${TEKTON_API}/namespaces/${enc(namespace)}/pipelineruns/${enc(name)}`,
    );
  }

  async listPipelineRuns(options: {
    namespace: string;
    labelSelector?: string;
    limit?: number;
  }): Promise<PipelineRunResource[]> {
    const search = new URLSearchParams();
    if (options.labelSelector) {
      search.set('labelSelector', options.labelSelector);
    }
    if (options.limit) {
      search.set('limit', String(options.limit));
    }

    const result = await this.#request<TektonList<PipelineRunResource>>(
      'GET',
      `${TEKTON_API}/namespaces/${enc(options.namespace)}/pipelineruns?${search}`,
    );
    return result.items ?? [];
  }

  async listTaskRunsForPipelineRun(
    namespace: string,
    pipelineRunName: string,
  ): Promise<TaskRunResource[]> {
    const search = new URLSearchParams({
      labelSelector: `${PIPELINE_RUN_LABEL}=${pipelineRunName}`,
    });
    const result = await this.#request<TektonList<TaskRunResource>>(
      'GET',
      `${TEKTON_API}/namespaces/${enc(namespace)}/taskruns?${search}`,
    );
    return result.items ?? [];
  }

  /**
   * Cancels a running PipelineRun the way `tkn pipelinerun cancel` does: by
   * patching `spec.status`.
   */
  async cancelPipelineRun(
    namespace: string,
    name: string,
  ): Promise<PipelineRunResource> {
    return await this.#request<PipelineRunResource>(
      'PATCH',
      `${TEKTON_API}/namespaces/${enc(namespace)}/pipelineruns/${enc(name)}`,
      {
        body: { spec: { status: 'Cancelled' } },
        contentType: 'application/merge-patch+json',
      },
    );
  }

  async #request<T>(
    method: string,
    path: string,
    options: { body?: unknown; contentType?: string } = {},
  ): Promise<T> {
    const url = `${this.cluster.url}${path}`;
    const token = await this.#getToken();

    const init: RequestInit = {
      method,
      agent: await this.#getAgent(),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.body
          ? { 'Content-Type': options.contentType ?? 'application/json' }
          : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    };

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      throw new ServiceUnavailableError(
        `Request to cluster '${this.cluster.name}' failed: ${
          (error as Error).message
        }`,
      );
    }

    const text = await response.text();

    if (!response.ok) {
      throw this.#toError(response.status, method, path, text);
    }

    if (!text) {
      return undefined as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new ForwardedError(
        `Cluster '${this.cluster.name}' returned a non-JSON response for ${method} ${path}`,
        error,
      );
    }
  }

  #toError(status: number, method: string, path: string, body: string): Error {
    // Kubernetes returns a Status object; its message is the useful part.
    let message = body;
    try {
      const parsed = JSON.parse(body) as { message?: string };
      message = parsed.message ?? body;
    } catch {
      /* keep the raw body */
    }

    const context = `${method} ${path} on cluster '${this.cluster.name}' failed with ${status}`;
    this.logger.warn(`${context}: ${message}`);
    const detail = `${context}: ${message}`;

    switch (status) {
      case 401:
        return new AuthenticationError(
          `${detail}. Check the cluster's ServiceAccount token.`,
        );
      case 403:
        return new NotAllowedError(
          `${detail}. Check the ServiceAccount's Tekton RBAC.`,
        );
      case 404:
        return new NotFoundError(detail);
      case 409:
        return new ConflictError(detail);
      default:
        return new Error(detail);
    }
  }

  async #getToken(): Promise<string> {
    if (this.cluster.serviceAccountToken) {
      return this.cluster.serviceAccountToken;
    }

    const file = this.cluster.serviceAccountTokenFile;
    if (!file) {
      throw new AuthenticationError(
        `No credentials for cluster '${this.cluster.name}': set serviceAccountToken or serviceAccountTokenFile`,
      );
    }

    try {
      // Read on every request: projected ServiceAccount tokens are rotated in
      // place and a cached value would start failing after an hour.
      return (await fs.readFile(file, 'utf8')).trim();
    } catch (error) {
      throw new ForwardedError(
        `Failed to read ServiceAccount token for cluster '${this.cluster.name}' from ${file}`,
        error,
      );
    }
  }

  async #getAgent(): Promise<https.Agent> {
    if (!this.#agent) {
      this.#agent = new https.Agent({
        keepAlive: true,
        rejectUnauthorized: !this.cluster.skipTLSVerify,
        ca: await this.#getCa(),
      });
    }
    return this.#agent;
  }

  async #getCa(): Promise<Buffer | undefined> {
    if (this.cluster.skipTLSVerify) {
      return undefined;
    }
    if (this.cluster.caData) {
      return Buffer.from(this.cluster.caData, 'base64');
    }
    if (!this.cluster.caFile) {
      return undefined;
    }
    try {
      return await fs.readFile(this.cluster.caFile);
    } catch (error) {
      this.logger.warn(
        `Could not read caFile ${this.cluster.caFile} for cluster '${this.cluster.name}', falling back to the system trust store: ${
          (error as Error).message
        }`,
      );
      return undefined;
    }
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}
