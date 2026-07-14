#!/usr/bin/env bash
# Residential housing-crawl runner — ONE shard per Mac, invoked by launchd.
#
# Runs the collector NATIVELY on the Mac (the proven path: CDP to the dedicated
# host Chrome preserves the residential IP + warm Kasada/Akamai clearance). Reads
# secrets from a local, UNCOMMITTED env file. Fires a macOS notification and exits
# non-zero if the dedicated Chrome is unreachable (4) or the crawl reports it needs
# a human to re-warm the anti-bot clearance (3).
#
# One-time host setup (per Mac), NEVER the personal Chrome profile — pass a REA URL
# as Chrome's STARTUP page so its own (non-automated) navigation clears REA's Kasada
# challenge and sets a session cookie. Playwright-driven navigation is detected by
# Kasada (returns an ~870B stub → the REA sweep is marked "blocked"); warming Domain
# does NOT help REA. With this, the crawl's Playwright REA fetches sail through — no
# manual clicking needed:
#   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
#     --remote-debugging-port=9222 \
#     --user-data-dir="$HOME/.shorted-housing-crawl-chrome" \
#     "https://www.realestate.com.au/"
set -uo pipefail

ENV_FILE="${HOUSING_CRAWL_ENV:-$HOME/.shorted-housing-crawl.env}"
if [[ -f "$ENV_FILE" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$ENV_FILE"
	set +a
fi

: "${DATABASE_URL:?DATABASE_URL must be set (put it in $ENV_FILE)}"
: "${CRAWL_CDP_URL:?CRAWL_CDP_URL must be set, e.g. http://localhost:9222}"

export CRAWL_DRY_RUN="${CRAWL_DRY_RUN:-false}"
export CRAWL_SHARD_INDEX="${CRAWL_SHARD_INDEX:-0}"
export CRAWL_SHARD_COUNT="${CRAWL_SHARD_COUNT:-1}"
export CRAWL_TIMEOUT_MIN="${CRAWL_TIMEOUT_MIN:-90}"

BIN="${HOUSING_CRAWL_BIN:-$HOME/bin/house-price-collector}"
LOG="${HOUSING_CRAWL_LOG:-$HOME/Library/Logs/shorted-housing-crawl.log}"

notify() { /usr/bin/osascript -e "display notification \"$1\" with title \"Housing crawl\"" >/dev/null 2>&1 || true; }

# Guard: the dedicated-profile Chrome must be listening on the CDP port.
if ! /usr/bin/curl -sf "${CRAWL_CDP_URL%/}/json/version" >/dev/null; then
	notify "Crawl Chrome not reachable at $CRAWL_CDP_URL — launch the dedicated profile."
	echo "$(date -u +%FT%TZ) chrome-unreachable $CRAWL_CDP_URL" >>"$LOG"
	exit 4
fi

echo "=== $(date -u +%FT%TZ) shard $CRAWL_SHARD_INDEX/$CRAWL_SHARD_COUNT dry=$CRAWL_DRY_RUN ===" >>"$LOG"
"$BIN" -mode listings >>"$LOG" 2>&1
rc_listings=$?
"$BIN" -mode crawl >>"$LOG" 2>&1
rc_crawl=$?
echo "listings rc=$rc_listings crawl rc=$rc_crawl" >>"$LOG"

if [[ "$rc_listings" -eq 3 || "$rc_crawl" -eq 3 ]]; then
	notify "Re-warm the crawl Chrome profile — Kasada/Akamai clearance expired."
	exit 3
fi
exit 0
