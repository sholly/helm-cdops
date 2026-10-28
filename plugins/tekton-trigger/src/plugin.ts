import {
  createApiFactory,
  createComponentExtension,
  createPlugin,
  createRoutableExtension,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import { Entity } from '@backstage/catalog-model';
import {
  TEKTON_EVENT_LISTENER_ANNOTATION,
  TEKTON_PIPELINE_ANNOTATION,
} from '@cdops/plugin-tekton-trigger-common';
import { tektonTriggerApiRef, TektonTriggerClient } from './api';
import { rootRouteRef } from './routes';

/** @public */
export const tektonTriggerPlugin = createPlugin({
  id: 'tekton-trigger',
  routes: {
    root: rootRouteRef,
  },
  apis: [
    createApiFactory({
      api: tektonTriggerApiRef,
      deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef },
      factory: ({ discoveryApi, fetchApi }) =>
        new TektonTriggerClient({ discoveryApi, fetchApi }),
    }),
  ],
});

/**
 * Entity tab with pipeline details, the trigger button and run history.
 *
 * @public
 */
export const EntityTektonTriggerContent = tektonTriggerPlugin.provide(
  createRoutableExtension({
    name: 'EntityTektonTriggerContent',
    mountPoint: rootRouteRef,
    component: () =>
      import('./components/TektonTriggerContent').then(
        m => m.TektonTriggerContent,
      ),
  }),
);

/**
 * Compact card for the entity overview tab.
 *
 * @public
 */
export const EntityTektonTriggerCard = tektonTriggerPlugin.provide(
  createComponentExtension({
    name: 'EntityTektonTriggerCard',
    component: {
      lazy: () =>
        import('./components/TektonTriggerCard').then(m => m.TektonTriggerCard),
    },
  }),
);

/**
 * Whether the entity is wired up for this plugin, for `EntitySwitch` and the
 * `if` prop on entity tabs.
 *
 * @public
 */
export const isTektonTriggerAvailable = (entity: Entity): boolean =>
  Boolean(
    entity.metadata.annotations?.[TEKTON_PIPELINE_ANNOTATION] ||
    entity.metadata.annotations?.[TEKTON_EVENT_LISTENER_ANNOTATION],
  );
