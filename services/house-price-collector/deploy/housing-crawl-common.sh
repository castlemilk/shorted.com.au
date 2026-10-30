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
	# The playwright driver lives OUTSIDE ~/Library/Caches so disk-space sweeps
	# cannot delete it again (the 2026-08-13 outage). Repair/install:
	#   ~/bin/house-price-collector -mode install-driver
	export CRAWL_PW_DRIVER_DIR="${CRAWL_PW_DRIVER_DIR:-$HOME/.shorted-housing-crawl/pw-driver}"

	BIN="${HOUSING_CRAWL_BIN:-$HOME/bin/house-price-collector}"
	LOG="${HOUSING_CRAWL_LOG:-$HOME/Library/Logs/shorted-housing-scheduler.log}"
}

hc_notify() { /usr/bin/osascript -e "display notification \"$1\" with title \"Housing crawl\"" >/dev/null 2>&1 || true; }

# hc_alert pushes an operator-facing alarm on BOTH channels: the transient macOS
# notification (miss-able) and, when configured, a Slack/Discord-compatible
# webhook ({"text": ...}). This is the rig's ONLY push channel — every terminal
# wrapper failure must route through it, because the 2026-08 outages were all
# "the log said so and nobody read the log". Best-effort: an alert failure must
# never change a run's outcome. Webhook: CRAWL_ALERT_WEBHOOK, falling back to
# CRAWL_FRESHNESS_WEBHOOK so one secret serves both the collector and the
# wrappers.
hc_alert() {
	local msg="$1"
	hc_notify "$msg"
	local webhook="${CRAWL_ALERT_WEBHOOK:-${CRAWL_FRESHNESS_WEBHOOK:-}}"
	if [[ -z "$webhook" ]]; then
		# A DARK ALERT CHANNEL MUST ANNOUNCE THAT IT IS DARK. With no webhook this
		# function silently collapses back to a macOS notification — precisely the
		# miss-able channel it was written to replace, and precisely the state the
		# rig was found in on 2026-08-18 (zero WEBHOOK entries in
		# ~/.shorted-housing-crawl.env). Say so, in the log the operator is already
		# reading, naming the variables that would fix it.
		echo "$(date -u +%FT%TZ) [alert] NO WEBHOOK CONFIGURED (set CRAWL_ALERT_WEBHOOK or CRAWL_FRESHNESS_WEBHOOK in ~/.shorted-housing-crawl.env) — this alert reached only a desktop notification: $msg" >>"${LOG:-/dev/stderr}"
		return 0
	fi
	local host_tag
	host_tag="$(/bin/hostname -s 2>/dev/null || echo rig)"
	# Minimal JSON string escaping (backslash first, then quotes); wrapper
	# messages are ASCII one-liners by convention.
	local esc="${msg//\\/\\\\}"
	esc="${esc//\"/\\\"}"
	curl --fail --silent --show-error --max-time 10 \
		-X POST -H 'Content-Type: application/json' \
		--data "{\"text\":\"[housing-crawl ${host_tag}] ${esc}\"}" \
		"$webhook" >/dev/null 2>&1 \
		|| echo "$(date -u +%FT%TZ) hc_alert: webhook delivery failed (message: $msg)" >>"${LOG:-/dev/null}"
	return 0
}

# hc_wait_for_agent polls the BrandBrain macOS agent's loopback control port
# before the first enqueue. Two outage modes motivate it: the agent app dying
# on restart (strict parent coupling, no relaunch — every run then 401s) and a
# drain firing seconds before the agent's auth session is minted (observed
# 2026-08: a 9s race failed the whole run). The port is re-minted per launch —
# ALWAYS read ~/.brandbrain/diag-port, never hardcode. Non-fatal by design:
# the collector auto-refreshes its token on 401, so after the wait budget we
# alert and proceed rather than block the schedule.
hc_wait_for_agent() {
	local wait_s="${CRAWL_AGENT_WAIT_S:-120}"
	local portfile="${BRANDBRAIN_DIAG_PORT_FILE:-$HOME/.brandbrain/diag-port}"
	local waited=0 port=""
	while ((waited < wait_s)); do
		port="$(/bin/cat "$portfile" 2>/dev/null | /usr/bin/tr -dc '0-9')"
		if [[ -n "$port" ]] && /usr/bin/nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
			echo "$(date -u +%FT%TZ) brandbrain agent control port $port is up (waited ${waited}s)" >>"${LOG:-/dev/null}"
			return 0
		fi
		sleep 5
		waited=$((waited + 5))
	done
	hc_alert "BrandBrain agent control port not up after ${wait_s}s — runs may 401. Is BrandBrainAgent.app running? (open -a /Applications/BrandBrainAgent.app, then read ~/.brandbrain/diag-port)"
	return 0
}

