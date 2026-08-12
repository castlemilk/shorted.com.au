#!/usr/bin/env bash
# property.com.au profile-LINK resolution for a residential macOS rig.
#
# This banks the per-property link for each address WITHOUT reading any profile.
# Resolution reads realestate.com.au's public consumer address autocomplete (a
# small JSON endpoint), so unlike run-housing-property.sh it needs no warm host
# Chrome and no CDP — it only needs to run somewhere with ordinary residential
# egress and a database connection.
#
# It is CHUNKED on purpose. ~48k addresses at the default pacing is ~26 hours,
# which is a bad shape for one process: a single failure loses the lot, and a
# day-long run against a third party's public endpoint is worse manners than the
# same work spread over a fortnight. Each run takes the next chunk of
# not-yet-resolved addresses, so successive runs advance the corpus and a run
# that dies simply resumes on the next schedule.
#
# WRITES BY DEFAULT. The collector's CRAWL_DRY_RUN defaults to true precisely so
# a hand-run cannot persist by accident; a scheduled wrapper is the one place
# that is not what you want, so this exports false explicitly — the same posture
# as the delta/full crawl wrappers. Check `dryRun=` in the log to confirm.
#
# Config (~/.shorted-housing-crawl.env, chmod 600, NOT committed):
#   DATABASE_URL=postgresql://...   # prod Supabase txn pooler (6543) is fine:
#                                   # this mode writes rows, it does not refresh MVs
#   # Optional overrides:
#   HOUSING_RESOLVE_BIN=$HOME/bin/house-price-collector
#   HOUSING_RESOLVE_LOG=$HOME/Library/Logs/shorted-housing-property-resolve.log
#   CRAWL_PROPERTY_RESOLVE_MAX=3000        # addresses per run (~1.6h at default pacing)
#   CRAWL_PROPERTY_RESOLVE_MIN_MS=900
#   CRAWL_PROPERTY_RESOLVE_MAX_MS=2200
set -uo pipefail

ENV_FILE="${HOUSING_RESOLVE_ENV:-$HOME/.shorted-housing-crawl.env}"
if [[ -f "$ENV_FILE" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$ENV_FILE"
	set +a
fi

: "${DATABASE_URL:?DATABASE_URL must be set (put it in $ENV_FILE)}"

# A chunk, not the corpus. Raising this does not make the sweep faster in any
# useful sense — the pacing is the constraint — it only makes one run longer and
# more expensive to lose.
export CRAWL_PROPERTY_RESOLVE_MAX="${CRAWL_PROPERTY_RESOLVE_MAX:-3000}"
export CRAWL_PROPERTY_RESOLVE_MIN_MS="${CRAWL_PROPERTY_RESOLVE_MIN_MS:-900}"
export CRAWL_PROPERTY_RESOLVE_MAX_MS="${CRAWL_PROPERTY_RESOLVE_MAX_MS:-2200}"
# Scheduled runs persist. See the header.
export CRAWL_DRY_RUN=false

BIN="${HOUSING_RESOLVE_BIN:-$HOME/bin/house-price-collector}"
LOG="${HOUSING_RESOLVE_LOG:-$HOME/Library/Logs/shorted-housing-property-resolve.log}"
mkdir -p "$(dirname "$LOG")"

echo "=== $(date -u +%FT%TZ) housing-property-resolve (chunk=${CRAWL_PROPERTY_RESOLVE_MAX}) ===" >>"$LOG"
"$BIN" -mode property-resolve >>"$LOG" 2>&1
rc=$?
echo "$(date -u +%FT%TZ) property-resolve rc=$rc" >>"$LOG"

# rc=3 is the collector's "we were blocked" signal. That is not a crash to page
# about — it is the mode stopping itself rather than pushing through the worklist —
# but repeated 3s mean the endpoint is pushing back and the pacing needs widening.
if [[ "$rc" -eq 3 ]]; then
	echo "$(date -u +%FT%TZ) property-resolve BLOCKED — widen CRAWL_PROPERTY_RESOLVE_MIN_MS/MAX_MS if this repeats" >>"$LOG"
	/usr/bin/osascript -e 'display notification "Property link resolution was blocked; check pacing." with title "Housing collector"' >/dev/null 2>&1 || true
	exit 0 # a paced back-off is the designed behaviour, not a failed run
fi

if [[ "$rc" -ne 0 ]]; then
	/usr/bin/osascript -e 'display notification "Property link resolution failed; check the collector log." with title "Housing collector"' >/dev/null 2>&1 || true
fi
exit "$rc"
