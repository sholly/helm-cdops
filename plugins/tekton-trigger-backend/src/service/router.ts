import express from 'express';
import Router from 'express-promise-router';
import {
  AuthService,
  BackstageCredentials,
  HttpAuthService,
  LoggerService,
  PermissionsService,
  RootConfigService,
} from '@backstage/backend-plugin-api';
import { CatalogService } from '@backstage/plugin-catalog-node';
import { Entity, parseEntityRef } from '@backstage/catalog-model';
import { InputError, NotAllowedError, NotFoundError } from '@backstage/errors';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import {
  ListPipelineRunsResponse,
  PipelineRunSummary,
  tektonPipelineCancelPermission,
  tektonPipelineReadPermission,
  tektonPipelineTriggerPermission,
  TektonTarget,
  TriggerPipelineResponse,
} from '@cdops/plugin-tekton-trigger-common';
import {
  ClusterConfig,
  readTektonTriggerConfig,
  TektonTriggerConfig,
} from './config';
import { TektonApiClient } from './TektonApiClient';
import { EventListenerClient } from './EventListenerClient';
import { buildPipelineRun, resolveParams } from './buildPipelineRun';
import {
  byNewestFirst,
  pipelineUrl,
  toParamSpecs,
  toPipelineRunSummary,
  toWorkspaceSpecs,
} from './mappers';
import { TEKTON_PIPELINE_LABEL } from './labels';
import { isTektonEntity, ResolvedTarget, resolveTarget } from './target';
import { TektonParamValue } from './tektonTypes';

export interface RouterOptions {
  logger: LoggerService;
  config: RootConfigService;
  auth: AuthService;
  httpAuth: HttpAuthService;
  permissions: PermissionsService;
  catalog: CatalogService;
  /** Overridden in tests. */
  clientFactory?: (cluster: ClusterConfig) => TektonApiClient;
  /** Overridden in tests. */
  eventListenerClient?: EventListenerClient;
}

