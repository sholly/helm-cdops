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
