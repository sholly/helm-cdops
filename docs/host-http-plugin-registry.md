# Hosting the plugins as HTTP artifacts in an OpenShift cluster

An alternative to the OCI-image path in [`install-rhdh.md`](install-rhdh.md):
build the two dynamic plugins, pack each one into a `.tgz`, and serve them from
an httpd pod in the cluster. RHDH's `install-dynamic-plugins` init container
fetches them by URL.

Pick this over OCI when you want no registry credentials, no push rights and no
pull secret linked to the RHDH ServiceAccount. Pick OCI when you want one
versioned image holding both halves and your existing registry's auth, signing
and retention. Everything after registration — cluster RBAC, the permission
framework, entity annotations, verification — is identical, and is covered in
[`install-rhdh.md`](install-rhdh.md) steps 5 through 9.

What changes versus OCI:

| | OCI | HTTP |
| --- | --- | --- |
| Artifact | one image, both plugins | two tarballs, one per plugin |
| Packaging command | `rhdh-cli plugin package` | `npm pack` |
| `package:` value | `oci://…:tag!<name>` | `http://plugin-registry:8080/<file>.tgz` |
| `integrity:` | not used | **required** |
| Credentials | registry login + pull secret | none |

---

## 0. Prerequisites

Same as [`install-rhdh.md`](install-rhdh.md) step 0, minus the registry
requirements — no `podman` and no push rights are needed. Still required:

- RHDH on a Backstage ≥ 1.39 base (this repo is pinned to 1.42 in
  `backstage.json`); the backend uses `coreServices.permissionsRegistry`.
- OpenShift Pipelines ≥ 1.11, for the `tekton.dev/v1` API.
- **Node 20 or 22** on the build host, plus yarn. Node 26 cannot build
  `better-sqlite3`, which `@backstage/backend-test-utils` pulls in, so
  `yarn install` fails outright.
- `oc` logged in with rights to create builds in the RHDH namespace.
- An RHDH CLI version matching your RHDH release.

---

## 1. Build and export

From the repo root:

```bash
yarn install --frozen-lockfile
yarn tsc
yarn test
yarn build            # backstage-cli repo build --all

yarn --cwd plugins/tekton-trigger export-dynamic
yarn --cwd plugins/tekton-trigger-backend export-dynamic
```

`yarn build` is not optional: both exports embed
`@cdops/plugin-tekton-trigger-common`, a private workspace package with no
published tarball, so its `dist/` has to exist first.

Each `export-dynamic` runs the RHDH CLI's `plugin export --embed-package
@cdops/plugin-tekton-trigger-common` and writes a derived package into that
plugin's `dist-dynamic/`, with `-dynamic` appended to the package name. The
script uses `@latest` as a default only — pin the CLI to your RHDH release
before a production export. See [`install-rhdh.md`](install-rhdh.md) step 2 for
what `plugin export` does in detail.

---

## 2. Pack each export into a tarball

This is the step that differs from OCI. `npm pack`, run from each
`dist-dynamic/` directory, produces the tarball *and* prints the integrity hash
RHDH will verify.

```bash
mkdir -p /tmp/plugin-registry

for p in plugins/tekton-trigger plugins/tekton-trigger-backend; do
  ( cd "$p/dist-dynamic" \
    && npm pack --pack-destination /tmp/plugin-registry --json \
       | jq -r '.[0] | "\(.filename)  \(.integrity)"' )
done
```

Keep both output lines. The `integrity` values go verbatim into the config in
step 4.

The file name is the package name with `@` dropped and `/` replaced by `-`, plus
the version, so expect something close to:

- `cdops-plugin-tekton-trigger-0.1.0.tgz` (frontend)
- `cdops-plugin-tekton-trigger-backend-dynamic-0.1.0.tgz` (backend)

Confirm rather than assume — the CLI does not append `-dynamic` uniformly
across roles, and the tarball name derives directly from the exported name:

```bash
jq -r .name plugins/tekton-trigger/dist-dynamic/package.json
jq -r .name plugins/tekton-trigger-backend/dist-dynamic/package.json
```

Check that the frontend tarball actually carries the federated bundle. A
Scalprum bundle that packs without its assets installs cleanly and then renders
nothing:

```bash
tar tzf /tmp/plugin-registry/cdops-plugin-tekton-trigger-0.1.0.tgz \
  | grep -E 'scalprum|plugin-manifest'
