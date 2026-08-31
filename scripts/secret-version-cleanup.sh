#!/usr/bin/env bash
#
# Secret Manager version cleanup — structurally safe edition.
#
# Background (incident 2026-07-26): the previous inline implementation in
# .github/workflows/cost-guardian.yml sorted versions with
# `gcloud secrets versions list --sort-by="~name"`, which is LEXICOGRAPHIC.
# Once INTERNAL_SERVICE_SECRET passed 1000 versions, "999" sorted above "1002",
# so the "newest 2" it kept were 999 and 998 and it DISABLED 1000, 1001 and 1002
# — including the version `latest` resolves to. The shorts Cloud Run service
# mounts that secret at startup, so every new instance failed to start and the
# API went hard-down for ~3.5h once the warm instances recycled.
#
# This script replaces that logic with four structural guards:
#
#   1. NUMERIC ordering (`sort -rn`) — never lexicographic.
#   2. The numerically-highest version is NEVER touched, whatever its state and
#      whatever KEEP_COUNT is. That is what the `latest` alias resolves to.
#   3. IN-USE protection — every secret version explicitly referenced by a Cloud
#      Run service or job in the project is excluded. Enumerated once per run
#      and cached; a failure to enumerate is FATAL (we never fall through to an
#      empty in-use list).
#   4. KEEP_COUNT (default 2) newest *enabled* versions are kept on top of the
#      above.
#
# BILLING TRUTH: disabling a version does NOT stop it billing. Secret Manager
# charges ~$0.06 per active secret *version* per month, and a DISABLED version
# is still an active version — only DESTROYED versions stop billing. So the
# disable pass below buys us nothing on the invoice; it is purely hygiene. The
# cost saving only materialises in the destroy pass, which is why a conservative
# destroy pass exists (`--destroy`, default OFF — see the workflow input
# `destroy_old_secret_versions`). Destroy only ever touches versions that are
# (a) not the numeric latest, (b) not in use, (c) already disabled, and
# (d) older than --destroy-age-days, capped at --destroy-cap per secret per run.
#
# Usage:
#   secret-version-cleanup.sh --project P [--keep 2]
#                             [--dry-run] [--destroy] [--destroy-age-days 90]
#                             [--destroy-cap 200] [--only-secret NAME]
#                             [--destroy-min-version N]
#                             [--destroy-max-version N] [--skip-disable]
#
# Pure sub-commands (no gcloud; used by scripts/secret-version-cleanup.test.mjs).
# Both read TSV on stdin: "<version-number>\t<state>\t<createTime RFC3339 UTC>".
#   secret-version-cleanup.sh select-disable --keep N [--in-use 12,34]
#   secret-version-cleanup.sh select-destroy --cutoff 2026-04-27T00:00:00Z \
#                             [--in-use 12,34] [--cap 200]

set -euo pipefail
export LC_ALL=C

PROJECT=""
KEEP_COUNT=2
DRY_RUN=false
DO_DESTROY=false
DESTROY_AGE_DAYS=90
DESTROY_CAP=200
ONLY_SECRET=""
DESTROY_MIN_VERSION=""
DESTROY_MAX_VERSION=""
SKIP_DISABLE=false

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Pure selection logic (unit tested)
# ---------------------------------------------------------------------------

# is_in_use <version> <csv>
is_in_use() {
  local v="$1" csv="${2:-}"
  [ -n "$csv" ] || return 1
  case ",${csv}," in
    *",${v},"*) return 0 ;;
    *) return 1 ;;
  esac
}

# numeric_latest — highest version number present, whatever its state.
# This is what the `latest` alias resolves to; it is never a cleanup candidate.
numeric_latest() {
  awk -F'\t' 'NF && $1 ~ /^[0-9]+$/ { print $1 }' | sort -rn | head -n 1
}

# select_disable <keep> <in-use-csv>  (stdin: TSV) -> version numbers to disable
select_disable() {
  local keep="$1" in_use_csv="${2:-}"
  local input latest candidates v
  input=$(cat)
  latest=$(printf '%s\n' "$input" | numeric_latest)

  candidates=$(printf '%s\n' "$input" \
    | awk -F'\t' 'NF && $1 ~ /^[0-9]+$/ && tolower($2) == "enabled" { print $1 }' \
    | sort -rn \
    | awk -v k="$keep" 'NR > k')

  while read -r v; do
    [ -n "$v" ] || continue
    # Guard 2: never the numeric latest (what `latest` resolves to).
    if [ "$v" = "$latest" ]; then continue; fi
    # Guard 3: never a version pinned by a live Cloud Run service/job.
    if is_in_use "$v" "$in_use_csv"; then continue; fi
    printf '%s\n' "$v"
  done <<EOF
$candidates
EOF
}

