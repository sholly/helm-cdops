import { Config } from '@backstage/config';
import { InputError, NotFoundError } from '@backstage/errors';

const IN_CLUSTER_TOKEN_FILE =
  '/var/run/secrets/kubernetes.io/serviceaccount/token';
const IN_CLUSTER_CA_FILE =
  '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';

export const DEFAULT_PIPELINE_TIMEOUT = '1h0m0s';
export const DEFAULT_MAX_RUNS = 20;
export const DEFAULT_SECRET_HEADER = 'X-Backstage-Token';
export const DEFAULT_VERSION_PARAM = 'git-revision';
export const DEFAULT_APP_PARAM = 'argocd-app';
export const DEFAULT_ENVIRONMENT_PARAM = 'environment';
export const DEFAULT_MAX_VERSIONS = 50;

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

/** How a picked git version is turned into a pipeline run. */
export interface DeployConfig {
  /** Pipeline parameter carrying the version, unless the entity overrides it. */
  versionParam: string;
  /** Pipeline parameter carrying the ArgoCD application name, when declared. */
  appParam: string;
  /** Pipeline parameter carrying the entity's `tekton.dev/environment`. */
  environmentParam: string;
  /** Offer branches in the version dropdown. */
  includeBranches: boolean;
  /** Offer tags in the version dropdown. */
  includeTags: boolean;
  /** Only tags matching this pattern are offered. */
  tagPattern?: RegExp;
  /** Upper bound on dropdown entries, newest first. */
  maxVersions: number;
}

export interface TektonTriggerConfig {
  defaultCluster?: string;
  clusters: ClusterConfig[];
  eventListeners: EventListenerConfig[];
  pipelineRun: PipelineRunDefaults;
  deploy: DeployConfig;
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
    deploy: readDeployConfig(config?.getOptionalConfig('deploy')),
    maxRuns: config?.getOptionalNumber('maxRuns') ?? DEFAULT_MAX_RUNS,
  };
}

function readDeployConfig(config: Config | undefined): DeployConfig {
  const rawPattern = config?.getOptionalString('tagPattern');

  let tagPattern: RegExp | undefined;
  if (rawPattern) {
    try {
      tagPattern = new RegExp(rawPattern);
    } catch (error) {
      throw new InputError(
        `tektonTrigger.deploy.tagPattern '${rawPattern}' is not a valid regular expression: ${(error as Error).message}`,
      );
    }
  }

  return {
    versionParam:
      config?.getOptionalString('versionParam') ?? DEFAULT_VERSION_PARAM,
    appParam: config?.getOptionalString('appParam') ?? DEFAULT_APP_PARAM,
    environmentParam:
      config?.getOptionalString('environmentParam') ??
      DEFAULT_ENVIRONMENT_PARAM,
    includeBranches: config?.getOptionalBoolean('includeBranches') ?? true,
    includeTags: config?.getOptionalBoolean('includeTags') ?? true,
    tagPattern,
    maxVersions:
      config?.getOptionalNumber('maxVersions') ?? DEFAULT_MAX_VERSIONS,
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
