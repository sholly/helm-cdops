import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Entity } from '@backstage/catalog-model';
import { EntityProvider } from '@backstage/plugin-catalog-react';
import { AlertApi, alertApiRef } from '@backstage/core-plugin-api';
import { permissionApiRef } from '@backstage/plugin-permission-react';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import {
  mockApis,
  renderInTestApp,
  TestApiProvider,
} from '@backstage/test-utils';
import {
  PipelineRunSummary,
  TektonTarget,
} from '@cdops/plugin-tekton-trigger-common';
import { tektonTriggerApiRef, TektonTriggerApi } from '../../api';
import { TektonTriggerContent } from './TektonTriggerContent';

const entity: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name: 'policy-api',
    namespace: 'default',
    annotations: {
      'tekton.dev/pipeline': 'build-and-deploy',
      'tekton.dev/namespace': 'cdops-ci',
    },
  },
  spec: { type: 'service', lifecycle: 'production', owner: 'team-a' },
};

const target: TektonTarget = {
  mode: 'pipelineRun',
  cluster: 'ocp-dev',
  namespace: 'cdops-ci',
  pipeline: 'build-and-deploy',
  consoleUrl: 'https://console.example.com/pipeline',
  params: [
    { name: 'git-url', type: 'string', fixed: true },
    { name: 'git-revision', type: 'string', default: 'main', fixed: false },
  ],
  workspaces: [{ name: 'source' }],
};

const run: PipelineRunSummary = {
  name: 'build-and-deploy-abc12',
  namespace: 'cdops-ci',
  cluster: 'ocp-dev',
  pipeline: 'build-and-deploy',
  status: 'Succeeded',
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  durationMs: 42_000,
  triggeredBy: 'user:default/jay',
  params: [],
  tasks: [],
  consoleUrl: 'https://console.example.com/run',
};

function mockTektonApi(overrides: Partial<TektonTriggerApi> = {}) {
  return {
    getTarget: jest.fn().mockResolvedValue(target),
    listPipelineRuns: jest.fn().mockResolvedValue([run]),
    getPipelineRun: jest.fn().mockResolvedValue(run),
    triggerPipeline: jest.fn().mockResolvedValue({
      mode: 'pipelineRun',
      pipelineRun: run,
    }),
    cancelPipelineRun: jest.fn().mockResolvedValue(run),
    ...overrides,
  } as jest.Mocked<TektonTriggerApi>;
}

/** The components only post alerts; nothing subscribes in these tests. */
const alertApi = {
  post: jest.fn(),
  alert$: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }),
} as unknown as AlertApi;

async function render(api: jest.Mocked<TektonTriggerApi>) {
  await renderInTestApp(
    <TestApiProvider
      apis={[
        [tektonTriggerApiRef, api],
        [alertApiRef, alertApi],
        [
          permissionApiRef,
          mockApis.permission({ authorize: AuthorizeResult.ALLOW }),
        ],
      ]}
    >
      <EntityProvider entity={entity}>
        <TektonTriggerContent />
      </EntityProvider>
    </TestApiProvider>,
  );
}

describe('TektonTriggerContent', () => {
  it('shows the pipeline and its runs', async () => {
    await render(mockTektonApi());

    expect(await screen.findByText('build-and-deploy')).toBeInTheDocument();
    expect(screen.getByText('cdops-ci')).toBeInTheDocument();
    expect(
      await screen.findByText('build-and-deploy-abc12'),
    ).toBeInTheDocument();
    expect(screen.getByText('Succeeded')).toBeInTheDocument();
    expect(screen.getByText('42s')).toBeInTheDocument();
  });

  it('prompts for the annotations when the entity is not wired up', async () => {
    await render(
      mockTektonApi({
        getTarget: jest.fn().mockResolvedValue({
          mode: 'pipelineRun',
          params: [],
          workspaces: [],
          unconfiguredReason: 'no annotations',
        }),
      }),
    );

    // The empty state shows the annotation name in prose and in a snippet.
    expect(
      (await screen.findAllByText(/tekton.dev\/pipeline/)).length,
    ).toBeGreaterThan(0);
  });

  it('triggers the pipeline with the parameters from the form', async () => {
    const api = mockTektonApi();
    await render(api);

    await userEvent.click(
      await screen.findByRole('button', { name: /run pipeline/i }),
    );

    // Params pinned by the catalog are shown but not editable.
    expect(
      screen.getByLabelText(/git-url \(set by the catalog\)/i),
    ).toBeDisabled();

    const revision = screen.getByLabelText(/git-revision/i);
    await userEvent.clear(revision);
    await userEvent.type(revision, 'release-1.2');

    await userEvent.click(screen.getByRole('button', { name: /^run$/i }));

    await waitFor(() =>
      expect(api.triggerPipeline).toHaveBeenCalledWith({
        entityRef: 'component:default/policy-api',
        params: { 'git-revision': 'release-1.2' },
      }),
    );
  });
});
