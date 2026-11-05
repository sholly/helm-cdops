import {
  Entity,
  parseEntityRef,
  stringifyEntityRef,
} from '@backstage/catalog-model';
import { InputError } from '@backstage/errors';
import {
  KUBERNETES_NAMESPACE_ANNOTATION,
  TEKTON_CLUSTER_ANNOTATION,
  TEKTON_ENVIRONMENT_ANNOTATION,
  TEKTON_ENVIRONMENT_PARAM_ANNOTATION,
  TEKTON_EVENT_LISTENER_ANNOTATION,
  TEKTON_NAMESPACE_ANNOTATION,
  TEKTON_PARAMS_ANNOTATION,
  TEKTON_PIPELINE_ANNOTATION,
  TEKTON_SERVICE_ACCOUNT_ANNOTATION,
  TEKTON_WORKSPACES_ANNOTATION,
} from '@cdops/plugin-tekton-trigger-common';
import {
  assertNamespaceAllowed,
  ClusterConfig,
  EventListenerConfig,
  getCluster,
  getEventListener,
  TektonTriggerConfig,
} from './config';
import {
  ENTITY_KIND_LABEL,
  ENTITY_NAME_LABEL,
  ENTITY_NAMESPACE_LABEL,
} from './labels';
import { TektonParamValue } from './tektonTypes';

export interface ResolvedTarget {
  mode: 'pipelineRun' | 'eventListener';
  entityRef: string;
  /** Undefined only in EventListener mode with no cluster to link to. */
  cluster?: ClusterConfig;
  namespace?: string;
  pipeline?: string;
  eventListener?: EventListenerConfig;
  serviceAccountName?: string;
  /** Parameter values pinned by the catalog; callers cannot override these. */
  fixedParams: Record<string, TektonParamValue>;
  /** Environment from `tekton.dev/environment`, when the entity declares one. */
  environment?: string;
  /** Pipeline parameter `environment` is passed as. */
  environmentParam: string;
  /** Workspace bindings passed through to `spec.workspaces`. */
  workspaces?: unknown[];
}

/** True when the entity carries enough annotations for the plugin to do anything. */
export function isTektonEntity(entity: Entity): boolean {
  const annotations = entity.metadata.annotations ?? {};
  return Boolean(
    annotations[TEKTON_PIPELINE_ANNOTATION] ||
    annotations[TEKTON_EVENT_LISTENER_ANNOTATION],
  );
}

function parseJsonAnnotation<T>(
  entity: Entity,
  annotation: string,
  expect: 'object' | 'array',
): T | undefined {
  const raw = entity.metadata.annotations?.[annotation];
  if (!raw) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InputError(
      `Annotation ${annotation} on ${stringifyEntityRef(entity)} is not valid JSON`,
    );
  }

  const ok =
    expect === 'array'
      ? Array.isArray(parsed)
      : typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  if (!ok) {
    throw new InputError(
      `Annotation ${annotation} on ${stringifyEntityRef(entity)} must be a JSON ${expect}`,
    );
  }
  return parsed as T;
}

/**
 * Turns an entity's annotations plus the plugin config into a concrete target.
 *
 * All trigger requests go through here, so a client can only ever reach a
 * pipeline that the catalog says the entity owns.
 */
export function resolveTarget(
  entity: Entity,
  config: TektonTriggerConfig,
): ResolvedTarget {
  const annotations = entity.metadata.annotations ?? {};
  const entityRef = stringifyEntityRef(entity);

  const pipeline = annotations[TEKTON_PIPELINE_ANNOTATION];
  const eventListenerName = annotations[TEKTON_EVENT_LISTENER_ANNOTATION];

  if (!pipeline && !eventListenerName) {
    throw new InputError(
      `${entityRef} has neither the ${TEKTON_PIPELINE_ANNOTATION} nor the ${TEKTON_EVENT_LISTENER_ANNOTATION} annotation`,
    );
  }

  const fixedParams =
    parseJsonAnnotation<Record<string, TektonParamValue>>(
      entity,
      TEKTON_PARAMS_ANNOTATION,
      'object',
    ) ?? {};
  const workspaces = parseJsonAnnotation<unknown[]>(
    entity,
    TEKTON_WORKSPACES_ANNOTATION,
    'array',
  );

  // Resolved here rather than on the deploy route so that every path - deploy,
  // plain trigger and EventListener - passes it, and so it inherits the
  // override protection that fixedParams already has.
  const environmentParam =
    annotations[TEKTON_ENVIRONMENT_PARAM_ANNOTATION] ??
    config.deploy.environmentParam;
  const environment =
    annotations[TEKTON_ENVIRONMENT_ANNOTATION]?.trim() || undefined;

  if (environment !== undefined) {
    // Both annotations pin the same parameter, so a value in each is a
    // contradiction the entity's author should see rather than a precedence
    // rule to memorise.
    if (Object.prototype.hasOwnProperty.call(fixedParams, environmentParam)) {
      throw new InputError(
        `Parameter '${environmentParam}' on ${entityRef} is set by both ${TEKTON_ENVIRONMENT_ANNOTATION} and ${TEKTON_PARAMS_ANNOTATION}; remove one`,
      );
    }
    fixedParams[environmentParam] = environment;
  }

  const common = {
    entityRef,
    pipeline,
    fixedParams,
    environment,
    environmentParam,
    workspaces,
    serviceAccountName:
      annotations[TEKTON_SERVICE_ACCOUNT_ANNOTATION] ??
      config.pipelineRun.serviceAccountName,
  };

  // An EventListener takes precedence: it is the more constrained path, since
  // the cluster-side TriggerBinding decides what actually runs.
  if (eventListenerName) {
    const eventListener = getEventListener(config, eventListenerName);
    const clusterName =
      annotations[TEKTON_CLUSTER_ANNOTATION] ?? eventListener.cluster;
    // Only needed for deep links and for listing runs, so a missing cluster is
    // not fatal here.
    let cluster: ClusterConfig | undefined;
    try {
      cluster = getCluster(config, clusterName);
    } catch (error) {
      if (clusterName) {
        throw error;
      }
    }

    const namespace =
      annotations[TEKTON_NAMESPACE_ANNOTATION] ??
      annotations[KUBERNETES_NAMESPACE_ANNOTATION] ??
      eventListener.namespace;

    if (cluster && namespace) {
      assertNamespaceAllowed(cluster, namespace);
    }

    return {
      ...common,
      mode: 'eventListener',
      eventListener,
      cluster,
      namespace,
    };
  }

  const cluster = getCluster(config, annotations[TEKTON_CLUSTER_ANNOTATION]);
  const namespace =
    annotations[TEKTON_NAMESPACE_ANNOTATION] ??
    annotations[KUBERNETES_NAMESPACE_ANNOTATION];

  if (!namespace) {
    throw new InputError(
      `${entityRef} needs a ${TEKTON_NAMESPACE_ANNOTATION} (or ${KUBERNETES_NAMESPACE_ANNOTATION}) annotation to run pipeline '${pipeline}'`,
    );
  }
  assertNamespaceAllowed(cluster, namespace);

  return { ...common, mode: 'pipelineRun', cluster, namespace };
}

/** Labels stamped on PipelineRuns so they can be traced back to the entity. */
export function entityRefToLabels(entityRef: string): Record<string, string> {
  const { kind, namespace, name } = parseEntityRef(entityRef);
  return {
    [ENTITY_KIND_LABEL]: kind.toLowerCase(),
    [ENTITY_NAMESPACE_LABEL]: namespace.toLowerCase(),
    [ENTITY_NAME_LABEL]: name,
  };
}
