import fetch from 'node-fetch';
import { LoggerService } from '@backstage/backend-plugin-api';
import { NotFoundError, ServiceUnavailableError } from '@backstage/errors';
import {
  ArgoServiceApi,
  buildArgoUrl,
  InstanceConfig,
} from '@roadiehq/backstage-plugin-argo-cd-node';
import {
  ArgoApplicationSummary,
  GitVersion,
} from '@cdops/plugin-tekton-trigger-common';
import {
  byNewestDeployment,
  RawArgoApplication,
  toArgoApplicationSummary,
  toGitVersions,
} from './argoMappers';
import { ArgoTarget } from './argoTarget';
import { DeployConfig } from './config';

/** ArgoCD's `{branches, tags}` from `GET /api/v1/repositories/{repo}/refs`. */
interface ArgoRefs {
  branches?: string[];
  tags?: string[];
}

/**
 * Reads ArgoCD on behalf of a catalog entity.
 *
 * Instance lookup, authentication (token, username/password or Azure OIDC) and
 * the application queries come from the Roadie ArgoCD service, so this plugin
 * shares one ArgoCD configuration with the Roadie plugins rather than defining
 * its own. Only the repository-refs call is made here, since that endpoint is
 * not part of the Roadie service.
 */
export class ArgoApplicationService {
  constructor(
    private readonly argocd: ArgoServiceApi,
    private readonly logger: LoggerService,
    private readonly deployConfig: DeployConfig,
  ) {}

  /**
   * The entity's applications, newest deployment first. Returns an empty list
   * rather than throwing when nothing matches, so the card can say "not found"
   * instead of showing an error.
   */
  async getApplications(target: ArgoTarget): Promise<ArgoApplicationSummary[]> {
    const instances = this.resolveInstances(target);
    const summaries: ArgoApplicationSummary[] = [];

    for (const instance of instances) {
      const token = await this.token(instance);
      if (!token) {
        continue;
      }

      let data: unknown;
      try {
        data = await this.argocd.getArgoAppData(
          instance.url,
          instance.name,
          token,
          { name: target.appName, selector: target.appSelector },
        );
      } catch (error) {
        // An app annotated by name lives on exactly one instance, so a miss on
        // the others is expected; log and keep looking.
        this.logger.debug(
          `No ArgoCD application for ${target.entityRef} on instance '${instance.name}': ${error}`,
        );
        continue;
      }

      for (const app of asApplications(data)) {
        summaries.push(
          toArgoApplicationSummary(app, {
            instance: instance.name,
            instanceUrl: instance.url,
          }),
        );
      }
    }

    await this.addRevisionInfo(summaries, instances);

    return summaries.sort(byNewestDeployment);
  }

  /**
   * Git refs the entity can be deployed at, read from ArgoCD's view of the
   * application's source repository.
   */
  async listVersions(
    target: ArgoTarget,
    app: ArgoApplicationSummary,
  ): Promise<GitVersion[]> {
    if (!app.repoUrl) {
      throw new NotFoundError(
        `ArgoCD application '${app.name}' has no source repository to list versions from`,
      );
    }

    const instance = this.instance(app.instance);
    const token = await this.argocd.getArgoToken(instance);

    const refs = await this.listRefs({
      instance,
      token,
      repoUrl: app.repoUrl,
      // Project-scoped repositories are only readable with the project named.
      project: target.project ?? app.project,
    });

    return toGitVersions(refs, {
      currentRevision: app.targetRevision,
      includeBranches: this.deployConfig.includeBranches,
      includeTags: this.deployConfig.includeTags,
      tagPattern: this.deployConfig.tagPattern,
      maxVersions: this.deployConfig.maxVersions,
    });
  }

