import { createPermission } from '@backstage/plugin-permission-common';

/** Allows reading pipelines and PipelineRuns for an entity. */
export const tektonPipelineReadPermission = createPermission({
  name: 'tekton.pipeline.read',
  attributes: { action: 'read' },
});

/** Allows creating a PipelineRun (or firing an EventListener) for an entity. */
export const tektonPipelineTriggerPermission = createPermission({
  name: 'tekton.pipeline.trigger',
  attributes: { action: 'create' },
});

/** Allows cancelling an in-flight PipelineRun. */
export const tektonPipelineCancelPermission = createPermission({
  name: 'tekton.pipeline.cancel',
  attributes: { action: 'update' },
});

/** Allows reading the deployed state of an entity's ArgoCD applications. */
export const argocdApplicationReadPermission = createPermission({
  name: 'argocd.application.read',
  attributes: { action: 'read' },
});

export const tektonTriggerPermissions = [
  tektonPipelineReadPermission,
  tektonPipelineTriggerPermission,
  tektonPipelineCancelPermission,
  argocdApplicationReadPermission,
];
