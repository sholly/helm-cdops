# Triggering `promotion-nonprod` from Azure DevOps

Three ways to start the `promotion-nonprod` Tekton pipeline from an Azure
DevOps pipeline, each implemented and ready to apply:

| | Option 1 | Option 2 | Option 3 |
|---|---|---|---|
| | **SA token** | **K8s service connection** | **EventListener webhook** |
| ADO authenticates with | token in a variable group | ADO service connection | shared secret in a header |
| Agent needs | `oc`, `tkn` | `oc`, `tkn`, `Kubernetes@1` | `curl` |
| Who creates the PipelineRun | the ADO agent | the ADO agent | the EventListener |
| Can stream logs / fail on failure | yes | yes | **no** |
| Can cancel the run | yes | yes | no |
| Cluster objects to apply | Role + SA + token | Role + SA + token | 10 objects |
| Credential lives in | variable group | service connection | one Secret |

**Which to use.** Option 2 for anything ongoing: same identity and RBAC as
option 1, but the credential sits in one project-level object that can be
restricted to named pipelines and carry its own approvals, and no secret is ever
mapped into a build variable. Option 1 when you cannot create service
connections, or for a quick trial — the script is identical either way. Option 3
when the ADO side should hold no cluster credential at all, or when the cluster
team wants sole control over what a promotion means; accept that it is
fire-and-forget.

## Contents

| File | What it is |
|---|---|
| [`promote-nonprod.sh`](promote-nonprod.sh) | Creates the PipelineRun with `oc`. Options 1 and 2 both call it; it detects which credential it was handed. |
| [`azure-pipelines-promotion-nonprod.yml`](azure-pipelines-promotion-nonprod.yml) | Option 1 |
| [`azure-pipelines-promotion-nonprod-svcconn.yml`](azure-pipelines-promotion-nonprod-svcconn.yml) | Option 2 |
| [`trigger-promotion-webhook.sh`](trigger-promotion-webhook.sh) | POSTs the promotion event. Option 3 calls it. |
| [`azure-pipelines-promotion-nonprod-webhook.yml`](azure-pipelines-promotion-nonprod-webhook.yml) | Option 3 |
| [`../openshift/rbac-azure-devops.yaml`](../openshift/rbac-azure-devops.yaml) | Cluster side of options 1 and 2 |
| [`../openshift/eventlistener-promotion-nonprod.yaml`](../openshift/eventlistener-promotion-nonprod.yaml) | Cluster side of option 3 |

Both scripts are plain shell with no ADO dependencies — export the same
variables and they run from a laptop, which is the fastest way to validate a
setup before wiring up a pipeline.

---

## What the pipeline does

[`promotion-nonprod.yaml`](../../promotion-nonprod.yaml), namespace
**`app-gitops`**. Three environment blocks, strictly sequential via `runAfter`,
four tasks each:

| | test | SIT | UAT |
|---|---|---|---|
| gate | — (unattended) | `approval-sit`, 24h | `approval-uat`, 24h |
| 1 | `git-clone` the GitOps repo | same | same |
| 2 | `openshift-client`: `oc patch --local` the image coordinates into `<env>/<application>.yaml` | same | same |
| 3 | `git-cli`: commit and `git push origin main` | same | same |
| 4 | `argocd-task-sync-and-wait` on `<env>-$(workspace)-root` | same | same |

So one run walks an image all the way from test to UAT, pausing for a human
twice. A promotion is a git commit to the GitOps repo plus an ArgoCD sync, per
environment.

### Parameters

Every parameter has a default in the Pipeline, so a run may omit any of them.

| Parameter | Type | Default |
|---|---|---|
| `application` | string | `test1` |
| `imageregistry` | string | `markel.jfrog.io/ids-docker-prod-local` |
| `imagename` | string | `dummyapi.host` |
| `imagetag` | string | `0.0.2.90-latest` |
| `workspace` | string | `jbanks-workspace` |
| `workspacerepo` | string | the `jbanks-workspace-gitops` repo |
| `approvers` | **array** | one AAD user |
| `number-of-approvals` | string | `1` |

