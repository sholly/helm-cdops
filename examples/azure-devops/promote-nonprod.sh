#!/usr/bin/env bash
#
# Creates a `promotion-nonprod` PipelineRun on OpenShift, and optionally streams
# its logs and waits for it.
#
# Authenticates one of two ways, whichever the caller set up:
#
#   KUBECONFIG already set   - nothing to do. This is the ADO Kubernetes service
#                              connection path: `Kubernetes@1` with
#                              `command: login` writes a kubeconfig and exports
#                              KUBECONFIG for the rest of the job, and both oc
#                              and tkn honour it.
#   OCP_SERVER + OCP_TOKEN   - the script runs `oc login` itself. This is the
#                              bare ServiceAccount-token path.
#
# Called by azure-pipelines-promotion-nonprod.yml (token) and
# azure-pipelines-promotion-nonprod-svcconn.yml (service connection), but it is
# a plain script with no ADO dependencies - export the same variables and it
# runs from a laptop.
#
# Required (token path only):
#   OCP_SERVER            https://api.<cluster>:6443
#   OCP_TOKEN             ServiceAccount token (see rbac-azure-devops.yaml)
# Optional:
#   OCP_CA_BUNDLE         API server CA, PEM. Token path only; omit for a
#                         publicly trusted cert.
#   OCP_NAMESPACE         default app-gitops. The service connection may pin a
#                         namespace of its own, so every oc/tkn call below
#                         passes -n explicitly rather than trusting the
#                         kubeconfig context.
#   PIPELINE_SA           SA the TaskRuns run as, default `pipeline`
#   TEKTON_TIMEOUT        whole-run timeout, default 72h
#   IMAGE_REGISTRY IMAGE_NAME IMAGE_TAG WORKSPACE_NAME WORKSPACE_REPO
#   APPLICATION APPROVERS NUMBER_OF_APPROVALS
#                         pipeline params; anything unset falls back to the
#                         Pipeline's own default
#   WAIT                  `true` to stream logs and exit non-zero on failure.
#                         Matched case-insensitively: an ADO boolean parameter
#                         interpolates as `True`, not `true`.
#
# Deliberately no `set -x`: it would echo OCP_TOKEN into the build log.
set -euo pipefail

NS=${OCP_NAMESPACE:-app-gitops}
PIPELINE=promotion-nonprod
SA=${PIPELINE_SA:-pipeline}
TIMEOUT=${TEKTON_TIMEOUT:-72h}
WAIT=$(printf '%s' "${WAIT:-false}" | tr '[:upper:]' '[:lower:]')
TMP=${AGENT_TEMPDIRECTORY:-${TMPDIR:-/tmp}}

# --------------------------------------------------------------------- login --
# An explicit token wins, so a caller can override a service connection's
# kubeconfig by setting OCP_TOKEN.
if [ -n "${OCP_TOKEN:-}" ]; then
  : "${OCP_SERVER:?OCP_SERVER is required alongside OCP_TOKEN}"

  login_args=(--token="${OCP_TOKEN}" --server="${OCP_SERVER}")
  if [ -n "${OCP_CA_BUNDLE:-}" ]; then
    printf '%s\n' "${OCP_CA_BUNDLE}" >"${TMP}/ocp-ca.crt"
    login_args+=(--certificate-authority="${TMP}/ocp-ca.crt")
  fi

  oc login "${login_args[@]}" >/dev/null
elif [ -z "${KUBECONFIG:-}" ]; then
  echo "Need either OCP_SERVER + OCP_TOKEN, or a KUBECONFIG from an ADO" >&2
  echo "Kubernetes service connection (Kubernetes@1 with command: login)." >&2
  exit 2
fi

echo "Authenticated to $(oc whoami --show-server) as $(oc whoami)"

# Fail here with a readable message rather than on a create whose rejection is
# buried in an admission webhook error.
oc get pipeline "${PIPELINE}" -n "${NS}" -o name >/dev/null

# ----------------------------------------------------------------- the params --
# Only pass what was set, so an unset variable means "use the Pipeline default"
# rather than an empty string that the tasks would interpolate literally.
params=()
add_param() {
  local name=$1 value=$2
  [ -n "${value}" ] || return 0
  params+=("$(printf '    - name: %s\n      value: "%s"' "${name}" "${value}")")
}

