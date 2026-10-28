/**
 * Triggers OpenShift Pipelines (Tekton) for catalog entities.
 *
 * @packageDocumentation
 */
export { tektonTriggerPlugin as default } from './plugin';
export { tektonTriggerPlugin } from './plugin';
export { createRouter } from './service/router';
export type { RouterOptions } from './service/router';
export { TektonApiClient } from './service/TektonApiClient';
export { EventListenerClient } from './service/EventListenerClient';
export { readTektonTriggerConfig } from './service/config';
export type {
  ClusterConfig,
  EventListenerConfig,
  TektonTriggerConfig,
} from './service/config';
