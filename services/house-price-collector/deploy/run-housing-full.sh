#!/usr/bin/env bash
# PERIODIC FULL housing re-crawl — the whole catalog, drained to empty.
#
# Enqueues the ENTIRE suburb catalog (CRAWL_ENQUEUE_SELECTION=all — today's default
# enqueue behaviour), drains the brandbrain queue to empty, then runs the freshness
# check. This is the fortnightly "reset the baseline" pass that catches suburbs the
# daily delta never re-selected (quiet suburbs with no churn) and re-confirms
# delists across the full catalog.
#
# Pairs with run-housing-delta.sh (daily demand-right-sized re-crawl). A full pass
# is heavier — expect many drain rounds; the loop is bounded by CRAWL_DRAIN_MAX_ROUNDS
# (default 30) and picks up where it left off on the next scheduled run.
#
# Config: same ~/.shorted-housing-crawl.env as run-housing-delta.sh / the other
# housing wrappers (DATABASE_URL, CRAWL_CDP_URL, BRANDBRAIN_AGENT_URL, optional
# CRAWL_FRESHNESS_* knobs).
#
# Exit codes: 0 ok · 3 re-warm needed · 4 Chrome unusable · 6 freshness ALARM ·
# 7 agent infrastructure failed before any work · 8 crawl ENVIRONMENT broken
# (Playwright driver missing — needs an operator to reinstall it; re-warming
# Chrome and re-running the schedule cannot fix it).
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=housing-crawl-common.sh
source "$DIR/housing-crawl-common.sh"

hc_load_env
hc_log_binary_provenance

# Single-drainer lock: a full pass runs ~1.5 days and must NOT overlap another
# drainer on this Mac's one host Chrome + one residential IP. Holding the lock makes
# the daily deltas skip cleanly while this pass runs. If another drainer is already
# holding it, this full pass skips (exit 0) rather than double-draining.
hc_acquire_lock

# Don't race the macOS agent's auth mint after a restart — poll its control
# port (bounded), alert if it never comes up, then proceed regardless.
hc_wait_for_agent

# Tag every `-mode agent` round + the freshness run below so the collector writes a
# HEALTH RECORD for this run to crawl_run_status (migration 000089) → the admin jobs
# dashboard, where the residential crawl now appears as a tracked scheduled job. A full
# pass runs many drain rounds over ~1.5 days; the STABLE CRAWL_RUN_ID makes them all
# accumulate into one row, and a dead rig auto-goes-stale via the row's finished_at.
export CRAWL_RUN_TYPE=full
export CRAWL_RUN_ID="full-$(date -u +%Y%m%dT%H%M%SZ)"

echo "=== $(date -u +%FT%TZ) housing-full (selection=all whole-catalog) ===" >>"$LOG"

# 1. Enqueue the whole catalog (idempotent — brandbrain dedups pending jobs).
# shellcheck disable=SC2209  # intentional one-shot env var prefixing the command
CRAWL_ENQUEUE_SELECTION=all "$BIN" -mode enqueue >>"$LOG" 2>&1
enqueue_rc=$?
echo "$(date -u +%FT%TZ) full enqueue rc=$enqueue_rc" >>"$LOG"

# 2. Drain the queue to empty (bounded, re-warm/Chrome aware).
hc_drain_until_empty
drain_rc=$?

# 3. Freshness alarm.
hc_freshness
fresh_rc=$?

echo "$(date -u +%FT%TZ) housing-full done: enqueue_rc=$enqueue_rc drain_rc=$drain_rc fresh_rc=$fresh_rc" >>"$LOG"
# Run every phase, then preserve failures in enqueue → drain → freshness order.
[[ "$enqueue_rc" -ne 0 ]] && exit "$enqueue_rc"
[[ "$drain_rc" -ne 0 ]] && exit "$drain_rc"
[[ "$fresh_rc" -ne 0 ]] && exit "$fresh_rc"
exit 0