`approvers` being array-typed matters: it is why the runs go in as YAML rather
than via `tkn pipeline start -p`, and why option 3 pins it in the
TriggerTemplate instead of accepting it from the payload.

### What must already exist in the cluster

None of the three options set this up, and all three need it:

- The `promotion-nonprod` Pipeline, in `app-gitops`.
- The **`pipeline` ServiceAccount**, with an Azure Repos git credential attached
  (for `git-clone` and `git-cli`, which pushes to `main`) and the ArgoCD
  environment secret (for `argocd-task-sync-and-wait`). This is the identity the
  TaskRuns execute as. Check it before blaming anything in this directory:

  ```sh
  oc get sa pipeline -n app-gitops -o jsonpath='{.secrets[*].name}{"\n"}'
  ```

- The ArgoCD root applications `test-<workspace>-root`, `sit-<workspace>-root`
  and `uat-<workspace>-root`.
- The Manual Approval Gate, which provides `kind: ApprovalTask`:

  ```sh
  oc get crd approvaltasks.openshift-pipelines.org
  ```

---

## Option 1 — ServiceAccount token

### 1. Cluster: create the identity

```sh
oc apply -n app-gitops -f examples/openshift/rbac-azure-devops.yaml
```

That creates ServiceAccount `azure-devops-promoter`, a non-expiring token
Secret, and a Role granting: `pipelines` get/list; `pipelineruns`
get/list/watch/create/patch; `taskruns` get/list/watch; `pods` and `pods/log`
read; and `approvaltasks` get/list/patch.

Two of those deserve a note. `pods`/`pods/log` are there because
`tkn pipelinerun logs` resolves each TaskRun to its pod and tails it — this is
why the Role is wider than
[`rbac.yaml`](../openshift/rbac.yaml), which the RHDH plugin uses and which
never reads logs. The `approvaltasks` verbs are only needed if the ADO job
should approve its own gates; drop them to keep the gates manual.

Verify — both must print `yes`:

```sh
oc auth can-i create pipelineruns.tekton.dev -n app-gitops \
  --as=system:serviceaccount:app-gitops:azure-devops-promoter
oc auth can-i get pods/log -n app-gitops \
  --as=system:serviceaccount:app-gitops:azure-devops-promoter
```

### 2. Cluster: read the credential out

```sh
oc whoami --show-server
# -> ocpServer

oc get secret azure-devops-promoter-token -n app-gitops \
  -o jsonpath='{.data.token}' | base64 -d
# -> ocpToken

oc get secret azure-devops-promoter-token -n app-gitops \
  -o jsonpath='{.data.ca\.crt}' | base64 -d
# -> ocpCaBundle
```

`ocpCaBundle` wants **decoded PEM** here. That differs from
`tektonTrigger.clusters[].caData` in
[`docs/install-rhdh.md`](../../docs/install-rhdh.md), which wants it still
base64-encoded — easy to mix up if you have set both up.

Leave `ocpCaBundle` empty if the API server presents a publicly trusted
certificate.

### 3. ADO: create the variable group

Pipelines → Library → **Variable group** named **`openshift-cdops`**:

| Variable | Value | Secret |
|---|---|---|
| `ocpServer` | `https://api.<cluster>:6443` | no |
| `ocpToken` | the token from step 2 | **yes** |
| `ocpCaBundle` | the PEM from step 2, or empty | **yes** |

### 4. ADO: create the pipeline

New pipeline → your repo → Existing Azure Pipelines YAML file →
`examples/azure-devops/azure-pipelines-promotion-nonprod.yml`.

Check the `pool: name: Default` line matches a real pool of yours. If this
pipeline lives in a different repo from these files, either add this repo under
`resources.repositories` and `checkout` both, or copy `promote-nonprod.sh` in.

### 5. Run it

Run the pipeline and fill in the parameters. Expected output:

```
Authenticated to https://api.<cluster>:6443 as system:serviceaccount:app-gitops:azure-devops-promoter
PipelineRun app-gitops/promotion-nonprod-ab12x
```

Try it from a laptop first, which skips the whole ADO round trip:

```sh
export OCP_SERVER=https://api.<cluster>:6443
export OCP_TOKEN=<token>
export APPLICATION=test1 IMAGE_NAME=dummyapi.host IMAGE_TAG=0.0.2.90-latest
./examples/azure-devops/promote-nonprod.sh
```

