import { createApiRef } from '@backstage/core-plugin-api';
import {
  ArgoDeployedState,
  DeployRequest,
  ListGitVersionsResponse,
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
  /** Deployed state of the entity's ArgoCD applications. */
  getArgoApplication(entityRef: string): Promise<ArgoDeployedState>;

  /**
   * Git versions the entity can be deployed at. `app` is required when the
   * entity resolves to more than one ArgoCD application.
   */
  listGitVersions(
    entityRef: string,
    app?: string,
  ): Promise<ListGitVersionsResponse>;

  /**
   * Runs the entity's pipeline with the picked version, which is what updates
   * the version ArgoCD has deployed.
   */
  deploy(request: DeployRequest): Promise<TriggerPipelineResponse>;

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