```

`/tmp/plugin-registry` must end up holding **only** the tarballs — the next step
uploads the whole directory into the image's document root.

---

## 3. Serve them from the cluster

An S2I binary build of the `httpd` image serves whatever you upload, on port
8080. Either apply the manifests:

```bash
oc apply -n <rhdh-namespace> -f examples/openshift/plugin-registry.yaml
oc start-build plugin-registry -n <rhdh-namespace> \
  --from-dir=/tmp/plugin-registry --wait
```

or do the same imperatively:

```bash
oc project <rhdh-namespace>
oc new-build httpd --name=plugin-registry --binary
oc start-build plugin-registry --from-dir=/tmp/plugin-registry --wait
oc new-app --image-stream=plugin-registry
```

Put the registry in the RHDH namespace if you can — the init container has to
reach it, and same-namespace keeps the URL short and the NetworkPolicy trivial.

Then confirm the Service name, the port and that the files are actually served,
before you write any of it into config:

```bash
oc get svc plugin-registry -n <rhdh-namespace> \
  -o jsonpath='{.metadata.name}:{.spec.ports[*].port}{"\n"}'

oc run curltest -n <rhdh-namespace> --rm -it --restart=Never \
  --image=registry.access.redhat.com/ubi9/ubi-minimal -- \
  curl -sSI http://plugin-registry:8080/cdops-plugin-tekton-trigger-0.1.0.tgz
```

`oc new-app` names the Service after the image stream and the httpd image
listens on 8080, but verify rather than trust it.

The URL to use:

- same namespace as RHDH — `http://plugin-registry:8080/<file>.tgz`
- another namespace — `http://plugin-registry.<ns>.svc.cluster.local:8080/<file>.tgz`

**Keep it a Service, not a Route.** Nothing on this path authenticates the
download, so in-cluster-only reachability *is* the access control; a Route would
publish your plugin bundles to anyone who finds the host. If the RHDH namespace
denies traffic by default, allow it — the NetworkPolicy at the end of
[`examples/openshift/plugin-registry.yaml`](../examples/openshift/plugin-registry.yaml)
covers ingress to the registry, and RHDH also needs egress to it.

To publish a new build later:

```bash
oc start-build plugin-registry -n <rhdh-namespace> \
  --from-dir=/tmp/plugin-registry --wait
```

The Deployment's image trigger rolls the pod automatically. See step 6 on why
the file names must change when the contents do.

---

## 4. Register the plugins with RHDH

Two entries, two URLs, each with its own `integrity`. There is no `!<name>`
suffix — that is OCI-only; here one tarball *is* one plugin.

The full block is in
[`examples/dynamic-plugins.http.yaml`](../examples/dynamic-plugins.http.yaml);
the shape is:

```yaml
includes:
  - dynamic-plugins.default.yaml
plugins:
  - package: http://plugin-registry:8080/cdops-plugin-tekton-trigger-backend-dynamic-0.1.0.tgz
    integrity: sha512-<from npm pack --json>
    disabled: false
    pluginConfig:
      tektonTrigger: { ... }          # clusters, pipelineRun, maxRuns

  - package: http://plugin-registry:8080/cdops-plugin-tekton-trigger-0.1.0.tgz
    integrity: sha512-<from npm pack --json>
    disabled: false
    pluginConfig:
      dynamicPlugins:
        frontend:
          cdops.plugin-tekton-trigger:
            mountPoints: [ ... ]      # entity.page.ci/cards, entity.page.overview/cards
```

Notes:

- The frontend `pluginConfig` is **mandatory**. Without the mount points the
  bundle loads and renders nothing, with no console error.
- `integrity` is documented as required for tarball and JavaScript packages, in
  the form `<alg>-<digest>`; `sha256`, `sha384` and `sha512` are supported, and
  `npm pack --json` emits `sha512`.
- The mount-point YAML is the same content as
  [`examples/app-config.dynamic-plugins.yaml`](../examples/app-config.dynamic-plugins.yaml),
  nested one level deeper under `pluginConfig:`. That file's top-level
  `dynamicPlugins:` shape is for a plain `app-config.yaml`.
- Newer RHDH releases accept `enabled: true` in place of `disabled: false`;
  `disabled` is still honoured, and `enabled` wins if both are set.
- `serviceAccountToken`, `caData` and the EventListener `secret` are marked
  `@visibility secret` in
  [`config.d.ts`](../plugins/tekton-trigger-backend/config.d.ts), so they are
  never served to the browser. Supply them through a Secret as env vars — see
  [`install-rhdh.md`](install-rhdh.md) step 4d.
