import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Entity } from '@backstage/catalog-model';
import { EntityProvider } from '@backstage/plugin-catalog-react';
import { AlertApi, alertApiRef } from '@backstage/core-plugin-api';
import { permissionApiRef } from '@backstage/plugin-permission-react';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { SWRConfig } from 'swr';
import {
  mockApis,
  renderInTestApp,
  TestApiProvider,
} from '@backstage/test-utils';
import {
  ArgoApplicationSummary,
  PipelineRunSummary,
} from '@cdops/plugin-tekton-trigger-common';
import { tektonTriggerApiRef, TektonTriggerApi } from '../../api';
import { ArgoCdDeployCard } from './ArgoCdDeployCard';

const entity: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name: 'policy-api',
    namespace: 'default',
    annotations: {
      'tekton.dev/pipeline': 'build-and-deploy',
      'tekton.dev/namespace': 'cdops-ci',
      'argocd/app-name': 'policy-api-prod',
    },
  },
  spec: { type: 'service', lifecycle: 'production', owner: 'team-a' },
};

const app: ArgoApplicationSummary = {
  name: 'policy-api-prod',
  instance: 'main',
  namespace: 'policy-prod',
  project: 'policy',
  syncStatus: 'Synced',
  healthStatus: 'Healthy',
  revision: 'v1.2.0',
  targetRevision: 'v1.2.0',
  repoUrl: 'https://github.com/cdops/policy-api',
  path: 'chart',
  deployedAt: new Date(Date.now() - 3_600_000).toISOString(),
  images: ['quay.io/cdops/policy-api:v1.2.0'],
  argoUrl: 'https://argocd.example.com/applications/policy-api-prod',
};

const run: PipelineRunSummary = {
  name: 'build-and-deploy-abc12',
  namespace: 'cdops-ci',
  cluster: 'ocp-dev',
  pipeline: 'build-and-deploy',
  status: 'Succeeded',
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  durationMs: 42_000,
  params: [],
  tasks: [],
};

function mockTektonApi(overrides: Partial<TektonTriggerApi> = {}) {
  return {
    getArgoApplication: jest.fn().mockResolvedValue({ apps: [app] }),
    listGitVersions: jest.fn().mockResolvedValue({
      repoUrl: app.repoUrl,
      items: [
        { ref: 'v1.3.0', type: 'tag' },
        { ref: 'v1.2.0', type: 'tag', current: true },
        { ref: 'main', type: 'branch' },
      ],
    }),
    deploy: jest
      .fn()
      .mockResolvedValue({ mode: 'pipelineRun', pipelineRun: run }),
    getTarget: jest.fn(),
    listPipelineRuns: jest.fn().mockResolvedValue([run]),
    getPipelineRun: jest.fn().mockResolvedValue(run),
    triggerPipeline: jest.fn(),
    cancelPipelineRun: jest.fn(),
    ...overrides,
  } as jest.Mocked<TektonTriggerApi>;
}

/** The card only posts alerts; nothing subscribes in these tests. */
const alertApi = {
  post: jest.fn(),
  alert$: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }),
} as unknown as AlertApi;

async function render(
  api: jest.Mocked<TektonTriggerApi>,
  authorize:
    AuthorizeResult.ALLOW | AuthorizeResult.DENY = AuthorizeResult.ALLOW,
) {
  await renderInTestApp(
    // usePermission reads through SWR, whose cache is module-global and keyed
    // by the permission alone. Without a fresh cache per test the first
    // render's decision is reused for every later one.
    <SWRConfig value={{ provider: () => new Map() }}>
      <TestApiProvider
        apis={[
          [tektonTriggerApiRef, api],
          [alertApiRef, alertApi],
          [permissionApiRef, mockApis.permission({ authorize })],
        ]}
      >
        <EntityProvider entity={entity}>
          <ArgoCdDeployCard />
        </EntityProvider>
      </TestApiProvider>
    </SWRConfig>,
  );
}

