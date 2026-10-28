import { createDevApp } from '@backstage/dev-utils';
import { EntityProvider } from '@backstage/plugin-catalog-react';
import { Entity } from '@backstage/catalog-model';
import { Content, Header, Page } from '@backstage/core-components';
import { tektonTriggerPlugin, TektonTriggerContent } from '../src';

const entity: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name: 'policy-api',
    namespace: 'default',
    annotations: {
      'tekton.dev/pipeline': 'build-and-deploy',
      'tekton.dev/namespace': 'cdops-ci',
      'tekton.dev/cluster': 'ocp-dev',
    },
  },
  spec: { type: 'service', lifecycle: 'production', owner: 'team-a' },
};

createDevApp()
  .registerPlugin(tektonTriggerPlugin)
  .addPage({
    title: 'Tekton trigger',
    path: '/tekton-trigger',
    element: (
      <EntityProvider entity={entity}>
        <Page themeId="service">
          <Header title="policy-api" />
          <Content>
            <TektonTriggerContent />
          </Content>
        </Page>
      </EntityProvider>
    ),
  })
  .render();
