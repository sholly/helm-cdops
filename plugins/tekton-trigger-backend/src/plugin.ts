import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { argocdServiceRef } from '@roadiehq/backstage-plugin-argo-cd-node';
import { tektonTriggerPermissions } from '@cdops/plugin-tekton-trigger-common';
import { createRouter } from './service/router';

/**
 * Backend plugin that reports the deployed state of a catalog entity's ArgoCD
 * applications and triggers the OpenShift Pipeline (Tekton) that changes the
 * version ArgoCD deploys.
 *
 * ArgoCD access comes from `argocdServiceRef`, whose default factory reads the
 * same `argocd.appLocatorMethods` config as the Roadie ArgoCD plugins.
 *
 * @public
 */
export const tektonTriggerPlugin = createBackendPlugin({
  pluginId: 'tekton-trigger',
  register(env) {
    env.registerInit({
      deps: {
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        auth: coreServices.auth,
        httpAuth: coreServices.httpAuth,
        httpRouter: coreServices.httpRouter,
        permissions: coreServices.permissions,
        permissionsRegistry: coreServices.permissionsRegistry,
        catalog: catalogServiceRef,
        argocd: argocdServiceRef,
      },
      async init({
        logger,
        config,
        auth,
        httpAuth,
        httpRouter,
        permissions,
        permissionsRegistry,
        catalog,
        argocd,
      }) {
        // Makes the permissions discoverable by the RBAC UI.
        permissionsRegistry.addPermissions(tektonTriggerPermissions);

        httpRouter.use(
          await createRouter({
            logger,
            config,
            auth,
            httpAuth,
            permissions,
            catalog,
            argocd,
          }),
        );
      },
    });
  },
});
