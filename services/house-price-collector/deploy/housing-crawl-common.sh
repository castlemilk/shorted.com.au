#!/usr/bin/env bash
# Shared helpers for the demand-right-sizing housing-crawl wrappers
# (run-housing-delta.sh + run-housing-full.sh). SOURCED, never executed directly.
#
# Provides:
#   hc_load_env           source ~/.shorted-housing-crawl.env + set common defaults
#                         (DATABASE_URL, CRAWL_CDP_URL, BRANDBRAIN_AGENT_URL,
#                         conservative pacing) and export BIN / LOG.
#   hc_notify <msg>       best-effort macOS notification.
#   hc_acquire_lock       take the NON-BLOCKING single-drainer lock (skip the run
#                         with exit 0 if another housing crawl already holds it).
#   hc_drain_until_empty  loop `-mode agent` until the queue reports empty
#                         (bounded by CRAWL_DRAIN_MAX_ROUNDS), honouring the
#                         exit-3 re-warm / exit-4 Chrome breaks and propagating
#                         every other collector failure unchanged.
#   hc_freshness          run `-mode freshness`; notify + surface its exit code.
#
# NO Chrome management here: since C1 (crawl_chrome.go) `-mode agent` SELF-WARMS +
# self-recovers the dedicated Chrome in-process each run, so these wrappers only
# enqueue, drain, and check freshness (same posture as run-housing-agent.sh).

hc_load_env() {
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
	# A queue-draining run can crawl many suburbs back to back — 240 min default.
	export CRAWL_TIMEOUT_MIN="${CRAWL_TIMEOUT_MIN:-240}"
	export BRANDBRAIN_AGENT_URL="${BRANDBRAIN_AGENT_URL:-https://api.brandbrain.dev}"
	# Conservative pacing — keep the residential IP well under portal rate limits.
	# Block-free matters more than speed for an unattended scheduled run, and it's how
	# we scale by "right-sizing demand" instead of spending on proxies.
	export CRAWL_MIN_DELAY_MS="${CRAWL_MIN_DELAY_MS:-20000}"
	export CRAWL_MAX_DELAY_MS="${CRAWL_MAX_DELAY_MS:-45000}"

	BIN="${HOUSING_CRAWL_BIN:-$HOME/bin/house-price-collector}"
	LOG="${HOUSING_CRAWL_LOG:-$HOME/Library/Logs/shorted-housing-scheduler.log}"
}

hc_notify() { /usr/bin/osascript -e "display notification \"$1\" with title \"Housing crawl\"" >/dev/null 2>&1 || true; }

# --- Cross-wrapper single-drainer lock ------------------------------------------
# ALL housing drainers on a Mac share ONE host Chrome (localhost:9222) + ONE
# residential IP, so two concurrent `-mode agent` drainers halve the effective
# pacing and raise the block risk the no-proxy design exists to avoid. A full pass
# (500 suburbs x 2 portals at ~14/hr) takes ~1.5 DAYS, so it is still running when
# the daily delta fires — rescheduling can't fix a >1-day job. This lock serializes
# them: the daily delta cleanly SKIPS while a full pass holds the lock (the full
# already re-crawls everything).
#
# macOS has NO flock(1) (that's util-linux), so this is a PORTABLE atomic lock:
# `mkdir` is atomic (a create that fails ⇒ the lock is held), the holder's PID is
# stored inside for a stale-lock guard (a crashed run's lock is reclaimed, not left
# to wedge every future run), and an EXIT trap releases it. Shared path across all
# wrappers via a fixed HOME-relative lockdir.
HC_LOCK_DIR="${HOUSING_CRAWL_LOCKDIR:-$HOME/.shorted-housing-crawl.lockdir}"
HC_LOCK_OWNED=0

# hc_release_lock removes the lock IFF this process owns it (armed by the EXIT trap
# in hc_acquire_lock). Guarded by HC_LOCK_OWNED so a SKIP path can never delete a
# live holder's lock.
hc_release_lock() {
	if [[ "$HC_LOCK_OWNED" == "1" ]]; then
		rm -f "$HC_LOCK_DIR/pid" 2>/dev/null || true
		rmdir "$HC_LOCK_DIR" 2>/dev/null || true
		HC_LOCK_OWNED=0
	fi
}

# hc_acquire_lock takes the NON-BLOCKING lock. On success it arms an EXIT/INT/TERM
# trap to release and returns 0. If the lock is held by a LIVE process it logs and
# `exit 0` (skip this run cleanly). A STALE lock (holder PID dead/unreadable) is
# reclaimed and the mkdir retried once; if a live race then wins, it skips too.
hc_acquire_lock() {
	local log="${LOG:-/dev/null}"
	local tries=0
	while ((tries < 2)); do
		tries=$((tries + 1))
		if mkdir "$HC_LOCK_DIR" 2>/dev/null; then
			echo "$$" >"$HC_LOCK_DIR/pid"
			HC_LOCK_OWNED=1
			trap hc_release_lock EXIT INT TERM
			return 0
		fi
		# Held — is the holder still alive?
		local holder=""
		holder="$(/bin/cat "$HC_LOCK_DIR/pid" 2>/dev/null | /usr/bin/tr -dc '0-9')"
		if [[ -n "$holder" ]] && /bin/kill -0 "$holder" 2>/dev/null; then
			echo "$(date -u +%FT%TZ) another housing crawl holds the lock (pid $holder) — skipping this run" >>"$log"
			exit 0
		fi
		# Stale (holder dead or pid file unreadable) — reclaim + retry the mkdir.
		echo "$(date -u +%FT%TZ) reclaiming stale housing-crawl lock (holder='${holder:-unknown}' not alive)" >>"$log"
		rm -f "$HC_LOCK_DIR/pid" 2>/dev/null || true
		rmdir "$HC_LOCK_DIR" 2>/dev/null || true
	done
	# A live race won the re-mkdir after our reclaim — skip rather than double-drain.
	echo "$(date -u +%FT%TZ) could not acquire housing-crawl lock after reclaim — skipping this run" >>"$log"
	exit 0
}

