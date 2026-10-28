import {
  PipelineRunStatus,
  PipelineRunSummary,
  PipelineRunTaskSummary,
  TektonParamSpec,
  TektonWorkspaceSpec,
} from '@cdops/plugin-tekton-trigger-common';
import { ClusterConfig } from './config';
import {
  ENTITY_REF_ANNOTATION,
  TEKTON_PIPELINE_LABEL,
  TRIGGERED_BY_ANNOTATION,
} from './labels';
import {
  PipelineResource,
  PipelineRunResource,
  TaskRunResource,
  TektonCondition,
} from './tektonTypes';

/** Deep link to a Pipeline in the OpenShift console or the Tekton dashboard. */
export function pipelineUrl(
  cluster: ClusterConfig | undefined,
  namespace: string | undefined,
  name: string | undefined,
): string | undefined {
  if (!cluster?.dashboardUrl || !namespace || !name) {
    return undefined;
  }
  return cluster.dashboardType === 'tekton'
    ? `${cluster.dashboardUrl}/#/namespaces/${namespace}/pipelines/${name}`
    : `${cluster.dashboardUrl}/k8s/ns/${namespace}/tekton.dev~v1~Pipeline/${name}`;
}

/** Deep link to a PipelineRun, which is where users go to read logs. */
export function pipelineRunUrl(
  cluster: ClusterConfig | undefined,
  namespace: string | undefined,
  name: string | undefined,
): string | undefined {
  if (!cluster?.dashboardUrl || !namespace || !name) {
    return undefined;
  }
  return cluster.dashboardType === 'tekton'
    ? `${cluster.dashboardUrl}/#/namespaces/${namespace}/pipelineruns/${name}`
    : `${cluster.dashboardUrl}/k8s/ns/${namespace}/tekton.dev~v1~PipelineRun/${name}/logs`;
}

function succeededCondition(
  conditions: TektonCondition[] | undefined,
): TektonCondition | undefined {
  return conditions?.find(c => c.type === 'Succeeded');
}

/**
 * Collapses Tekton's `Succeeded` condition into a single status.
 *
 * Tekton reports completion through `status=True|False` and progress through
 * `status=Unknown` with a reason such as `Running` or `Started`.
 */
export function toStatus(
  conditions: TektonCondition[] | undefined,
): PipelineRunStatus {
  const condition = succeededCondition(conditions);
  if (!condition) {
    return conditions?.length ? 'Unknown' : 'Pending';
  }

  const reason = condition.reason ?? '';

  switch (condition.status) {
    case 'True':
      return 'Succeeded';
    case 'False':
      return reason.toLowerCase().includes('cancel') ? 'Cancelled' : 'Failed';
    default:
      if (reason === 'Started' || reason === 'PipelineRunPending') {
        return 'Pending';
      }
      if (reason.toLowerCase().includes('cancel')) {
        return 'Cancelled';
      }
      return 'Running';
  }
}

function durationMs(
  startedAt?: string,
  completedAt?: string,
): number | undefined {
  if (!startedAt) {
    return undefined;
  }
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return undefined;
  }
  return Math.max(0, end - start);
}

export function toTaskSummary(
  taskRun: TaskRunResource,
): PipelineRunTaskSummary {
  const condition = succeededCondition(taskRun.status?.conditions);
  return {
    name:
      taskRun.metadata.labels?.['tekton.dev/pipelineTask'] ??
      taskRun.metadata.name ??
      'unknown',
    status: toStatus(taskRun.status?.conditions),
    reason: condition?.reason,
    startedAt: taskRun.status?.startTime,
    completedAt: taskRun.status?.completionTime,
  };
}

export function toPipelineRunSummary(
  resource: PipelineRunResource,
  cluster: ClusterConfig | undefined,
  taskRuns?: TaskRunResource[],
): PipelineRunSummary {
  const namespace = resource.metadata.namespace ?? '';
  const name = resource.metadata.name ?? '';
  const condition = succeededCondition(resource.status?.conditions);
  const startedAt =
    resource.status?.startTime ?? resource.metadata.creationTimestamp;
  const completedAt = resource.status?.completionTime;

  return {
    name,
    namespace,
    cluster: cluster?.name ?? '',
    pipeline:
      resource.spec.pipelineRef?.name ??
      resource.metadata.labels?.[TEKTON_PIPELINE_LABEL],
    status: toStatus(resource.status?.conditions),
    reason: condition?.reason,
    message: condition?.message,
    startedAt,
    completedAt,
    durationMs: durationMs(startedAt, completedAt),
    triggeredBy:
      resource.metadata.annotations?.[TRIGGERED_BY_ANNOTATION] ??
      resource.metadata.annotations?.[ENTITY_REF_ANNOTATION],
    params: (resource.spec.params ?? []).map(param => ({
      name: param.name,
      value: Array.isArray(param.value)
        ? param.value
        : String(
            typeof param.value === 'object'
              ? JSON.stringify(param.value)
              : param.value,
          ),
    })),
    tasks: (taskRuns ?? [])
      .map(toTaskSummary)
      .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '')),
    consoleUrl: pipelineRunUrl(cluster, namespace, name),
  };
}

/** Newest first, so the UI can show the latest run without extra work. */
export function byNewestFirst(
  a: PipelineRunSummary,
  b: PipelineRunSummary,
): number {
  return (b.startedAt ?? '').localeCompare(a.startedAt ?? '');
}

export function toParamSpecs(
  pipeline: PipelineResource,
  fixedParams: Record<string, unknown> = {},
): TektonParamSpec[] {
  return (pipeline.spec?.params ?? []).map(param => ({
    name: param.name,
    type: param.type ?? 'string',
    description: param.description,
    default: param.default as TektonParamSpec['default'],
    fixed: Object.prototype.hasOwnProperty.call(fixedParams, param.name),
  }));
}

export function toWorkspaceSpecs(
  pipeline: PipelineResource,
): TektonWorkspaceSpec[] {
  return (pipeline.spec?.workspaces ?? []).map(workspace => ({
    name: workspace.name,
    description: workspace.description,
    optional: workspace.optional,
  }));
}