# select_destroy <in-use-csv> <cutoff-rfc3339> <cap>  (stdin: TSV)
# Destroys oldest-first. Only already-disabled, not-latest, not-in-use versions
# with a parseable createTime strictly older than the cutoff are eligible.
select_destroy() {
  local in_use_csv="${1:-}" cutoff="$2" cap="$3"
  local min_version="${4:-}" max_version="${5:-}"
  local input latest rows v t out=""
  input=$(cat)
  latest=$(printf '%s\n' "$input" | numeric_latest)

  rows=$(printf '%s\n' "$input" \
    | awk -F'\t' 'NF && $1 ~ /^[0-9]+$/ && tolower($2) == "disabled" { print $1 "\t" $3 }' \
    | sort -n)

  while IFS=$'\t' read -r v t; do
    [ -n "$v" ] || continue
    if [ "$v" = "$latest" ]; then continue; fi
    if is_in_use "$v" "$in_use_csv"; then continue; fi
    if [ -n "$min_version" ] && [ "$v" -lt "$min_version" ]; then continue; fi
    if [ -n "$max_version" ] && [ "$v" -gt "$max_version" ]; then continue; fi
    # Unknown/unparseable creation time => treat as too young to destroy.
    case "$t" in
      [0-9][0-9][0-9][0-9]-*) ;;
      *) continue ;;
    esac
    # RFC3339 UTC strings sort lexicographically == chronologically.
    [ "$t" \< "$cutoff" ] || continue
    out="${out}${v}"$'\n'
  done <<EOF
$rows
EOF

  printf '%s' "$out" | awk -v c="$cap" 'NF && NR <= c'
}

# ---------------------------------------------------------------------------
# Cloud Run in-use enumeration
# ---------------------------------------------------------------------------

# extract_secret_refs — stdin: a Cloud Run service/job JSON; stdout: "secret\tversion".
# Walks the whole tree so it works for both the knative (v1) and v2 shapes:
#   v1 env:     valueFrom.secretKeyRef {name, key}
#   v1 volume:  secret {secretName, items:[{key,...}]}
#   v2 env:     valueSource.secretKeyRef {secret, version}
#   v2 volume:  secret {secret, versions:[{version,...}]}
extract_secret_refs() {
  # NB: the program is fed on fd 3, NOT stdin — `python3 -` would consume the
  # heredoc AS stdin and leave the piped Cloud Run JSON unread (json.load then
  # dies on EOF). Caught in review by running against prod; a plain `-` here
  # made every nightly run fail-closed on the first describe.
  python3 /dev/fd/3 3<<'PY'
import json, sys

out = set()

def add(name, version):
    if name:
        out.add((str(name).split("/")[-1], str(version or "latest").split("/")[-1]))

def walk(node):
    if isinstance(node, dict):
        ref = node.get("secretKeyRef")
        if isinstance(ref, dict):
            add(ref.get("name") or ref.get("secret"),
                ref.get("key") or ref.get("version"))
        name = node.get("secretName")
        if isinstance(name, str):
            items = node.get("items") or []
            if items:
                for it in items:
                    if isinstance(it, dict):
                        add(name, it.get("key") or it.get("version"))
            else:
                add(name, "latest")
        sec = node.get("secret")
        if isinstance(sec, str):
            vers = node.get("versions") or node.get("items") or []
            if vers:
                for it in vers:
                    if isinstance(it, dict):
                        add(sec, it.get("version") or it.get("key"))
            else:
                add(sec, "latest")
        for v in node.values():
            walk(v)
    elif isinstance(node, list):
        for v in node:
            walk(v)

try:
    doc = json.load(sys.stdin)
except Exception as exc:  # noqa: BLE001 - surfaced as a hard failure by caller
    sys.stderr.write("failed to parse Cloud Run JSON: %s\n" % exc)
    sys.exit(1)

walk(doc)
for name, version in sorted(out):
    print("%s\t%s" % (name, version))
PY
}

