/**
 * Reports the deployed state of a catalog entity's ArgoCD applications and
 * triggers the OpenShift Pipeline (Tekton) that changes the deployed version.
 *
 * @packageDocumentation
 */
export { tektonTriggerPlugin as default } from './plugin';
export { tektonTriggerPlugin } from './plugin';
export { createRouter } from './service/router';
export type { RouterOptions } from './service/router';
export { TektonApiClient } from './service/TektonApiClient';
export { EventListenerClient } from './service/EventListenerClient';
export { ArgoApplicationService } from './service/ArgoApplicationService';
export {
  isArgoEntity,
  resolveArgoTarget,
  argoUnconfiguredReason,
} from './service/argoTarget';
export type { ArgoTarget } from './service/argoTarget';
export { readTektonTriggerConfig } from './service/config';
export type {
  ClusterConfig,
  DeployConfig,
  EventListenerConfig,
  TektonTriggerConfig,
} from './service/config';