# hc_find_go resolves a usable `go` binary WITHOUT relying on PATH.
#
# THIS IS THE WHOLE POINT: launchd starts the wrappers with a minimal PATH
# (/usr/bin:/bin:/usr/sbin:/sbin) and the plists set no EnvironmentVariables, so
# an interactive `command -v go` proves nothing about the scheduled run. Homebrew
# installs go at /opt/homebrew/bin/go, which is NOT on that PATH — so every
# scheduled run resolved "unknown" and the provenance line, the one defence
# against a drifted hand-deployed binary, was dark on the only context that
# matters. Probe explicit candidates; HOUSING_GO_BIN overrides for odd rigs.
# Prints the go path, or nothing when none is usable.
hc_find_go() {
	local candidates=() c
	[[ -n "${HOUSING_GO_BIN:-}" ]] && candidates+=("$HOUSING_GO_BIN")
	c="$(command -v go 2>/dev/null || true)"
	[[ -n "$c" ]] && candidates+=("$c")
	candidates+=(/opt/homebrew/bin/go /usr/local/go/bin/go /usr/local/bin/go)
	for c in "${candidates[@]}"; do
		[[ -x "$c" ]] && { echo "$c"; return 0; }
	done
	return 1
}

# hc_log_binary_provenance names the exact code this run executes. The rig
# binary is a HAND deploy (deploy/README.md) — it has drifted from main before
# (built 4h17m before the fix it was assumed to carry, 2026-08-15), and the
# only durable defence is making the running revision impossible to not see.
# Best-effort: a rig with no Go toolchain at any candidate path logs "unknown"
# rather than failing.
hc_log_binary_provenance() {
	local rev="unknown" gobin
	gobin="$(hc_find_go || true)"
	if [[ -n "$gobin" ]]; then
		rev="$("$gobin" version -m "$BIN" 2>/dev/null \
			| /usr/bin/awk '$1 == "build" && $2 ~ /^vcs\.revision=/ { sub("vcs.revision=", "", $2); print substr($2, 1, 12); exit }')"
		rev="${rev:-unknown}"
	fi
	echo "$(date -u +%FT%TZ) collector binary: $BIN (vcs.revision=${rev})" >>"$LOG"
}

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
		# Remove the lock ONLY while its pid file still names us. A lock that was
		# reclaimed and taken over by another process is not ours to remove.
		local cur
		cur="$(/bin/cat "$HC_LOCK_DIR/pid" 2>/dev/null | /usr/bin/tr -dc '0-9')"
		if [[ "$cur" == "$$" ]]; then
			rm -f "$HC_LOCK_DIR/pid" 2>/dev/null || true
			rmdir "$HC_LOCK_DIR" 2>/dev/null || true
		fi
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
		# Test seam: the cross-language test interleaves a second reclaimer here.
		if declare -F hc_lock_before_reclaim >/dev/null 2>&1; then hc_lock_before_reclaim; fi
		# Re-read the pid immediately before removing anything. If it changed since
		# we judged it stale, another process has reclaimed and taken the lock, so
		# this run must not remove it. Go's reclaim does the same check.
		local again=""
		again="$(/bin/cat "$HC_LOCK_DIR/pid" 2>/dev/null | /usr/bin/tr -dc '0-9')"
		if [[ "$again" != "$holder" ]]; then
			echo "$(date -u +%FT%TZ) housing-crawl lock changed during reclaim (pid '${holder:-unknown}' -> '${again:-unknown}') — skipping this run" >>"$log"
			exit 0
		fi
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
# then self-warms Chrome + refreshes the housing MVs, and leaves its revalidate ping
# to the drain, below). Bounded by CRAWL_DRAIN_MAX_ROUNDS (default 30).
# Round-terminating signals, in order:
#   rc 3  -> a sweep tripped the re-warm circuit. COOL DOWN and retry in the same
#            invocation (CRAWL_REWARM_COOLDOWN_SEC, CRAWL_REWARM_MAX_RETRIES);
#            only return 3 once that budget is spent. Handing a re-warm back to
#            the SCHEDULE is what made the crawl slow: the delta job runs at
#            10:00 daily, so one re-warm cost a whole day. Measured 2026-09-10 —
#            the run stopped at 21 of 38 jobs against a 120-suburb cap, which
#            turns the designed ~4-day catalog rotation into weeks.
#   rc 4  -> Chrome unusable even after self-warm; STOP. Returns 4.
#   other non-zero rc -> fatal collector/agent failure; STOP and preserve rc.
#   "no more jobs" in the round output -> queue empty; STOP. Returns 0.
#   processed 0 job(s)                 -> nothing claimable (all circuit-open, or a
#            transient claim error); STOP to avoid spinning. Returns 0.
# Parses the collector's own STABLE log lines "[agent] no more jobs" and
# "[agent] done: processed N job(s)" (see runAgent in crawl_agent.go, which carries
# a comment pinning that contract).
#
# Cache revalidation is once per DRAIN, not once per round. A round that wrote
# data used to ping /api/revalidate itself, and one ping purges /price-drops,
# /housing and every suburb page and flushes the whole housing KV prefix. A drain
# of N rounds purged them N times, so nearly every visit during a drain was the
# first request after a purge, which renders while the visitor waits (2026-10-21:
# /price-drops, two GETs 20 minutes apart, both 44s at Age 0). Each round now runs
# with CRAWL_REVALIDATE_DEFER=1 and logs "deferred to the drain" instead
# (revalidateAfterCrawlWrite in revalidate.go). The drain runs `-mode revalidate`
# once when it ends, whichever way it ends, and at most once per
# CRAWL_REVALIDATE_INTERVAL_SEC (default 3600) while a long drain runs. The ping
# is best-effort: it never changes the drain's return code.
hc_drain_until_empty() {
	local revalidate_due=0 revalidated_at rc
	revalidated_at="$(date +%s)"
	hc_drain_rounds
	rc=$?
	if ((revalidate_due)); then
		hc_drain_revalidate
	fi
	return "$rc"
}