export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const { logger, auth, httpAuth, permissions, catalog } = options;

  const tektonConfig: TektonTriggerConfig = readTektonTriggerConfig(
    options.config,
  );

  if (!tektonConfig.clusters.length && !tektonConfig.eventListeners.length) {
    logger.warn(
      'tekton-trigger is installed but no clusters or eventListeners are configured; every request will fail',
    );
  }

  const clients = new Map<string, TektonApiClient>();
  const clientFactory =
    options.clientFactory ??
    ((cluster: ClusterConfig) => new TektonApiClient(cluster, logger));
  const getClient = (cluster: ClusterConfig) => {
    let client = clients.get(cluster.name);
    if (!client) {
      client = clientFactory(cluster);
      clients.set(cluster.name, client);
    }
    return client;
  };

  const eventListenerClient =
    options.eventListenerClient ?? new EventListenerClient(logger);

  const authorize = async (
    request: express.Request,
    permission:
      | typeof tektonPipelineReadPermission
      | typeof tektonPipelineTriggerPermission
      | typeof tektonPipelineCancelPermission,
  ): Promise<BackstageCredentials> => {
    const credentials = await httpAuth.credentials(request, {
      allow: ['user', 'service'],
    });

    const [decision] = await permissions.authorize([{ permission }], {
      credentials,
    });
    if (decision.result !== AuthorizeResult.ALLOW) {
      throw new NotAllowedError(`Not allowed to perform '${permission.name}'`);
    }

    return credentials;
  };

  const userEntityRef = (credentials: BackstageCredentials) =>
    auth.isPrincipal(credentials, 'user')
      ? credentials.principal.userEntityRef
      : undefined;

  const readEntity = async (
    request: express.Request,
    credentials: BackstageCredentials,
  ): Promise<Entity> => {
    const entityRef = request.query.entityRef ?? request.body?.entityRef;
    if (typeof entityRef !== 'string' || !entityRef) {
      throw new InputError('Missing entityRef');
    }
    // Reject malformed refs before they reach the catalog. parseEntityRef
    // throws a plain Error, which would surface as a 500.
    try {
      parseEntityRef(entityRef);
    } catch (error) {
      throw new InputError(
        `Invalid entityRef '${entityRef}': ${(error as Error).message}`,
      );
    }

    const entity = await catalog.getEntityByRef(entityRef, { credentials });
    if (!entity) {
      // Also what the catalog returns when the caller may not see the entity.
      throw new NotFoundError(`Entity ${entityRef} not found`);
    }
    return entity;
  };

  const listRuns = async (
    target: ResolvedTarget,
  ): Promise<PipelineRunSummary[]> => {
    if (!target.cluster || !target.namespace || !target.pipeline) {
      // Nothing to select on: an EventListener-only entity has no pipeline name.
      return [];
    }

    const runs = await getClient(target.cluster).listPipelineRuns({
      namespace: target.namespace,
      labelSelector: `${TEKTON_PIPELINE_LABEL}=${target.pipeline}`,
    });

    return runs
      .map(run => toPipelineRunSummary(run, target.cluster))
      .sort(byNewestFirst)
      .slice(0, tektonConfig.maxRuns);
  };

  const router = Router();
  router.use(express.json());

  /**
   * What the entity can run, including the pipeline's declared parameters so
   * the frontend can render a form without talking to the cluster itself.
   */
  router.get('/target', async (request, response) => {
    const credentials = await authorize(request, tektonPipelineReadPermission);
    const entity = await readEntity(request, credentials);

    if (!isTektonEntity(entity)) {
      const target: TektonTarget = {
        mode: 'pipelineRun',
        params: [],
        workspaces: [],
        unconfiguredReason:
          'This entity has no tekton.dev/pipeline or tekton.dev/event-listener annotation.',
      };
      response.json(target);
      return;
    }

    const target = resolveTarget(entity, tektonConfig);

    let params: TektonTarget['params'] = [];
    let workspaces: TektonTarget['workspaces'] = [];

    if (target.cluster && target.namespace && target.pipeline) {
      const pipeline = await getClient(target.cluster).getPipeline(
        target.namespace,
        target.pipeline,
      );
      params = toParamSpecs(pipeline, target.fixedParams);
      workspaces = toWorkspaceSpecs(pipeline);
    }

    const body: TektonTarget = {
      mode: target.mode,
      cluster: target.cluster?.name,
      namespace: target.namespace,
      pipeline: target.pipeline,
      eventListener: target.eventListener?.name,
      params,
      workspaces,
      consoleUrl: pipelineUrl(
        target.cluster,
        target.namespace,
        target.pipeline,
      ),
    };
    response.json(body);
  });

  router.get('/pipelineruns', async (request, response) => {
    const credentials = await authorize(request, tektonPipelineReadPermission);
    const entity = await readEntity(request, credentials);

    if (!isTektonEntity(entity)) {
      response.json({ items: [] } as ListPipelineRunsResponse);
      return;
    }

    const target = resolveTarget(entity, tektonConfig);
    response.json({
      items: await listRuns(target),
    } as ListPipelineRunsResponse);
  });

  /** One run, with its TaskRuns, for the expanded view. */
  router.get('/pipelineruns/:name', async (request, response) => {
    const credentials = await authorize(request, tektonPipelineReadPermission);
    const entity = await readEntity(request, credentials);
    const target = resolveTarget(entity, tektonConfig);

    if (!target.cluster || !target.namespace) {
      throw new InputError(
        `${target.entityRef} has no cluster or namespace to read PipelineRuns from`,
      );
    }

    const client = getClient(target.cluster);
    const { name } = request.params;

    const [run, taskRuns] = await Promise.all([
      client.getPipelineRun(target.namespace, name),
      client
        .listTaskRunsForPipelineRun(target.namespace, name)
        // Task detail is a nice-to-have; a missing TaskRun list should not
        // hide the run's own status.
        .catch(error => {
          logger.warn(
            `Could not list TaskRuns for ${target.namespace}/${name}: ${error}`,
          );
          return [];
        }),
    ]);

    assertRunBelongsToTarget(run.metadata.labels, target, name);

    response.json(toPipelineRunSummary(run, target.cluster, taskRuns));
  });

  /** Trigger: creates a PipelineRun, or fires the entity's EventListener. */
  router.post('/pipelineruns', async (request, response) => {
    const credentials = await authorize(
      request,
      tektonPipelineTriggerPermission,
    );
    const entity = await readEntity(request, credentials);
    const target = resolveTarget(entity, tektonConfig);
    const triggeredBy = userEntityRef(credentials);

    const supplied = readSuppliedParams(request.body?.params);

    if (target.mode === 'eventListener') {
      const result = await eventListenerClient.send(target.eventListener!, {
        source: 'backstage-tekton-trigger',
        entityRef: target.entityRef,
        pipeline: target.pipeline,
        namespace: target.namespace,
        triggeredBy,
        params: { ...supplied, ...target.fixedParams },
      });

      const body: TriggerPipelineResponse = {
        mode: 'eventListener',
        eventListener: result,
      };
      response.status(202).json(body);
      return;
    }

    const client = getClient(target.cluster!);
    const pipeline = await client.getPipeline(
      target.namespace!,
      target.pipeline!,
    );

    const params = resolveParams({
      specs: toParamSpecs(pipeline, target.fixedParams),
      supplied,
      fixed: target.fixedParams,
    });

    const created = await client.createPipelineRun(
      target.namespace!,
      buildPipelineRun({
        target,
        params,
        userEntityRef: triggeredBy,
        defaults: tektonConfig.pipelineRun,
      }),
    );

    logger.info(
      `Created PipelineRun ${target.namespace}/${created.metadata.name} from pipeline '${target.pipeline}' on cluster '${target.cluster!.name}' for ${target.entityRef}${
        triggeredBy ? ` (triggered by ${triggeredBy})` : ''
      }`,
    );

    const body: TriggerPipelineResponse = {
      mode: 'pipelineRun',
      pipelineRun: toPipelineRunSummary(created, target.cluster),
    };
    response.status(201).json(body);
  });

  router.post('/pipelineruns/:name/cancel', async (request, response) => {
    const credentials = await authorize(
      request,
      tektonPipelineCancelPermission,
    );
    const entity = await readEntity(request, credentials);
    const target = resolveTarget(entity, tektonConfig);

    if (!target.cluster || !target.namespace) {
      throw new InputError(
        `${target.entityRef} has no cluster or namespace to cancel PipelineRuns in`,
      );
    }

    const client = getClient(target.cluster);
    const { name } = request.params;

    // Read first, so a caller cannot cancel an unrelated run by name.
    const existing = await client.getPipelineRun(target.namespace, name);
    assertRunBelongsToTarget(existing.metadata.labels, target, name);

    const cancelled = await client.cancelPipelineRun(target.namespace, name);

    logger.info(
      `Cancelled PipelineRun ${target.namespace}/${name} for ${target.entityRef}${
        userEntityRef(credentials) ? ` (by ${userEntityRef(credentials)})` : ''
      }`,
    );

    response.json(toPipelineRunSummary(cancelled, target.cluster));
  });

  return router;
}

/**
 * Guards the by-name routes: the namespace alone is not a tight enough scope,
 * since a namespace usually holds pipelines for several entities.
 */
function assertRunBelongsToTarget(
  labels: Record<string, string> | undefined,
  target: ResolvedTarget,
  name: string,
) {
  if (!target.pipeline) {
    return;
  }
  if (labels?.[TEKTON_PIPELINE_LABEL] !== target.pipeline) {
    throw new NotFoundError(
      `PipelineRun '${name}' does not belong to pipeline '${target.pipeline}'`,
    );
  }
}

function readSuppliedParams(input: unknown): Record<string, TektonParamValue> {
  if (input === undefined || input === null) {
    return {};
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new InputError('params must be an object');
  }

  const result: Record<string, TektonParamValue> = {};
  for (const [name, value] of Object.entries(
    input as Record<string, unknown>,
  )) {
    if (typeof value === 'string') {
      result[name] = value;
    } else if (
      Array.isArray(value) &&
      value.every(item => typeof item === 'string')
    ) {
      result[name] = value as string[];
    } else {
      throw new InputError(
        `Parameter '${name}' must be a string or an array of strings`,
      );
    }
  }
  return result;
}
