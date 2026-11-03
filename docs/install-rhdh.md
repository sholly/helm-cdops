# Installing the Tekton trigger plugin into an existing Red Hat Developer Hub

This guide installs the three packages in this repo into an RHDH instance that
is **already running** on OpenShift, as dynamic plugins — no rebuild of the RHDH
image, no fork of `backstage-showcase`.

Nothing here modifies the running RHDH image. The work is:

1. build and export the two plugins as dynamic plugins,
2. push them to a registry as an OCI image,
3. add them to RHDH's dynamic-plugins config,
4. grant the RHDH pod read/create access to Tekton in the pipeline namespaces,
5. annotate the catalog entities that should get the ArgoCD deployment card.

Step 3 pushes an OCI image. For the alternative — pack each plugin with
`npm pack` and serve the tarballs over HTTP from an httpd pod in the cluster,
with no registry credentials or pull secret — follow
[`host-http-plugin-registry.md`](host-http-plugin-registry.md) in place of
steps 2 through 4, then come back here for steps 5 onward.

---

## 0. Prerequisites

| Requirement                                                    | Why                                                                                                                                                                                  | How to check                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| RHDH on a Backstage ≥ 1.39 base                                | The backend uses `coreServices.permissionsRegistry`, added in Backstage 1.39. This repo is pinned to 1.42 (`backstage.json`).                                                        | `oc exec deploy/<rhdh> -- cat /opt/app-root/src/package.json \| grep backstage` or the version matrix for your RHDH release |
| OpenShift Pipelines ≥ 1.11                                     | The plugin uses the `tekton.dev/v1` API.                                                                                                                                             | `oc get csv -n openshift-operators \| grep pipelines`                                                                       |
| ArgoCD reachable from the RHDH pod, plus a read-only token      | The card leads with ArgoCD's deployed state and sources the version dropdown from the application's repository. Configured under the root `argocd` key — step 4a.                    | `oc get route -n openshift-gitops`                                                                                          |
| RHDH's RBAC plugin enabled (optional)                          | Needed only if you want the four permissions to show up in the RBAC UI.                                                                                                             | `oc get cm dynamic-plugins-rhdh -o yaml \| grep rbac`                                                                       |
| Node 20 or newer + Yarn 4, on the build host                   | `@backstage/cli` and the RHDH CLI. Yarn 4 is pinned by `packageManager` and committed under `.yarn/releases`. No native toolchain needed — nothing in the tree compiles from source. | `node -v`                                                                                                                   |
| `podman` (or `docker`/`buildah`) and push rights to a registry | Dynamic plugins are shipped as an OCI image.                                                                                                                                         | `podman login quay.io`                                                                                                      |
| An RHDH CLI version matching your RHDH release                 | Command names and flags changed between `@janus-idp/cli` (RHDH ≤ 1.6) and `@red-hat-developer-hub/cli` (1.7+).                                                                       | see [the RHDH version matrix](https://github.com/redhat-developer/rhdh/blob/main/docs/dynamic-plugins/versions.md)          |

> If your RHDH is older than the Backstage 1.39 baseline, the backend plugin
> will fail to initialise (`coreServices.permissionsRegistry` is undefined).
> Upgrade RHDH first; there is no config workaround.

---

## 1. Two repo prerequisites (already applied here)

Both of these were defects in this repo and are now fixed on `main`. They are
recorded because they are invisible failures if you are working from an older
checkout or a fork.

### 1a. The Scalprum module name

RHDH resolves a mount point's component from the Scalprum module named
`PluginRoot` unless the mount point entry sets `module:` explicitly. This repo
originally exposed the module as `TektonTrigger` while neither
`examples/app-config.dynamic-plugins.yaml` nor
`plugins/tekton-trigger/app-config.janus-idp.yaml` set `module:` — so the mount
points resolved to nothing and the card silently never rendered.

`plugins/tekton-trigger/package.json` now reads:

```jsonc
  "scalprum": {
    "name": "cdops.plugin-tekton-trigger",
    "exposedModules": {
      "PluginRoot": "./src/index.ts"
    }
  }
```

which makes both of this repo's mount-point YAML files correct as written. If
you reintroduce a custom module name, add `module: <name>` to **every** entry
under `mountPoints:` in the config you deploy (step 4).

Leave `scalprum.name` alone: `cdops.plugin-tekton-trigger` is exactly what the
CLI would generate for `@cdops/plugin-tekton-trigger` (drop the `@`, `/` → `.`),
and it is the key you use in `dynamicPlugins.frontend`.

### 1b. The `export-dynamic` script

Both plugin `package.json` files previously defined:

```json
"export-dynamic": "janus-cli package export-dynamic-plugin"
```

`@janus-idp/cli` is not a dependency anywhere in this repo and `yarn.lock` has
no entry for it, so `yarn export-dynamic` failed with "command not found". The
script now invokes the RHDH CLI directly:

```json
"export-dynamic": "rm -rf dist-dynamic && npx -y @red-hat-developer-hub/cli@latest plugin export --embed-package @cdops/plugin-tekton-trigger-common"
```

The leading `rm -rf dist-dynamic` is required, not housekeeping. The CLI picks
its install mode from whether `dist-dynamic/yarn.lock` already exists: absent, it
copies the monorepo root lockfile in and runs `yarn install --no-immutable`;
present, it runs `yarn install --immutable`. A lockfile left over from an earlier
export pins the `file:` resolution hashes of the embedded packages, so once those
are rebuilt the install genuinely needs to rewrite the lock and `--immutable`
rejects it:

```
YN0028: The lockfile would have been modified by this install, which is explicitly forbidden.
```

Clearing the directory first makes every export a clean one.

`@latest` is deliberate only as a default — pin the CLI to the version that
matches your RHDH release (see step 0) before a production export, either by
editing the script or by running the pinned command from step 2 by hand.

---

## 2. Build and export

Run everything from the repo root.

```bash
yarn install --immutable
yarn tsc
yarn test
yarn build            # backstage-cli repo build --all
```

`yarn build` matters: the exports embed `@cdops/plugin-tekton-trigger-common`,
which is a private workspace package with no published tarball, so its `dist/`
must exist first.

### Frontend and backend

```bash
yarn --cwd plugins/tekton-trigger export-dynamic
yarn --cwd plugins/tekton-trigger-backend export-dynamic
```

Each script runs, from that package's root:

```bash
npx -y @red-hat-developer-hub/cli@<version-for-your-rhdh> plugin export \
  --embed-package @cdops/plugin-tekton-trigger-common
```

What `plugin export` does:

- writes a derived package into `dist-dynamic/`, with `-dynamic` appended to the
  package name;
- treats every `@backstage/*` dependency as **shared** (turns them into
  `peerDependencies` satisfied by the RHDH host) — correct here, since all of
  this plugin's Backstage deps are within the host's range;
- **embeds** packages whose name ends in `-node` or `-common`, which already
  covers `@cdops/plugin-tekton-trigger-common`; the explicit `--embed-package`
  above just makes it non-negotiable;
- for the backend, requires the plugin to be the package's **default export** —
  satisfied by `export { tektonTriggerPlugin as default }` in
  `plugins/tekton-trigger-backend/src/index.ts`;
- for the frontend, builds the Scalprum federated bundle from the `scalprum`
  block in `package.json`.

Record the exported names — you need them for the `!`-suffixed OCI paths:

```bash
jq -r .name plugins/tekton-trigger/dist-dynamic/package.json
jq -r .name plugins/tekton-trigger-backend/dist-dynamic/package.json
```

The path inside the image is that name with the `@` dropped and `/` replaced by
`-`, so expect:

- `cdops-plugin-tekton-trigger` (frontend)
- `cdops-plugin-tekton-trigger-backend-dynamic` (backend)

Confirm rather than assume — the names are printed in the export log, and you
can list them straight out of the finished image:

```bash
podman run --rm --entrypoint ls quay.io/<org>/cdops-tekton-trigger:0.1.0 /
```

---

## 3. Package as an OCI image and push

Run `plugin package` from each **plugin source root**, not from `dist-dynamic`.
It can take several plugins into one image, which is what you want here so both
halves ship and version together:

```bash
cd /path/to/helm-cdops
npx @red-hat-developer-hub/cli@latest plugin package \
  --tag quay.io/<org>/cdops-tekton-trigger:0.1.0 \
  plugins/tekton-trigger plugins/tekton-trigger-backend

podman push quay.io/<org>/cdops-tekton-trigger:0.1.0
```

The CLI does not push for you. Add `--container-tool docker` (or `buildah`) if
podman is not what you have.

If your plugin build runs one directory at a time, build two images instead and
reference both in step 4 — the config shape is identical.

**Private registry:** create a pull secret in the RHDH namespace and attach it
to the RHDH pod's ServiceAccount, otherwise the init container cannot pull the
plugin image:

```bash
oc create secret docker-registry plugin-pull \
  --docker-server=quay.io --docker-username=<user> --docker-password=<token> \
  -n <rhdh-namespace>
oc secrets link <rhdh-serviceaccount> plugin-pull --for=pull -n <rhdh-namespace>
```

### Alternative: npm registry instead of OCI

Works, but needs an `integrity` hash per entry and an npmrc Secret in the
cluster. Red Hat recommends OCI, and derived dynamic packages should not go to
the public npm registry.

```bash
cd plugins/tekton-trigger-backend/dist-dynamic
npm publish --registry https://nexus.internal/repository/npm-private/
npm pack --json | jq -r '.[0].integrity'   # the value for `integrity:`
```

---

## 4. Register the plugins with RHDH

Both entries go in the same `plugins:` list. The frontend entry **must** carry a
`pluginConfig` with its mount points; without it the bundle loads and renders
nothing.

### 4a. The plugin entries

```yaml
plugins:
  # ---- backend -----------------------------------------------------------
  - package: oci://quay.io/<org>/cdops-tekton-trigger:0.1.0!cdops-plugin-tekton-trigger-backend-dynamic
    disabled: false
    pluginConfig:
      tektonTrigger:
        defaultCluster: ocp-dev
        clusters:
          - name: ocp-dev
            url: https://api.ocp-dev.example.com:6443
            # Omit serviceAccountToken when RHDH runs on this cluster: the
            # plugin then reads the projected token at
            # /var/run/secrets/kubernetes.io/serviceaccount/token on every
            # request, so rotation needs no restart. See step 5.
            dashboardUrl: https://console-openshift-console.apps.ocp-dev.example.com
            dashboardType: openshift
            allowedNamespaces:
              - cdops-ci
              - cdops-build
          - name: ocp-prod
            url: https://api.ocp-prod.example.com:6443
            serviceAccountToken: ${TEKTON_OCP_PROD_TOKEN}
            caData: ${TEKTON_OCP_PROD_CA}
            dashboardUrl: https://console-openshift-console.apps.ocp-prod.example.com
            allowedNamespaces:
              - cdops-release
        pipelineRun:
          serviceAccountName: pipeline
          timeout: 1h0m0s
          labels:
            app.kubernetes.io/part-of: developer-hub
          annotations:
            cdops.com/triggered-from: developer-hub
        deploy:
          # The pipeline must declare this parameter; the plugin sets it to the
          # version picked in the card's dropdown.
          versionParam: git-revision
          appParam: argocd-app
          includeTags: true
          includeBranches: true
          maxVersions: 50
        maxRuns: 20
      # ArgoCD, in the Roadie config shape. A read-only account is enough: the
      # plugin reads applications and lists repository refs, and never syncs.
      # If the Roadie ArgoCD plugins are already installed in this RHDH, their
      # argocd block is reused and this one can be omitted.
      argocd:
        appLocatorMethods:
          - type: config
            instances:
              - name: main
                url: https://argocd.apps.ocp-dev.example.com
                token: ${ARGOCD_MAIN_TOKEN}

  # ---- frontend ----------------------------------------------------------
  - package: oci://quay.io/<org>/cdops-tekton-trigger:0.1.0!cdops-plugin-tekton-trigger
    disabled: false
    pluginConfig:
      dynamicPlugins:
        frontend:
          cdops.plugin-tekton-trigger:
            mountPoints:
              # The ArgoCD deployment card is the plugin's only frontend
              # extension. The overview page is already part of RHDH's default
              # entity page, so no entityTabs entry is needed.
              - mountPoint: entity.page.overview/cards
                importName: EntityArgoCdDeployCard
                # module: <name>   # only if you reintroduced a custom module name
                config:
                  layout:
                    gridColumnEnd:
                      lg: 'span 6'
                      md: 'span 8'
                      xs: 'span 12'
                  if:
                    anyOf:
                      - hasAnnotation: argocd/app-name
                      - hasAnnotation: argocd/app-selector
```

Notes on this block:

- The mount-point YAML is the same content as
  [`examples/app-config.dynamic-plugins.yaml`](../examples/app-config.dynamic-plugins.yaml),
  just nested one level deeper under `pluginConfig:`. That file's top-level
  `dynamicPlugins:` shape is for a plain `app-config.yaml`, not for the
  dynamic-plugins list.
- Newer RHDH releases accept `enabled: true` in place of `disabled: false`;
  `disabled` is still honoured, and `enabled` wins if you set both.
- `pluginConfig` is merged into the running app-config, so you can also put the
  `tektonTrigger` block in your main app-config ConfigMap instead. Keeping it on
  the plugin entry keeps plugin and config in one place.
- `serviceAccountToken`, `caData` and the EventListener `secret` are marked
  `@visibility secret` in
  [`config.d.ts`](../plugins/tekton-trigger-backend/config.d.ts), so they are
  never served to the browser.
- For a tgz or npm package instead of OCI, the entry needs an `integrity:` key
  alongside `package:`.

### 4b. Where that list lives — Helm

```yaml
# values.yaml
global:
  dynamic:
    includes:
      - dynamic-plugins.default.yaml # keep RHDH's own defaults
    plugins:
      - package: oci://quay.io/<org>/cdops-tekton-trigger:0.1.0!cdops-plugin-tekton-trigger-backend-dynamic
        disabled: false
        pluginConfig: { ... } # as above
      - package: oci://quay.io/<org>/cdops-tekton-trigger:0.1.0!cdops-plugin-tekton-trigger
        disabled: false
        pluginConfig: { ... } # as above
```

```bash
helm upgrade <release> redhat-developer-hub/backstage \
  -n <rhdh-namespace> -f values.yaml
```

Dropping `includes:` turns off every plugin RHDH enables by default — always
keep the line.

### 4c. Where that list lives — RHDH Operator

Edit the dynamic-plugins ConfigMap (commonly `dynamic-plugins-rhdh`) that your
`Backstage` CR points at, and put the two entries in its `dynamic-plugins.yaml`
key:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: dynamic-plugins-rhdh
  namespace: <rhdh-namespace>
data:
  dynamic-plugins.yaml: |
    includes:
      - dynamic-plugins.default.yaml
    plugins:
      - package: oci://quay.io/<org>/cdops-tekton-trigger:0.1.0!cdops-plugin-tekton-trigger-backend-dynamic
        disabled: false
        pluginConfig: { ... }
      - package: oci://quay.io/<org>/cdops-tekton-trigger:0.1.0!cdops-plugin-tekton-trigger
        disabled: false
        pluginConfig: { ... }
```

```yaml
apiVersion: rhdh.redhat.com/v1alpha3
kind: Backstage
metadata:
  name: developer-hub
spec:
  application:
    dynamicPluginsConfigMapName: dynamic-plugins-rhdh
```

Confirm the name the operator is actually reading before you edit anything:

```bash
oc get backstage -n <rhdh-namespace> \
  -o jsonpath='{.items[*].spec.application.dynamicPluginsConfigMapName}{"\n"}'
```

### 4d. Secrets for off-cluster clusters

Only needed for entries that set `serviceAccountToken` / `caData` (the
`ocp-prod` entry above). The `${VAR}` placeholders are resolved from the RHDH
pod's environment.

```bash
oc create secret generic tekton-trigger-secrets -n <rhdh-namespace> \
  --from-literal=TEKTON_OCP_PROD_TOKEN="$(oc --context ocp-prod get secret developer-hub-tekton-token -n cdops-release -o jsonpath='{.data.token}' | base64 -d)" \
  --from-literal=TEKTON_OCP_PROD_CA="$(oc --context ocp-prod get cm kube-root-ca.crt -n cdops-release -o jsonpath='{.data.ca\.crt}' | base64 -w0)"
```

Helm:

```yaml
upstream:
  backstage:
    extraEnvVarsSecrets:
      - tekton-trigger-secrets
```

Operator:

```yaml
spec:
  application:
    extraEnvs:
      secrets:
        - name: tekton-trigger-secrets
```

---

## 5. Give RHDH access to Tekton

[`examples/openshift/rbac.yaml`](../examples/openshift/rbac.yaml) creates a
dedicated `developer-hub-tekton` ServiceAccount plus Role and RoleBinding. For
an **existing** RHDH deployment, the simpler and usually better route is to bind
that Role to the ServiceAccount the RHDH pod already runs as, so the projected
token it reads is the one that carries the permissions.

```bash
RHDH_SA=$(oc get deploy <rhdh-deployment> -n <rhdh-namespace> \
  -o jsonpath='{.spec.template.spec.serviceAccountName}')
echo "$RHDH_SA"
```

Then, **per pipeline namespace** (every namespace listed in
`allowedNamespaces`):

```bash
oc apply -n cdops-ci -f examples/openshift/rbac.yaml   # creates the Role
oc create rolebinding developer-hub-tekton-rhdh \
  --role=developer-hub-tekton \
  --serviceaccount=<rhdh-namespace>:"$RHDH_SA" \
  -n cdops-ci
```

The Role is least-privilege by design: `get`/`list` on `pipelines` and
`taskruns`, and `get`/`list`/`watch`/`create`/`patch` on `pipelineruns`
(`patch` is what cancellation uses).

Choose **one** of these three credential modes per cluster entry:

| Mode                          | Config                                                                                                                                                                                                                           | When                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Projected token (recommended) | omit `serviceAccountToken` and `serviceAccountTokenFile`; the plugin defaults to `/var/run/secrets/kubernetes.io/serviceaccount/token` and the CA at `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`, re-read per request | RHDH on the same cluster as the pipelines           |
| Static token                  | `serviceAccountToken: ${VAR}` from the `developer-hub-tekton-token` Secret, plus `caData`                                                                                                                                        | remote cluster                                      |
| Mounted token file            | `serviceAccountTokenFile: /path/to/token`                                                                                                                                                                                        | you project a second SA token into the pod yourself |

If you stay with the repo's separate `developer-hub-tekton` SA **and** want the
projected-token mode, you must also change the RHDH pod's `serviceAccountName`
to it — which affects everything else RHDH does in-cluster. Binding the Role to
RHDH's own SA avoids that entirely.

Also check egress: if the RHDH namespace has a restrictive NetworkPolicy, allow
the pod to reach the Kubernetes API server (and the EventListener Route, if you
use that path).

---

## 6. Enable the permission framework (recommended)

The backend registers four permissions with the permission registry, so RHDH's
RBAC UI lists them once the plugin is loaded:

| Permission                | Guards                                              |
| ------------------------- | --------------------------------------------------- |
| `argocd.application.read` | reading the deployed state and the version list     |
| `tekton.pipeline.read`    | reading the target and run history                  |
| `tekton.pipeline.trigger` | deploying: creating a run / firing an EventListener |
| `tekton.pipeline.cancel`  | cancelling a run                                    |

Without a policy, **every authenticated user who can see the entity can deploy
it.** Turn the framework on:

```yaml
permission:
  enabled: true
```

Then grant them in your RBAC policy — e.g. in the `rbac-policy.csv` your RHDH
RBAC plugin reads:

```csv
p, role:default/platform-engineer, argocd.application.read, read, allow
p, role:default/platform-engineer, tekton.pipeline.read, read, allow
p, role:default/platform-engineer, tekton.pipeline.trigger, create, allow
p, role:default/platform-engineer, tekton.pipeline.cancel, update, allow
g, user:default/jay, role:default/platform-engineer
```

Denying `argocd.application.read` blanks the card's deployed state while
leaving the run history, so grant it to anyone who should see the card at all.

For "owners only", a conditional policy on entity ownership is shown in the
[README](../README.md#permissions). The card disables the deploy button when a
permission is denied, and the backend enforces it regardless of the UI.

---

## 7. Annotate your entities

No entity picks up the card until it is annotated. The backend resolves the
ArgoCD application, cluster, namespace and pipeline from the **catalog
entity**, never from the request body, so these annotations are the
authorization boundary.

```yaml
metadata:
  annotations:
    # what the card shows
    argocd/app-name: policy-api-prod # required (or argocd/app-selector)
    argocd/instance-name: main # optional; else all instances searched
    argocd/project-name: policy # required if the repo is project-scoped
    # what the deploy button runs
    tekton.dev/pipeline: deploy-version # required (or tekton.dev/event-listener)
    tekton.dev/namespace: cdops-ci # required; falls back to backstage.io/kubernetes-namespace
    tekton.dev/cluster: ocp-dev # optional; falls back to defaultCluster
```

Optional: `tekton.dev/version-param` and `tekton.dev/app-param` (which pipeline
parameters carry the picked version and the application name),
`tekton.dev/service-account`, `tekton.dev/params` (JSON object of values pinned
by the catalog — the backend rejects attempts to override them, and the version
parameter may not appear there), `tekton.dev/workspaces` (JSON array passed
through to `spec.workspaces`), `tekton.dev/event-listener`. Full examples in
[`examples/catalog-component.yaml`](../examples/catalog-component.yaml).

The namespace must appear in that cluster's `allowedNamespaces`, or the request
is rejected — that list is what stops someone editing a `catalog-info.yaml` to
reach a namespace they shouldn't.

### If you use the EventListener path

Apply [`examples/openshift/eventlistener.yaml`](../examples/openshift/eventlistener.yaml)
(replace `replace-me` in both the Secret and the CEL filter with the same value
you put in `tektonTrigger.eventListeners[].secret`), and add the
`eventListeners` block to the backend config:

```yaml
eventListeners:
  - name: cdops-el
    url: http://el-cdops-ci.cdops-ci.svc.cluster.local:8080
    secret: ${TEKTON_EVENT_LISTENER_SECRET}
    secretHeader: X-Backstage-Token
    cluster: ocp-dev
    namespace: cdops-ci
```

Tekton's CEL interceptor cannot read a Secret, so the shared secret is compared
in plain CEL. Keep that URL cluster-internal (as above) or put a NetworkPolicy
in front of it; do not rely on the header alone over a public Route.

---

## 8. Verify

```bash
# 1. The init container pulled and unpacked both plugins
oc logs deploy/<rhdh-deployment> -n <rhdh-namespace> -c install-dynamic-plugins | \
  grep -i tekton

# 2. The frontend bundle is listed
oc exec deploy/<rhdh-deployment> -n <rhdh-namespace> -- \
  ls /dynamic-plugins-root

# 3. The backend plugin is loaded and routed
oc logs deploy/<rhdh-deployment> -n <rhdh-namespace> -c backstage | \
  grep -i 'tekton-trigger'
```

Then from a shell with a Developer Hub token:

```bash
# ArgoCD side: the deployed state the card leads with
curl -s "$BACKSTAGE/api/tekton-trigger/argocd/application?entityRef=component:default/policy-api" \
  -H "Authorization: Bearer $TOKEN" | jq

# ArgoCD side: the dropdown's contents
curl -s "$BACKSTAGE/api/tekton-trigger/argocd/versions?entityRef=component:default/policy-api" \
  -H "Authorization: Bearer $TOKEN" | jq

# Tekton side: resolved target plus the pipeline's declared params
curl -s "$BACKSTAGE/api/tekton-trigger/target?entityRef=component:default/policy-api" \
  -H "Authorization: Bearer $TOKEN" | jq
```

An app with a sync and health status means the ArgoCD config, token and
annotations line up; a non-empty `items` on the versions route means ArgoCD can
read the application's repository. A resolved cluster/namespace/pipeline that
declares the version parameter means the Tekton config, RBAC and annotations
line up too. Finally, open the entity in RHDH: the overview card should show
the deployed state, and the dropdown should preselect the version ArgoCD is
tracking.

---

## 9. Troubleshooting

| Symptom                                                   | Cause                                                                                                                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Card never renders, no console error                      | `module:` mismatch — step 1a. The config references a Scalprum module RHDH cannot find. The entity also needs `argocd/app-name` or `argocd/app-selector` for the mount point's `if:` to match. |
| `Plugin ... not found in image` during init               | The `!<name>` path doesn't match the exported package name. Re-check with `jq -r .name dist-dynamic/package.json`.                                             |
| Init container `ImagePullBackOff`                         | Pull secret not linked to the RHDH ServiceAccount — step 3.                                                                                                    |
| Backend fails with `permissionsRegistry` undefined        | RHDH base is older than Backstage 1.39 — step 0.                                                                                                               |
| `No clusters are configured under tektonTrigger.clusters` | `pluginConfig` didn't merge. Check indentation and that the backend entry (not the frontend one) carries the `tektonTrigger` block.                            |
| 403 from the OpenShift API                                | The Role is bound to the wrong ServiceAccount, or missing in that namespace — step 5. Apply it per namespace.                                                  |
| `Namespace '<ns>' is not allowed`                         | The entity's `tekton.dev/namespace` is not in that cluster's `allowedNamespaces`.                                                                              |
| `Cluster '<x>' is not configured`                         | `tekton.dev/cluster` on the entity names a cluster that isn't in the config.                                                                                   |
| Triggering works for everyone                             | `permission.enabled` is false or no policy grants/denies `tekton.pipeline.trigger` — step 6.                                                                   |
| Unknown-parameter errors on trigger                       | Intentional: params are validated against the Pipeline's declared params, and overriding a `tekton.dev/params` value is rejected rather than silently dropped. |
| x509 errors against the API server                        | Set `caData` (base64 PEM) or `caFile`. `skipTLSVerify: true` exists for dev only.                                                                              |

### Rolling back

Set `disabled: true` on both entries (or remove them) and re-apply; the next
RHDH restart comes up without the plugin. Nothing in this install mutates RHDH's
image or database.

---

## 10. Upgrading

Bump the version in both `package.json` files, re-run steps 2 and 3 with a new
image tag, then update the tag in both `package:` references. Pin a tag or a
digest (`oci://…@sha256:…!<name>`) rather than a floating tag, so a pod restart
can never pull a plugin version you haven't tested.
