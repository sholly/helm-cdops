import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { ResponseError } from '@backstage/errors';
import {
  ListPipelineRunsResponse,
  PipelineRunSummary,
  TektonTarget,
  TriggerPipelineRequest,
  TriggerPipelineResponse,
} from '@cdops/plugin-tekton-trigger-common';
import { TektonTriggerApi } from './types';

/** @public */
export class TektonTriggerClient implements TektonTriggerApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly fetchApi: FetchApi;

  constructor(options: { discoveryApi: DiscoveryApi; fetchApi: FetchApi }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi;
  }

  async getTarget(entityRef: string): Promise<TektonTarget> {
    return await this.request<TektonTarget>(
      `/target?${new URLSearchParams({ entityRef })}`,
    );
  }

  async listPipelineRuns(entityRef: string): Promise<PipelineRunSummary[]> {
    const response = await this.request<ListPipelineRunsResponse>(
      `/pipelineruns?${new URLSearchParams({ entityRef })}`,
    );
    return response.items;
  }

  async getPipelineRun(
    entityRef: string,
    name: string,
  ): Promise<PipelineRunSummary> {
    return await this.request<PipelineRunSummary>(
      `/pipelineruns/${encodeURIComponent(name)}?${new URLSearchParams({
        entityRef,
      })}`,
    );
  }

  async triggerPipeline(
    request: TriggerPipelineRequest,
  ): Promise<TriggerPipelineResponse> {
    return await this.request<TriggerPipelineResponse>('/pipelineruns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  }

  async cancelPipelineRun(
    entityRef: string,
    name: string,
  ): Promise<PipelineRunSummary> {
    return await this.request<PipelineRunSummary>(
      `/pipelineruns/${encodeURIComponent(name)}/cancel?${new URLSearchParams({
        entityRef,
      })}`,
      { method: 'POST' },
    );
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const baseUrl = await this.discoveryApi.getBaseUrl('tekton-trigger');
    const response = await this.fetchApi.fetch(`${baseUrl}${path}`, init);

    if (!response.ok) {
      throw await ResponseError.fromResponse(response);
    }

    return (await response.json()) as T;
  }
}
