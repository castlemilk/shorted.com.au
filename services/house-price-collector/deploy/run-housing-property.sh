#!/usr/bin/env bash
# Scheduled property.com.au AVM enrichment. Fetches a BOUNDED batch of addresses that
# have no fresh property_valuations row and writes their AVM estimate + sales history +
# attributes. Runs via the collector's SELF-WARM Chrome (a native REA-startup warm clears
# property.com.au — same Kasada tenant — and hard-recovers a wedged Chrome). ALL storage
# on gamma (the internal disk runs near-full; Chrome wedges without disk headroom).
# Shares the single-drainer lock with the listings crawl.
#
# CRITICAL OPS RULE: let this run to COMPLETION — never `kill -9` a property run mid-write.
# A hard-killed collector leaks its Supabase pooler connections; a few of those saturate
# the ~60-connection pool and block ALL new DB connections (the live site keeps serving on
# its established app pool, but new batches/queries can't connect until the leaks time out
# or the pooler is bounced). Use SIGTERM if you must stop it, and prefer just waiting.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=housing-crawl-common.sh
source "$DIR/housing-crawl-common.sh"

hc_load_env
hc_acquire_lock   # skip cleanly if the listings crawl (delta/full) is already draining

# --- all storage on gamma-systems-2 (see the disk-headroom rule above) ---
GAMMA="${HOUSING_GAMMA_CACHE:-/Volumes/gamma-systems-2/dev-caches}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$GAMMA/ms-playwright}"
export HOUSING_CRAWL_CHROME_PROFILE="${HOUSING_CRAWL_CHROME_PROFILE:-$GAMMA/housing-crawl-chrome}"
export TMPDIR="${HOUSING_CRAWL_TMPDIR:-$GAMMA/tmp}"
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH" "$HOUSING_CRAWL_CHROME_PROFILE" "$TMPDIR"

# Bounded batch + pacing. CRAWL_AUTO_WARM defaults true → the collector launches, proves,
# and recovers its own dedicated Chrome (do NOT set CRAWL_CDP_URL to a hand-managed one).
export CRAWL_PROPERTY_MAX="${CRAWL_PROPERTY_MAX:-50}"
export CRAWL_PROPERTY_TTL_DAYS="${CRAWL_PROPERTY_TTL_DAYS:-90}"
export CRAWL_TIMEOUT_MIN="${CRAWL_TIMEOUT_MIN:-180}"

echo "=== $(date -u +%FT%TZ) housing-property (max=$CRAWL_PROPERTY_MAX ttl=${CRAWL_PROPERTY_TTL_DAYS}d, storage=gamma) ===" >>"$LOG"
"$BIN" -mode property >>"$LOG" 2>&1
rc=$?
echo "$(date -u +%FT%TZ) property rc=$rc" >>"$LOG"
exit "$rc"
