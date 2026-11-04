# ArgoCD deployment card for Backstage / Red Hat Developer Hub

Shows what an entity's ArgoCD application currently has deployed, offers a
dropdown of git versions to deploy, and deploys the picked one by triggering an
OpenShift Pipelines (Tekton) pipeline.

One card does all three:

```
┌─ ArgoCD Deployment ──────────────── policy-api-prod · policy ─ ⟳ ↗ ─┐
│  ● Synced     ● Healthy                                             │
│                                                                     │
│  Deployed   v1.2.0 · 1 hour ago                                     │
│  Tracking   v1.2.0                                                  │
│  Commit     Bump chart to 1.2.0 — a.dev                             │
│  Namespace  policy-prod                                             │
│  Source     github.com/cdops/policy-api-gitops · environments/prod  │
│  [policy-api:v1.2.0]                                                │
│                                                                     │
│  Version ⌄  v1.3.0            [ Deploy ]                            │
│  ──────────────────────────────────────────────────────────────────  │
│  Recent pipelines                                                   │
│  ● Succeeded  deploy-version-abc12 · 1 hour ago · 42s               │
└─────────────────────────────────────────────────────────────────────┘
```

Three packages:

| Package                          | Role            | What it does                                                |
| -------------------------------- | --------------- | ----------------------------------------------------------- |
| `plugins/tekton-trigger`         | frontend plugin | The ArgoCD deployment card: state, version dropdown, deploy |
| `plugins/tekton-trigger-backend` | backend plugin  | Reads ArgoCD, triggers Tekton, enforces permissions         |
| `plugins/tekton-trigger-common`  | shared library  | Types, annotations, permissions                             |

