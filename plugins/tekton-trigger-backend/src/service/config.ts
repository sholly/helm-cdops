import { Config } from '@backstage/config';
import { InputError, NotFoundError } from '@backstage/errors';

const IN_CLUSTER_TOKEN_FILE =
  '/var/run/secrets/kubernetes.io/serviceaccount/token';
const IN_CLUSTER_CA_FILE =
  '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';

export const DEFAULT_PIPELINE_TIMEOUT = '1h0m0s';
export const DEFAULT_MAX_RUNS = 20;
export const DEFAULT_SECRET_HEADER = 'X-Backstage-Token';

export type DashboardType = 'openshift' | 'tekton';

export interface ClusterConfig {
  name: string;
  url: string;
  serviceAccountToken?: string;
  serviceAccountTokenFile?: string;
  caData?: string;
  caFile?: string;
  skipTLSVerify: boolean;
  dashboardUrl?: string;
  dashboardType: DashboardType;
  allowedNamespaces?: string[];
}

export interface EventListenerConfig {
  name: string;
  url: string;
  secret?: string;
  secretHeader: string;
  cluster?: string;
  namespace?: string;
}

export interface PipelineRunDefaults {
  serviceAccountName?: string;
  timeout: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

export interface TektonTriggerConfig {
  defaultCluster?: string;
  clusters: ClusterConfig[];
  eventListeners: EventListenerConfig[];
  pipelineRun: PipelineRunDefaults;
  maxRuns: number;
}

function readStringMap(config: Config | undefined, key: string) {
  const child = config?.getOptionalConfig(key);
  if (!child) {
    return {};
  }
  return Object.fromEntries(
    child.keys().map(k => [k, child.getString(k)]),
  ) as Record<string, string>;
}

function readCluster(config: Config): ClusterConfig {
  const name = config.getString('name');
  const token = config.getOptionalString('serviceAccountToken');
  const tokenFile = config.getOptionalString('serviceAccountTokenFile');
  const caData = config.getOptionalString('caData');
  const caFile = config.getOptionalString('caFile');
  const skipTLSVerify = config.getOptionalBoolean('skipTLSVerify') ?? false;

  const dashboardType = (config.getOptionalString('dashboardType') ??
    'openshift') as DashboardType;
  if (!['openshift', 'tekton'].includes(dashboardType)) {
    throw new InputError(
      `Invalid tektonTrigger.clusters[${name}].dashboardType '${dashboardType}', expected 'openshift' or 'tekton'`,
    );
  }

  return {
    name,
    url: config.getString('url').replace(/\/+$/, ''),
    serviceAccountToken: token,
    // Fall back to the projected in-cluster token so an RHDH deployment on the
    // same cluster needs no secret at all.
    serviceAccountTokenFile:
      tokenFile ?? (token ? undefined : IN_CLUSTER_TOKEN_FILE),
    caData,
    caFile:
      caFile ?? (caData || skipTLSVerify ? undefined : IN_CLUSTER_CA_FILE),
    skipTLSVerify,
    dashboardUrl: config.getOptionalString('dashboardUrl')?.replace(/\/+$/, ''),
    dashboardType,
    allowedNamespaces: config.getOptionalStringArray('allowedNamespaces'),
  };
}

function readEventListener(config: Config): EventListenerConfig {
  return {
    name: config.getString('name'),
    url: config.getString('url').replace(/\/+$/, ''),
    secret: config.getOptionalString('secret'),
    secretHeader:
      config.getOptionalString('secretHeader') ?? DEFAULT_SECRET_HEADER,
    cluster: config.getOptionalString('cluster'),
    namespace: config.getOptionalString('namespace'),
  };
}

export function readTektonTriggerConfig(root: Config): TektonTriggerConfig {
  const config = root.getOptionalConfig('tektonTrigger');

  const clusters = (config?.getOptionalConfigArray('clusters') ?? []).map(
    readCluster,
  );
  const eventListeners = (
    config?.getOptionalConfigArray('eventListeners') ?? []
  ).map(readEventListener);

  const duplicateCluster = clusters
    .map(c => c.name)
    .find((name, index, all) => all.indexOf(name) !== index);
  if (duplicateCluster) {
    throw new InputError(
      `Duplicate tektonTrigger cluster name '${duplicateCluster}'`,
    );
  }

  const defaultCluster = config?.getOptionalString('defaultCluster');
  if (defaultCluster && !clusters.some(c => c.name === defaultCluster)) {
    throw new InputError(
      `tektonTrigger.defaultCluster '${defaultCluster}' is not a configured cluster`,
    );
  }

  const pipelineRunConfig = config?.getOptionalConfig('pipelineRun');

  return {
    defaultCluster,
    clusters,
    eventListeners,
    pipelineRun: {
      serviceAccountName:
        pipelineRunConfig?.getOptionalString('serviceAccountName'),
      timeout:
        pipelineRunConfig?.getOptionalString('timeout') ??
        DEFAULT_PIPELINE_TIMEOUT,
      labels: readStringMap(pipelineRunConfig, 'labels'),
      annotations: readStringMap(pipelineRunConfig, 'annotations'),
    },
    maxRuns: config?.getOptionalNumber('maxRuns') ?? DEFAULT_MAX_RUNS,
  };
}

export function getCluster(
  config: TektonTriggerConfig,
  name: string | undefined,
): ClusterConfig {
  const wanted = name ?? config.defaultCluster;

  if (!wanted) {
    if (config.clusters.length === 1) {
      return config.clusters[0];
    }
    throw new InputError(
      config.clusters.length === 0
        ? 'No clusters are configured under tektonTrigger.clusters'
        : 'Several clusters are configured; set tektonTrigger.defaultCluster or annotate the entity with tekton.dev/cluster',
    );
  }

  const cluster = config.clusters.find(c => c.name === wanted);
  if (!cluster) {
    throw new NotFoundError(
      `Cluster '${wanted}' is not configured under tektonTrigger.clusters`,
    );
  }
  return cluster;
}

export function getEventListener(
  config: TektonTriggerConfig,
  name: string,
): EventListenerConfig {
  const listener = config.eventListeners.find(l => l.name === name);
  if (!listener) {
    throw new NotFoundError(
      `EventListener '${name}' is not configured under tektonTrigger.eventListeners`,
    );
  }
  return listener;
}

export function assertNamespaceAllowed(
  cluster: ClusterConfig,
  namespace: string,
) {
  if (
    cluster.allowedNamespaces &&
    !cluster.allowedNamespaces.includes(namespace)
  ) {
    throw new InputError(
      `Namespace '${namespace}' is not allowed on cluster '${cluster.name}'`,
    );
  }
}
