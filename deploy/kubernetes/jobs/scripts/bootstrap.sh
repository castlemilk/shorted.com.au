#!/usr/bin/env bash
# One-time (idempotent) bootstrap of the omega VKE cluster + GCP for shorted-jobs.
#
#   KUBECONFIG=~/projects/paprika/terraform/omega.kubeconfig \
#   CLOUDSDK_CORE_ACCOUNT=ben@shorted.com.au \
#     deploy/kubernetes/jobs/scripts/bootstrap.sh            # plan (prints only)
#   ... CONFIRM=prod deploy/kubernetes/jobs/scripts/bootstrap.sh   # apply
#
# What it does, in order:
#   1. Namespace `shorted-jobs`.
#   2. Image pull secret `shorted-gar`: a read-only Artifact Registry key for a
#      dedicated puller SA. Runtime Workload Identity does NOT cover kubelet image
#      pulls — every tenant on omega carries a pull secret for this reason
#      (telesis-gar, brandbrain-gar, ...). Skipped if the secret exists; set
#      ROTATE_PULL_KEY=1 to mint a fresh key.
#   3. Google Workload Identity Federation in rosy-clover-477102-t5: pool
#      `vke-omega`, OIDC provider `omega` trusting the cluster's service-account
#      issuer (JWKS uploaded, since the VKE issuer is not publicly discoverable),
#      restricted to the `shorted-jobs` namespace. Then one
#      roles/iam.workloadIdentityUser grant per KSA the chart renders with a
#      `shorted.com.au/google-service-account` annotation — each job keeps the
#      exact Google identity (and bucket IAM) its Cloud Run job had.
#
# Re-run step 3 whenever the cluster's service-account signing keys rotate (the
# uploaded JWKS goes stale and every WIF exchange starts failing with
# invalid_grant): `ONLY=wif CONFIRM=prod scripts/bootstrap.sh`.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-rosy-clover-477102-t5}"
NAMESPACE="${NAMESPACE:-shorted-jobs}"
POOL_ID="${WIF_POOL_ID:-vke-omega}"
PROVIDER_ID="${WIF_PROVIDER_ID:-omega}"
AR_LOCATION="${AR_LOCATION:-australia-southeast2}"
AR_REPOSITORY="${AR_REPOSITORY:-shorted}"
PULLER_SA_NAME="${PULLER_SA_NAME:-vke-omega-image-puller}"
ONLY="${ONLY:-all}" # all | namespace | pull | wif

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chart="${here}/../chart"

need() { command -v "$1" >/dev/null 2>&1 || { echo "$1 is required" >&2; exit 1; }; }
need kubectl
need gcloud
need helm
need jq
need yq

apply=false
if [[ "${CONFIRM:-}" == "prod" ]]; then
  apply=true
fi
run() {
  if $apply; then
    "$@"
  else
    printf '[plan]'
    printf ' %q' "$@"
    echo
  fi
}

ctx="$(kubectl config current-context 2>/dev/null || echo '?')"
echo "==> cluster context: ${ctx}   GCP project: ${PROJECT_ID}   account: $(gcloud config get-value account 2>/dev/null)"
$apply || echo "==> PLAN ONLY — re-run with CONFIRM=prod to apply"

project_number="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
chart_project_number="$(yq '.workloadIdentity.projectNumber' "${chart}/values.yaml")"
if [[ "${project_number}" != "${chart_project_number}" ]]; then
  echo "values.yaml workloadIdentity.projectNumber=${chart_project_number} but ${PROJECT_ID} is ${project_number}" >&2
  exit 1
fi

# --- 1. Namespace -----------------------------------------------------------
if [[ "${ONLY}" == all || "${ONLY}" == namespace ]]; then
  echo "==> namespace ${NAMESPACE}"
  if $apply; then
    kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml \
      | kubectl label --local -f - app.kubernetes.io/part-of=shorted -o yaml \
      | kubectl apply -f -
  else
    run kubectl create namespace "${NAMESPACE}"
  fi
fi

# --- 2. Artifact Registry pull secret ---------------------------------------
if [[ "${ONLY}" == all || "${ONLY}" == pull ]]; then
  puller="${PULLER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
  echo "==> image pull secret shorted-gar (reader SA ${puller})"
  if kubectl -n "${NAMESPACE}" get secret shorted-gar >/dev/null 2>&1 && [[ "${ROTATE_PULL_KEY:-0}" != 1 ]]; then
    echo "    exists — skipping (ROTATE_PULL_KEY=1 to rotate)"
  else
    if ! gcloud iam service-accounts describe "${puller}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
      run gcloud iam service-accounts create "${PULLER_SA_NAME}" --project "${PROJECT_ID}" \
        --display-name "omega VKE image puller (read-only Artifact Registry)"
    fi
    run gcloud artifacts repositories add-iam-policy-binding "${AR_REPOSITORY}" \
      --project "${PROJECT_ID}" --location "${AR_LOCATION}" \
      --member "serviceAccount:${puller}" --role roles/artifactregistry.reader --condition=None
    if $apply; then
      # Key and docker config live only in 0600 temp files and pipes — never in
      # a process argument list.
      umask 077
      keyfile="$(mktemp)"
      cfgfile="$(mktemp)"
      trap 'rm -f "${keyfile}" "${cfgfile}"' EXIT
      # IAM is eventually consistent: a just-created SA can 404 for a while.
      for attempt in 1 2 3 4 5 6; do
        if gcloud iam service-accounts keys create "${keyfile}" --iam-account "${puller}" --project "${PROJECT_ID}"; then
          break
        fi
        [[ "${attempt}" == 6 ]] && { echo "could not mint a key for ${puller}" >&2; exit 1; }
        sleep $((attempt * 5))
      done
      jq -n --rawfile key "${keyfile}" --arg server "${AR_LOCATION}-docker.pkg.dev" \
        '{auths: {($server): {username: "_json_key", password: $key, auth: ("_json_key:" + $key | @base64)}}}' >"${cfgfile}"
      kubectl -n "${NAMESPACE}" create secret generic shorted-gar \
        --type kubernetes.io/dockerconfigjson \
        --from-file .dockerconfigjson="${cfgfile}" \
        --dry-run=client -o yaml | kubectl apply -f -
      rm -f "${keyfile}" "${cfgfile}"
    else
      run gcloud iam service-accounts keys create KEYFILE --iam-account "${puller}"
      run kubectl -n "${NAMESPACE}" create secret docker-registry shorted-gar "..."
    fi
  fi
