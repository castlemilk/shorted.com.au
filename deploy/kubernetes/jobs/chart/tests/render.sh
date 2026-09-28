#!/usr/bin/env bash
# Render contract for the shorted-jobs chart. Needs helm + yq (mikefarah v4).
#
#   deploy/kubernetes/jobs/chart/tests/render.sh
#
# Guards the properties that would page someone (or silently not) if they
# drifted: nothing runs until explicitly enabled, every schedule still matches
# the Cloud Scheduler trigger it replaced, per-workload secret isolation, keyless
# GCP auth only where a job writes to GCS, and immutable image tags.
set -euo pipefail

chart="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "${chart}/../../../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

fails=0
fail() { echo "FAIL: $*" >&2; fails=$((fails + 1)); }
pass() { echo "ok   $*"; }

render() { helm template shorted-jobs "${chart}" --namespace shorted-jobs "$@"; }

helm lint "${chart}" >/dev/null && pass "helm lint"
render >"${tmp}/default.yaml"

cronjobs() { yq -N 'select(.kind == "CronJob") | .metadata.name' "$1" | sort; }
field() { # field <file> <cronjob> <yq expr on the CronJob>
  yq -N "select(.kind == \"CronJob\" and .metadata.name == \"$2\") | $3" "$1"
}
secret_key() { # secret_key <file> <cronjob> <ENV>
  field "$1" "$2" ".spec.jobTemplate.spec.template.spec.containers[0].env[] | select(.name == \"$3\") | .valueFrom.secretKeyRef.key"
}

# --- 1. The schedule table: CronJob -> the Cloud Scheduler cron it replaces. --
# Each cron string must ALSO still appear in the Terraform that defines the
# Cloud Run trigger, so a schedule changed on one side only fails here.
declare -A want_schedule=(
  [shorts-data-sync]="0 10 * * *"
  [house-price-collector-monthly]="0 16 5 * *"
  [house-price-collector-drop-index]="0 18 * * *"
  [influence-collector-monthly]="0 18 5 * *"
  [shorted-announcements]="0 11 * * *"
  [shorted-index-sync]="30 11 * * *"
  [shorted-price-sync]="0 10 * * 1-5"
  [shorted-picks]="30 13 * * 1-5"
  [shorted-picks-fundamentals]="0 15 * * *"
  [shorted-economy]="0 17 5 * *"
  [shorted-weekly-report]="0 11 * * 5"
  [shorted-weekly-report-monthly]="0 1 1 * *"
  [shorted-news]="0 */4 * * *"
  [shorted-news-backfill-images]="0 3 * * *"
  [shorted-news-resolve-googlenews]="0 4 * * 1"
  [shorted-news-cluster]="30 */2 * * *"
  [shorted-news-digest]="0 1 * * 5"
  [shorted-signals]="0 13 * * 1"
  [director-trade-extractor]="30 12 * * *"
  [financial-report-extractor]="0 14 * * *"
  [asx-discovery]="0 12 * * 0"
)

got_names="$(cronjobs "${tmp}/default.yaml")"
want_names="$(printf '%s\n' "${!want_schedule[@]}" | sort)"
if [[ "${got_names}" == "${want_names}" ]]; then
  pass "exactly the ${#want_schedule[@]} expected CronJobs render"
else
  fail "CronJob set drifted:"$'\n'"$(diff <(echo "${want_names}") <(echo "${got_names}") || true)"
fi

tf_sources="$(cat "${repo_root}"/terraform/environments/prod/main.tf "${repo_root}"/terraform/modules/*/main.tf "${repo_root}"/terraform/modules/*/variables.tf)"
for name in "${!want_schedule[@]}"; do
  want="${want_schedule[${name}]}"
  got="$(field "${tmp}/default.yaml" "${name}" '.spec.schedule')"
  [[ "${got}" == "${want}" ]] || fail "${name}: schedule '${got}' != '${want}'"
  grep -qF "\"${want}\"" <<<"${tf_sources}" || fail "${name}: '${want}' no longer appears in Terraform — was the Cloud Scheduler trigger changed without the CronJob?"
  [[ "$(field "${tmp}/default.yaml" "${name}" '.spec.timeZone')" == "Etc/UTC" ]] || fail "${name}: timeZone must be Etc/UTC"
