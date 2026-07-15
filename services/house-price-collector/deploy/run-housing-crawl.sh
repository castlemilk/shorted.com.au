#!/usr/bin/env bash
# Residential housing-crawl runner — ONE shard per Mac, invoked by launchd.
#
# Runs the collector NATIVELY on the Mac (the proven path: CDP to the dedicated
# host Chrome preserves the residential IP + warm Kasada/Akamai clearance). Reads
# secrets from a local, UNCOMMITTED env file.
#
# SELF-HEALING: this script no longer depends on an operator remembering to
# launch Chrome with a REA startup URL by hand. It:
#   1. auto-launches the dedicated Chrome (warm_chrome, below) if it isn't
#      reachable at all,
#   2. PROVES the REA session actually cleared Kasada via the collector's own
#      `-mode warmcheck` preflight (a reachable CDP port is NOT the same thing
#      as a warm REA session — see below), re-warming + retrying up to twice
#      if it's cold,
#   3. only then runs the real crawl.
# Fires a macOS notification and exits non-zero if Chrome still can't be
# reached (4), warmcheck still fails after retries (5), or the crawl itself
# reports it needs a re-warm (3).
#
# The underlying reliability fact this preflight encodes: Chrome's own NATIVE
# startup navigation to a REA URL clears Kasada's KPSDK challenge and sets a
# session cookie; a Playwright-DRIVEN navigation to the same URL does NOT — REA
# returns an ~870-byte KPSDK stub with 0 listings and the sweep is silently
# marked "blocked". Warming Domain does NOT help REA. NEVER the personal
# Chrome profile — always a dedicated --user-data-dir:
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
CHROME_BIN="${HOUSING_CRAWL_CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
CHROME_PROFILE_DIR="${HOUSING_CRAWL_CHROME_PROFILE:-$HOME/.shorted-housing-crawl-chrome}"

notify() { /usr/bin/osascript -e "display notification \"$1\" with title \"Housing crawl\"" >/dev/null 2>&1 || true; }

# chrome_reachable checks the dedicated-profile Chrome's CDP endpoint. This is
# necessary but NOT sufficient for a real crawl — Chrome can be up with a
# cold/expired REA session (see warmcheck below).
chrome_reachable() { /usr/bin/curl -sf "${CRAWL_CDP_URL%/}/json/version" >/dev/null; }

# warm_chrome launches (or relaunches) the DEDICATED-profile Chrome with a REA
# URL as its STARTUP page — the fix documented in the header comment, now
# automated instead of depending on an operator remembering it. NEVER points
# at the personal Chrome profile. Backgrounds the launch and gives Chrome +
# Kasada's challenge time to settle before the caller re-checks.
warm_chrome() {
	local port="${CRAWL_CDP_URL%/}"
	port="${port##*:}"
	echo "$(date -u +%FT%TZ) warm_chrome: launching dedicated Chrome (port=$port profile=$CHROME_PROFILE_DIR)" >>"$LOG"
	"$CHROME_BIN" \
		--remote-debugging-port="$port" \
		--user-data-dir="$CHROME_PROFILE_DIR" \
		"https://www.realestate.com.au/" >>"$LOG" 2>&1 &
	disown 2>/dev/null || true
	sleep 12
}

echo "=== $(date -u +%FT%TZ) shard $CRAWL_SHARD_INDEX/$CRAWL_SHARD_COUNT dry=$CRAWL_DRY_RUN ===" >>"$LOG"

# 1. Chrome must be reachable at all — auto-launch it rather than requiring a
#    human to remember to start it.
if ! chrome_reachable; then
	echo "$(date -u +%FT%TZ) chrome-unreachable $CRAWL_CDP_URL — auto-launching" >>"$LOG"
	warm_chrome
	if ! chrome_reachable; then
		notify "Crawl Chrome not reachable at $CRAWL_CDP_URL even after auto-launch — check Chrome/CDP manually."
		echo "$(date -u +%FT%TZ) chrome-unreachable-after-launch $CRAWL_CDP_URL" >>"$LOG"
		exit 4
	fi
fi

# 2. Chrome being reachable doesn't mean REA's Kasada session is warm — PROVE
#    it via the collector's own fetcher (-mode warmcheck) before spending a
#    real crawl run on a session that will just come back "blocked". Re-warm
#    + retry up to twice if it reports cold (exit 5).
warm_attempts=0
"$BIN" -mode warmcheck >>"$LOG" 2>&1
rc_warmcheck=$?
while [[ "$rc_warmcheck" -eq 5 && "$warm_attempts" -lt 2 ]]; do
	warm_attempts=$((warm_attempts + 1))
	echo "$(date -u +%FT%TZ) warmcheck not warm (attempt $warm_attempts/2) — relaunching Chrome to re-warm" >>"$LOG"
	warm_chrome
	"$BIN" -mode warmcheck >>"$LOG" 2>&1
	rc_warmcheck=$?
done
if [[ "$rc_warmcheck" -ne 0 ]]; then
	notify "REA Chrome could not be warmed — check Kasada / relaunch Chrome with a REA startup URL"
	echo "$(date -u +%FT%TZ) warmcheck-failed rc=$rc_warmcheck after $warm_attempts re-warm attempt(s)" >>"$LOG"
	exit 5
fi

# 3. Warm — safe to spend the real (slow, adversarial) crawl run.
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
