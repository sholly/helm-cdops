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

/**
 * ArgoCD annotations. These follow the convention established by the Roadie
 * ArgoCD plugins, whose service this plugin uses to reach ArgoCD, so an entity
 * already annotated for those plugins needs no extra annotations here.
 */

/** Name of the ArgoCD `Application`, e.g. `policy-api-prod`. */
export const ARGOCD_APP_NAME_ANNOTATION = 'argocd/app-name';

/**
 * Label selector matching several ArgoCD `Application`s, e.g.
 * `app.kubernetes.io/instance=policy-api`. Used when one component is deployed
 * as more than one Application (per environment, say).
 */
export const ARGOCD_APP_SELECTOR_ANNOTATION = 'argocd/app-selector';

/** Name of an entry in `argocd.appLocatorMethods[].instances`. */
export const ARGOCD_INSTANCE_NAME_ANNOTATION = 'argocd/instance-name';

/** ArgoCD project, required when the Application's repository is project-scoped. */
export const ARGOCD_PROJECT_NAME_ANNOTATION = 'argocd/project-name';

/**
 * Name of the Tekton pipeline parameter that carries the git version being
 * deployed. Defaults to `tektonTrigger.deploy.versionParam`.
 */
export const TEKTON_VERSION_PARAM_ANNOTATION = 'tekton.dev/version-param';

/**
 * Name of the Tekton pipeline parameter that carries the ArgoCD application
 * name. Defaults to `tektonTrigger.deploy.appParam`. Only set when the
 * pipeline declares it.
 */
export const TEKTON_APP_PARAM_ANNOTATION = 'tekton.dev/app-param';
