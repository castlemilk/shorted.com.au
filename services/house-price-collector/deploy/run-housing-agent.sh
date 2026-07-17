#!/usr/bin/env bash
# Seamless housing-crawl DRAINER — the "runs via the Mac agent on a schedule"
# half of the queue-based crawl. Invoked by launchd (see
# com.shorted.housing-agent.plist.template) so the corpus grows hands-off: no
# operator has to remember to run anything per-crawl.
#
# It does the two queue steps in one pass:
#   1. `-mode enqueue` — post the curated 115-suburb catalog (crawl_targets.go)
#      to the brandbrain crawl_jobs queue. Idempotent: brandbrain owns the queue
#      and dedups / tracks per-suburb job state, so re-enqueuing already-crawled
#      suburbs just refreshes the work-list rather than double-crawling.
#   2. `-mode agent` — claim jobs (SKIP LOCKED) one suburb at a time, run the
#      per-suburb listings sweep against the warm host Chrome, write listings to
#      prod Supabase, and report a COUNTS-ONLY summary back to brandbrain (no
#      listing rows / addresses / PII ever cross to brandbrain).
#
# This is the standalone-runner's (run-housing-crawl.sh) SELF-HEALING Chrome
# warm reused verbatim — auto-launch the dedicated Chrome + prove REA's Kasada
# clearance via `-mode warmcheck` before spending a real run. The difference is
# only the modes run (enqueue+agent vs listings+crawl): this rig drains the
# shared brandbrain queue instead of crawling its own static shard, so multiple
# Macs fan the catalog out via SKIP LOCKED and auth auto-refreshes off the
# co-located BrandBrain macOS agent (no long-lived token to mint).
#
# Config (~/.shorted-housing-crawl.env, chmod 600, NOT committed):
#   DATABASE_URL=postgresql://...          # prod Supabase (transaction pooler, 6543)
#   CRAWL_CDP_URL=http://localhost:9222
#   BRANDBRAIN_AGENT_URL=https://api.brandbrain.dev
#   # BRANDBRAIN_AGENT_TOKEN is OPTIONAL — the collector reads the running macOS
#   # agent's rotating token from ~/.brandbrain/{diag-port,control_secret} and
#   # refreshes it on 401, so an unattended batch never expires mid-run.
#
# Exit: 0 ok · 3 re-warm needed · 4 Chrome unreachable · 5 REA warmcheck failed.
# Set CRAWL_SKIP_ENQUEUE=true to drain only (skip step 1).
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
# A queue-draining agent run needs longer than the quick official/refresh runs:
# it can crawl many suburbs back to back. Default 240 min (matches the value the
# earlier unattended batches used); override in the env file if needed.
export CRAWL_TIMEOUT_MIN="${CRAWL_TIMEOUT_MIN:-240}"
export BRANDBRAIN_AGENT_URL="${BRANDBRAIN_AGENT_URL:-https://api.brandbrain.dev}"

BIN="${HOUSING_CRAWL_BIN:-$HOME/bin/house-price-collector}"
LOG="${HOUSING_CRAWL_LOG:-$HOME/Library/Logs/shorted-housing-agent.log}"
CHROME_BIN="${HOUSING_CRAWL_CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
CHROME_PROFILE_DIR="${HOUSING_CRAWL_CHROME_PROFILE:-$HOME/.shorted-housing-crawl-chrome}"

notify() { /usr/bin/osascript -e "display notification \"$1\" with title \"Housing crawl\"" >/dev/null 2>&1 || true; }

chrome_reachable() { /usr/bin/curl -sf "${CRAWL_CDP_URL%/}/json/version" >/dev/null; }

# warm_chrome launches (or relaunches) the DEDICATED-profile Chrome with a REA
# URL as its STARTUP page — Chrome's own native startup navigation clears
# Kasada's KPSDK challenge (a Playwright-driven nav does NOT). NEVER the personal
# profile — always a dedicated --user-data-dir.
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

# dedicated_chrome_pids prints the PIDs of the DEDICATED-profile Chrome only —
# matched by its --user-data-dir with a FIXED-STRING grep (never a regex) over the
# UNtruncated command line (ps -ww). The personal Chrome never carries this flag,
# so it is never matched; grep -v excludes this pipeline itself. CHROME_PROFILE_DIR
# always has a value (defaulted from $HOME), so the pattern can't match every Chrome.
dedicated_chrome_pids() {
	/bin/ps -axww -o pid=,command= 2>/dev/null \
		| /usr/bin/grep -F -- "--user-data-dir=$CHROME_PROFILE_DIR" \
		| /usr/bin/grep -v grep \
		| /usr/bin/awk '{print $1}'
}

