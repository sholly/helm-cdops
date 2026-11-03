import { Entity, stringifyEntityRef } from '@backstage/catalog-model';
import {
  ARGOCD_APP_NAME_ANNOTATION,
  ARGOCD_APP_SELECTOR_ANNOTATION,
  ARGOCD_INSTANCE_NAME_ANNOTATION,
  ARGOCD_PROJECT_NAME_ANNOTATION,
} from '@cdops/plugin-tekton-trigger-common';

/** How to find an entity's ArgoCD `Application`s. */
export interface ArgoTarget {
  entityRef: string;
  /** Exactly one of `appName` or `appSelector` is set. */
  appName?: string;
  appSelector?: string;
  /** Restricts the lookup to one configured instance. */
  instanceName?: string;
  /** Needed when the Application's repository is project-scoped. */
  project?: string;
}

/** True when the entity carries enough annotations to locate an Application. */
export function isArgoEntity(entity: Entity): boolean {
  const annotations = entity.metadata.annotations ?? {};
  return Boolean(
    annotations[ARGOCD_APP_NAME_ANNOTATION] ||
    annotations[ARGOCD_APP_SELECTOR_ANNOTATION],
  );
}

/** Reason the ArgoCD card has nothing to show, or undefined when it does. */
export function argoUnconfiguredReason(entity: Entity): string | undefined {
  return isArgoEntity(entity)
    ? undefined
    : `This entity has no ${ARGOCD_APP_NAME_ANNOTATION} or ${ARGOCD_APP_SELECTOR_ANNOTATION} annotation.`;
}

/**
 * Resolves an entity's ArgoCD annotations. Like the Tekton target, this is the
 * only way a request names an Application, so a caller can never read or
 * deploy an Application the catalog does not associate with the entity.
 */
export function resolveArgoTarget(entity: Entity): ArgoTarget {
  const annotations = entity.metadata.annotations ?? {};
  const appName = annotations[ARGOCD_APP_NAME_ANNOTATION];
  const appSelector = annotations[ARGOCD_APP_SELECTOR_ANNOTATION];

  return {
    entityRef: stringifyEntityRef(entity),
    // app-name wins when both are set: it is the more specific of the two.
    appName,
    appSelector: appName ? undefined : appSelector,
    instanceName: annotations[ARGOCD_INSTANCE_NAME_ANNOTATION],
    project: annotations[ARGOCD_PROJECT_NAME_ANNOTATION],
  };
}
