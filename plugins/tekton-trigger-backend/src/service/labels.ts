/** Labels and annotations this plugin stamps on the PipelineRuns it creates. */

/** Lower-cased entity kind, e.g. `component`. */
export const ENTITY_KIND_LABEL = 'backstage.io/entity-kind';
/** Entity namespace, e.g. `default`. */
export const ENTITY_NAMESPACE_LABEL = 'backstage.io/entity-namespace';
/** Entity name. Entity names are valid Kubernetes label values; entity refs are not. */
export const ENTITY_NAME_LABEL = 'backstage.io/entity-name';
export const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
export const MANAGED_BY_VALUE = 'backstage-tekton-trigger';

/** Full entity ref, which contains characters labels do not allow. */
export const ENTITY_REF_ANNOTATION = 'backstage.io/entity-ref';
/** Entity ref of the user who pressed the button. */
export const TRIGGERED_BY_ANNOTATION = 'backstage.io/triggered-by';

/** Label Tekton itself sets from `spec.pipelineRef.name`. */
export const TEKTON_PIPELINE_LABEL = 'tekton.dev/pipeline';