---

## Option 2 — Kubernetes service connection

Same ServiceAccount and the same Role as option 1 — the only difference is where
the token is stored and who hands it to the job.

### 1. Cluster: create the identity

Exactly step 1 of option 1. Skip if you already did it.

```sh
oc apply -n app-gitops -f examples/openshift/rbac-azure-devops.yaml
```

### 2. ADO: create the service connection

Project settings → Service connections → New → **Kubernetes** →
authentication method **Service Account**. Name it **`openshift-cdops-k8s`**.

| Field | Value |
|---|---|
| Server URL | `oc whoami --show-server` |
| Secret | `oc get secret azure-devops-promoter-token -n app-gitops -o json` — paste the **whole JSON object** |

ADO reads `token` and `ca.crt` out of that object itself, which is why there is
nothing to decode here.

Tick "Grant access permission to all pipelines", or leave it unticked and
authorize the connection when the first run prompts for it.

### 3. ADO: create the pipeline

New pipeline → Existing Azure Pipelines YAML file →
`examples/azure-devops/azure-pipelines-promotion-nonprod-svcconn.yml`.

No variable group. If you named the connection something else, change the
`kubernetesServiceConnection` variable at the top of the file.

### 4. Run it

The job logs in with a task rather than a script:

```yaml
- task: Kubernetes@1
  inputs:
    connectionType: Kubernetes Service Connection
    kubernetesServiceEndpoint: $(kubernetesServiceConnection)
    command: login          # writes a kubeconfig, exports KUBECONFIG for the job
```

`promote-nonprod.sh` then sees `KUBECONFIG` set, skips its own `oc login`, and
behaves exactly as in option 1. A matching `command: logout` runs at the end
with `condition: always()`.

### Watch out for

- **TLS.** The Service Account method takes `ca.crt` from the SA token Secret,
  which is the cluster's *internal* serving CA. If your API endpoint presents a
  custom named certificate, verification fails. Use the **Kubeconfig**
  authentication method with the correct CA rather than ticking "Accept
  untrusted certificates".
- **The connection's namespace field** only sets the kubeconfig context default.
  `promote-nonprod.sh` passes `-n app-gitops` on every call, so a mismatch
  cannot quietly send a run elsewhere.
- A variable **group** called `openshift-cdops` (option 1) and a service
  **connection** called `openshift-cdops-k8s` are different kinds of object.
  Only option 1 needs the group.

---

## Option 3 — EventListener webhook

The cluster side carries almost everything here; the ADO job shrinks to one
`curl`. The pipeline name, the ServiceAccount, the approvers, the run timeout
and the workspace binding all live in the TriggerTemplate, so ADO can ask for a
promotion but cannot change what one means.

### 1. Cluster: apply the trigger objects

```sh
oc apply -n app-gitops -f examples/openshift/eventlistener-promotion-nonprod.yaml
```

Ten objects: a Secret, the EventListener's own ServiceAccount
`tekton-triggers-azure-devops` with a Role/RoleBinding and a
ClusterRole/ClusterRoleBinding, a TriggerBinding, a TriggerTemplate, the
EventListener, and a Route.

The ClusterRole is cluster-scoped because `ref: {name: cel}` resolves to a
ClusterInterceptor, which is not namespaced. It grants read-only access to
`clustertriggerbindings` and `clusterinterceptors`, nothing else.

### 2. Cluster: replace the placeholder secret

The file ships `token: replace-me`. Overwrite it:

```sh
TOKEN=$(openssl rand -hex 32)
oc create secret generic azure-devops-webhook-secret -n app-gitops \
  --from-literal=token="$TOKEN" --dry-run=client -o yaml | oc apply -f -
echo "$TOKEN"   # -> elToken
```

**Re-applying the YAML file resets the token to `replace-me`.** For a real
deployment, delete the Secret from your copy of the file and manage it
separately.

### 3. Cluster: check the listener came up

```sh
oc get eventlistener promotion-nonprod -n app-gitops
oc get pods -n app-gitops -l eventlistener=promotion-nonprod
```

