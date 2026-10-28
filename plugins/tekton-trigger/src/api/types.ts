import { createApiRef } from '@backstage/core-plugin-api';
import {
  PipelineRunSummary,
  TektonTarget,
  TriggerPipelineRequest,
  TriggerPipelineResponse,
} from '@cdops/plugin-tekton-trigger-common';

/**
 * Talks to the `tekton-trigger` backend. The backend resolves the entity's
 * annotations itself, so every call is scoped by entity ref rather than by
 * cluster, namespace and pipeline.
 *
 * @public
 */
export interface TektonTriggerApi {
  /** What this entity can run, including the pipeline's declared parameters. */
  getTarget(entityRef: string): Promise<TektonTarget>;

  listPipelineRuns(entityRef: string): Promise<PipelineRunSummary[]>;

  getPipelineRun(entityRef: string, name: string): Promise<PipelineRunSummary>;

  triggerPipeline(
    request: TriggerPipelineRequest,
  ): Promise<TriggerPipelineResponse>;

  cancelPipelineRun(
    entityRef: string,
    name: string,
  ): Promise<PipelineRunSummary>;
}

/** @public */
export const tektonTriggerApiRef = createApiRef<TektonTriggerApi>({
  id: 'plugin.tekton-trigger.service',
});
