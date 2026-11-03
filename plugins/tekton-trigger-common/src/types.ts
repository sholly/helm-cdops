/** Tekton parameter kinds we accept from the UI. */
export type TektonParamType = 'string' | 'array' | 'object';

/** A parameter declared by a Tekton `Pipeline`. */
export interface TektonParamSpec {
  name: string;
  type: TektonParamType;
  description?: string;
  default?: string | string[] | Record<string, string>;
  /** True when the catalog pins this value, so the form renders it read-only. */
  fixed?: boolean;
}

/** A workspace declared by a Tekton `Pipeline`. */
export interface TektonWorkspaceSpec {
  name: string;
  description?: string;
  optional?: boolean;
}

/** How a trigger reaches the cluster. */
export type TektonTriggerMode = 'pipelineRun' | 'eventListener';

/**
 * Everything the frontend needs to render the trigger form, resolved on the
 * backend from the entity's annotations and the plugin config.
 */
export interface TektonTarget {
  mode: TektonTriggerMode;
  cluster?: string;
  namespace?: string;
  pipeline?: string;
  eventListener?: string;
  params: TektonParamSpec[];
  workspaces: TektonWorkspaceSpec[];
  /** OpenShift console URL for the pipeline, when a dashboard URL is configured. */
  consoleUrl?: string;
  /** Set when the entity is not wired up; the UI shows this instead of the form. */
  unconfiguredReason?: string;
}

export type PipelineRunStatus =
  'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Cancelled' | 'Unknown';

export interface PipelineRunTaskSummary {
  name: string;
  status: PipelineRunStatus;
  reason?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface PipelineRunSummary {
  name: string;
  namespace: string;
  cluster: string;
  pipeline?: string;
  status: PipelineRunStatus;
  reason?: string;
  message?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  /** Backstage identity recorded on the PipelineRun when it was triggered here. */
  triggeredBy?: string;
  params: { name: string; value: string | string[] }[];
  tasks: PipelineRunTaskSummary[];
  consoleUrl?: string;
}

export interface TriggerPipelineRequest {
  entityRef: string;
  params?: Record<string, string | string[]>;
}

export interface TriggerPipelineResponse {
  mode: TektonTriggerMode;
  /** Present in `pipelineRun` mode. */
  pipelineRun?: PipelineRunSummary;
  /** Present in `eventListener` mode; Triggers creates the run asynchronously. */
  eventListener?: {
    name: string;
    eventId?: string;
    status: number;
  };
}

export interface ListPipelineRunsResponse {
  items: PipelineRunSummary[];
}

/** Terminal states, i.e. the UI can stop polling. */
export const TERMINAL_PIPELINE_RUN_STATUSES: PipelineRunStatus[] = [
  'Succeeded',
  'Failed',
  'Cancelled',
];

export function isPipelineRunComplete(status: PipelineRunStatus): boolean {
  return TERMINAL_PIPELINE_RUN_STATUSES.includes(status);
}

/** ArgoCD sync status of an `Application`. */
export type ArgoSyncStatus = 'Synced' | 'OutOfSync' | 'Unknown';

/** ArgoCD health status of an `Application`. */
export type ArgoHealthStatus =
  'Healthy' | 'Progressing' | 'Degraded' | 'Suspended' | 'Missing' | 'Unknown';

/** Phase of the most recent ArgoCD sync operation. */
export type ArgoOperationPhase =
  'Running' | 'Succeeded' | 'Failed' | 'Error' | 'Terminating';

/** Commit metadata for a revision, resolved from ArgoCD. */
export interface ArgoRevisionInfo {
  revision: string;
  author?: string;
  date?: string;
  message?: string;
}

/** The most recent sync operation on an `Application`. */
export interface ArgoOperationState {
  phase: ArgoOperationPhase;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Revision the operation was syncing to. */
  revision?: string;
}

/**
 * The deployed state of one ArgoCD `Application`, flattened for the UI.
 */
export interface ArgoApplicationSummary {
  name: string;
  /** Name of the `argocd.appLocatorMethods[].instances` entry holding it. */
  instance: string;
  /** Destination namespace the Application deploys into. */
  namespace?: string;
  project?: string;
  syncStatus: ArgoSyncStatus;
  healthStatus: ArgoHealthStatus;
  /** Message explaining a non-Healthy health status. */
  healthMessage?: string;
  /** Revision currently running, i.e. `status.sync.revision`. */
  revision?: string;
  /** Revision ArgoCD is tracking, i.e. `spec.source.targetRevision`. */
  targetRevision?: string;
  /** Commit metadata for `revision`, when ArgoCD could resolve it. */
  revisionInfo?: ArgoRevisionInfo;
  repoUrl?: string;
  path?: string;
  /** When the running revision was deployed, from the newest history entry. */
  deployedAt?: string;
  operationState?: ArgoOperationState;
  /** Container images reported by `status.summary.images`. */
  images: string[];
  /** Deep link into the ArgoCD UI for this Application. */
  argoUrl?: string;
}

/** Everything the card needs to show the deployed state of an entity. */
export interface ArgoDeployedState {
  apps: ArgoApplicationSummary[];
  /** Set when the entity has no ArgoCD annotations; the UI shows this instead. */
  unconfiguredReason?: string;
}

/** A git ref the entity can be deployed at. */
export interface GitVersion {
  ref: string;
  type: 'tag' | 'branch';
  /** True when this is the revision ArgoCD is currently tracking. */
  current?: boolean;
}

export interface ListGitVersionsResponse {
  items: GitVersion[];
  /** Repository the refs came from. */
  repoUrl?: string;
  /** Set when the versions could not be listed, e.g. no repo to read. */
  unavailableReason?: string;
}

/**
 * Deploy request: a version picked from {@link ListGitVersionsResponse} plus
 * the entity. The backend turns this into a PipelineRun whose version
 * parameter carries `version`.
 */
export interface DeployRequest {
  entityRef: string;
  /** Git ref to deploy, as returned by the versions endpoint. */
  version: string;
  /** ArgoCD application to deploy, when the entity has more than one. */
  app?: string;
  /** Extra pipeline parameters, merged under the catalog's fixed params. */
  params?: Record<string, string | string[]>;
}

/** Terminal ArgoCD operation phases, i.e. the UI can stop polling. */
export const TERMINAL_ARGO_OPERATION_PHASES: ArgoOperationPhase[] = [
  'Succeeded',
  'Failed',
  'Error',
];

export function isArgoOperationComplete(phase: ArgoOperationPhase): boolean {
  return TERMINAL_ARGO_OPERATION_PHASES.includes(phase);
}

/** True while ArgoCD has not settled on the revision it is tracking. */
export function isArgoAppSettling(app: ArgoApplicationSummary): boolean {
  return (
    app.syncStatus === 'OutOfSync' ||
    app.healthStatus === 'Progressing' ||
    app.operationState?.phase === 'Running' ||
    app.operationState?.phase === 'Terminating'
  );
}