- The Scalprum key `cdops.plugin-tekton-trigger` and the `PluginRoot` module
  name are what make the mount points resolve without a `module:` key. See
  [`install-rhdh.md`](install-rhdh.md) step 1a before changing either.

### Helm

```yaml
# values.yaml
global:
  dynamic:
    includes:
      - dynamic-plugins.default.yaml    # keep RHDH's own defaults
    plugins:
      - package: http://plugin-registry:8080/cdops-plugin-tekton-trigger-backend-dynamic-0.1.0.tgz
        integrity: sha512-…
        disabled: false
        pluginConfig: { ... }
      - package: http://plugin-registry:8080/cdops-plugin-tekton-trigger-0.1.0.tgz
        integrity: sha512-…
        disabled: false
        pluginConfig: { ... }
```

```bash
helm upgrade <release> redhat-developer-hub/backstage \
  -n <rhdh-namespace> -f values.yaml
```

Red Hat's Helm documentation describes `package` as a local folder path or an
npm package spec and does not mention HTTP URLs. The installer hands the value
to `npm pack`, which does accept a tarball URL, so this works — but it is worth
confirming on your release rather than discovering it in a failed rollout.

### Operator

Put the same `plugins:` list in the `dynamic-plugins.yaml` key of the ConfigMap
your `Backstage` CR names. Check which one it actually reads first:

```bash
oc get backstage -n <rhdh-namespace> \
  -o jsonpath='{.items[*].spec.application.dynamicPluginsConfigMapName}{"\n"}'
```

Restart the RHDH application to apply.

---

## 5. Everything downstream

Unchanged from the OCI path, and documented in
[`install-rhdh.md`](install-rhdh.md):

| Step | What |
| --- | --- |
| 5 | Bind the Tekton Role to RHDH's own ServiceAccount, per pipeline namespace |
| 6 | `permission.enabled: true` plus an RBAC policy for the three permissions |
| 7 | Annotate the entities that should get the tab and card |
| 8 | Verify: init-container logs, `/dynamic-plugins-root`, backend logs, `GET /target` |

---

## 6. HTTP-specific caveats

- **`integrity` is a content hash.** Overwriting a tarball in place under the
  same file name breaks every install that referenced it, with a hash mismatch
  in the init container. Bump the version in both plugin `package.json` files so
  the file name changes, and treat published URLs as immutable.
- **No TLS story for this path.** Red Hat documents custom CA trust only for OCI
  registries. If you front the registry with HTTPS using a self-signed
  certificate there is no supported knob for the init container's trust store;
  staying on plain in-cluster HTTP avoids the problem. Do not reach for
  `NODE_TLS_REJECT_UNAUTHORIZED` — it is not a documented setting here and it
  disables verification process-wide.
- **No authentication on the fetch.** The `.npmrc`-and-Secret mechanism applies
  to npm registries only; no credential mechanism is documented for tarball
  URLs.
- **The registry is a second thing to keep alive.** If its pod is down when RHDH
  restarts, the init container cannot fetch the plugins and RHDH comes up
  without them. An OCI registry you already run has this covered; an httpd pod
  in the same namespace does not.

---

## 7. Troubleshooting

Everything in [`install-rhdh.md`](install-rhdh.md) step 9 still applies. Added
by this path:

| Symptom | Cause |
| --- | --- |
| Init container: integrity/checksum mismatch | The tarball at that URL is not the one you hashed. A file was overwritten in place — step 6. Re-pack, re-hash, use a new file name. |
| Init container: `ENOTFOUND` / connection refused on the URL | Wrong Service name, wrong port, wrong namespace in the URL, or a NetworkPolicy blocking it — step 3. |
| Init container: 404 for the tarball | The file was not in the directory passed to `--from-dir`, or the name does not match the exported package name. Check with `curl -sSI` from a pod, and `jq -r .name dist-dynamic/package.json`. |
| Init container: integrity missing/invalid format | `integrity` is required for tarballs, as `<alg>-<digest>` — take it from `npm pack --json`, not from a manual `sha512sum` (the digest is base64, not hex). |
| Plugins vanish after an RHDH restart | The registry pod was unavailable at restart — step 6. |
| Tab and card never render, no console error | Frontend `pluginConfig` missing, or a `module:` mismatch — [`install-rhdh.md`](install-rhdh.md) step 1a. |