done
pass "schedules match the Cloud Scheduler triggers (UTC)"

# --- 2. Nothing runs by default; enabling is per job and needs suspendAll=false.
if [[ -z "$(yq -N 'select(.kind == "CronJob" and .spec.suspend != true) | .metadata.name' "${tmp}/default.yaml")" ]]; then
  pass "every CronJob is suspended by default"
else
  fail "a CronJob renders unsuspended with default values"
fi

render --set suspendAll=false --set 'enabled[0]=shorts-data-sync' >"${tmp}/one.yaml"
live="$(yq -N 'select(.kind == "CronJob" and .spec.suspend == false) | .metadata.name' "${tmp}/one.yaml")"
[[ "${live}" == "shorts-data-sync" ]] && pass "enabled[] unsuspends only the listed job" || fail "enabled[] live set = '${live}'"

render --set 'enabled[0]=shorts-data-sync' >"${tmp}/guarded.yaml"
[[ -z "$(yq -N 'select(.kind == "CronJob" and .spec.suspend == false) | .metadata.name' "${tmp}/guarded.yaml")" ]] \
  && pass "suspendAll=true overrides enabled[]" || fail "suspendAll=true did not hold"

# --- 3. Secrets: one Secret, and per-workload Gemini key isolation. ----------
bad_refs="$(yq -N 'select(.kind == "CronJob") | .spec.jobTemplate.spec.template.spec.containers[0].env[] | select(.valueFrom.secretKeyRef) | select(.valueFrom.secretKeyRef.name != "shorted-jobs-env") | .name' "${tmp}/default.yaml")"
[[ -z "${bad_refs}" ]] && pass "every secretKeyRef targets shorted-jobs-env" || fail "secretKeyRefs outside shorted-jobs-env: ${bad_refs}"

for job in shorted-news shorted-news-backfill-images shorted-news-resolve-googlenews shorted-news-cluster shorted-news-digest; do
  [[ "$(secret_key "${tmp}/default.yaml" "${job}" GEMINI_API_KEY)" == "GEMINI_API_KEY_NEWS" ]] || fail "${job}: GEMINI_API_KEY must come from GEMINI_API_KEY_NEWS"
done
for job in director-trade-extractor financial-report-extractor; do
  [[ "$(secret_key "${tmp}/default.yaml" "${job}" GEMINI_API_KEY)" == "GEMINI_API_KEY_REPORT_EXTRACTOR" ]] || fail "${job}: GEMINI_API_KEY must come from GEMINI_API_KEY_REPORT_EXTRACTOR"
done
[[ "$(secret_key "${tmp}/default.yaml" financial-report-extractor LANGEXTRACT_API_KEY)" == "GEMINI_API_KEY_REPORT_EXTRACTOR" ]] || fail "financial-report-extractor: LANGEXTRACT_API_KEY key"
for job in shorted-weekly-report shorted-weekly-report-monthly; do
  [[ "$(secret_key "${tmp}/default.yaml" "${job}" GEMINI_API_KEY)" == "GEMINI_API_KEY" ]] || fail "${job}: GEMINI_API_KEY key"
done
pass "Gemini keys stay isolated per workload"

# --- 4. Keyless GCP auth only where a job writes to GCS. ----------------------
wif_jobs="$(yq -N 'select(.kind == "CronJob") | select(.spec.jobTemplate.spec.template.spec.containers[0].env[] | select(.name == "GOOGLE_APPLICATION_CREDENTIALS")) | .metadata.name' "${tmp}/default.yaml" | sort | tr '\n' ' ')"
[[ "${wif_jobs}" == "asx-discovery financial-report-extractor shorted-price-sync " ]] && pass "WIF only on the GCS-writing jobs" || fail "WIF job set = '${wif_jobs}'"
grep -q '//iam.googleapis.com/projects/334313144667/locations/global/workloadIdentityPools/vke-omega/providers/omega' "${tmp}/default.yaml" \
  && pass "WIF audience targets rosy-clover's vke-omega/omega provider" || fail "WIF audience missing"
