/**
 * Catalog annotations read by the Tekton trigger plugin.
 *
 * The backend resolves every trigger request against the catalog entity rather
 * than trusting the client, so these annotations are the only way to say which
 * pipeline an entity is allowed to run.
 */

/** Name of the Tekton `Pipeline` to run, e.g. `build-and-deploy`. */
export const TEKTON_PIPELINE_ANNOTATION = 'tekton.dev/pipeline';

/** Namespace holding the pipeline. Falls back to `backstage.io/kubernetes-namespace`. */
export const TEKTON_NAMESPACE_ANNOTATION = 'tekton.dev/namespace';

/** Name of a cluster from `tektonTrigger.clusters`. Falls back to the configured default. */
export const TEKTON_CLUSTER_ANNOTATION = 'tekton.dev/cluster';

/** Name of an entry in `tektonTrigger.eventListeners`. When set, trigger goes through Tekton Triggers. */
export const TEKTON_EVENT_LISTENER_ANNOTATION = 'tekton.dev/event-listener';

/** `ServiceAccount` the PipelineRun's TaskRuns execute as. */
export const TEKTON_SERVICE_ACCOUNT_ANNOTATION = 'tekton.dev/service-account';

/**
 * JSON object of parameter values that are fixed by the catalog and cannot be
 * overridden by the caller, e.g. `{"git-url":"https://github.com/org/repo"}`.
 */
export const TEKTON_PARAMS_ANNOTATION = 'tekton.dev/params';

/**
 * JSON array of Tekton workspace bindings, passed through to `spec.workspaces`
 * verbatim, e.g. `[{"name":"source","volumeClaimTemplate":{...}}]`.
 */
export const TEKTON_WORKSPACES_ANNOTATION = 'tekton.dev/workspaces';

/** Kubernetes namespace annotation used by the core Kubernetes plugin. */
export const KUBERNETES_NAMESPACE_ANNOTATION =
  'backstage.io/kubernetes-namespace';