An EventListener with no pod usually means its ServiceAccount cannot read its
own configuration — check the RoleBinding from step 1.

### 4. Decide the URL

In-cluster, for a self-hosted agent on the internal network — **preferred**,
because it keeps the trigger off the internet entirely:

```
http://el-promotion-nonprod.app-gitops.svc.cluster.local:8080
```

Through the Route, if ADO reaches the cluster from outside:

```sh
echo "https://$(oc get route el-promotion-nonprod -n app-gitops -o jsonpath='{.spec.host}')"
```

If you use the Route and its certificate is issued by an internal CA, you need
`elCaBundle`. On a default install:

```sh
oc get cm default-ingress-cert -n openshift-config-managed \
  -o jsonpath='{.data.ca-bundle\.crt}'
```

Pair an exposed Route with a NetworkPolicy. Once it is reachable, the shared
secret is the only thing standing in front of a pipeline that pushes to git and
syncs ArgoCD.

### 5. ADO: create the variable group

Variable group named **`openshift-cdops-webhook`**:

| Variable | Value | Secret |
|---|---|---|
| `elUrl` | the URL from step 4 | no |
| `elToken` | the token from step 2 | **yes** |
| `elCaBundle` | ingress CA PEM, or empty | **yes** |

### 6. ADO: create the pipeline

New pipeline → Existing Azure Pipelines YAML file →
`examples/azure-devops/azure-pipelines-promotion-nonprod-webhook.yml`.

Note what is *not* a parameter: `approvers` and `number-of-approvals`. A caller
that can name its own approvers has defeated the gate, so the TriggerTemplate
pins both. To change them, edit the TriggerTemplate.

### 7. Run it, with the listener's log open

```sh
oc logs -n app-gitops -l eventlistener=promotion-nonprod -f
```

The job prints the payload it sends and the listener's reply:

```
Accepted (201): {"eventListener":"promotion-nonprod","namespace":"app-gitops","eventID":"..."}
```

Then find the run it created:

```sh
oc get pipelinerun -n app-gitops -l azure-devops/build-id=<buildId>
```

### The limitation, stated plainly

**A 2xx means the event was accepted, not that the PipelineRun was created** —
let alone that it succeeded. Nothing in the response can tell you either. So
this option has no `waitForCompletion`: not an omission, there is no way to
implement one. The job cannot stream logs, cannot fail when the promotion fails,
and cannot cancel anything.

Two correlation handles exist for looking a run up afterwards, from somewhere
that does have cluster access:

```sh
oc get pipelinerun -n app-gitops -l azure-devops/build-id=<buildId>
oc get pipelinerun -n app-gitops -l triggers.tekton.dev/triggers-eventid=<eventID>
```

If neither returns anything, the event was accepted and the run was *not*
created. That failure appears only in the listener's log, which is why step 7
opens it.

### Service hooks are a different thing

ADO can POST on its own from Project settings → Service hooks, with no pipeline
YAML at all. But that request comes from Microsoft's cloud rather than your
network, so the Route must be internet-facing, and the body is ADO's own event
schema — the TriggerBinding here would need rewriting against it, and the CEL
filter would have to authenticate with basic auth rather than a custom header.
Worth it for "promote whenever this build succeeds"; not for a parameterised,
on-demand promotion.

---

## Approving the gates

The run deploys test unattended, then parks before SIT and again before UAT.

```sh
oc get approvaltasks -n app-gitops
opc approvaltask approve <name> -n app-gitops
```

Or in the OpenShift console, under the PipelineRun. Approvers come from the
`approvers` parameter — an AAD user by bare name, or `group:<groupName>` for a
group — and `number-of-approvals` sets how many are needed at each gate.

### Where to put the gate

| | |
|---|---|
| **Keep gates in Tekton** (as shipped) | Approve in the console. ADO exits as soon as the run is created. Right default for options 1 and 2, and the only option for option 3. |
| **Move gates to ADO** | Remove `approval-sit` and `approval-uat` from `promotion-nonprod.yaml`, split it per environment, and gate each stage with an ADO environment check. |

