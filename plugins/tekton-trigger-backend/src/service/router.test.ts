import express from 'express';
import request from 'supertest';
import {
  errorHandler,
  mockAuth,
  mockHttpAuth,
  mockLogger,
  mockPermissions,
  mockRootConfig,
  mockUserCredentials,
} from './testMocks';
import { catalogServiceMock } from '@backstage/plugin-catalog-node/testUtils';
import { Entity } from '@backstage/catalog-model';
import { createRouter } from './router';
import { TektonApiClient } from './TektonApiClient';
import { EventListenerClient } from './EventListenerClient';
import { ArgoApplicationService } from './ArgoApplicationService';
import { PipelineResource, PipelineRunResource } from './tektonTypes';
import { ArgoApplicationSummary } from '@cdops/plugin-tekton-trigger-common';
import { ArgoServiceApi } from '@roadiehq/backstage-plugin-argo-cd-node';

const pipeline: PipelineResource = {
  metadata: { name: 'build-and-deploy', namespace: 'cdops-ci' },
  spec: {
    params: [
      { name: 'git-url', type: 'string', description: 'Repository to build' },
      { name: 'git-revision', type: 'string', default: 'main' },
      { name: 'image-tag', type: 'string', default: 'latest' },
    ],
    workspaces: [{ name: 'source' }],
  },
};

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
      'tekton.dev/params': '{"git-url":"https://github.com/cdops/policy-api"}',
    },
  },
  spec: { type: 'service', lifecycle: 'production', owner: 'team-a' },
};

const argoEntity: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name: 'claims-api',
    namespace: 'default',
    annotations: {
      'tekton.dev/pipeline': 'build-and-deploy',
      'tekton.dev/namespace': 'cdops-ci',
      'tekton.dev/cluster': 'ocp-dev',
      'argocd/app-name': 'claims-api-prod',
      'argocd/instance-name': 'main',
      // git-url has no default on the pipeline, so it has to come from here.
      'tekton.dev/params': '{"git-url":"https://github.com/cdops/claims-api"}',
    },
  },
  spec: { type: 'service', lifecycle: 'production', owner: 'team-a' },
};

const argoApp: ArgoApplicationSummary = {
  name: 'claims-api-prod',
  instance: 'main',
  namespace: 'claims-prod',
  project: 'claims',
  syncStatus: 'Synced',
  healthStatus: 'Healthy',
  revision: 'abc1234',
  targetRevision: 'v1.2.0',
  repoUrl: 'https://github.com/cdops/claims-api',
  path: 'chart',
  deployedAt: '2026-10-27T09:00:00Z',
  images: ['quay.io/cdops/claims-api:v1.2.0'],
  argoUrl: 'https://argocd.example.com/applications/claims-api-prod',
};

const bareEntity: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name: 'no-pipeline', namespace: 'default' },
  spec: { type: 'service', lifecycle: 'production', owner: 'team-a' },
};

const eventListenerEntity: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name: 'claims-ui',
    namespace: 'default',
    annotations: {
      'tekton.dev/event-listener': 'cdops-el',
      'tekton.dev/namespace': 'cdops-ci',
    },
  },
  spec: { type: 'website', lifecycle: 'production', owner: 'team-a' },
};

// Carries both ArgoCD and Tekton annotations so the environment can be checked
// on the deploy route as well as the plain trigger route.
const envEntity: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name: 'policy-api-prod',
    namespace: 'default',
    annotations: {
      'tekton.dev/pipeline': 'build-and-deploy',
      'tekton.dev/namespace': 'cdops-ci',
      'tekton.dev/cluster': 'ocp-dev',
      'tekton.dev/environment': 'prod',
      'argocd/app-name': 'claims-api-prod',
      'argocd/instance-name': 'main',
      'tekton.dev/params': '{"git-url":"https://github.com/cdops/policy-api"}',
    },
  },
  spec: { type: 'service', lifecycle: 'production', owner: 'team-a' },
};