# hc_drain_revalidate sends the drain's one cache bust (see hc_drain_until_empty)
# and resets the state it shares with hc_drain_rounds.
hc_drain_revalidate() {
	local revalidate_rc=0
	echo "$(date -u +%FT%TZ) drain: revalidating the housing caches for the rounds that deferred" >>"$LOG"
	"$BIN" -mode revalidate >>"$LOG" 2>&1 || revalidate_rc=$?
	if ((revalidate_rc != 0)); then
		echo "$(date -u +%FT%TZ) drain: revalidate exited $revalidate_rc (best-effort; the drain result is unchanged)" >>"$LOG"
	fi
	revalidate_due=0
	revalidated_at="$(date +%s)"
}

# hc_drain_rounds is the round loop behind hc_drain_until_empty, which owns the
# contract documented there.
hc_drain_rounds() {
	local max_rounds="${CRAWL_DRAIN_MAX_ROUNDS:-30}"
	# A re-warm is a routine Kasada outcome, not a fault, and the collector
	# self-warms at the start of every `-mode agent` round — so the only thing a
	# retry needs is time for the portal to stop seeing the burnt fingerprint.
	# Slow, and bounded. The cooldown is what makes a retry work; the budget is
	# what stops a blocking portal being hammered.
	#
	# Two production runs on 2026-09-11 measured this, and the second corrected
	# the first. Judge a run by SUCCEEDED jobs, never by "processed" — processed
	# counts jobs that were claimed and immediately DEFERRED because the portal
	# circuit was open, so a long run of deferrals reads as throughput:
	#
	#   budget 2:  85 processed -> 34 succeeded, 16 failed, 35 deferred
	#   budget 4: 323 processed -> 26 succeeded, 56 failed, 241 deferred
	#
	# Four retries ran almost four times as long, succeeded on FEWER suburbs and
	# tripled the failures. Once the circuit is open the portal is telling us to
	# stop, and more retries just keep asking. Two it is.
	local rewarm_cooldown="${CRAWL_REWARM_COOLDOWN_SEC:-900}"
	local rewarm_budget="${CRAWL_REWARM_MAX_RETRIES:-2}"
	local rewarms=0
	local round=0 rc=0 out processed capture_file
	capture_file="$(mktemp "${TMPDIR:-/tmp}/shorted-housing-drain.XXXXXX")" || {
		echo "$(date -u +%FT%TZ) drain: could not create round capture file" >>"$LOG"
		return 1
	}
	trap 'rm -f "$capture_file"; trap - RETURN' RETURN
	while ((round < max_rounds)); do
		round=$((round + 1))
		: >"$capture_file"
		CRAWL_REVALIDATE_DEFER=1 "$BIN" -mode agent 2>&1 | /usr/bin/tee -a "$LOG" "$capture_file" >/dev/null
		rc=${PIPESTATUS[0]}
		out="$(/bin/cat "$capture_file")"
		processed="$(printf '%s\n' "$out" | /usr/bin/sed -n 's/.*done: processed \([0-9][0-9]*\) job.*/\1/p' | tail -1)"
		processed="${processed:-0}"
		echo "$(date -u +%FT%TZ) drain round $round/$max_rounds: rc=$rc processed=$processed" >>"$LOG"
		# Before the rc dispatch below, so a round that wrote data and then
		# ended the drain (a re-warm, a dead Chrome) still gets its ping.
		if printf '%s\n' "$out" | /usr/bin/grep -q "deferred to the drain"; then
			revalidate_due=1
		fi
		if ((revalidate_due)) && (($(date +%s) - revalidated_at >= ${CRAWL_REVALIDATE_INTERVAL_SEC:-3600})); then
			hc_drain_revalidate
		fi
		case "$rc" in
		3)
			if ((rewarms >= rewarm_budget)); then
				echo "$(date -u +%FT%TZ) drain: re-warm signalled (rc=3) and the retry budget is spent after $rewarms retry(ies) — stopping; the next scheduled run self-warms" >>"$LOG"
				return 3
			fi
			rewarms=$((rewarms + 1))
			echo "$(date -u +%FT%TZ) drain: re-warm signalled (rc=3) — cooling down ${rewarm_cooldown}s then retrying in this run ($rewarms/$rewarm_budget)" >>"$LOG"
			/bin/sleep "$rewarm_cooldown"
			continue
			;;
		4)
			echo "$(date -u +%FT%TZ) drain: Chrome unusable (rc=4) — stopping" >>"$LOG"
			hc_alert "Housing crawl STOPPED: Chrome unusable (rc=4) even after self-warm. See $LOG."
			return 4
			;;
		8)
			# The crawl ENVIRONMENT is broken: the Playwright driver is missing, or another
			# process holds the CDP port. Neither is a browser fault, so both are kept
			# distinct from rc=4. The 2026-08-13 outage proved how expensive a wrong log
			# line is: "Chrome unusable" sent the operator to the re-warm runbook, which
			# cannot fix either, and the crawl stayed down two days. The collector's own
			# log line says which one it was.
			echo "$(date -u +%FT%TZ) drain: crawl environment broken (rc=8) — the Playwright DRIVER is missing (reinstall: ~/bin/house-price-collector -mode install-driver), or the CDP port held by another process (see the log line above). Re-warming will not help." >>"$LOG"
			hc_alert "Housing crawl STOPPED: crawl environment broken (rc=8) — driver missing, or the CDP port held by another process. Re-warming Chrome will NOT fix either. See $LOG."
			return 8
			;;
		10)
			# A round cancelled on purpose (SIGTERM/SIGINT, or its events stream or
			# parent went away). It finalized what it committed, so stop without
			# retrying and without alerting: an operator stop is not a fault.
			echo "$(date -u +%FT%TZ) drain: round cancelled (rc=10) — stopping; committed work was finalized" >>"$LOG"
			return 10
			;;
		12)
			# Another live process holds the single-drainer lock. Under this wrapper
			# the lock is ours and the round is our child, so this means a second
			# drainer exists. Stop and say so; do not retry against it.
			echo "$(date -u +%FT%TZ) drain: another drainer holds the lock (rc=12) — stopping" >>"$LOG"
			hc_alert "Housing crawl STOPPED: another drainer holds the housing-crawl lock (rc=12). See $LOG."
			return 12
			;;
		0)
			;;
		*)
			echo "$(date -u +%FT%TZ) drain: collector failed (rc=$rc) — stopping" >>"$LOG"
			hc_alert "Housing crawl agent failed (rc=$rc). Check $LOG."
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
		hc_alert "Housing crawl freshness ALARM — the price-drops board is going stale. Check $LOG / the residential rigs."
	fi
	return "$rc"
}