# collect_in_use <project> <outfile> — FATAL on any enumeration failure.
collect_in_use() {
  local project="$1" outfile="$2"
  local region res name
  : > "$outfile"

  command -v python3 >/dev/null 2>&1 || die "python3 is required to enumerate Cloud Run secret references"

  # Regions are DISCOVERED, not hardcoded: a region-filtered list silently
  # misses resources (review found a dev job in asia-northeast1 holding a
  # secret ref that the old hardcoded list couldn't see — invisible in-use
  # refs are exactly the outage class this script exists to prevent). A
  # no-region `gcloud run <res> list` returns every region; the location
  # label gives us the region for the follow-up describe. The old
  # --regions flag is gone: discovery covers everything.
  for res in services jobs; do
    local listing
    if ! listing=$(gcloud run "$res" list --project="$project" \
          --format="value(metadata.name,metadata.labels.'cloud.googleapis.com/location')" 2>&1); then
      die "failed to list Cloud Run $res across all regions ($project): $listing — refusing to disable/destroy anything"
    fi
    while IFS=$'\t' read -r name region; do
      [ -z "$name" ] && continue
      [ -z "$region" ] && die "no region label for Cloud Run $res/$name ($project) — refusing to continue with a partial view"
      local json
      if ! json=$(gcloud run "$res" describe "$name" --project="$project" --region="$region" \
            --format=json 2>&1); then
        die "failed to describe Cloud Run $res/$name in $region ($project) — refusing to disable/destroy anything"
      fi
      printf '%s' "$json" | extract_secret_refs >> "$outfile" \
        || die "failed to extract secret refs from $res/$name in $region ($project)"
    done <<< "$listing"
  done

  sort -u -o "$outfile" "$outfile"
}

# ---------------------------------------------------------------------------
# Main cleanup
# ---------------------------------------------------------------------------

run_cleanup() {
  [ -n "$PROJECT" ] || die "--project is required"

  if [ -n "$DESTROY_MIN_VERSION" ] || [ -n "$DESTROY_MAX_VERSION" ]; then
    [ -n "$DESTROY_MIN_VERSION" ] && [ -n "$DESTROY_MAX_VERSION" ] \
      || die "--destroy-min-version and --destroy-max-version must be supplied together"
    [[ "$DESTROY_MIN_VERSION" =~ ^[0-9]+$ ]] && [[ "$DESTROY_MAX_VERSION" =~ ^[0-9]+$ ]] \
      || die "destroy version bounds must be numeric"
    [ "$DESTROY_MIN_VERSION" -le "$DESTROY_MAX_VERSION" ] \
      || die "destroy minimum version must not exceed maximum version"
    [ "$DO_DESTROY" = "true" ] \
      || die "destroy version bounds require --destroy"
  fi

  log "=== Secret Manager cleanup: $PROJECT ==="
  log "keep=$KEEP_COUNT dry_run=$DRY_RUN destroy=$DO_DESTROY destroy_age_days=$DESTROY_AGE_DAYS destroy_cap=$DESTROY_CAP only_secret=${ONLY_SECRET:-all} destroy_range=${DESTROY_MIN_VERSION:-all}-${DESTROY_MAX_VERSION:-all} skip_disable=$SKIP_DISABLE"
  log ""

  local in_use_file
  in_use_file=$(mktemp)
  # shellcheck disable=SC2064  # expand now: $in_use_file is stable
  trap "rm -f '$in_use_file'" EXIT

  log "Enumerating secret versions referenced by live Cloud Run services and jobs..."
  collect_in_use "$PROJECT" "$in_use_file"
  local ref_count
  ref_count=$(grep -c . "$in_use_file" || true)
  log "  Protected: $ref_count distinct (secret, version) references"

  # Sanity floor: both projects run services that mount secrets. Zero refs means
  # the enumeration silently produced nothing — exactly the condition that must
  # never be allowed to fall through to a disable pass.
  if [ "$ref_count" -lt 1 ]; then
    die "no Cloud Run secret references found — enumeration is suspect; refusing to disable/destroy anything"
  fi

  local cutoff=""
  if [ "$DO_DESTROY" = "true" ]; then
    cutoff=$(rfc3339_days_ago "$DESTROY_AGE_DAYS")
    log "  Destroy cutoff: versions created before $cutoff"
  fi
  log ""

  local total_disabled=0 total_destroyed=0 secret versions in_use_csv to_disable to_destroy ver secrets
  if [ -n "$ONLY_SECRET" ]; then
    secrets="$ONLY_SECRET"
  elif ! secrets=$(gcloud secrets list --project="$PROJECT" --format="value(name)" 2>&1); then
    die "failed to list secrets for project $PROJECT — refusing to continue"
  fi

  for secret in $secrets; do
    if ! versions=$(gcloud secrets versions list "$secret" --project="$PROJECT" \
          --format="value(name,state,createTime.date(tz='UTC', format='%Y-%m-%dT%H:%M:%SZ'))" 2>&1); then
      die "failed to list versions for secret $secret — refusing to continue"
    fi

    in_use_csv=$(awk -F'\t' -v s="$secret" '$1 == s && $2 ~ /^[0-9]+$/ { print $2 }' "$in_use_file" \
      | sort -un | paste -sd, - | tr -d '[:space:]')

    to_disable=""
    if [ "$SKIP_DISABLE" != "true" ]; then
      to_disable=$(printf '%s\n' "$versions" | select_disable "$KEEP_COUNT" "$in_use_csv")
    fi

    if [ -n "$to_disable" ]; then
      log "$secret: disabling $(printf '%s\n' "$to_disable" | grep -c .) versions (keep=$KEEP_COUNT, latest protected, in-use=[${in_use_csv:-none}])"
      while read -r ver; do
        [ -n "$ver" ] || continue
        if [ "$DRY_RUN" = "true" ]; then
          log "  DRY RUN: would disable $secret/$ver"
        elif gcloud secrets versions disable "$ver" --secret="$secret" --project="$PROJECT" --quiet 2>/dev/null; then
          total_disabled=$((total_disabled + 1))
        else
          log "  Failed to disable $secret version $ver"
        fi
      done <<EOF
$to_disable
EOF
    fi

    if [ "$DO_DESTROY" = "true" ]; then
      # Re-read state so versions disabled a moment ago are not destroyed in the
      # same run (they are not yet older than the age cutoff anyway, but the
      # re-read keeps the two passes honest).
      to_destroy=$(printf '%s\n' "$versions" | select_destroy "$in_use_csv" "$cutoff" "$DESTROY_CAP" "$DESTROY_MIN_VERSION" "$DESTROY_MAX_VERSION")
      if [ -n "$to_destroy" ]; then
        log "$secret: destroying $(printf '%s\n' "$to_destroy" | grep -c .) versions (disabled + older than ${DESTROY_AGE_DAYS}d, cap=$DESTROY_CAP)"
        while read -r ver; do
          [ -n "$ver" ] || continue
          if [ "$DRY_RUN" = "true" ]; then
            log "  DRY RUN: would destroy $secret/$ver"
          elif gcloud secrets versions destroy "$ver" --secret="$secret" --project="$PROJECT" --quiet 2>/dev/null; then
            total_destroyed=$((total_destroyed + 1))
          else
            log "  Failed to destroy $secret version $ver"
          fi
        done <<EOF
$to_destroy
EOF
      fi
    fi
  done

  log ""
  log "=== Cleanup complete: disabled $total_disabled, destroyed $total_destroyed ==="
}

