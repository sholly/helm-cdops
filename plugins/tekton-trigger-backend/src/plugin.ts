import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { tektonTriggerPermissions } from '@cdops/plugin-tekton-trigger-common';
import { createRouter } from './service/router';

/**
 * Backend plugin that triggers OpenShift Pipelines (Tekton) for catalog
 * entities.
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
          }),
        );
      },
    });
  },
});
