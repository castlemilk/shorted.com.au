#!/usr/bin/env bash
# NSW Valuer-General PSI ingest for a residential macOS rig.
#
# The official NSW yearly ZIPs are Cloudflare-challenged from Cloud Run egress,
# so the normal scheduled `official` mode deliberately does not request them.
# This wrapper loads a machine-local env file and invokes only `-mode vg-nsw`
# from approved residential egress. The collector writes the vg_nsw run row,
# enforces persisted-period freshness, refreshes housing views on success, and
# returns 1 on ingest/freshness failure.
#
# Config (~/.shorted-housing-vg.env, chmod 600, NOT committed):
#   DATABASE_URL=postgresql://...          # prod Supabase txn pooler (6543)
#   # Optional overrides:
#   HOUSING_VG_BIN=$HOME/bin/house-price-collector
#   HOUSING_VG_LOG=$HOME/Library/Logs/shorted-housing-vg-nsw.log
#   VG_NSW_TIMEOUT_MIN=240
set -uo pipefail

ENV_FILE="${HOUSING_VG_ENV:-$HOME/.shorted-housing-vg.env}"
if [[ -f "$ENV_FILE" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$ENV_FILE"
	set +a
fi

: "${DATABASE_URL:?DATABASE_URL must be set (put it in $ENV_FILE)}"

export VG_NSW_TIMEOUT_MIN="${VG_NSW_TIMEOUT_MIN:-240}"
BIN="${HOUSING_VG_BIN:-$HOME/bin/house-price-collector}"
LOG="${HOUSING_VG_LOG:-$HOME/Library/Logs/shorted-housing-vg-nsw.log}"
mkdir -p "$(dirname "$LOG")"

echo "=== $(date -u +%FT%TZ) housing-vg-nsw (timeout=${VG_NSW_TIMEOUT_MIN}m) ===" >>"$LOG"
"$BIN" -mode vg-nsw >>"$LOG" 2>&1
rc=$?
echo "$(date -u +%FT%TZ) vg_nsw rc=$rc" >>"$LOG"

if [[ "$rc" -ne 0 ]]; then
	/usr/bin/osascript -e 'display notification "NSW Valuer-General ingest failed; check the collector log." with title "Housing collector"' >/dev/null 2>&1 || true
fi
exit "$rc"
