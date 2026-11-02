# Tekton trigger plugin for Backstage / Red Hat Developer Hub

Run an OpenShift Pipelines (Tekton) pipeline for a catalog entity from
Developer Hub, and watch the run from the entity page.

Three packages:

| Package                          | Role            | What it does                                            |
| -------------------------------- | --------------- | ------------------------------------------------------- |
| `plugins/tekton-trigger`         | frontend plugin | Entity tab + overview card, trigger dialog, run history |
| `plugins/tekton-trigger-backend` | backend plugin  | Talks to the OpenShift API, enforces permissions        |
| `plugins/tekton-trigger-common`  | shared library  | Types, annotations, permissions                         |

## How it works

```
Entity page  ──POST /api/tekton-trigger/pipelineruns {entityRef, params}──▶  backend
                                                                              │
                                      1. authorize (permission framework)     │
                                      2. read the entity from the catalog     │
                                      3. resolve annotations → cluster/ns/    │
                                         pipeline                             │
                                      4. validate params against the Pipeline │
                                                                              ▼
                              ┌───────────────────────────────┬───────────────────────┐
                              │ POST .../pipelineruns         │ POST EventListener    │
                              │ (default)                     │ (tekton.dev/event-    │
                              │                               │  listener annotation) │
                              └───────────────────────────────┴───────────────────────┘
```

The client never names a cluster, namespace or pipeline. It sends an entity ref,
and the backend derives the target from that entity's annotations, so a user can
only ever trigger what the catalog says the entity owns.

Two trigger modes:

- **PipelineRun (default)** — the backend creates a `PipelineRun` with
  `generateName`, so repeated clicks never collide. Needs the RBAC in
  [`examples/openshift/rbac.yaml`](examples/openshift/rbac.yaml).
- **EventListener** — the backend POSTs a JSON event to a Tekton Triggers
  `EventListener` and the cluster-side `TriggerTemplate` decides what runs. Use
  this when the pipeline shape should stay under the cluster team's control. See
  [`examples/openshift/eventlistener.yaml`](examples/openshift/eventlistener.yaml).

## Install

### 1. Add the packages

From a Backstage monorepo, with the three directories copied into `plugins/`:

```bash
yarn --cwd packages/app add @cdops/plugin-tekton-trigger
yarn --cwd packages/backend add @cdops/plugin-tekton-trigger-backend
```

### 2. Backend

```ts
// packages/backend/src/index.ts
backend.add(import('@cdops/plugin-tekton-trigger-backend'));
```

### 3. Frontend

Add the tab and the overview card to the entity page:

```tsx
// packages/app/src/components/catalog/EntityPage.tsx
import {
  EntityTektonTriggerCard,
  EntityTektonTriggerContent,
  isTektonTriggerAvailable,
} from '@cdops/plugin-tekton-trigger';

const serviceEntityPage = (
  <EntityLayout>
    {/* ... */}
    <EntityLayout.Route
      path="/pipelines"
      title="Pipelines"
      if={isTektonTriggerAvailable}
    >
      <EntityTektonTriggerContent />
    </EntityLayout.Route>
  </EntityLayout>
);

const overviewContent = (
  <Grid container spacing={3}>
    {/* ... */}
    <EntitySwitch>
      <EntitySwitch.Case if={isTektonTriggerAvailable}>
        <Grid item md={4} xs={12}>
          <EntityTektonTriggerCard />
        </Grid>
      </EntitySwitch.Case>
    </EntitySwitch>
  </Grid>
);
```

### 3b. Red Hat Developer Hub (dynamic plugins)

Export both plugins, then wire up the mount points:

```bash
# frontend (Scalprum bundle) and backend
yarn --cwd plugins/tekton-trigger export-dynamic
yarn --cwd plugins/tekton-trigger-backend export-dynamic
```

`export-dynamic` calls the RHDH packaging CLI, `@red-hat-developer-hub/cli`, and
embeds the shared `-common` package. Pin the CLI to the version that matches
your RHDH release instead of `@latest` for a production export.

Mount-point configuration is in
[`examples/app-config.dynamic-plugins.yaml`](examples/app-config.dynamic-plugins.yaml).

For installing into an RHDH instance that is already running — exporting,
packaging to OCI, the Helm and Operator config, cluster RBAC and verification —
see [`docs/install-rhdh.md`](docs/install-rhdh.md).

To host the exported plugins as `.tgz` artifacts served over HTTP from a pod in
the cluster instead of pushing an OCI image — no registry credentials, no pull
secret — see
[`docs/host-http-plugin-registry.md`](docs/host-http-plugin-registry.md).

### 4. Cluster access

```bash
oc apply -n cdops-ci -f examples/openshift/rbac.yaml
```

- **Developer Hub on the same cluster** — leave `serviceAccountToken` unset and
  run the pod as `developer-hub-tekton`. The plugin reads the projected token
  from `/var/run/secrets/kubernetes.io/serviceaccount/token` on **every**
  request, so rotation needs no restart.
- **Developer Hub off-cluster** — take the token from the
  `developer-hub-tekton-token` Secret and pass it in as an env var.

### 5. Configure