Gates in both places means approving twice. And ADO cannot approve its own run
unless the `azure-devops-promoter` SA is listed in `approvers` and keeps the
`approvaltasks` verbs in its Role — at which point the gate has stopped being a
human control.

### Waiting in ADO (options 1 and 2 only)

`waitForCompletion: false` is the default: create the run, print its name, exit
green. Setting it `true` makes the job stream the logs and exit non-zero if the
run fails — but it then blocks through both gates, which needs a self-hosted
pool with `jobTimeoutMinutes: 0` and an agent you are willing to tie up for up
to 48 hours. It also occupies a parallel-job slot the whole time. Reasonable if
your approvers are quick; otherwise leave it off.

---

## Things that apply to all three

**`timeouts.pipeline` is mandatory.** Tekton defaults a PipelineRun to **1 hour**
and the per-task `timeout: 24h0m0s` in the Pipeline does not override it — the
run gets cancelled while still parked on the SIT approval. Every option here
sets `72h`: options 1 and 2 through the `tektonTimeout` variable, option 3 in
the TriggerTemplate.

**Two ServiceAccounts, different jobs.** Easy to conflate, and the error messages
do not help:

| | Identity | Needs |
|---|---|---|
| Creates the run | `azure-devops-promoter` (options 1, 2) or `tekton-triggers-azure-devops` (option 3) | Tekton API access per its Role |
| Runs the tasks | `pipeline`, via `taskRunTemplate.serviceAccountName` | Azure Repos git credential, ArgoCD env secret |

A promotion that creates a run which then fails in `git-clone` or `git-cli` is
almost always the second one.

**The workspace must be bound.** `workspace-helm` is declared by the Pipeline and
mounted by every task, and is not marked `optional`, so each option binds it
with a `volumeClaimTemplate`. `ReadWriteOnce` is enough — the tasks are strictly
sequential via `runAfter`, so only one pod holds the volume at a time. Note that
`tekton.dev/workspaces` on a catalog entity does **not** apply on the
EventListener path; there, the TriggerTemplate owns the binding.

**Runs show up in RHDH.** Tekton sets `tekton.dev/pipeline=promotion-nonprod`
from `pipelineRef` on every run regardless of who created it, and that is the
label the tekton-trigger backend lists on
([`router.ts:174`](../../plugins/tekton-trigger-backend/src/service/router.ts)).
So ADO-triggered runs appear in the card next to button-triggered ones, with no
extra labelling.

**No `set -x` in either script.** It would echo the token or the shared secret
into the build log, where ADO's secret masking does not reach every form. The
Pipeline's own tasks use `set -x` and `env|sort`, but that output stays in the
cluster.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Run cancelled after ~1h, parked on `approval-sit` | `timeouts.pipeline` missing or too short. Needs to exceed the sum of the gate waits. |
| `oc login` succeeds, `oc get pipeline` is forbidden | Role or RoleBinding not applied to `app-gitops`. Check with `oc auth can-i ... --as=system:serviceaccount:...`. |
| `tkn pipelinerun logs` fails with a pods error | Missing `pods`/`pods/log` in the Role — the plugin's `rbac.yaml` does not grant these. |
| x509 error on `oc login` | `ocpCaBundle` empty or wrong, or base64-encoded when it should be decoded PEM. |
| x509 error from `Kubernetes@1` | API server uses a custom named certificate; the SA Secret's `ca.crt` cannot verify it. Use the Kubeconfig auth method. |
| Service connection "not authorized" | Authorize it for the pipeline, or grant access to all pipelines. |
| `param approvers` type error on create | `approvers` passed as a string. It is array-typed; it must be a YAML/JSON sequence. |
| Webhook returns 401 | `X-Azdo-Token` not matching the Secret, or `body.source != 'azure-devops'`. The listener does not say which — read its log. |
| Webhook returns 2xx, no PipelineRun appears | TriggerTemplate failed to create it. Only the listener's log says why. |
| EventListener has no pod | Its ServiceAccount cannot read its own trigger objects. |
| Run created, fails in `git-cli` | The `pipeline` SA has no Azure Repos credential, or no push rights on `main`. |
| Run created, fails in `argocd-task-sync-and-wait` | ArgoCD env secret missing, or the `<env>-<workspace>-root` application does not exist. |