# rfc3339_days_ago <days> — GNU date on the runner, BSD date locally.
rfc3339_days_ago() {
  local days="$1"
  date -u -d "${days} days ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -v "-${days}d" +%Y-%m-%dT%H:%M:%SZ
}

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------

main() {
  local sub="${1:-}"
  case "$sub" in
    select-disable)
      shift
      local keep=2 in_use=""
      while [ $# -gt 0 ]; do
        case "$1" in
          --keep) keep="$2"; shift 2 ;;
          --in-use) in_use="$2"; shift 2 ;;
          *) die "unknown arg for select-disable: $1" ;;
        esac
      done
      select_disable "$keep" "$in_use"
      return 0
      ;;
    select-destroy)
      shift
      local in_use="" cutoff="" cap=200 min_version="" max_version=""
      while [ $# -gt 0 ]; do
        case "$1" in
          --in-use) in_use="$2"; shift 2 ;;
          --cutoff) cutoff="$2"; shift 2 ;;
          --cap) cap="$2"; shift 2 ;;
          --min-version) min_version="$2"; shift 2 ;;
          --max-version) max_version="$2"; shift 2 ;;
          *) die "unknown arg for select-destroy: $1" ;;
        esac
      done
      [ -n "$cutoff" ] || die "select-destroy requires --cutoff"
      select_destroy "$in_use" "$cutoff" "$cap" "$min_version" "$max_version"
      return 0
      ;;
  esac

  while [ $# -gt 0 ]; do
    case "$1" in
      --project) PROJECT="$2"; shift 2 ;;
      --keep) KEEP_COUNT="$2"; shift 2 ;;
      --dry-run) DRY_RUN=true; shift ;;
      --destroy) DO_DESTROY=true; shift ;;
      --destroy-age-days) DESTROY_AGE_DAYS="$2"; shift 2 ;;
      --destroy-cap) DESTROY_CAP="$2"; shift 2 ;;
      --only-secret) ONLY_SECRET="$2"; shift 2 ;;
      --destroy-min-version) DESTROY_MIN_VERSION="$2"; shift 2 ;;
      --destroy-max-version) DESTROY_MAX_VERSION="$2"; shift 2 ;;
      --skip-disable) SKIP_DISABLE=true; shift ;;
      -h|--help) sed -n '2,40p' "$0"; return 0 ;;
      *) die "unknown arg: $1" ;;
    esac
  done

  run_cleanup
}

main "$@"