ArgoCD access goes through
[`@roadiehq/backstage-plugin-argo-cd-node`](https://www.npmjs.com/package/@roadiehq/backstage-plugin-argo-cd-node)'s
`argocdServiceRef`, so this plugin reads the same `argocd.appLocatorMethods`
config as the Roadie ArgoCD plugins and reuses their instance lookup, their
authentication (token, username/password or Azure OIDC) and their entity
annotations. If those plugins are already installed, there is no second ArgoCD
configuration to maintain.

## How it works

The card asks three questions, all scoped by entity ref:

```
            GET /argocd/application?entityRef=…      ┌──────────┐
Card  ──────────────────────────────────────────────▶ │          │
            what is deployed right now               │  ArgoCD  │
                                                     │          │
            GET /argocd/versions?entityRef=…         │          │
      ──────────────────────────────────────────────▶ │          │
            which git refs could be deployed         └──────────┘
                                                      (repo refs)

            POST /deploy {entityRef, version, app}
      ──────────────────────────────────────────────▶  backend
                                                          │
             1. authorize (permission framework)           │
             2. read the entity from the catalog           │
             3. resolve argocd/* annotations → application │
             4. re-check `version` against ArgoCD's refs   │
             5. resolve tekton.dev/* annotations → pipeline│
             6. set the version param, validate the rest   │
                                                          ▼
                              ┌────────────────────┬─────────────────────┐
                              │ POST …/pipelineruns│ POST EventListener  │
                              │ (default)          │ (tekton.dev/event-  │
                              │                    │  listener)          │
                              └────────────────────┴─────────────────────┘
                                          │
                                          ▼
                       pipeline writes the new version into the
                       gitops repo → ArgoCD syncs → card updates
```

The client never names a cluster, namespace, pipeline or ArgoCD application. It
sends an entity ref, and the backend derives everything from that entity's
annotations, so a user can only ever read and deploy what the catalog says the
entity owns.

**The plugin does not change ArgoCD directly.** Deploying runs the entity's
pipeline, and that pipeline is what updates the version ArgoCD deploys — by
bumping a tag in a values file, committing to the gitops repo, or whatever the
team's pipeline already does. The card then polls ArgoCD and shows the new
state once it has synced. Nothing here calls ArgoCD's sync API.

### Where the versions come from

`GET /argocd/versions` reads the application's source repository through
ArgoCD's own `GET /api/v1/repositories/{repo}/refs`, which returns the repo's
branches and tags. ArgoCD already has credentials for that repository, so no
SCM token needs to be configured in Backstage. Tags are listed first, newest
first by semver-ish ordering, with branches after; the revision ArgoCD is
tracking is marked `(current)` and preselected.

A project-scoped repository is only readable with the project named, so set
`argocd/project-name` on those entities.

### How the version reaches the pipeline

The picked version is passed as a pipeline parameter — `git-revision` by
default, configurable with `tektonTrigger.deploy.versionParam` or per entity
with `tekton.dev/version-param`. The pipeline must declare that parameter; a
pipeline that does not is rejected with a 400 rather than run in a way that
would ignore the user's choice.

The ArgoCD application name is passed as `argocd-app` too, but only when the
pipeline declares it, so a pipeline that handles a single application does not
have to take it.

Two trigger modes, as before:

- **PipelineRun (default)** — the backend creates a `PipelineRun` with
  `generateName`, so repeated clicks never collide. Needs the RBAC in
  [`examples/openshift/rbac.yaml`](examples/openshift/rbac.yaml).
- **EventListener** — the backend POSTs a JSON event to a Tekton Triggers
  `EventListener`, with the version and application in the payload's `params`,
  and the cluster-side `TriggerTemplate` decides what runs. See
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

Add the card to the entity overview page:

```tsx
// packages/app/src/components/catalog/EntityPage.tsx
import {
  EntityArgoCdDeployCard,
  isArgoCdDeployAvailable,
} from '@cdops/plugin-tekton-trigger';

const overviewContent = (
  <Grid container spacing={3}>
    {/* ... */}
    <EntitySwitch>
      <EntitySwitch.Case if={isArgoCdDeployAvailable}>
        <Grid item md={6} xs={12}>
          <EntityArgoCdDeployCard />
        </Grid>
      </EntitySwitch.Case>
    </EntitySwitch>
  </Grid>
);
```

The `EntitySwitch` is optional: the card renders nothing for an entity with no
ArgoCD annotations, so it is safe to add unguarded to a shared entity page.

### 3b. Red Hat Developer Hub (dynamic plugins)

Export both plugins, then wire up the mount points:

```bash
# frontend (Scalprum bundle) and backend
yarn --cwd plugins/tekton-trigger export-dynamic
yarn --cwd plugins/tekton-trigger-backend export-dynamic
```

`export-dynamic` calls the RHDH packaging CLI, `@red-hat-developer-hub/cli`,
pinned to `1.10.8` as a devDependency of each plugin, and embeds the shared
`-common` package. Two things are load-bearing and both fail silently:

- the CLI **pin** — 2.1.0 dropped the Scalprum output RHDH 1.10 still needs, so
  never use `@latest`; match the release line to your RHDH;
- the root **`resolutions: { "webpack": "5.105.4" }`** — two webpack copies make
  the Scalprum bundle build emit nothing while exiting 0.

Both are explained in [`docs/install-rhdh.md`](docs/install-rhdh.md) steps 1c
and 1d. After any frontend export, confirm the bundle exists:

```bash
ls plugins/tekton-trigger/dist-dynamic/dist-scalprum/plugin-manifest.json
```

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
your `app-config.yaml`. It covers both halves:

```yaml
# ArgoCD — the Roadie config shape, shared with the Roadie ArgoCD plugins.
argocd:
  appLocatorMethods:
    - type: config
      instances:
        - name: main
          url: https://argocd.apps.ocp-dev.example.com
          token: ${ARGOCD_MAIN_TOKEN} # or username + password

tektonTrigger:
  deploy:
    versionParam: git-revision # the pipeline must declare this
    appParam: argocd-app # passed only when the pipeline declares it
    includeTags: true
    includeBranches: true
    tagPattern: '^v\d+\.\d+\.\d+$' # optional: release tags only
    maxVersions: 50
  # ...clusters, eventListeners, pipelineRun as before
```

The ArgoCD account needs to read applications and to list repository refs
(`GET /api/v1/repositories/{repo}/refs`); a read-only ArgoCD account is enough,
since the plugin never syncs or mutates ArgoCD.

The `tektonTrigger` shape is declared in
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
    # what the card shows
    argocd/app-name: policy-api-prod
    # what the deploy button runs
    tekton.dev/pipeline: deploy-version
    tekton.dev/namespace: cdops-ci
```

ArgoCD, matching the Roadie ArgoCD plugins' annotations:

| Annotation             | Required | Purpose                                                                |
| ---------------------- | -------- | ---------------------------------------------------------------------- |
| `argocd/app-name`      | yes¹     | Application whose deployed state the card shows                        |
| `argocd/app-selector`  | yes¹     | Label selector, for a component deployed as several applications       |
| `argocd/instance-name` | no       | Entry in `argocd.appLocatorMethods[].instances`; else all are searched |
| `argocd/project-name`  | no       | ArgoCD project; required when the repository is project-scoped         |

¹ Either `argocd/app-name` or `argocd/app-selector`. With a selector the card
shows an application picker and deploys the picked one. `app-name` wins if both
are set.

Tekton:

| Annotation                   | Required | Purpose                                                           |
| ---------------------------- | -------- | ----------------------------------------------------------------- |
| `tekton.dev/pipeline`        | yes²     | Pipeline the deploy button runs                                   |
| `tekton.dev/namespace`       | yes      | Namespace; falls back to `backstage.io/kubernetes-namespace`      |
| `tekton.dev/cluster`         | no       | Entry in `tektonTrigger.clusters`; falls back to `defaultCluster` |
| `tekton.dev/event-listener`  | no       | Trigger through Tekton Triggers instead                           |
| `tekton.dev/version-param`   | no       | Parameter carrying the picked version; else `deploy.versionParam` |
| `tekton.dev/app-param`       | no       | Parameter carrying the application name; else `deploy.appParam`   |
| `tekton.dev/service-account` | no       | ServiceAccount for the TaskRuns                                   |
| `tekton.dev/params`          | no       | JSON object of parameter values pinned by the catalog             |
| `tekton.dev/workspaces`      | no       | JSON array passed through to `spec.workspaces`                    |

² Either `tekton.dev/pipeline` or `tekton.dev/event-listener`. An entity with
ArgoCD annotations but no Tekton ones still gets the card and its deployed
state; the deploy button has nothing to run.

The version parameter may not appear in `tekton.dev/params`: a pinned version
would contradict the dropdown, so the backend rejects it with an explanation
rather than silently ignoring the choice.

Full examples in
[`examples/catalog-component.yaml`](examples/catalog-component.yaml).

## Permissions

Four permissions, registered with the permission registry so RHDH's RBAC UI
lists them:

| Permission                | Guards                                              |
| ------------------------- | --------------------------------------------------- |
| `argocd.application.read` | Reading the deployed state and the version list     |
| `tekton.pipeline.read`    | Reading the target and the run history              |
| `tekton.pipeline.trigger` | Deploying: creating a run / firing an EventListener |
| `tekton.pipeline.cancel`  | Cancelling a run                                    |

Without a permission policy every authenticated user who can see the entity can
deploy it. A policy that limits deploying to the entity's owners:

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

The card disables the deploy button when `tekton.pipeline.trigger` is denied,
and the backend enforces it regardless of what the UI does.

## HTTP API

All routes are under `/api/tekton-trigger` and take the entity by ref.

| Method | Path                                     | Purpose                                                 |
| ------ | ---------------------------------------- | ------------------------------------------------------- |
| `GET`  | `/argocd/application?entityRef=…`        | Deployed state of the entity's applications             |
| `GET`  | `/argocd/versions?entityRef=…&app=…`     | Git versions for the dropdown                           |
| `POST` | `/deploy`                                | Deploy; body `{ entityRef, version, app?, params? }`    |
| `GET`  | `/target?entityRef=…`                    | Resolved target + the pipeline's declared params        |
| `GET`  | `/pipelineruns?entityRef=…`              | Run history, newest first                               |
| `GET`  | `/pipelineruns/:name?entityRef=…`        | One run, including its TaskRuns                         |
| `POST` | `/pipelineruns`                          | Trigger without a version; body `{ entityRef, params }` |
| `POST` | `/pipelineruns/:name/cancel?entityRef=…` | Cancel a run                                            |

```bash
curl -X POST "$BACKSTAGE/api/tekton-trigger/deploy" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"entityRef":"component:default/policy-api","version":"v1.3.0"}'
```

`app` is required on the version and deploy routes only when the entity
resolves to more than one ArgoCD application; the error names the candidates.
The `/argocd/*` routes answer 200 with an explanation (`unconfiguredReason`,
`unavailableReason`) rather than an error when the entity is not wired up, so
the card can stay quiet instead of showing a failure.

## Security notes

- **The entity is the authorization boundary.** Cluster, namespace, pipeline
  and ArgoCD application come from catalog annotations, never from the request
  body. An `app` in the request may only name an application the entity already
  resolves to.
- **The version is re-checked server-side.** `POST /deploy` lists the
  application's refs from ArgoCD again and rejects a version that is not among
  them, so the dropdown is a convenience rather than the authority. A crafted
  request cannot push an arbitrary string into a PipelineRun parameter.
- **A pinned version parameter is rejected,** not overridden: an entity whose
  `tekton.dev/params` pins the version parameter fails with an explanation,
  since the two sources would contradict each other.
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
- **Read-only against ArgoCD.** The plugin never syncs, patches or creates
  ArgoCD resources, so the ArgoCD credential can be a read-only account. All
  change goes through the pipeline.
- The EventListener path authenticates with a shared-secret header compared in a
  CEL interceptor. Tekton's CEL interceptor cannot read a Secret, so keep that
  route cluster-internal or behind a NetworkPolicy instead of relying on the
  header alone.

## Development

```bash
yarn install
yarn tsc          # type-check
CI=1 yarn test    # unit tests (router routes + the card)
yarn lint:all
yarn build
yarn --cwd plugins/tekton-trigger start   # standalone dev app for the frontend
```

Node 20 or newer, and Yarn 4 — the version is pinned by `packageManager` in
the root `package.json` and a matching release is committed under
`.yarn/releases`, so `yarn` picks it up with no setup (enable Corepack with
`corepack enable` if you'd rather it manage the download). `yarn test` without
`CI=1` starts Jest in watch mode.

Nothing in the dependency tree needs a native toolchain — no compiler, Python
or `node-gyp` on the build host. Install scripts are disabled repo-wide
(`enableScripts` is left at Yarn 4's default). The backend tests use the
local service stubs in `plugins/tekton-trigger-backend/src/service/testMocks.ts`
rather than `@backstage/backend-test-utils`, which would drag in
`better-sqlite3` and (via testcontainers) `cpu-features`, both of which build
from source.

The frontend dev app renders the card against a mock entity. For the backend,
point `app-config.local.yaml` at a cluster and an ArgoCD instance and run the
backend of a host Backstage app.

## Limitations

- **The card does not sync ArgoCD.** It shows state and runs a pipeline. If
  your pipeline commits to the gitops repo and ArgoCD is on a slow refresh
  interval, the new state appears when ArgoCD next syncs, not when the pipeline
  finishes.
- **The version list is git refs, not deployment history.** It comes from
  `repositories/{repo}/refs`, so it offers branches and tags. Rolling back to a
  plain commit SHA that carries no tag is not offered, and neither is ArgoCD's
  own `status.history`.
- **Multi-source applications** are read through their first source only; the
  version dropdown tracks that repository.
- The deployed state is polled (5s while ArgoCD is converging, 30s once
  settled), not streamed.
- Logs are not proxied; the card deep-links to the OpenShift console (or Tekton
  Dashboard) run page and to the application in ArgoCD.
- Workspace bindings are declared per entity via `tekton.dev/workspaces`.
- Requires Backstage ≥ 1.39 (new backend system, `coreServices.permissionsRegistry`),
  Tekton `tekton.dev/v1` (OpenShift Pipelines ≥ 1.11), and an ArgoCD with the
  `repositories/{repo}/refs` endpoint (≥ 1.8).
