#!/usr/bin/env bash
# Housing-crawl DRAINER (headless / server fallback). Enqueues the curated suburb
# catalog to the brandbrain crawl_jobs queue, then drains it with `-mode agent`
# (claim jobs SKIP-LOCKED, per-suburb listings sweep → prod Supabase, counts-only
# summary back to brandbrain).
#
# SUPERSEDED ON THE MAC. The bundled BrandBrain macOS agent — its Real-estate
# "Auto-crawl" tab (brandbrain 1.8.0+) — now runs/schedules this crawl directly,
# so an operator's Mac needs neither a launchd plist nor this wrapper. This script
# (and com.shorted.housing-agent.plist.template beside it) remain ONLY for
# headless / server / CI use where there is no GUI agent.
#
# NO WRAPPER-SIDE CHROME MANAGEMENT. Since C1 (crawl_chrome.go), `-mode agent`
# SELF-WARMS the dedicated Chrome in-process before every run: auto-launch on a
# REA startup URL, prove Kasada clearance (warmcheck), and hard-recover a wedged
# Chrome — all internal. This wrapper therefore just enqueues, drains, and
# surfaces the result. Chrome knobs the collector honors (set them in the env
# file if the defaults don't fit): HOUSING_CRAWL_CHROME_BIN,
# HOUSING_CRAWL_CHROME_PROFILE, CRAWL_CDP_URL, and CRAWL_AUTO_WARM=false to opt
# out of the in-process warm entirely.
#
# Config (~/.shorted-housing-crawl.env, chmod 600, NOT committed):
#   DATABASE_URL=postgresql://...          # prod Supabase (transaction pooler, 6543)
#   CRAWL_CDP_URL=http://localhost:9222
#   BRANDBRAIN_AGENT_URL=https://api.brandbrain.dev
#   # BRANDBRAIN_AGENT_TOKEN is OPTIONAL — the collector reads the running macOS
#   # agent's rotating token from ~/.brandbrain/{diag-port,control_secret} and
#   # refreshes it on 401, so an unattended batch never expires mid-run.
#
# Exit codes pass straight through from `-mode agent`:
#   0 ok · 3 re-warm needed (the collector self-warms on the NEXT run) ·
#   4 Chrome unusable even after the in-process self-warm.
# Set CRAWL_SKIP_ENQUEUE=true to drain leftover work only (skip the enqueue).
set -uo pipefail

# Source the shared lib for the cross-wrapper single-drainer lock only (this script
# keeps its own env handling below — it does NOT call hc_load_env).
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=housing-crawl-common.sh
source "$DIR/housing-crawl-common.sh"

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
# A queue-draining agent run can crawl many suburbs back to back — 240 min default.
export CRAWL_TIMEOUT_MIN="${CRAWL_TIMEOUT_MIN:-240}"
export BRANDBRAIN_AGENT_URL="${BRANDBRAIN_AGENT_URL:-https://api.brandbrain.dev}"

BIN="${HOUSING_CRAWL_BIN:-$HOME/bin/house-price-collector}"
LOG="${HOUSING_CRAWL_LOG:-$HOME/Library/Logs/shorted-housing-agent.log}"

notify() { /usr/bin/osascript -e "display notification \"$1\" with title \"Housing crawl\"" >/dev/null 2>&1 || true; }

# Single-drainer lock: don't run a second concurrent drainer on this Mac's one host
# Chrome + one residential IP. If a delta/full/agent drain already holds the lock,
# this run skips cleanly (exit 0). Shared with run-housing-delta.sh / run-housing-full.sh.
hc_acquire_lock

echo "=== $(date -u +%FT%TZ) housing-agent drain (dry=$CRAWL_DRY_RUN skip_enqueue=${CRAWL_SKIP_ENQUEUE:-false}) ===" >>"$LOG"

# 1. (Re)populate the queue — idempotent (brandbrain dedups per suburb). Skip
#    with CRAWL_SKIP_ENQUEUE=true to drain leftover work only.
if [[ "${CRAWL_SKIP_ENQUEUE:-false}" != "true" ]]; then
	"$BIN" -mode enqueue >>"$LOG" 2>&1
	echo "enqueue rc=$?" >>"$LOG"
fi

# 2. Drain. `-mode agent` self-warms + self-recovers the dedicated Chrome
#    (crawl_chrome.go), so there's nothing for this wrapper to warm or retry.
"$BIN" -mode agent >>"$LOG" 2>&1
rc=$?
echo "agent rc=$rc" >>"$LOG"

case "$rc" in
	0) : ;;
	3) notify "Housing crawl: Kasada/Akamai clearance tripped — the collector re-warms on the next scheduled run." ;;
	4) notify "Housing crawl: dedicated Chrome unusable even after self-warm — check Chrome/CDP." ;;
	*) notify "Housing crawl exited rc=$rc — check $LOG." ;;
esac
exit "$rc"
