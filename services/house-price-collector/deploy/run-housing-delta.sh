#!/usr/bin/env bash
# DAILY DELTA housing re-crawl — "right-size demand, no proxy spend".
#
# Re-crawls ONLY the suburbs that need it — never-crawled, stale (last crawl older
# than CRAWL_DELTA_TTL_HOURS, default 24h), or churny (>= CRAWL_DELTA_CHURN_MIN
# recent price events over CRAWL_DELTA_CHURN_DAYS, default 1 / 7d) — ranked
# never-first / churniest / oldest and capped at CRAWL_DELTA_MAX_SUBURBS (default
# 60). It then DRAINS the brandbrain queue to empty (so one run clears the whole
# enqueue, not just the first ~20 jobs) and runs a freshness check that ALARMS if
# the board has silently gone stale.
#
# Pairs with run-housing-full.sh (periodic FULL re-crawl of the whole catalog).
# Install both via launchd — see com.shorted.housing-delta.plist.template.
#
# Config (~/.shorted-housing-crawl.env, chmod 600, NOT committed) — same file the
# other housing wrappers read:
#   DATABASE_URL=postgresql://...            # prod Supabase (txn pooler, 6543)
#   CRAWL_CDP_URL=http://localhost:9222
#   BRANDBRAIN_AGENT_URL=https://api.brandbrain.dev
#   # BRANDBRAIN_AGENT_TOKEN optional (collector auto-refreshes from the co-located
#   # macOS agent's loopback control API on 401).
#   # Optional knobs: CRAWL_DELTA_TTL_HOURS, CRAWL_DELTA_CHURN_MIN,
#   # CRAWL_DELTA_CHURN_DAYS, CRAWL_DELTA_MAX_SUBURBS, CRAWL_DRAIN_MAX_ROUNDS,
#   # CRAWL_FRESHNESS_ALARM_HOURS, CRAWL_FRESHNESS_WEBHOOK.
#
# Exit codes: 0 ok · 3 re-warm needed (collector self-warms next run) · 4 Chrome
# unusable · 6 freshness ALARM (board is going stale).
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=housing-crawl-common.sh
source "$DIR/housing-crawl-common.sh"

hc_load_env

# Single-drainer lock: if a full pass (or another delta) is already draining on this
# Mac, SKIP this run (exit 0) — one host Chrome + one residential IP means concurrent
# drainers only hurt. A full pass runs ~1.5 days, during which daily deltas skip.
hc_acquire_lock

echo "=== $(date -u +%FT%TZ) housing-delta (selection=delta ttl=${CRAWL_DELTA_TTL_HOURS:-24}h churn>=${CRAWL_DELTA_CHURN_MIN:-1}/${CRAWL_DELTA_CHURN_DAYS:-7}d cap=${CRAWL_DELTA_MAX_SUBURBS:-60}) ===" >>"$LOG"

# 1. Enqueue ONLY the stale/churny slice (delta selection logs its own why + cap).
# shellcheck disable=SC2209  # intentional one-shot env var prefixing the command
CRAWL_ENQUEUE_SELECTION=delta "$BIN" -mode enqueue >>"$LOG" 2>&1
echo "$(date -u +%FT%TZ) delta enqueue rc=$?" >>"$LOG"

# 2. Drain the queue to empty (bounded, re-warm/Chrome aware).
hc_drain_until_empty
drain_rc=$?

# 3. Freshness alarm — run regardless of the drain outcome (we still want to know
#    the board is stale even when this run couldn't fully clear the queue).
hc_freshness
fresh_rc=$?

echo "$(date -u +%FT%TZ) housing-delta done: drain_rc=$drain_rc fresh_rc=$fresh_rc" >>"$LOG"
# Surface a re-warm / Chrome failure first, then a freshness alarm, else ok.
case "$drain_rc" in 3 | 4) exit "$drain_rc" ;; esac
[[ "$fresh_rc" -ne 0 ]] && exit "$fresh_rc"
exit 0