  /**
   * Checks a version against ArgoCD's refs before it reaches the pipeline, so
   * a caller cannot push an arbitrary string into a PipelineRun parameter.
   */
  async assertVersionAllowed(
    target: ArgoTarget,
    app: ArgoApplicationSummary,
    version: string,
  ): Promise<void> {
    const versions = await this.listVersions(target, app);
    if (!versions.some(candidate => candidate.ref === version)) {
      throw new NotFoundError(
        `Version '${version}' is not a known ref of ${app.repoUrl}`,
      );
    }
  }

  /** `GET /api/v1/repositories/{repo}/refs`, which the Roadie service lacks. */
  private async listRefs(options: {
    instance: InstanceConfig;
    token: string;
    repoUrl: string;
    project?: string;
  }): Promise<ArgoRefs> {
    const search = new URLSearchParams();
    if (options.project) {
      search.set('appProject', options.project);
    }

    const url = buildArgoUrl(
      options.instance.url,
      `/api/v1/repositories/${encodeURIComponent(options.repoUrl)}/refs${
        search.size ? `?${search}` : ''
      }`,
    );

    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${options.token}`,
        },
      });
    } catch (error) {
      throw new ServiceUnavailableError(
        `Could not reach ArgoCD instance '${options.instance.name}': ${error}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ServiceUnavailableError(
        `ArgoCD instance '${options.instance.name}' returned ${response.status} listing refs of ${options.repoUrl}: ${body.slice(0, 200)}`,
      );
    }

    return (await response.json()) as ArgoRefs;
  }

  /**
   * Commit metadata for each application's running revision. Best-effort: it
   * is only shown as a subtitle, so a failure must not hide the deployed state.
   */
  private async addRevisionInfo(
    summaries: ArgoApplicationSummary[],
    instances: InstanceConfig[],
  ): Promise<void> {
    await Promise.all(
      summaries.map(async summary => {
        if (!summary.revision) {
          return;
        }
        const instance = instances.find(i => i.name === summary.instance);
        if (!instance) {
          return;
        }

        try {
          const token = await this.argocd.getArgoToken(instance);
          const data = await this.argocd.getRevisionData(
            instance.url,
            { name: summary.name },
            token,
            summary.revision,
          );
          summary.revisionInfo = {
            revision: summary.revision!,
            author: data.author,
            date: data.date,
            message: data.message,
          };
        } catch (error) {
          this.logger.debug(
            `Could not read revision metadata for ${summary.name}@${summary.revision}: ${error}`,
          );
        }
      }),
    );
  }

  /** The instances worth querying: the annotated one, or all of them. */
  private resolveInstances(target: ArgoTarget): InstanceConfig[] {
    const all = this.argocd.getArgoInstanceArray();

    if (!all.length) {
      throw new ServiceUnavailableError(
        'No ArgoCD instances are configured under argocd.appLocatorMethods',
      );
    }

    if (!target.instanceName) {
      return all;
    }
    return [this.instance(target.instanceName)];
  }

  private instance(name: string): InstanceConfig {
    const instance = this.argocd
      .getArgoInstanceArray()
      .find(candidate => candidate.name === name);
    if (!instance) {
      throw new NotFoundError(
        `ArgoCD instance '${name}' is not configured under argocd.appLocatorMethods`,
      );
    }
    return instance;
  }

  private async token(instance: InstanceConfig): Promise<string | undefined> {
    try {
      return await this.argocd.getArgoToken(instance);
    } catch (error) {
      // One unreachable instance should not break an entity whose app lives
      // on another one.
      this.logger.warn(
        `Could not authenticate against ArgoCD instance '${instance.name}': ${error}`,
      );
      return undefined;
    }
  }
}

/**
 * Normalises the two shapes the Roadie service returns: a single application
 * for a name query, and `{items}` for a selector query.
 */
function asApplications(data: unknown): RawArgoApplication[] {
  if (!data || typeof data !== 'object') {
    return [];
  }
  const items = (data as { items?: unknown }).items;
  if (Array.isArray(items)) {
    return items as RawArgoApplication[];
  }
  return (data as RawArgoApplication).metadata?.name
    ? [data as RawArgoApplication]
    : [];
}
