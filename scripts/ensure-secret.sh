#!/usr/bin/env bash
#
# ensure-secret.sh NAME [VALUE|-]  (project from $GCP_PROJECT_ID)
#
# VALUE "-" reads the value from stdin, and every deploy caller passes it that way.
# An argument is in the process table (ps) for every gcloud call this script makes,
# so a VALUE argument is for an operator at a terminal only.
#
# Creates a Secret Manager secret if missing, and adds a new version ONLY when
# the value has actually changed. Single source of truth for the three
# near-identical `ensure_secret()` copies that used to live inline in
# .github/workflows/terraform-deploy.yml.
#
# WHY THIS EXISTS (incident 2026-07-26): the inline version compared
#
#     CURRENT=$(gcloud secrets versions access latest ...)
#     if [ "$CURRENT" = "$value" ]
#
# Command substitution `$(...)` strips ALL trailing newlines from what it
# captures. If the GitHub Actions secret carries a trailing newline (easy to do
# when pasting into the GH UI), `$value` keeps it and `$CURRENT` cannot — so the
# comparison NEVER matched and every single deploy added a brand-new version.
# INTERNAL_SERVICE_SECRET reached 1,002 versions that way, which then tripped
# the lexicographic sort bug in the cost-guardian cleanup and took the API down.
#
# Two deliberate fixes:
#   1. Compare content-robustly by sha256 of the bytes, not by shell string
#      equality (safe for multi-line/odd values).
#   2. Normalise the trailing-newline asymmetry: strip trailing CR/LF from BOTH
#      sides before hashing. The read path already strips them, and storing a
#      value whose only difference is a trailing newline is churn forever. We
#      always WRITE with `printf %s` (no trailing newline), so the stored value
#      and the normalised GH value converge.
#   3. If `versions access latest` FAILS but the secret exists (e.g. latest is
#      disabled or destroyed), do NOT blindly add a version — that is exactly
#      how churn snowballs and how a disabled-latest incident gets papered over.
#      Warn loudly and skip; a human decides.
#   4. ENSURE_SECRET_CREATE_ONLY=1 creates a missing secret but NEVER versions
#      an existing one. The terraform-plan job runs with NO GitHub environment, so
#      it reads each secret's project-level copy in Cuttlefish, while terraform-apply
#      and the Vercel deploy run in the `prod` environment and read a `prod` copy
#      when one is set. When the two INTERNAL_SERVICE_SECRET values differ, a
#      versioning plan job and a versioning apply job fight:
#      two new versions per deploy (1,410 by 2026-09-26) and a window in which
#      `latest` holds a value the web app does not. Only the job whose
#      environment matches the deploy may write values.
#   5. A value that is empty once trailing CR/LF are removed counts as not set, and
#      nothing is written for it. The emptiness check runs after the strip, so a
#      value of only CR/LF cannot become a 0-byte version.

# Turn xtrace off before anything else, so `bash -x`, SHELLOPTS=xtrace and a
# BASH_ENV that sets -x never print the value. The redirect hides this line's own trace.
{ set +x; } 2>/dev/null

set -euo pipefail

# Strip trailing CR/LF only (never interior or trailing spaces).
strip_trailing_newlines() {
  local s="$1"
  while [ -n "$s" ]; do
    case "$s" in
      *$'\n' | *$'\r') s="${s%?}" ;;
      *) break ;;
    esac
  done
  printf '%s' "$s"
}

NAME="${1:-}"
VALUE="${2:-}"
PROJECT="${GCP_PROJECT_ID:-}"

[ -n "$NAME" ] || { echo "ensure-secret.sh: secret name is required" >&2; exit 2; }
[ -n "$PROJECT" ] || { echo "ensure-secret.sh: GCP_PROJECT_ID is required" >&2; exit 2; }

if [ "$VALUE" = "-" ]; then
  # Reads all of stdin with IFS empty and -r, so every byte is kept. read returns
  # non-zero at end of input, which is expected here.
  IFS= read -r -d '' VALUE || true
fi

# Empty means empty AFTER the strip. Checking before it let a value of only CR/LF
# through, and it was written as a 0-byte version.
VALUE=$(strip_trailing_newlines "$VALUE")
if [ -z "$VALUE" ]; then
  echo "WARNING: $NAME not set, skipping"
  exit 0
fi

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

# A failed describe is NOT proof the secret is missing — a transient auth or
# network error also exits non-zero, and treating that as "missing" made a
# create race an existing secret and fail the whole deploy (PR #494's plan job,
# 2026-08-25). Only create on an actual NOT_FOUND; anything else is the
# unreadable-secret path: warn and let a human look, exactly like the
# disabled-latest case below.
DESCRIBE_ERR=$(mktemp)
if ! gcloud secrets describe "$NAME" --project "$PROJECT" >/dev/null 2>"$DESCRIBE_ERR"; then
  if grep -qiE "NOT_FOUND|not found" "$DESCRIBE_ERR"; then
    rm -f "$DESCRIBE_ERR"
    echo "Creating secret: $NAME"
    printf "%s" "$(strip_trailing_newlines "$VALUE")" \
      | gcloud secrets create "$NAME" --data-file=- --replication-policy="automatic" --project "$PROJECT"
    exit 0
  fi
  echo "::warning title=Secret state unknown::describe $NAME in $PROJECT failed for a reason other than NOT_FOUND — NOT creating or versioning."
  sed 's/^/  gcloud: /' "$DESCRIBE_ERR" >&2 || true
  rm -f "$DESCRIBE_ERR"
  exit 0
fi
rm -f "$DESCRIBE_ERR"

if [ "${ENSURE_SECRET_CREATE_ONLY:-}" = "1" ]; then
  echo "$NAME exists; create-only mode, not versioning"
  exit 0
fi

ACCESS_ERR=$(mktemp)
if ! CURRENT=$(gcloud secrets versions access latest --secret="$NAME" --project "$PROJECT" 2>"$ACCESS_ERR"); then
  echo "::warning title=Secret unreadable::Cannot read latest version of $NAME in $PROJECT — NOT adding a new version."
  echo "  The secret exists but 'versions access latest' failed. The latest version is probably DISABLED or DESTROYED."
  echo "  Adding a version here would mask the real problem and churn versions. Fix the secret state, then re-run."
  sed 's/^/  gcloud: /' "$ACCESS_ERR" >&2 || true
  rm -f "$ACCESS_ERR"
  exit 0
fi
rm -f "$ACCESS_ERR"

CURRENT_HASH=$(printf "%s" "$(strip_trailing_newlines "$CURRENT")" | sha256)
VALUE_HASH=$(printf "%s" "$(strip_trailing_newlines "$VALUE")" | sha256)

if [ "$CURRENT_HASH" = "$VALUE_HASH" ]; then
  echo "$NAME unchanged, skipping"
else
  echo "$NAME changed, adding new version"
  printf "%s" "$(strip_trailing_newlines "$VALUE")" \
    | gcloud secrets versions add "$NAME" --data-file=- --project "$PROJECT"
fi
