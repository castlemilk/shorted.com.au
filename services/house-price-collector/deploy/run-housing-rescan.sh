#!/usr/bin/env bash
# SUPERVISED full-catalog rescan — drives run-housing-full.sh to actual completion.
#
# Why this exists: hc_drain_until_empty returns 3 the moment a round signals
# "re-warm" and STOPS the whole pass. That is the right call for one invocation
# (the collector self-warms next run), but the full pass is only scheduled on the
# 1st and 15th, so an unsupervised stop parks a rescan for up to a fortnight. Over
# ~1000 jobs a transient block is close to certain, so a one-shot full pass almost
# never finishes.
#
# This loop re-invokes the full pass after a re-warm stop, waits out any run that
# already holds the crawl lock, and exits as soon as a pass drains the queue. It
# adds no crawl pressure of its own: pacing, the per-source circuit breaker and
# the blockTracker session guard all still live in the collector.
#
# Usage (safe to background; survives a stopped pass, not a reboot):
#   nohup caffeinate -i bash run-housing-rescan.sh > /tmp/housing-rescan.log 2>&1 &
#
# Knobs:
#   RESCAN_MAX_PASSES   how many full-pass invocations to attempt (default 40)
#   RESCAN_BACKOFF_S    settle time between passes (default 300 — lets a hot
#                       session cool before re-warming, same spirit as the
#                       circuit breaker's cooldown)
#   RESCAN_DEADLINE_H   give up after this many hours (default 72)
# Plus every knob run-housing-full.sh honours (CRAWL_LISTINGS_MIN_PER_PAGE,
# CRAWL_AGENT_BLOCK_TRIP, CRAWL_DRAIN_MAX_ROUNDS, ...).
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="${HOUSING_CRAWL_LOG:-$HOME/Library/Logs/shorted-housing-scheduler.log}"
LOCK_DIR="${HC_LOCK_DIR:-$HOME/.shorted-housing-crawl.lockdir}"

max_passes="${RESCAN_MAX_PASSES:-40}"
backoff="${RESCAN_BACKOFF_S:-300}"
deadline_h="${RESCAN_DEADLINE_H:-72}"
started=$(date +%s)

say() { echo "$(date -u +%FT%TZ) [rescan] $*" | tee -a "$LOG"; }

# wait_for_free blocks while another housing crawl legitimately holds the lock,
# so the supervisor never counts a lock-skip as an attempt (run-housing-full.sh
# exits 0 immediately in that case, which would otherwise spin the loop).
wait_for_free() {
	while :; do
		local holder=""
		holder="$(/bin/cat "$LOCK_DIR/pid" 2>/dev/null | /usr/bin/tr -dc '0-9')"
		[[ -z "$holder" ]] && return 0
		/bin/kill -0 "$holder" 2>/dev/null || return 0 # stale; full pass reclaims it
		sleep 60
	done
}

say "supervised rescan starting (max_passes=$max_passes backoff=${backoff}s deadline=${deadline_h}h)"

for ((pass = 1; pass <= max_passes; pass++)); do
	if (($(date +%s) - started > deadline_h * 3600)); then
		say "deadline of ${deadline_h}h reached after $((pass - 1)) pass(es) — stopping; queue keeps its remaining pending jobs"
		exit 0
	fi

	wait_for_free

	# Mark the log so the queue-empty check below only reads THIS pass's output.
	marker="rescan-pass-$pass-$(date -u +%Y%m%dT%H%M%SZ)"
	say "pass $pass/$max_passes starting ($marker)"

	bash "$DIR/run-housing-full.sh"
	rc=$?

	# hc_drain_until_empty writes "drain: queue empty after N round(s)" only when
	# the collector itself reported no more jobs — the one unambiguous done signal.
	if /usr/bin/tail -400 "$LOG" | /usr/bin/grep -q "drain: queue empty after"; then
		say "queue drained — rescan COMPLETE after $pass pass(es)"
		exit 0
	fi

	case "$rc" in
	3) say "pass $pass stopped for a re-warm (rc=3) — collector self-warms; retrying after ${backoff}s" ;;
	4) say "pass $pass could not use Chrome (rc=4) — retrying after ${backoff}s; check the dedicated profile if this repeats" ;;
	6) say "pass $pass completed but freshness still ALARMs (rc=6) — continuing" ;;
	0) say "pass $pass ended cleanly but the queue is not empty — continuing" ;;
	*) say "pass $pass exited rc=$rc — continuing" ;;
	esac

	sleep "$backoff"
done

say "hit RESCAN_MAX_PASSES=$max_passes — stopping; re-run to continue draining"
exit 0