Merge [`examples/app-config.tekton.yaml`](examples/app-config.tekton.yaml) into
your `app-config.yaml`. The shape is declared in
[`plugins/tekton-trigger-backend/config.d.ts`](plugins/tekton-trigger-backend/config.d.ts),
so once the backend package is a dependency of your app,
`yarn backstage-cli config:check` validates it — wrong types and missing
required keys fail the check with the exact config path. `serviceAccountToken`,
`caData` and the EventListener `secret` are marked secret, so they never reach
frontend config.

### 6. Annotate entities

```yaml
metadata:
  annotations:
    tekton.dev/pipeline: build-and-deploy
    tekton.dev/namespace: cdops-ci
    tekton.dev/cluster: ocp-dev
```

| Annotation                   | Required | Purpose                                                           |
| ---------------------------- | -------- | ----------------------------------------------------------------- |
| `tekton.dev/pipeline`        | yes¹     | Pipeline to run                                                   |
| `tekton.dev/namespace`       | yes      | Namespace; falls back to `backstage.io/kubernetes-namespace`      |
| `tekton.dev/cluster`         | no       | Entry in `tektonTrigger.clusters`; falls back to `defaultCluster` |
| `tekton.dev/event-listener`  | no       | Trigger through Tekton Triggers instead                           |
| `tekton.dev/service-account` | no       | ServiceAccount for the TaskRuns                                   |
| `tekton.dev/params`          | no       | JSON object of parameter values pinned by the catalog             |
| `tekton.dev/workspaces`      | no       | JSON array passed through to `spec.workspaces`                    |

¹ Either `tekton.dev/pipeline` or `tekton.dev/event-listener`.

Full examples in
[`examples/catalog-component.yaml`](examples/catalog-component.yaml).

## Permissions

Three permissions, registered with the permission registry so RHDH's RBAC UI
lists them:

| Permission                | Guards                                   |
| ------------------------- | ---------------------------------------- |
| `tekton.pipeline.read`    | Reading the target and the run history   |
| `tekton.pipeline.trigger` | Creating a run / firing an EventListener |
| `tekton.pipeline.cancel`  | Cancelling a run                         |

Without a permission policy every authenticated user who can see the entity can
trigger its pipeline. A policy that limits triggering to the entity's owners:

```ts
if (isPermission(request.permission, tektonPipelineTriggerPermission)) {
  return createCatalogConditionalDecision(
    request.permission,
    catalogConditions.isEntityOwner({
      claims: user?.info.ownershipEntityRefs ?? [],
    }),
  );
}
```

The UI disables the buttons when a permission is denied, and the backend
enforces it regardless of what the UI does.

## HTTP API

All routes are under `/api/tekton-trigger` and take the entity by ref.

| Method | Path                                     | Purpose                                          |
| ------ | ---------------------------------------- | ------------------------------------------------ |
| `GET`  | `/target?entityRef=…`                    | Resolved target + the pipeline's declared params |
| `GET`  | `/pipelineruns?entityRef=…`              | Run history, newest first                        |
| `GET`  | `/pipelineruns/:name?entityRef=…`        | One run, including its TaskRuns                  |
| `POST` | `/pipelineruns`                          | Trigger; body `{ entityRef, params }`            |
| `POST` | `/pipelineruns/:name/cancel?entityRef=…` | Cancel a run                                     |

```bash
curl -X POST "$BACKSTAGE/api/tekton-trigger/pipelineruns" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"entityRef":"component:default/policy-api","params":{"git-revision":"release-1.2"}}'
```

## Security notes

- **The entity is the authorization boundary.** Cluster, namespace and pipeline
  come from catalog annotations, never from the request body.
- **Namespace allow-list.** `allowedNamespaces` caps what an annotation can
  reach even if someone edits a `catalog-info.yaml`.
- **Parameters are validated** against the Pipeline's declared params. Unknown
  params and attempts to override `tekton.dev/params` values are rejected rather
  than silently dropped, so a stale form fails loudly.
- **Runs are scoped by pipeline.** The by-name routes check the
  `tekton.dev/pipeline` label before reading or cancelling, so one entity cannot
  cancel another's run in a shared namespace.
- **Provenance.** Every created run carries `backstage.io/entity-ref` and
  `backstage.io/triggered-by` annotations plus `backstage.io/entity-*` labels.
- The EventListener path authenticates with a shared-secret header compared in a
  CEL interceptor. Tekton's CEL interceptor cannot read a Secret, so keep that
  route cluster-internal or behind a NetworkPolicy instead of relying on the
  header alone.

## Development

```bash
yarn install
yarn tsc          # type-check
yarn test         # unit tests (15, covering the router and the entity tab)
yarn lint:all
yarn build
yarn --cwd plugins/tekton-trigger start   # standalone dev app for the frontend
```

Use Node 20 or 22. `@backstage/backend-test-utils` pulls in `better-sqlite3`,
whose native build does not yet compile on Node 26.

The frontend dev app renders the entity tab against a mock entity. For the
backend, point `app-config.local.yaml` at a cluster and run the backend of a
host Backstage app.

## Limitations

- Logs are not proxied; the UI deep-links to the OpenShift console (or Tekton
  Dashboard) run page. Proxying would mean streaming pod logs per TaskRun.
- Workspace bindings are declared per entity via `tekton.dev/workspaces`; the
  dialog does not offer to build them interactively.
- Requires Backstage ≥ 1.39 (new backend system, `coreServices.permissionsRegistry`)
  and Tekton `tekton.dev/v1`, i.e. OpenShift Pipelines ≥ 1.11.