fi

# --- 3. Workload Identity Federation ----------------------------------------
if [[ "${ONLY}" == all || "${ONLY}" == wif ]]; then
  issuer="$(kubectl get --raw /.well-known/openid-configuration | jq -r '.issuer')"
  if [[ -z "${issuer}" || "${issuer}" == null ]]; then
    echo "cluster OIDC discovery returned no issuer" >&2
    exit 1
  fi
  jwks="$(mktemp)"
  kubectl get --raw /openid/v1/jwks >"${jwks}"
  audience="//iam.googleapis.com/projects/${project_number}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
  mapping="google.subject=assertion.sub,attribute.namespace=assertion['kubernetes.io']['namespace'],attribute.service_account_name=assertion['kubernetes.io']['serviceaccount']['name']"
  # Only this namespace may exchange tokens in THIS project's pool.
  condition="assertion.sub.startsWith('system:serviceaccount:${NAMESPACE}:')"

  echo "==> WIF pool ${POOL_ID} / provider ${PROVIDER_ID} (issuer ${issuer})"
  run gcloud services enable sts.googleapis.com iamcredentials.googleapis.com --project "${PROJECT_ID}"
  if ! gcloud iam workload-identity-pools describe "${POOL_ID}" --project "${PROJECT_ID}" --location global >/dev/null 2>&1; then
    run gcloud iam workload-identity-pools create "${POOL_ID}" --project "${PROJECT_ID}" --location global \
      --display-name "VKE omega" --description "Vultr VKE omega Kubernetes service accounts (shorted-jobs)"
  fi
  verb=create-oidc
  if gcloud iam workload-identity-pools providers describe "${PROVIDER_ID}" --project "${PROJECT_ID}" \
    --location global --workload-identity-pool "${POOL_ID}" >/dev/null 2>&1; then
    verb=update-oidc
  fi
  run gcloud iam workload-identity-pools providers "${verb}" "${PROVIDER_ID}" \
    --project "${PROJECT_ID}" --location global --workload-identity-pool "${POOL_ID}" \
    --display-name "omega VKE" --issuer-uri "${issuer}" --jwk-json-path "${jwks}" \
    --allowed-audiences "${audience}" --attribute-mapping "${mapping}" --attribute-condition "${condition}"

  # KSA -> GSA pairs straight from the chart, so a job that gains a
  # gcpServiceAccount gets its trust on the next bootstrap run.
  pairs="$(helm template shorted-jobs "${chart}" --namespace "${NAMESPACE}" \
    | yq -N 'select(.kind == "ServiceAccount" and .metadata.annotations["shorted.com.au/google-service-account"]) | .metadata.name + "|" + .metadata.annotations["shorted.com.au/google-service-account"]')"
  while IFS='|' read -r ksa gsa; do
    [[ -n "${ksa}" ]] || continue
    principal="principal://iam.googleapis.com/projects/${project_number}/locations/global/workloadIdentityPools/${POOL_ID}/subject/system:serviceaccount:${NAMESPACE}:${ksa}"
    echo "==> ${NAMESPACE}/${ksa} may impersonate ${gsa}"
    run gcloud iam service-accounts add-iam-policy-binding "${gsa}" --project "${PROJECT_ID}" \
      --role roles/iam.workloadIdentityUser --member "${principal}" --condition=None
  done <<<"${pairs}"
  rm -f "${jwks}"

  # cronjob-reporter reads Cloud Scheduler attempts for the HTTP-triggered
  # syncs (chart schedulerMonitors). Cloud Scheduler has no per-job IAM, so
  # this one read-only role is project-level; CI cannot write project IAM.
  reporter_gsa="vke-cronjob-reporter@${PROJECT_ID}.iam.gserviceaccount.com"
  if gcloud iam service-accounts describe "${reporter_gsa}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    echo "==> ${reporter_gsa}: roles/cloudscheduler.viewer (project)"
    run gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
      --member "serviceAccount:${reporter_gsa}" --role roles/cloudscheduler.viewer --condition=None
  else
    echo "==> ${reporter_gsa} not created yet (Terraform creates it); re-run after the deploy"
  fi
fi

echo "==> bootstrap $($apply && echo applied || echo planned). Next: scripts/sync-secrets.sh, then scripts/register-monitors.py."
