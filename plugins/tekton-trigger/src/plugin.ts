import {
  createApiFactory,
  createComponentExtension,
  createPlugin,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import { Entity } from '@backstage/catalog-model';
import {
  ARGOCD_APP_NAME_ANNOTATION,
  ARGOCD_APP_SELECTOR_ANNOTATION,
  TEKTON_EVENT_LISTENER_ANNOTATION,
  TEKTON_PIPELINE_ANNOTATION,
} from '@cdops/plugin-tekton-trigger-common';
import { tektonTriggerApiRef, TektonTriggerClient } from './api';

/** @public */
export const tektonTriggerPlugin = createPlugin({
  id: 'tekton-trigger',
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
 * Card showing the deployed state of the entity's ArgoCD application, with a
 * version dropdown and a button that runs the pipeline to deploy it.
 *
 * @public
 */
export const EntityArgoCdDeployCard = tektonTriggerPlugin.provide(
  createComponentExtension({
    name: 'EntityArgoCdDeployCard',
    component: {
      lazy: () =>
        import('./components/ArgoCdDeployCard').then(m => m.ArgoCdDeployCard),
    },
  }),
);

/**
 * Whether the entity has an ArgoCD application for the card to show, for
 * `EntitySwitch` and the `if` prop on entity cards.
 *
 * @public
 */
export const isArgoCdDeployAvailable = (entity: Entity): boolean =>
  Boolean(
    entity.metadata.annotations?.[ARGOCD_APP_NAME_ANNOTATION] ||
    entity.metadata.annotations?.[ARGOCD_APP_SELECTOR_ANNOTATION],
  );

/**
 * Whether the entity can run a pipeline, i.e. whether the card's deploy button
 * has anything to trigger.
 *
 * @public
 */
export const isTektonTriggerAvailable = (entity: Entity): boolean =>
  Boolean(
    entity.metadata.annotations?.[TEKTON_PIPELINE_ANNOTATION] ||
    entity.metadata.annotations?.[TEKTON_EVENT_LISTENER_ANNOTATION],
  );
