#!/usr/bin/env bash
# Shared helpers for the demand-right-sizing housing-crawl wrappers
# (run-housing-delta.sh + run-housing-full.sh). SOURCED, never executed directly.
#
# Provides:
#   hc_load_env           source ~/.shorted-housing-crawl.env + set common defaults
#                         (DATABASE_URL, CRAWL_CDP_URL, BRANDBRAIN_AGENT_URL,
#                         conservative pacing) and export BIN / LOG.
#   hc_notify <msg>       best-effort macOS notification.
#   hc_drain_until_empty  loop `-mode agent` until the queue reports empty
#                         (bounded by CRAWL_DRAIN_MAX_ROUNDS), honouring the
#                         exit-3 re-warm / exit-4 Chrome breaks.
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
	# Block-free matters more than speed for an unattended nightly run, and it's how
	# we scale by "right-sizing demand" instead of spending on proxies.
	export CRAWL_MIN_DELAY_MS="${CRAWL_MIN_DELAY_MS:-20000}"
	export CRAWL_MAX_DELAY_MS="${CRAWL_MAX_DELAY_MS:-45000}"

	BIN="${HOUSING_CRAWL_BIN:-$HOME/bin/house-price-collector}"
	LOG="${HOUSING_CRAWL_LOG:-$HOME/Library/Logs/shorted-housing-scheduler.log}"
}

hc_notify() { /usr/bin/osascript -e "display notification \"$1\" with title \"Housing crawl\"" >/dev/null 2>&1 || true; }

# hc_drain_until_empty loops `-mode agent` until the brandbrain queue is drained, so
# ONE scheduled invocation clears the whole enqueue instead of leaving ~cap jobs
# behind (each `-mode agent` run only claims up to CRAWL_AGENT_MAX_JOBS, default 20,
# then self-warms Chrome + refreshes the housing MVs + pings revalidate). Bounded by
# CRAWL_DRAIN_MAX_ROUNDS (default 30). Round-terminating signals, in order:
#   rc 3  -> a sweep tripped the re-warm circuit; STOP (the next scheduled run
#            self-warms). Returns 3.
#   rc 4  -> Chrome unusable even after self-warm; STOP. Returns 4.
#   "no more jobs" in the round output -> queue empty; STOP. Returns 0.
#   processed 0 job(s)                 -> nothing claimable (all circuit-open, or a
#            transient claim error); STOP to avoid spinning. Returns 0.
# Parses the collector's own STABLE log lines "[agent] no more jobs" and
# "[agent] done: processed N job(s)" (see runAgent in crawl_agent.go, which carries
# a comment pinning that contract).
hc_drain_until_empty() {
	local max_rounds="${CRAWL_DRAIN_MAX_ROUNDS:-30}"
	local round=0 rc=0 out processed
	while ((round < max_rounds)); do
		round=$((round + 1))
		out="$("$BIN" -mode agent 2>&1)"
		rc=$?
		printf '%s\n' "$out" >>"$LOG"
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