const config = mockRootConfig({
  tektonTrigger: {
    defaultCluster: 'ocp-dev',
    clusters: [
      {
        name: 'ocp-dev',
        url: 'https://api.ocp-dev.example.com:6443',
        serviceAccountToken: 'token',
        dashboardUrl: 'https://console.apps.ocp-dev.example.com',
        allowedNamespaces: ['cdops-ci'],
      },
    ],
    eventListeners: [
      {
        name: 'cdops-el',
        url: 'https://el-cdops.apps.ocp-dev.example.com',
        secret: 'shhh',
      },
    ],
    pipelineRun: { serviceAccountName: 'pipeline', timeout: '30m0s' },
  },
});

function pipelineRun(
  overrides: Partial<PipelineRunResource> = {},
): PipelineRunResource {
  return {
    metadata: {
      name: 'build-and-deploy-abc12',
      namespace: 'cdops-ci',
      labels: { 'tekton.dev/pipeline': 'build-and-deploy' },
      ...overrides.metadata,
    },
    spec: { pipelineRef: { name: 'build-and-deploy' }, ...overrides.spec },
    status: {
      conditions: [{ type: 'Succeeded', status: 'Unknown', reason: 'Running' }],
      startTime: '2026-10-27T10:00:00Z',
      ...overrides.status,
    },
  };
}

async function buildApp(
  options: {
    entities?: Entity[];
    allow?: boolean;
    client?: Partial<TektonApiClient>;
    eventListenerClient?: Partial<EventListenerClient>;
    argoService?: Partial<ArgoApplicationService>;
  } = {},
) {
  const client = {
    getPipeline: jest.fn().mockResolvedValue(pipeline),
    createPipelineRun: jest.fn().mockResolvedValue(pipelineRun()),
    getPipelineRun: jest.fn().mockResolvedValue(pipelineRun()),
    listPipelineRuns: jest.fn().mockResolvedValue([pipelineRun()]),
    listTaskRunsForPipelineRun: jest.fn().mockResolvedValue([]),
    cancelPipelineRun: jest.fn().mockResolvedValue(
      pipelineRun({
        status: {
          conditions: [
            {
              type: 'Succeeded',
              status: 'False',
              reason: 'Cancelled',
            },
          ],
          startTime: '2026-10-27T10:00:00Z',
          completionTime: '2026-10-27T10:01:00Z',
        },
      }),
    ),
    ...options.client,
  } as unknown as TektonApiClient;

  const eventListenerClient = {
    send: jest
      .fn()
      .mockResolvedValue({ name: 'cdops-el', status: 202, eventId: 'evt-1' }),
    ...options.eventListenerClient,
  } as unknown as EventListenerClient;

  const argoService = {
    getApplications: jest.fn().mockResolvedValue([argoApp]),
    listVersions: jest.fn().mockResolvedValue([
      { ref: 'v1.3.0', type: 'tag' },
      { ref: 'v1.2.0', type: 'tag', current: true },
      { ref: 'main', type: 'branch' },
    ]),
    assertVersionAllowed: jest.fn().mockResolvedValue(undefined),
    ...options.argoService,
  } as unknown as ArgoApplicationService;

  const permissions = mockPermissions(options.allow !== false);

  const router = await createRouter({
    logger: mockLogger(),
    config,
    auth: mockAuth(),
    httpAuth: mockHttpAuth(mockUserCredentials('user:default/jay')),
    permissions,
    catalog: catalogServiceMock({
      entities: options.entities ?? [
        entity,
        argoEntity,
        bareEntity,
        eventListenerEntity,
      ],
    }),
    clientFactory: () => client,
    eventListenerClient,
    // The Roadie service is only reached through argoService, which is stubbed.
    argocd: {} as ArgoServiceApi,
    argoService,
  });

  const app = express().use(router).use(errorHandler());

  return { app, client, eventListenerClient, argoService };
}