/** Opens a Material-UI Select and picks an option by its visible label. */
async function pickFromDropdown(label: RegExp, option: string) {
  await userEvent.click(screen.getByLabelText(label));
  const listbox = await screen.findByRole('listbox');
  await userEvent.click(within(listbox).getByText(option));
}

describe('ArgoCdDeployCard', () => {
  it('shows the deployed state of the application', async () => {
    await render(mockTektonApi());

    expect(await screen.findByText('Synced')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText('policy-api-prod · policy')).toBeInTheDocument();
    expect(screen.getByText('policy-prod')).toBeInTheDocument();
    // The running revision and the tracked revision are both labelled.
    expect(screen.getByText('Deployed')).toBeInTheDocument();
    expect(screen.getByText('Tracking')).toBeInTheDocument();
  });

  it('defaults the dropdown to the version argocd tracks', async () => {
    await render(mockTektonApi());

    // The ref and the "(current)" marker are separate elements inside the
    // closed select, so match on the combobox's own text.
    const select = await screen.findByLabelText(/version/i);
    await waitFor(() =>
      expect(select.textContent).toMatch(/^v1\.2\.0\(current\)$/),
    );
  });

  it('deploys the picked version after confirmation', async () => {
    const api = mockTektonApi();
    await render(api);

    await screen.findByText('Synced');
    await pickFromDropdown(/version/i, 'v1.3.0');

    await userEvent.click(screen.getByRole('button', { name: /^deploy$/i }));

    // The confirmation names the application and the version being deployed.
    expect(
      await screen.findByText(/Deploy policy-api-prod\?/i),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: /deploy v1\.3\.0/i }),
    );

    await waitFor(() =>
      expect(api.deploy).toHaveBeenCalledWith({
        entityRef: 'component:default/policy-api',
        version: 'v1.3.0',
        app: 'policy-api-prod',
      }),
    );
  });

  it('does not deploy when the confirmation is cancelled', async () => {
    const api = mockTektonApi();
    await render(api);

    await screen.findByText('Synced');
    await userEvent.click(screen.getByRole('button', { name: /^deploy$/i }));
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(api.deploy).not.toHaveBeenCalled();
  });

  it('disables deploying without the trigger permission', async () => {
    await render(mockTektonApi(), AuthorizeResult.DENY);

    await screen.findByText('Synced');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^deploy$/i })).toBeDisabled(),
    );
  });

  it('explains an empty dropdown instead of offering a dead button', async () => {
    await render(
      mockTektonApi({
        listGitVersions: jest.fn().mockResolvedValue({
          items: [],
          unavailableReason: 'No source repository to list versions from.',
        }),
      }),
    );

    expect(
      await screen.findByText(/No source repository to list versions from/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^deploy$/i }),
    ).not.toBeInTheDocument();
  });

  it('lists the recent pipeline runs', async () => {
    await render(mockTektonApi());

    expect(
      await screen.findByText(/build-and-deploy-abc12/),
    ).toBeInTheDocument();
    expect(screen.getByText('Succeeded')).toBeInTheDocument();
  });

  it('renders nothing when the entity has no argocd application', async () => {
    await render(
      mockTektonApi({
        getArgoApplication: jest.fn().mockResolvedValue({
          apps: [],
          unconfiguredReason: 'no annotations',
        }),
      }),
    );

    await waitFor(() =>
      expect(screen.queryByText('ArgoCD Deployment')).not.toBeInTheDocument(),
    );
  });

  it('lets the user switch between several applications', async () => {
    const staging: ArgoApplicationSummary = {
      ...app,
      name: 'policy-api-staging',
      syncStatus: 'OutOfSync',
    };
    const api = mockTektonApi({
      getArgoApplication: jest.fn().mockResolvedValue({ apps: [app, staging] }),
    });
    await render(api);

    await screen.findByText('Synced');
    await pickFromDropdown(/application/i, 'policy-api-staging');

    expect(await screen.findByText('OutOfSync')).toBeInTheDocument();
    // Versions are re-read for the newly picked application.
    await waitFor(() =>
      expect(api.listGitVersions).toHaveBeenCalledWith(
        'component:default/policy-api',
        'policy-api-staging',
      ),
    );
  });
});