grep -Eq 'google-application-credentials\.json|gcpCredentials|private_key' "${tmp}/default.yaml" && fail "JSON-key credential wiring rendered" || pass "no JSON-key credentials"

# --- 5. Images, resume key, per-attempt deadlines, monitoring labels. --------
yq -N 'select(.kind == "CronJob" or .kind == "Deployment") | .. | select(has("image")) | .image' "${tmp}/default.yaml" | grep -Eq ':latest$|:$' \
  && fail "a mutable or empty image tag rendered" || pass "images pinned to immutable tags"
missing_exec="$(yq -N 'select(.kind == "CronJob") | select([.spec.jobTemplate.spec.template.spec.containers[0].env[] | select(.name == "CLOUD_RUN_EXECUTION")] | length == 0) | .metadata.name' "${tmp}/default.yaml")"
[[ -z "${missing_exec}" ]] && pass "CLOUD_RUN_EXECUTION (resume key) injected everywhere" || fail "missing CLOUD_RUN_EXECUTION: ${missing_exec}"
attempt_src="$(field "${tmp}/default.yaml" shorted-picks '.spec.jobTemplate.spec.template.spec.containers[0].env[] | select(.name == "CLOUD_RUN_TASK_ATTEMPT") | .valueFrom.fieldRef.fieldPath')"
[[ "${attempt_src}" == "metadata.annotations['batch.kubernetes.io/job-index-failure-count']" ]] \
  && [[ "$(field "${tmp}/default.yaml" shorted-picks '.spec.jobTemplate.spec.completionMode')" == "Indexed" ]] \
  && pass "CLOUD_RUN_TASK_ATTEMPT comes from the Indexed Job's per-index failure count" || fail "CLOUD_RUN_TASK_ATTEMPT wiring"
[[ "$(field "${tmp}/default.yaml" house-price-collector-drop-index '.spec.jobTemplate.spec.template.spec.activeDeadlineSeconds')" == "14400" ]] \
  && pass "drop-index keeps its 4h per-attempt timeout" || fail "drop-index timeout"
[[ "$(field "${tmp}/default.yaml" director-trade-extractor '.spec.jobTemplate.spec.backoffLimitPerIndex')" == "0" ]] \
  && pass "extractors keep max_retries=0" || fail "director-trade-extractor backoffLimit"
unlabelled="$(yq -N 'select(.kind == "CronJob") | select(.spec.jobTemplate.metadata.labels["shorted.com.au/cron-monitor"] != "true") | .metadata.name' "${tmp}/default.yaml")"
[[ -z "${unlabelled}" ]] && pass "every CronJob is opted into the reporter" || fail "not monitored: ${unlabelled}"
[[ "$(yq -N 'select(.kind == "Deployment" and .metadata.name == "cronjob-reporter") | .spec.template.spec.containers[0].args[0]' "${tmp}/default.yaml")" == "cronjob-reporter" ]] \
  && pass "reporter Deployment renders" || fail "reporter Deployment missing"

# --- 6. Render-time guards fail loudly. -------------------------------------
render --set 'jobs.shorted-news.image=nope' >/dev/null 2>&1 && fail "unknown image key rendered" || pass "unknown image key fails the render"
render --set 'images.jobs.tag=' >/dev/null 2>&1 && fail "empty image tag rendered" || pass "empty image tag fails the render"
render --set 'jobs.shorted-news.profiles[0]=nope' >/dev/null 2>&1 && fail "unknown profile rendered" || pass "unknown profile fails the render"

if ((fails > 0)); then
  echo "${fails} check(s) failed" >&2
  exit 1
fi
echo "all chart checks passed"