describe('tekton-trigger router', () => {
  const ref = 'component:default/policy-api';

  describe('GET /target', () => {
    it('describes the pipeline and marks catalog-pinned params as fixed', async () => {
      const { app } = await buildApp();

      const response = await request(app)
        .get('/target')
        .query({ entityRef: ref });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        mode: 'pipelineRun',
        cluster: 'ocp-dev',
        namespace: 'cdops-ci',
        pipeline: 'build-and-deploy',
        consoleUrl:
          'https://console.apps.ocp-dev.example.com/k8s/ns/cdops-ci/tekton.dev~v1~Pipeline/build-and-deploy',
      });
      expect(response.body.params).toEqual([
        expect.objectContaining({ name: 'git-url', fixed: true }),
        expect.objectContaining({
          name: 'git-revision',
          fixed: false,
          default: 'main',
        }),
        expect.objectContaining({ name: 'image-tag', fixed: false }),
      ]);
      expect(response.body.workspaces).toEqual([{ name: 'source' }]);
    });

    it('reports an unannotated entity instead of failing', async () => {
      const { app } = await buildApp();

      const response = await request(app)
        .get('/target')
        .query({ entityRef: 'component:default/no-pipeline' });

      expect(response.status).toBe(200);
      expect(response.body.unconfiguredReason).toMatch(/no tekton.dev/);
    });

    it('rejects an unknown entity', async () => {
      const { app } = await buildApp();

      const response = await request(app)
        .get('/target')
        .query({ entityRef: 'component:default/nope' });

      expect(response.status).toBe(404);
    });

    it('rejects a request without a valid entityRef', async () => {
      const { app } = await buildApp();

      expect((await request(app).get('/target')).status).toBe(400);
      expect(
        (await request(app).get('/target').query({ entityRef: 'nonsense' }))
          .status,
      ).toBe(400);
    });
  });

  describe('POST /pipelineruns', () => {
    it('creates a PipelineRun with merged params and provenance metadata', async () => {
      const { app, client } = await buildApp();

      const response = await request(app)
        .post('/pipelineruns')
        .send({ entityRef: ref, params: { 'git-revision': 'release-1.2' } });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        mode: 'pipelineRun',
        pipelineRun: {
          name: 'build-and-deploy-abc12',
          status: 'Running',
          consoleUrl:
            'https://console.apps.ocp-dev.example.com/k8s/ns/cdops-ci/tekton.dev~v1~PipelineRun/build-and-deploy-abc12/logs',
        },
      });

      expect(client.createPipelineRun).toHaveBeenCalledWith(
        'cdops-ci',
        expect.objectContaining({
          apiVersion: 'tekton.dev/v1',
          kind: 'PipelineRun',
          metadata: expect.objectContaining({
            generateName: 'build-and-deploy-',
            namespace: 'cdops-ci',
            labels: expect.objectContaining({
              'app.kubernetes.io/managed-by': 'backstage-tekton-trigger',
              'backstage.io/entity-kind': 'component',
              'backstage.io/entity-namespace': 'default',
              'backstage.io/entity-name': 'policy-api',
            }),
            annotations: expect.objectContaining({
              'backstage.io/entity-ref': ref,
              'backstage.io/triggered-by': 'user:default/jay',
            }),
          }),
        }),
      );

      const created = (client.createPipelineRun as jest.Mock).mock.calls[0][1];
      expect(created.spec.params).toEqual([
        { name: 'git-url', value: 'https://github.com/cdops/policy-api' },
        { name: 'git-revision', value: 'release-1.2' },
      ]);
      expect(created.spec.taskRunTemplate).toEqual({
        serviceAccountName: 'pipeline',
      });
      expect(created.spec.timeouts).toEqual({ pipeline: '30m0s' });
    });

    it('refuses to override a param pinned by the catalog', async () => {
      const { app, client } = await buildApp();

      const response = await request(app)
        .post('/pipelineruns')
        .send({
          entityRef: ref,
          params: { 'git-url': 'https://evil.example' },
        });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/fixed by the catalog/);
      expect(client.createPipelineRun).not.toHaveBeenCalled();
    });

    it('refuses params the pipeline does not declare', async () => {
      const { app, client } = await buildApp();

      const response = await request(app)
        .post('/pipelineruns')
        .send({ entityRef: ref, params: { 'extra-param': 'x' } });

      expect(response.status).toBe(400);
      expect(client.createPipelineRun).not.toHaveBeenCalled();
    });

    it('fires the EventListener when the entity uses Triggers', async () => {
      const { app, eventListenerClient, client } = await buildApp();

      const response = await request(app)
        .post('/pipelineruns')
        .send({ entityRef: 'component:default/claims-ui' });

      expect(response.status).toBe(202);
      expect(response.body).toEqual({
        mode: 'eventListener',
        eventListener: { name: 'cdops-el', status: 202, eventId: 'evt-1' },
      });
      expect(eventListenerClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'cdops-el' }),
        expect.objectContaining({
          entityRef: 'component:default/claims-ui',
          triggeredBy: 'user:default/jay',
        }),
      );
      expect(client.createPipelineRun).not.toHaveBeenCalled();
    });

    it('denies callers without the trigger permission', async () => {
      const { app, client } = await buildApp({ allow: false });

      const response = await request(app)
        .post('/pipelineruns')
        .send({ entityRef: ref });

      expect(response.status).toBe(403);
      expect(client.createPipelineRun).not.toHaveBeenCalled();
    });
  });

  describe('tekton.dev/environment', () => {
    const envRef = 'component:default/policy-api-prod';

    function clientWithEnvironmentParam() {
      return {
        getPipeline: jest.fn().mockResolvedValue({
          ...pipeline,
          spec: {
            ...pipeline.spec,
            params: [
              ...(pipeline.spec?.params ?? []),
              { name: 'environment', type: 'string' },
            ],
          },
        }),
      } as Partial<TektonApiClient>;
    }

    it('passes the annotated environment on the trigger route', async () => {
      const { app, client } = await buildApp({
        entities: [envEntity],
        client: clientWithEnvironmentParam(),
      });

      const response = await request(app)
        .post('/pipelineruns')
        .send({ entityRef: envRef });

      expect(response.status).toBe(201);
      const created = (client.createPipelineRun as jest.Mock).mock.calls[0][1];
      expect(created.spec.params).toEqual(
        expect.arrayContaining([{ name: 'environment', value: 'prod' }]),
      );
    });

    it('passes it on the deploy route as well', async () => {
      const { app, client } = await buildApp({
        entities: [envEntity],
        client: clientWithEnvironmentParam(),
      });

      const response = await request(app)
        .post('/deploy')
        .send({ entityRef: envRef, version: 'v1.3.0' });

      expect(response.status).toBe(201);
      const created = (client.createPipelineRun as jest.Mock).mock.calls[0][1];
      expect(created.spec.params).toEqual(
        expect.arrayContaining([
          { name: 'environment', value: 'prod' },
          { name: 'git-revision', value: 'v1.3.0' },
        ]),
      );
    });

    it('sends it in the EventListener payload', async () => {
      const elEntity: Entity = {
        ...eventListenerEntity,
        metadata: {
          ...eventListenerEntity.metadata,
          annotations: {
            ...eventListenerEntity.metadata.annotations,
            'tekton.dev/environment': 'prod',
          },
        },
      };
      const { app, eventListenerClient } = await buildApp({
        entities: [elEntity],
      });

      const response = await request(app)
        .post('/pipelineruns')
        .send({ entityRef: 'component:default/claims-ui' });

      expect(response.status).toBe(202);
      expect(eventListenerClient.send).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'cdops-el' }),
        expect.objectContaining({ params: { environment: 'prod' } }),
      );
    });

    it('rejects a pipeline that declares no environment param', async () => {
      const { app, client } = await buildApp({ entities: [envEntity] });

      const response = await request(app)
        .post('/pipelineruns')
        .send({ entityRef: envRef });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/environment/);
      expect(client.createPipelineRun).not.toHaveBeenCalled();
    });

    it('refuses to let a caller override it', async () => {
      const { app, client } = await buildApp({
        entities: [envEntity],
        client: clientWithEnvironmentParam(),
      });

      const response = await request(app)
        .post('/pipelineruns')
        .send({ entityRef: envRef, params: { environment: 'dev' } });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/fixed by the catalog/);
      expect(client.createPipelineRun).not.toHaveBeenCalled();
    });

    it('rejects an entity that sets the environment twice', async () => {
      const conflicting: Entity = {
        ...envEntity,
        metadata: {
          ...envEntity.metadata,
          annotations: {
            ...envEntity.metadata.annotations,
            'tekton.dev/params': '{"environment":"dev"}',
          },
        },
      };
      const { app, client } = await buildApp({
        entities: [conflicting],
        client: clientWithEnvironmentParam(),
      });

      const response = await request(app)
        .post('/pipelineruns')
        .send({ entityRef: envRef });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/set by both/);
      expect(client.createPipelineRun).not.toHaveBeenCalled();
    });

    it('honours a per-entity parameter name', async () => {
      const renamed: Entity = {
        ...envEntity,
        metadata: {
          ...envEntity.metadata,
          annotations: {
            ...envEntity.metadata.annotations,
            'tekton.dev/environment-param': 'target-env',
          },
        },
      };
      const { app, client } = await buildApp({
        entities: [renamed],
        client: {
          getPipeline: jest.fn().mockResolvedValue({
            ...pipeline,
            spec: {
              ...pipeline.spec,
              params: [
                ...(pipeline.spec?.params ?? []),
                { name: 'target-env', type: 'string' },
              ],
            },
          }),
        } as Partial<TektonApiClient>,
      });

      const response = await request(app)
        .post('/pipelineruns')
        .send({ entityRef: envRef });

      expect(response.status).toBe(201);
      const created = (client.createPipelineRun as jest.Mock).mock.calls[0][1];
      expect(created.spec.params).toEqual(
        expect.arrayContaining([{ name: 'target-env', value: 'prod' }]),
      );
    });

    it('leaves an entity without the annotation alone', async () => {
      // Declared with a default, so omitting it is valid and Tekton applies
      // the pipeline's own value.
      const { app, client } = await buildApp({
        client: {
          getPipeline: jest.fn().mockResolvedValue({
            ...pipeline,
            spec: {
              ...pipeline.spec,
              params: [
                ...(pipeline.spec?.params ?? []),
                { name: 'environment', type: 'string', default: 'dev' },
              ],
            },
          }),
        } as Partial<TektonApiClient>,
      });

      const response = await request(app)
        .post('/pipelineruns')
        .send({ entityRef: ref });

      expect(response.status).toBe(201);
      const created = (client.createPipelineRun as jest.Mock).mock.calls[0][1];
      expect(created.spec.params).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'environment' }),
        ]),
      );
    });
  });

  describe('GET /pipelineruns', () => {
    it('lists runs for the entity pipeline, newest first', async () => {
      const { app, client } = await buildApp({
        client: {
          listPipelineRuns: jest.fn().mockResolvedValue([
            pipelineRun({
              metadata: {
                name: 'older',
                namespace: 'cdops-ci',
                labels: { 'tekton.dev/pipeline': 'build-and-deploy' },
              },
              status: {
                conditions: [{ type: 'Succeeded', status: 'True' }],
                startTime: '2026-10-26T10:00:00Z',
                completionTime: '2026-10-26T10:05:00Z',
              },
            }),
            pipelineRun({
              metadata: { name: 'newer', namespace: 'cdops-ci' },
            }),
          ]),
        } as Partial<TektonApiClient>,
      });

      const response = await request(app)
        .get('/pipelineruns')
        .query({ entityRef: ref });

      expect(response.status).toBe(200);
      expect(response.body.items.map((r: any) => r.name)).toEqual([
        'newer',
        'older',
      ]);
      expect(response.body.items[1]).toMatchObject({
        status: 'Succeeded',
        durationMs: 300_000,
      });
      expect(client.listPipelineRuns).toHaveBeenCalledWith({
        namespace: 'cdops-ci',
        labelSelector: 'tekton.dev/pipeline=build-and-deploy',
      });
    });
  });

  describe('POST /pipelineruns/:name/cancel', () => {
    it('cancels a run belonging to the entity pipeline', async () => {
      const { app, client } = await buildApp();

      const response = await request(app)
        .post('/pipelineruns/build-and-deploy-abc12/cancel')
        .query({ entityRef: ref });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('Cancelled');
      expect(client.cancelPipelineRun).toHaveBeenCalledWith(
        'cdops-ci',
        'build-and-deploy-abc12',
      );
    });

    it('will not cancel a run from another pipeline in the namespace', async () => {
      const { app, client } = await buildApp({
        client: {
          getPipelineRun: jest.fn().mockResolvedValue(
            pipelineRun({
              metadata: {
                name: 'someone-elses-run',
                namespace: 'cdops-ci',
                labels: { 'tekton.dev/pipeline': 'other-pipeline' },
              },
            }),
          ),
        } as Partial<TektonApiClient>,
      });

      const response = await request(app)
        .post('/pipelineruns/someone-elses-run/cancel')
        .query({ entityRef: ref });

      expect(response.status).toBe(404);
      expect(client.cancelPipelineRun).not.toHaveBeenCalled();
    });
  });

  describe('GET /argocd/application', () => {
    const argoRef = 'component:default/claims-api';

    it("returns the deployed state of the entity's application", async () => {
      const { app } = await buildApp();

      const response = await request(app)
        .get('/argocd/application')
        .query({ entityRef: argoRef });

      expect(response.status).toBe(200);
      expect(response.body.apps).toHaveLength(1);
      expect(response.body.apps[0]).toMatchObject({
        name: 'claims-api-prod',
        syncStatus: 'Synced',
        healthStatus: 'Healthy',
        targetRevision: 'v1.2.0',
      });
      expect(response.body.unconfiguredReason).toBeUndefined();
    });

    it('explains itself instead of failing when the entity has no argocd annotations', async () => {
      const { app, argoService } = await buildApp();

      const response = await request(app)
        .get('/argocd/application')
        .query({ entityRef: 'component:default/no-pipeline' });

      expect(response.status).toBe(200);
      expect(response.body.apps).toEqual([]);
      expect(response.body.unconfiguredReason).toMatch(/argocd\/app-name/);
      expect(argoService.getApplications).not.toHaveBeenCalled();
    });

    it('reports when nothing matched rather than pretending it is unconfigured', async () => {
      const { app } = await buildApp({
        argoService: { getApplications: jest.fn().mockResolvedValue([]) },
      });

      const response = await request(app)
        .get('/argocd/application')
        .query({ entityRef: argoRef });

      expect(response.status).toBe(200);
      expect(response.body.unconfiguredReason).toContain('claims-api-prod');
    });
  });

  describe('GET /argocd/versions', () => {
    const argoRef = 'component:default/claims-api';

    it('lists the git versions, marking the tracked one', async () => {
      const { app } = await buildApp();

      const response = await request(app)
        .get('/argocd/versions')
        .query({ entityRef: argoRef });

      expect(response.status).toBe(200);
      expect(response.body.repoUrl).toBe('https://github.com/cdops/claims-api');
      expect(response.body.items).toEqual([
        { ref: 'v1.3.0', type: 'tag' },
        { ref: 'v1.2.0', type: 'tag', current: true },
        { ref: 'main', type: 'branch' },
      ]);
    });

    it('requires an app when the entity resolves to several', async () => {
      const { app } = await buildApp({
        argoService: {
          getApplications: jest
            .fn()
            .mockResolvedValue([
              argoApp,
              { ...argoApp, name: 'claims-api-staging' },
            ]),
        },
      });

      const response = await request(app)
        .get('/argocd/versions')
        .query({ entityRef: argoRef });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/claims-api-staging/);
    });

    it('rejects an app the entity does not own', async () => {
      const { app } = await buildApp();

      const response = await request(app)
        .get('/argocd/versions')
        .query({ entityRef: argoRef, app: 'someone-elses-app' });

      expect(response.status).toBe(404);
    });
  });

  describe('POST /deploy', () => {
    const argoRef = 'component:default/claims-api';

    it('runs the pipeline with the picked version in the version param', async () => {
      const { app, client, argoService } = await buildApp();

      const response = await request(app)
        .post('/deploy')
        .send({ entityRef: argoRef, version: 'v1.3.0' });

      expect(response.status).toBe(201);
      expect(argoService.assertVersionAllowed).toHaveBeenCalledWith(
        expect.objectContaining({ appName: 'claims-api-prod' }),
        expect.objectContaining({ name: 'claims-api-prod' }),
        'v1.3.0',
      );

      const created = (client.createPipelineRun as jest.Mock).mock.calls[0][1];
      expect(created.spec.params).toEqual(
        expect.arrayContaining([{ name: 'git-revision', value: 'v1.3.0' }]),
      );
      // argocd-app is not declared by this pipeline, so it is not passed.
      expect(created.spec.params).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'argocd-app' }),
        ]),
      );
    });

    it('passes the application name when the pipeline declares the param', async () => {
      const { app, client } = await buildApp({
        client: {
          getPipeline: jest.fn().mockResolvedValue({
            ...pipeline,
            spec: {
              ...pipeline.spec,
              params: [
                ...(pipeline.spec?.params ?? []),
                { name: 'argocd-app', type: 'string' },
              ],
            },
          }),
        } as Partial<TektonApiClient>,
      });

      const response = await request(app)
        .post('/deploy')
        .send({ entityRef: argoRef, version: 'v1.3.0' });

      expect(response.status).toBe(201);
      const created = (client.createPipelineRun as jest.Mock).mock.calls[0][1];
      expect(created.spec.params).toEqual(
        expect.arrayContaining([
          { name: 'argocd-app', value: 'claims-api-prod' },
        ]),
      );
    });

    it('re-checks the version against argocd rather than trusting the client', async () => {
      const { app, client } = await buildApp({
        argoService: {
          assertVersionAllowed: jest.fn().mockRejectedValue(
            Object.assign(new Error('Version not known'), {
              name: 'NotFoundError',
            }),
          ),
        },
      });

      const response = await request(app)
        .post('/deploy')
        .send({ entityRef: argoRef, version: 'v9.9.9-made-up' });

      expect(response.status).toBe(404);
      expect(client.createPipelineRun).not.toHaveBeenCalled();
    });

    it('rejects a pipeline that declares no version param', async () => {
      const { app, client } = await buildApp({
        client: {
          getPipeline: jest.fn().mockResolvedValue({
            ...pipeline,
            spec: {
              ...pipeline.spec,
              params: [{ name: 'git-url', type: 'string' }],
            },
          }),
        } as Partial<TektonApiClient>,
      });

      const response = await request(app)
        .post('/deploy')
        .send({ entityRef: argoRef, version: 'v1.3.0' });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/git-revision/);
      expect(client.createPipelineRun).not.toHaveBeenCalled();
    });

    it('requires a version', async () => {
      const { app } = await buildApp();

      const response = await request(app)
        .post('/deploy')
        .send({ entityRef: argoRef });

      expect(response.status).toBe(400);
    });

    it('refuses to deploy an entity with no argocd annotations', async () => {
      const { app, client } = await buildApp();

      const response = await request(app)
        .post('/deploy')
        .send({ entityRef: 'component:default/policy-api', version: 'v1.3.0' });

      expect(response.status).toBe(400);
      expect(client.createPipelineRun).not.toHaveBeenCalled();
    });
  });
});
