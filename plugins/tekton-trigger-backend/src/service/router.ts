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
import { ArgoServiceApi } from '@roadiehq/backstage-plugin-argo-cd-node';
import {
  ArgoApplicationSummary,
  argocdApplicationReadPermission,
  ArgoDeployedState,
  ListGitVersionsResponse,
  ListPipelineRunsResponse,
  PipelineRunSummary,
  TEKTON_APP_PARAM_ANNOTATION,
  TEKTON_ENVIRONMENT_PARAM_ANNOTATION,
  TEKTON_VERSION_PARAM_ANNOTATION,
  tektonPipelineCancelPermission,
  tektonPipelineReadPermission,
  tektonPipelineTriggerPermission,
  TektonParamSpec,
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
import { ArgoApplicationService } from './ArgoApplicationService';
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
import {
  argoUnconfiguredReason,
  ArgoTarget,
  isArgoEntity,
  resolveArgoTarget,
} from './argoTarget';
import { TektonParamValue } from './tektonTypes';

export interface RouterOptions {
  logger: LoggerService;
  config: RootConfigService;
  auth: AuthService;
  httpAuth: HttpAuthService;
  permissions: PermissionsService;
  catalog: CatalogService;
  /** Roadie ArgoCD service, injected from `argocdServiceRef`. */
  argocd: ArgoServiceApi;
  /** Overridden in tests. */
  clientFactory?: (cluster: ClusterConfig) => TektonApiClient;
  /** Overridden in tests. */
  eventListenerClient?: EventListenerClient;
  /** Overridden in tests. */
  argoService?: ArgoApplicationService;
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

  const argoService =
    options.argoService ??
    new ArgoApplicationService(options.argocd, logger, tektonConfig.deploy);

  const authorize = async (
    request: express.Request,
    permission:
      | typeof tektonPipelineReadPermission
      | typeof tektonPipelineTriggerPermission
      | typeof tektonPipelineCancelPermission
      | typeof argocdApplicationReadPermission,
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

  /**
   * Picks the application a request is about. The card deploys one application
   * at a time, so a request naming none is only unambiguous when the entity
   * resolves to exactly one.
   */
  const selectApp = (
    apps: ArgoApplicationSummary[],
    entityRef: string,
    requested?: unknown,
  ): ArgoApplicationSummary => {
    if (!apps.length) {
      throw new NotFoundError(`No ArgoCD application found for ${entityRef}`);
    }

    if (requested === undefined || requested === null || requested === '') {
      if (apps.length > 1) {
        throw new InputError(
          `${entityRef} resolves to ${apps.length} ArgoCD applications (${apps
            .map(app => app.name)
            .join(', ')}); name one with the 'app' parameter`,
        );
      }
      return apps[0];
    }

    if (typeof requested !== 'string') {
      throw new InputError('app must be a string');
    }

    // Only applications the catalog associates with the entity are reachable.
    const app = apps.find(candidate => candidate.name === requested);
    if (!app) {
      throw new NotFoundError(
        `ArgoCD application '${requested}' is not one of ${entityRef}'s applications`,
      );
    }
    return app;
  };

  /**
   * Turns the picked version into pipeline parameters.
   *
   * The version reaches the pipeline through a parameter the pipeline itself
   * declares, so an entity whose pipeline takes no such parameter is rejected
   * here rather than silently running a pipeline that ignores the choice.
   */
  const deployParams = (args: {
    specs: TektonParamSpec[];
    entity: Entity;
    target: ResolvedTarget;
    app: ArgoApplicationSummary;
    version: string;
    supplied: Record<string, TektonParamValue>;
    /** EventListener payloads are not validated against a pipeline spec. */
    validateAgainstSpecs: boolean;
  }): Record<string, TektonParamValue> => {
    const annotations = args.entity.metadata.annotations ?? {};
    const versionParam =
      annotations[TEKTON_VERSION_PARAM_ANNOTATION] ??
      tektonConfig.deploy.versionParam;
    const appParam =
      annotations[TEKTON_APP_PARAM_ANNOTATION] ?? tektonConfig.deploy.appParam;

    if (
      Object.prototype.hasOwnProperty.call(
        args.target.fixedParams,
        versionParam,
      )
    ) {
      throw new InputError(
        `Parameter '${versionParam}' carries the deployed version but is pinned by the catalog; remove it from the tekton.dev/params annotation`,
      );
    }

    if (
      args.validateAgainstSpecs &&
      !args.specs.some(spec => spec.name === versionParam)
    ) {
      throw new InputError(
        `Pipeline '${args.target.pipeline}' does not declare a parameter named '${versionParam}'; set tekton.dev/version-param or tektonTrigger.deploy.versionParam to the parameter that carries the git version`,
      );
    }

    const params: Record<string, TektonParamValue> = {
      ...args.supplied,
      [versionParam]: args.version,
    };

    // The application name is optional: only pass it when the pipeline asks
    // for it and the catalog has not pinned it.
    const appParamWanted = args.validateAgainstSpecs
      ? args.specs.some(spec => spec.name === appParam)
      : true;
    if (
      appParamWanted &&
      !Object.prototype.hasOwnProperty.call(args.target.fixedParams, appParam)
    ) {
      params[appParam] = args.app.name;
    }

    return params;
  };

  /** Shared by the plain trigger route and the deploy route. */
  const trigger = async (args: {
    entity: Entity;
    target: ResolvedTarget;
    triggeredBy?: string;
    /** Caller-supplied values; the catalog's fixed params still win. */
    supplied: Record<string, TektonParamValue>;
    /** Set by the deploy route to inject the version parameter. */
    withParams?: (
      specs: TektonParamSpec[],
      validateAgainstSpecs: boolean,
    ) => Record<string, TektonParamValue>;
  }): Promise<{ status: number; body: TriggerPipelineResponse }> => {
    const { entity: _entity, target, triggeredBy } = args;

    if (target.mode === 'eventListener') {
      const supplied = args.withParams
        ? args.withParams([], false)
        : args.supplied;

      const result = await eventListenerClient.send(target.eventListener!, {
        source: 'backstage-tekton-trigger',
        entityRef: target.entityRef,
        pipeline: target.pipeline,
        namespace: target.namespace,
        triggeredBy,
        params: { ...supplied, ...target.fixedParams },
      });

      return {
        status: 202,
        body: { mode: 'eventListener', eventListener: result },
      };
    }

    const client = getClient(target.cluster!);
    const pipeline = await client.getPipeline(
      target.namespace!,
      target.pipeline!,
    );
    const specs = toParamSpecs(pipeline, target.fixedParams);

    // resolveParams only reads fixed values for params the pipeline declares,
    // so without this an environment the entity asked for would be dropped in
    // silence.
    if (
      target.environment !== undefined &&
      !specs.some(spec => spec.name === target.environmentParam)
    ) {
      throw new InputError(
        `Pipeline '${target.pipeline}' does not declare a parameter named '${target.environmentParam}'; set ${TEKTON_ENVIRONMENT_PARAM_ANNOTATION} or tektonTrigger.deploy.environmentParam to the parameter that carries the environment`,
      );
    }

    const supplied = args.withParams
      ? args.withParams(specs, true)
      : args.supplied;

    const params = resolveParams({
      specs,
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

    return {
      status: 201,
      body: {
        mode: 'pipelineRun',
        pipelineRun: toPipelineRunSummary(created, target.cluster),
      },
    };
  };

  const router = Router();
  router.use(express.json());

  /**
   * Deployed state of the entity's ArgoCD applications. This is what the card
   * leads with, so it answers with `unconfiguredReason` rather than an error
   * when the entity is not wired up.
   */
  router.get('/argocd/application', async (request, response) => {
    const credentials = await authorize(
      request,
      argocdApplicationReadPermission,
    );
    const entity = await readEntity(request, credentials);

    const unconfiguredReason = argoUnconfiguredReason(entity);
    if (unconfiguredReason) {
      response.json({ apps: [], unconfiguredReason } as ArgoDeployedState);
      return;
    }

    const target = resolveArgoTarget(entity);
    const apps = await argoService.getApplications(target);

    response.json({
      apps,
      unconfiguredReason: apps.length
        ? undefined
        : `No ArgoCD application matched ${describeArgoTarget(target)}.`,
    } as ArgoDeployedState);
  });

  /** Git versions the entity can be deployed at, for the card's dropdown. */
  router.get('/argocd/versions', async (request, response) => {
    const credentials = await authorize(
      request,
      argocdApplicationReadPermission,
    );
    const entity = await readEntity(request, credentials);

    if (!isArgoEntity(entity)) {
      response.json({
        items: [],
        unavailableReason: argoUnconfiguredReason(entity),
      } as ListGitVersionsResponse);
      return;
    }

    const target = resolveArgoTarget(entity);
    const apps = await argoService.getApplications(target);
    const app = selectApp(apps, target.entityRef, request.query.app);

    if (!app.repoUrl) {
      response.json({
        items: [],
        unavailableReason: `ArgoCD application '${app.name}' has no source repository to list versions from.`,
      } as ListGitVersionsResponse);
      return;
    }

    response.json({
      items: await argoService.listVersions(target, app),
      repoUrl: app.repoUrl,
    } as ListGitVersionsResponse);
  });

  /**
   * Deploy: runs the entity's pipeline with the picked git version, which is
   * what updates the version ArgoCD has deployed.
   */
  router.post('/deploy', async (request, response) => {
    const credentials = await authorize(
      request,
      tektonPipelineTriggerPermission,
    );
    const entity = await readEntity(request, credentials);

    const version = request.body?.version;
    if (typeof version !== 'string' || !version) {
      throw new InputError('Missing version');
    }

    if (!isArgoEntity(entity)) {
      throw new InputError(
        argoUnconfiguredReason(entity) ?? 'Entity has no ArgoCD application',
      );
    }

    const argoTarget = resolveArgoTarget(entity);
    const apps = await argoService.getApplications(argoTarget);
    const app = selectApp(apps, argoTarget.entityRef, request.body?.app);

    // The dropdown is a convenience, not the authority: re-check the version
    // against ArgoCD so a crafted request cannot reach an arbitrary ref.
    await argoService.assertVersionAllowed(argoTarget, app, version);

    const target = resolveTarget(entity, tektonConfig);
    const triggeredBy = userEntityRef(credentials);
    const supplied = readSuppliedParams(request.body?.params);

    const { status, body } = await trigger({
      entity,
      target,
      triggeredBy,
      supplied,
      withParams: (specs, validateAgainstSpecs) =>
        deployParams({
          specs,
          entity,
          target,
          app,
          version,
          supplied,
          validateAgainstSpecs,
        }),
    });

    logger.info(
      `Deploying ${app.name} at '${version}' for ${target.entityRef}${
        triggeredBy ? ` (requested by ${triggeredBy})` : ''
      }`,
    );

    response.status(status).json(body);
  });

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

    const { status, body } = await trigger({
      entity,
      target,
      triggeredBy: userEntityRef(credentials),
      supplied: readSuppliedParams(request.body?.params),
    });

    response.status(status).json(body);
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

function describeArgoTarget(target: ArgoTarget): string {
  const what = target.appName
    ? `application '${target.appName}'`
    : `selector '${target.appSelector}'`;
  return target.instanceName
    ? `${what} on instance '${target.instanceName}'`
    : what;
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