add_param imageregistry "${IMAGE_REGISTRY:-}"
add_param imagename "${IMAGE_NAME:-}"
add_param imagetag "${IMAGE_TAG:-}"
add_param workspace "${WORKSPACE_NAME:-}"
add_param workspacerepo "${WORKSPACE_REPO:-}"
add_param application "${APPLICATION:-}"
add_param number-of-approvals "${NUMBER_OF_APPROVALS:-}"

# `approvers` is an array param, so it goes in as a JSON/YAML flow sequence and
# is NOT quoted like the scalars above.
if [ -n "${APPROVERS:-}" ]; then
  params+=("$(printf '    - name: approvers\n      value: %s' "${APPROVERS}")")
fi

# --------------------------------------------------------------- create the run --
# generateName lets the API server pick the suffix, so repeated runs never
# collide. The labels are what makes an ADO-triggered run findable later.
created=$(
  oc create -o name -f - <<EOF
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  generateName: ${PIPELINE}-
  namespace: ${NS}
  labels:
    app.kubernetes.io/managed-by: azure-devops
    azure-devops/build-id: "${BUILD_BUILDID:-local}"
  annotations:
    azure-devops/build-url: "${SYSTEM_COLLECTIONURI:-}${SYSTEM_TEAMPROJECT:-}/_build/results?buildId=${BUILD_BUILDID:-}"
    azure-devops/requested-by: "${BUILD_REQUESTEDFOR:-$(whoami)}"
spec:
  pipelineRef:
    name: ${PIPELINE}
  taskRunTemplate:
    serviceAccountName: ${SA}
  timeouts:
    # Tekton defaults to 1h, which would cancel the run while it is still parked
    # on the SIT approval. Must exceed the sum of the gate waits.
    pipeline: ${TIMEOUT}
$(if [ ${#params[@]} -gt 0 ]; then printf '  params:\n'; printf '%s\n' "${params[@]}"; fi)
  workspaces:
    # The Pipeline declares workspace-helm and every task mounts it, so the run
    # has to bind it. ReadWriteOnce is enough: the tasks are strictly sequential
    # via runAfter, so only one pod holds the volume at a time.
    - name: workspace-helm
      volumeClaimTemplate:
        spec:
          accessModes: [ReadWriteOnce]
          resources:
            requests:
              storage: 1Gi
          # storageClassName: gp3-csi
EOF
)

RUN=${created#*/}
echo "PipelineRun ${NS}/${RUN}"
[ -z "${TF_BUILD:-}" ] || echo "##vso[task.setvariable variable=pipelineRunName]${RUN}"

if [ "${WAIT}" != "true" ]; then
  cat <<MSG

Created and not waiting. The run deploys test unattended, then parks on an
ApprovalTask before SIT and again before UAT. Approve in the OpenShift console,
or:

  oc get approvaltasks -n ${NS}
  opc approvaltask approve <name> -n ${NS}

Follow it with:

  tkn pipelinerun logs ${RUN} -n ${NS} -f
MSG
  exit 0
fi

# ------------------------------------------------------------------ wait for it --
# tkn returns when the run ends, but also on a dropped watch, so the Succeeded
# condition - not tkn's exit code - is what decides the result.
tkn pipelinerun logs "${RUN}" -n "${NS}" -f || true

while :; do
  status=$(oc get pipelinerun "${RUN}" -n "${NS}" \
    -o jsonpath='{.status.conditions[?(@.type=="Succeeded")].status}')
  case "${status}" in
    True)
      echo "PipelineRun ${RUN} succeeded"
      exit 0
      ;;
    False)
      oc get pipelinerun "${RUN}" -n "${NS}" -o jsonpath='{range .status.conditions[*]}{.reason}: {.message}{"\n"}{end}'
      [ -z "${TF_BUILD:-}" ] || echo "##vso[task.logissue type=error]PipelineRun ${RUN} failed"
      exit 1
      ;;
  esac
  sleep 15
done