# hc_drain_until_empty loops `-mode agent` until the brandbrain queue is drained, so
# ONE scheduled invocation clears the whole enqueue instead of leaving ~cap jobs
# behind (each `-mode agent` run only claims up to CRAWL_AGENT_MAX_JOBS, default 20,
# then self-warms Chrome + refreshes the housing MVs + pings revalidate). Bounded by
# CRAWL_DRAIN_MAX_ROUNDS (default 30). Round-terminating signals, in order:
#   rc 3  -> a sweep tripped the re-warm circuit; STOP (the next scheduled run
#            self-warms). Returns 3.
#   rc 4  -> Chrome unusable even after self-warm; STOP. Returns 4.
#   other non-zero rc -> fatal collector/agent failure; STOP and preserve rc.
#   "no more jobs" in the round output -> queue empty; STOP. Returns 0.
#   processed 0 job(s)                 -> nothing claimable (all circuit-open, or a
#            transient claim error); STOP to avoid spinning. Returns 0.
# Parses the collector's own STABLE log lines "[agent] no more jobs" and
# "[agent] done: processed N job(s)" (see runAgent in crawl_agent.go, which carries
# a comment pinning that contract).
hc_drain_until_empty() {
	local max_rounds="${CRAWL_DRAIN_MAX_ROUNDS:-30}"
	local round=0 rc=0 out processed capture_file
	capture_file="$(mktemp "${TMPDIR:-/tmp}/shorted-housing-drain.XXXXXX")" || {
		echo "$(date -u +%FT%TZ) drain: could not create round capture file" >>"$LOG"
		return 1
	}
	trap 'rm -f "$capture_file"; trap - RETURN' RETURN
	while ((round < max_rounds)); do
		round=$((round + 1))
		: >"$capture_file"
		"$BIN" -mode agent 2>&1 | /usr/bin/tee -a "$LOG" "$capture_file" >/dev/null
		rc=${PIPESTATUS[0]}
		out="$(/bin/cat "$capture_file")"
		processed="$(printf '%s\n' "$out" | /usr/bin/sed -n 's/.*done: processed \([0-9][0-9]*\) job.*/\1/p' | tail -1)"
		processed="${processed:-0}"
		echo "$(date -u +%FT%TZ) drain round $round/$max_rounds: rc=$rc processed=$processed" >>"$LOG"
		case "$rc" in
		3)
			echo "$(date -u +%FT%TZ) drain: re-warm signalled (rc=3) — stopping; collector self-warms next run" >>"$LOG"
			return 3
			;;
		4)
			echo "$(date -u +%FT%TZ) drain: Chrome unusable (rc=4) — stopping" >>"$LOG"
			return 4
			;;
		8)
			# The crawl ENVIRONMENT is broken (missing Playwright driver), not the
			# browser. Kept distinct from rc=4 because the 2026-08-13 outage proved
			# how expensive a wrong log line is: "Chrome unusable" sent the operator
			# to the re-warm runbook, which cannot install a driver, and the crawl
			# stayed down two days with 500/500 suburbs stale. Name the actual fix.
			echo "$(date -u +%FT%TZ) drain: crawl environment broken (rc=8) — the Playwright DRIVER is missing, NOT Chrome. Re-warming will not help. Reinstall: cd services && GOWORK=off go run github.com/mxschmitt/playwright-go/cmd/playwright@v0.6100.0 install" >>"$LOG"
			hc_notify "Housing crawl STOPPED: Playwright driver missing (rc=8). Re-warming Chrome will NOT fix it — reinstall the driver. See $LOG."
			return 8
			;;
		0)
			;;
		*)
			echo "$(date -u +%FT%TZ) drain: collector failed (rc=$rc) — stopping" >>"$LOG"
			hc_notify "Housing crawl agent failed (rc=$rc). Check $LOG."
			return "$rc"
			;;
		esac
		if printf '%s\n' "$out" | /usr/bin/grep -q "no more jobs"; then
			echo "$(date -u +%FT%TZ) drain: queue empty after $round round(s)" >>"$LOG"
			return 0
		fi
		if ((processed == 0)); then
			echo "$(date -u +%FT%TZ) drain: 0 processed and queue not reported empty — stopping to avoid spin" >>"$LOG"
			return 0
		fi
	done
	echo "$(date -u +%FT%TZ) drain: hit CRAWL_DRAIN_MAX_ROUNDS=$max_rounds — stopping (queue may still hold work; next scheduled run continues)" >>"$LOG"
	return 0
}

# hc_freshness runs the read-only freshness guard. Exit 6 == the board has silently
# gone stale (oldest covered suburb past CRAWL_FRESHNESS_ALARM_HOURS); notify so a
# human sees it even if nobody is tailing the log. Returns the collector's rc.
hc_freshness() {
	"$BIN" -mode freshness >>"$LOG" 2>&1
	local rc=$?
	echo "$(date -u +%FT%TZ) freshness rc=$rc" >>"$LOG"
	if [[ "$rc" -eq 6 ]]; then
		hc_notify "Housing crawl freshness ALARM — the price-drops board is going stale. Check $LOG / the residential rigs."
	fi
	return "$rc"
}
