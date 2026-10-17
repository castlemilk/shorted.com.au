#!/usr/bin/env bash
# Copy the GCP Secret Manager secrets the jobs read into the `shorted-jobs-env`
# Kubernetes Secret on omega. Keys are the Secret Manager ids verbatim.
#
#   KUBECONFIG=... CLOUDSDK_CORE_ACCOUNT=ben@shorted.com.au \
#     deploy/kubernetes/jobs/scripts/sync-secrets.sh             # list what would sync
#   ... CONFIRM=prod deploy/kubernetes/jobs/scripts/sync-secrets.sh   # write it
#
# The key list is derived from the rendered chart (every secretKeyRef into the
# Secret), so it cannot drift from what the jobs actually reference. Values
# never touch disk or stdout: they stream from gcloud into a JSON document on a
# pipe into `kubectl apply`.
#
# Secret Manager stays the source of truth. After rotating a secret there,
# re-run this script; the next job run picks it up (env is read at pod start).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-rosy-clover-477102-t5}"
NAMESPACE="${NAMESPACE:-shorted-jobs}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chart="${here}/../chart"

for bin in kubectl gcloud helm yq jq; do
  command -v "${bin}" >/dev/null 2>&1 || { echo "${bin} is required" >&2; exit 1; }
done

secret_name="$(yq '.secretEnv.secretName' "${chart}/values.yaml")"
keys="$(helm template shorted-jobs "${chart}" --namespace "${NAMESPACE}" \
  | yq -N '.. | select(has("secretKeyRef")) | .secretKeyRef | select(.name == "'"${secret_name}"'") | .key' \
  | sort -u)"

echo "==> ${secret_name} in ${NAMESPACE} (context $(kubectl config current-context)) needs $(wc -l <<<"${keys}" | tr -d ' ') keys:"
missing=0
while read -r key; do
  if gcloud secrets describe "${key}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    echo "    ${key}"
  else
    echo "    ${key}  <-- MISSING in Secret Manager (${PROJECT_ID})" >&2
    missing=1
  fi
done <<<"${keys}"
if ((missing)); then
  echo "refusing to sync a partial Secret: a job would start with an empty credential" >&2
  exit 1
fi

if [[ "${CONFIRM:-}" != "prod" ]]; then
  echo "==> PLAN ONLY — re-run with CONFIRM=prod to write the Secret"
  exit 0
fi

# Build the Secret without a value ever reaching disk, stdout or a process
# argument list (argv is world-readable via ps): `printf` is a shell builtin, and
# jq reads the key<TAB>base64 pairs from its stdin.
while read -r key; do
  value_b64="$(gcloud secrets versions access latest --secret "${key}" --project "${PROJECT_ID}" | base64 | tr -d '\n')"
  printf '%s\t%s\n' "${key}" "${value_b64}"
done <<<"${keys}" | jq -R -s --arg name "${secret_name}" --arg ns "${NAMESPACE}" '
  (split("\n") | map(select(length > 0) | split("\t") | {(.[0]): .[1]}) | add) as $data
  | {
      apiVersion: "v1", kind: "Secret", type: "Opaque",
      metadata: {name: $name, namespace: $ns, labels: {"app.kubernetes.io/part-of": "shorted", "shorted.com.au/synced-from": "gcp-secret-manager"}},
      data: $data
    }' | kubectl apply -f -

echo "==> synced $(wc -l <<<"${keys}" | tr -d ' ') keys into ${NAMESPACE}/${secret_name}"
