#!/usr/bin/env bash
#
# POSTs a promotion event to the `promotion-nonprod` Tekton Triggers
# EventListener. No cluster credential: a URL and a shared secret is the whole
# of it.
#
# Called by azure-pipelines-promotion-nonprod-webhook.yml, but it is a plain
# script with no ADO dependencies - export the same variables and it runs from a
# laptop.
#
# Required:
#   EL_URL                EventListener URL. In-cluster, for an agent on the
#                         internal network:
#                           http://el-promotion-nonprod.app-gitops.svc.cluster.local:8080
#                         or the Route's https:// host from off-cluster.
#   EL_TOKEN              shared secret, matching the `token` key of the
#                         azure-devops-webhook-secret Secret
#   APPLICATION           manifest filename under test/, sit/, uat/
#   IMAGE_NAME
#   IMAGE_TAG
# Optional:
#   IMAGE_REGISTRY WORKSPACE_NAME WORKSPACE_REPO
#                         omitted keys fall back to the TriggerTemplate's
#                         defaults, which mirror the Pipeline's
#   EL_CA_BUNDLE          CA for the Route, PEM. Omit for a publicly trusted
#                         cert or a plain-http in-cluster URL.
#
# Deliberately no `set -x`: it would echo EL_TOKEN into the build log.
set -euo pipefail

: "${EL_URL:?EL_URL is required}"
: "${EL_TOKEN:?EL_TOKEN is required}"
: "${APPLICATION:?APPLICATION is required}"
: "${IMAGE_NAME:?IMAGE_NAME is required}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"

TMP=${AGENT_TEMPDIRECTORY:-${TMPDIR:-/tmp}}

# ------------------------------------------------------------------ the body --
# Built with a here-doc rather than jq, which is not on every agent image. Every
# interpolated value is one the EventListener's CEL filter or the Pipeline's own
# params validate, and none of them can contain a quote without failing there.
payload_file="${TMP}/promotion-event.json"
{
  printf '{\n'
  printf '  "source": "azure-devops",\n'
  printf '  "application": "%s",\n' "${APPLICATION}"
  printf '  "imagename": "%s",\n' "${IMAGE_NAME}"
  printf '  "imagetag": "%s",\n' "${IMAGE_TAG}"
  [ -z "${IMAGE_REGISTRY:-}" ] || printf '  "imageregistry": "%s",\n' "${IMAGE_REGISTRY}"
  [ -z "${WORKSPACE_NAME:-}" ] || printf '  "workspace": "%s",\n' "${WORKSPACE_NAME}"
  [ -z "${WORKSPACE_REPO:-}" ] || printf '  "workspacerepo": "%s",\n' "${WORKSPACE_REPO}"
  printf '  "buildUrl": "%s",\n' "${SYSTEM_COLLECTIONURI:-}${SYSTEM_TEAMPROJECT:-}/_build/results?buildId=${BUILD_BUILDID:-}"
  printf '  "requestedBy": "%s",\n' "${BUILD_REQUESTEDFOR:-$(whoami)}"
  # Last, so no trailing comma. buildId is quoted: it ends up as a label value,
  # and the TriggerBinding expects a string.
  printf '  "buildId": "%s"\n' "${BUILD_BUILDID:-local}"
  printf '}\n'
} >"${payload_file}"

echo "Event payload:"
cat "${payload_file}"

# ------------------------------------------------------------------ the POST --
curl_args=(
  --silent --show-error
  --request POST
  --header 'Content-Type: application/json'
  --header "X-Azdo-Token: ${EL_TOKEN}"
  --data @"${payload_file}"
  # The EventListener is idempotent in neither direction, so retry only on
  # connection failures - never on a 5xx, which may have created a run already.
  --retry 3 --retry-connrefused --connect-timeout 10 --max-time 60
  --output "${TMP}/el-response.json"
  --write-out '%{http_code}'
)
if [ -n "${EL_CA_BUNDLE:-}" ]; then
  printf '%s\n' "${EL_CA_BUNDLE}" >"${TMP}/el-ca.crt"
  curl_args+=(--cacert "${TMP}/el-ca.crt")
fi

echo "POST ${EL_URL}"
code=$(curl "${curl_args[@]}" "${EL_URL}")
body=$(cat "${TMP}/el-response.json" 2>/dev/null || true)

case "${code}" in
  2*) ;;
  401 | 403)
    echo "${code}: the EventListener rejected the event." >&2
    echo "Usually X-Azdo-Token not matching the azure-devops-webhook-secret" >&2
    echo "Secret, or body.source != 'azure-devops'. The listener does not say" >&2
    echo "which; check its pod logs:" >&2
    echo "  oc logs -n app-gitops -l eventlistener=promotion-nonprod --tail=50" >&2
    exit 1
    ;;
  *)
    echo "${code}: ${body}" >&2
    exit 1
    ;;
esac

# The response names the event, not the run: {"eventListener":...,"eventID":...}
event_id=$(printf '%s' "${body}" | sed -n 's/.*"eventID"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
echo "Accepted (${code}): ${body}"
[ -z "${TF_BUILD:-}" ] || echo "##vso[task.setvariable variable=eventId]${event_id}"

cat <<MSG

A 2xx means the event was ACCEPTED, not that the PipelineRun was created - let
alone that it succeeded. Nothing in this response can tell you either, which is
the trade-off for needing no cluster credential. To find the run, from somewhere
that does have one:

  oc get pipelinerun -n app-gitops -l azure-devops/build-id=${BUILD_BUILDID:-local}
  oc get pipelinerun -n app-gitops -l triggers.tekton.dev/triggers-eventid=${event_id:-<eventID>}

If neither returns anything, the event was accepted and the run was not created.
That failure shows up only in the listener's log:

  oc logs -n app-gitops -l eventlistener=promotion-nonprod --tail=50
MSG
