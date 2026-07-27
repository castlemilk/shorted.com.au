#!/usr/bin/env bash
#
# ensure-secret.sh NAME VALUE  (project from $GCP_PROJECT_ID)
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

set -euo pipefail

NAME="${1:-}"
VALUE="${2:-}"
PROJECT="${GCP_PROJECT_ID:-}"

[ -n "$NAME" ] || { echo "ensure-secret.sh: secret name is required" >&2; exit 2; }
[ -n "$PROJECT" ] || { echo "ensure-secret.sh: GCP_PROJECT_ID is required" >&2; exit 2; }

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

if ! gcloud secrets describe "$NAME" --project "$PROJECT" >/dev/null 2>&1; then
  echo "Creating secret: $NAME"
  printf "%s" "$(strip_trailing_newlines "$VALUE")" \
    | gcloud secrets create "$NAME" --data-file=- --replication-policy="automatic" --project "$PROJECT"
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