# recover_wedged_chrome hard-resets a WEDGED dedicated Chrome — the case where the
# CDP port answers /json/version yet the browser can't drive a page: a hung tab, a
# stale SingletonLock after an unclean exit, or 0 open tabs (so the collector's
# fetcher can't get a CDP context — "Browser context management is not supported").
# A plain relaunch can't clear a held SingletonLock, so SIGKILL the dedicated-profile
# Chrome (a hung Chrome ignores SIGTERM) and CONFIRM it is gone BEFORE clearing the
# lock + relaunching (else a still-alive instance holds the lock and warm_chrome
# spawns a SECOND Chrome on the profile). Only the dedicated profile is ever touched.
recover_wedged_chrome() {
	echo "$(date -u +%FT%TZ) recover_wedged_chrome: SIGKILL dedicated Chrome + clear SingletonLock (profile=$CHROME_PROFILE_DIR)" >>"$LOG"
	local pids
	pids="$(dedicated_chrome_pids)"
	if [[ -n "$pids" ]]; then
		# shellcheck disable=SC2086  # word-split is intended: one kill for all PIDs
		/bin/kill -9 $pids >>"$LOG" 2>&1 || true
	fi
	local waited=0
	while [[ -n "$(dedicated_chrome_pids)" && "$waited" -lt 10 ]]; do
		sleep 1
		waited=$((waited + 1))
	done
	if [[ -n "$(dedicated_chrome_pids)" ]]; then
		echo "$(date -u +%FT%TZ) recover_wedged_chrome: dedicated Chrome still alive after ${waited}s — NOT relaunching (avoids a second instance); retry next attempt" >>"$LOG"
		return 0
	fi
	rm -f "$CHROME_PROFILE_DIR/SingletonLock" "$CHROME_PROFILE_DIR/SingletonSocket" "$CHROME_PROFILE_DIR/SingletonCookie" 2>/dev/null || true
	warm_chrome
}

echo "=== $(date -u +%FT%TZ) housing-agent drain (dry=$CRAWL_DRY_RUN skip_enqueue=${CRAWL_SKIP_ENQUEUE:-false}) ===" >>"$LOG"

# 1. Chrome must be reachable at all — auto-launch rather than requiring a human.
if ! chrome_reachable; then
	echo "$(date -u +%FT%TZ) chrome-unreachable $CRAWL_CDP_URL — auto-launching" >>"$LOG"
	warm_chrome
	if ! chrome_reachable; then
		notify "Crawl Chrome not reachable at $CRAWL_CDP_URL even after auto-launch — check Chrome/CDP manually."
		echo "$(date -u +%FT%TZ) chrome-unreachable-after-launch $CRAWL_CDP_URL" >>"$LOG"
		exit 4
	fi
fi

# 2. Reachable != warm — PROVE REA's Kasada session cleared via the collector's
#    own fetcher (-mode warmcheck) before spending a real run. Retry up to twice:
#      rc==5 (cold Kasada stub, Chrome working) → plain re-warm relaunch.
#      rc==4 (fetcher init failed → Chrome/CDP unusable: wedged tab / stale
#             SingletonLock / 0 tabs) → hard-recover (kill + clear lock + relaunch).
warm_attempts=0
"$BIN" -mode warmcheck >>"$LOG" 2>&1
rc_warmcheck=$?
while [[ ( "$rc_warmcheck" -eq 5 || "$rc_warmcheck" -eq 4 ) && "$warm_attempts" -lt 2 ]]; do
	warm_attempts=$((warm_attempts + 1))
	if [[ "$rc_warmcheck" -eq 4 ]]; then
		echo "$(date -u +%FT%TZ) warmcheck rc=4 — Chrome wedged/unusable (attempt $warm_attempts/2), hard-recovering" >>"$LOG"
		recover_wedged_chrome
	else
		echo "$(date -u +%FT%TZ) warmcheck not warm (attempt $warm_attempts/2) — relaunching Chrome to re-warm" >>"$LOG"
		warm_chrome
	fi
	"$BIN" -mode warmcheck >>"$LOG" 2>&1
	rc_warmcheck=$?
done
if [[ "$rc_warmcheck" -ne 0 ]]; then
	notify "REA Chrome could not be warmed (warmcheck rc=$rc_warmcheck) — check Kasada / wedged Chrome"
	echo "$(date -u +%FT%TZ) warmcheck-failed rc=$rc_warmcheck after $warm_attempts recovery attempt(s)" >>"$LOG"
	exit 5
fi

# 3. Warm — (re)populate the queue, then drain it. Enqueue is idempotent
#    (brandbrain dedups per suburb); skip it with CRAWL_SKIP_ENQUEUE=true to
#    drain leftover work only.
if [[ "${CRAWL_SKIP_ENQUEUE:-false}" != "true" ]]; then
	"$BIN" -mode enqueue >>"$LOG" 2>&1
	echo "enqueue rc=$?" >>"$LOG"
fi

# Drain. If -mode agent reports rc==4 (crawl fetcher init failed — the host Chrome
# wedged / lost its warm tab so CDP has no context), hard-recover Chrome and retry
# up to twice, so an unattended drain SELF-HEALS instead of aborting with the queue
# undrained (the exact failure the warmcheck-passed-then-agent-failed case hits).
agent_attempts=0
"$BIN" -mode agent >>"$LOG" 2>&1
rc_agent=$?
echo "agent rc=$rc_agent" >>"$LOG"
while [[ "$rc_agent" -eq 4 && "$agent_attempts" -lt 2 ]]; do
	agent_attempts=$((agent_attempts + 1))
	echo "$(date -u +%FT%TZ) agent rc=4 — Chrome wedged (attempt $agent_attempts/2), hard-recovering + re-draining" >>"$LOG"
	recover_wedged_chrome
	"$BIN" -mode agent >>"$LOG" 2>&1
	rc_agent=$?
	echo "agent rc=$rc_agent" >>"$LOG"
done

if [[ "$rc_agent" -eq 3 ]]; then
	notify "Re-warm the crawl Chrome profile — Kasada/Akamai clearance expired."
	exit 3
fi
if [[ "$rc_agent" -eq 4 ]]; then
	notify "Housing crawl: Chrome stayed wedged after recovery — check the dedicated Chrome/CDP."
	echo "$(date -u +%FT%TZ) agent-failed rc=4 after $agent_attempts recovery attempt(s)" >>"$LOG"
	exit 4
fi
exit 0
