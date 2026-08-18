# Housing listings crawl — reliability programme (implementation plan)

Design: `docs/superpowers/specs/2026-08-18-crawl-reliability-design.md` — read
it first; it carries the arithmetic and the verified corrections this plan
assumes.

## Ground rules for the implementer

- Every Go command runs with `GOWORK=off`. Unit tests:
  `cd services && GOWORK=off go test ./house-price-collector/ -run <Name>`.
  Store/DB tests need `-tags=integration` (none are added by this plan).
- **No migrations.** Nothing here touches DDL, so the hand-applied-prod-DDL
  regime is not in play.
- **No jest visual baselines** (linux-only; nothing here touches web UI).
- The wrapper scripts and the collector binary on the rig are a **hand
  deploy** — merging this plan does not ship it. The final task stages the rig
  via the new `stage-rig.sh`. Do not run any crawl mode as part of this plan;
  the bash test suite uses fake collectors only.
- Tasks 1–8 are independent of each other and can land in any order; Task 9
  (docs) and Task 10 (rig staging, operator-run) go last.
- TDD: in every task the test is written and observed to FAIL before the
  implementation change, then observed to PASS after.

---

## Task 1 — Raise the delta cap: `CRAWL_DELTA_MAX_SUBURBS` 60 → 120

The delta cap, not drain behaviour, is the throughput ceiling (design §2).
120/day ≈ 4.2-day catalog rotation ≈ ~9.6h crawl-time/day at current pacing.
Pacing (`CRAWL_MIN_DELAY_MS`/`CRAWL_MAX_DELAY_MS`) is NOT touched.

**Test first** — append to
`services/house-price-collector/crawl_delta_test.go`:

```go
// The delta cap is the throughput ceiling of the whole crawl: 500 catalog
// suburbs / cap per day = the steady-state rotation. 60/day implied ~8.3 days
// (measured median 117h staleness, 2026-08-18); 120/day keeps rotation inside
// the 120h freshness horizon with margin. envInt treats "" as unset, so
// t.Setenv with an empty value exercises the default.
func TestLoadDeltaConfig_DefaultCapSupportsFreshnessHorizon(t *testing.T) {
	t.Setenv("CRAWL_DELTA_TTL_HOURS", "")
	t.Setenv("CRAWL_DELTA_CHURN_MIN", "")
	t.Setenv("CRAWL_DELTA_CHURN_DAYS", "")
	t.Setenv("CRAWL_DELTA_MAX_SUBURBS", "")
	cfg := loadDeltaConfig()
	if cfg.maxSuburbs != 120 {
		t.Fatalf("default CRAWL_DELTA_MAX_SUBURBS = %d, want 120 (500/120 ≈ 4.2-day rotation < 120h horizon)", cfg.maxSuburbs)
	}
	if cfg.ttl != 24*time.Hour {
		t.Fatalf("default CRAWL_DELTA_TTL_HOURS changed to %s — this task must not touch selection eligibility", cfg.ttl)
	}
}
```

Run: `cd services && GOWORK=off go test ./house-price-collector/ -run TestLoadDeltaConfig` — FAILS (got 60).

**Implement** — in `services/house-price-collector/crawl_delta.go`, change two
lines.

The struct comment (line 38):

```go
	maxSuburbs int           // CRAWL_DELTA_MAX_SUBURBS(default 120): per-run selection cap
```

The default (line 46):

```go
		maxSuburbs: envInt("CRAWL_DELTA_MAX_SUBURBS", 120),
```

Also update the stale default shown in the wrapper's banner line — in
`services/house-price-collector/deploy/run-housing-delta.sh` line 51, replace
`cap=${CRAWL_DELTA_MAX_SUBURBS:-60}` with `cap=${CRAWL_DELTA_MAX_SUBURBS:-120}`,
and in its header comment (line 7–8) replace `capped at CRAWL_DELTA_MAX_SUBURBS
(default 60)` with `capped at CRAWL_DELTA_MAX_SUBURBS (default 120)`.

Run: the new test PASSES; full package test
`cd services && GOWORK=off go test ./house-price-collector/` stays green.

---

## Task 2 — Renegotiate the horizon: `CRAWL_FRESHNESS_ALARM_HOURS` 72 → 120

72h is unreachable at any sane cap (design §2); an alarm that is always on is
an alarm nobody reads. 120h matches the Task-1 rotation with margin.

**Test first** — append to
`services/house-price-collector/crawl_freshness_test.go`:

```go
// The alarm horizon must be one the configured throughput can actually meet:
// at CRAWL_DELTA_MAX_SUBURBS=120 the catalog rotates in ~4.2 days (~101h), so
// 120h alarms only on genuine trouble. The old 72h default alarmed on the
// steady state itself, which is how a 305h-oldest catalog became normal.
func TestLoadFreshnessConfig_DefaultHorizonMatchesConfiguredThroughput(t *testing.T) {
	t.Setenv("CRAWL_DELTA_TTL_HOURS", "")
	t.Setenv("CRAWL_FRESHNESS_ALARM_HOURS", "")
	t.Setenv("CRAWL_DELTA_CHURN_DAYS", "")
	t.Setenv("CRAWL_FRESHNESS_WEBHOOK", "")
	cfg := loadFreshnessConfig()
	if cfg.alarmAfter != 120*time.Hour {
		t.Fatalf("default CRAWL_FRESHNESS_ALARM_HOURS = %s, want 120h", cfg.alarmAfter)
	}
	if cfg.ttl != 24*time.Hour {
		t.Fatalf("default CRAWL_DELTA_TTL_HOURS changed to %s — the stale-count line must keep meaning 'older than a day'", cfg.ttl)
	}
}
```

Run — FAILS (got 72h). (The existing `classifyFreshness` tests build explicit
configs via `defaultFreshnessCfg()` and are unaffected.)

**Implement** — in `services/house-price-collector/crawl_freshness.go`:

Line 30 (struct comment):

```go
	alarmAfter time.Duration // CRAWL_FRESHNESS_ALARM_HOURS (default 120h): oldest-covered horizon that alarms
```

Line 38:

```go
		alarmAfter: time.Duration(envInt("CRAWL_FRESHNESS_ALARM_HOURS", 120)) * time.Hour,
```

Run: new test PASSES; package green.

---

## Task 3 — One rig alert helper (`hc_alert`) + wait-for-agent, wired to every terminal failure

Today a failed scheduled run ends in a log line plus (sometimes) a transient
macOS notification; `CRAWL_FRESHNESS_WEBHOOK` is read only by `-mode
freshness` and has never been set. This task gives the wrappers one push
channel and closes the drain-vs-auth-mint race rig-side.

**Test first** — append these tests to
`services/house-price-collector/deploy/housing-lifecycle-exit.test.sh`,
immediately before the `failures=0` line, and add the four invocation lines to
the run list at the bottom (shown after the functions):

```bash
# hc_alert must reach BOTH channels: the macOS notification (existing hc_notify)
# and, when a webhook is configured, an HTTP POST. Faked by shadowing curl and
# osascript on PATH — no network, no real notification.
make_fake_tools() {
	FAKE_TOOLS="$TMP_ROOT/tools"
	mkdir -p "$FAKE_TOOLS"
	cat >"$FAKE_TOOLS/curl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" >>"$TMP_ROOT/curl-args.txt"
exit 0
EOF
	chmod +x "$FAKE_TOOLS/curl"
}

test_hc_alert_posts_webhook_when_configured() {
	make_fake_tools
	rm -f "$TMP_ROOT/curl-args.txt"
	run_expect_rc 0 bash -c '
		set -uo pipefail
		PATH="$4:$PATH"
		source "$1/housing-crawl-common.sh"
		LOG="$3"
		CRAWL_ALERT_WEBHOOK="https://hooks.example.invalid/T000/B000"
		hc_alert "test alert message"
	' _ "$DIR" unused "$TMP_ROOT/alert.log" "$FAKE_TOOLS" || return 1
	if ! /usr/bin/grep -q "test alert message" "$TMP_ROOT/curl-args.txt"; then
		echo "FAIL: hc_alert did not POST the message to the webhook" >&2
		return 1
	fi
	if ! /usr/bin/grep -q "hooks.example.invalid" "$TMP_ROOT/curl-args.txt"; then
		echo "FAIL: hc_alert did not target CRAWL_ALERT_WEBHOOK" >&2
		return 1
	fi
}

test_hc_alert_escapes_json_quotes() {
	make_fake_tools
	rm -f "$TMP_ROOT/curl-args.txt"
	run_expect_rc 0 bash -c '
		set -uo pipefail
		PATH="$4:$PATH"
		source "$1/housing-crawl-common.sh"
		LOG="$3"
		CRAWL_ALERT_WEBHOOK="https://hooks.example.invalid/x"
		hc_alert "rc=8: reinstall with \"install-driver\""
	' _ "$DIR" unused "$TMP_ROOT/alert-esc.log" "$FAKE_TOOLS" || return 1
	if ! /usr/bin/grep -q '\\"install-driver\\"' "$TMP_ROOT/curl-args.txt"; then
		echo "FAIL: hc_alert did not JSON-escape double quotes" >&2
		return 1
	fi
}

test_hc_alert_noops_without_webhook() {
	make_fake_tools
	rm -f "$TMP_ROOT/curl-args.txt"
	run_expect_rc 0 bash -c '
		set -uo pipefail
		PATH="$4:$PATH"
		source "$1/housing-crawl-common.sh"
		LOG="$3"
		unset CRAWL_ALERT_WEBHOOK CRAWL_FRESHNESS_WEBHOOK 2>/dev/null || true
		hc_alert "should not be posted"
	' _ "$DIR" unused "$TMP_ROOT/alert-none.log" "$FAKE_TOOLS" || return 1
	if [[ -f "$TMP_ROOT/curl-args.txt" ]]; then
		echo "FAIL: hc_alert POSTed with no webhook configured" >&2
		return 1
	fi
}

# The wait-for-agent gate must give up after its budget, alert, and still
# return 0 — the collector has its own on-401 token refresh, so a missing
# agent must degrade the run to "will probably 401 loudly", never block it.
test_hc_wait_for_agent_times_out_alerts_and_proceeds() {
	make_fake_tools
	rm -f "$TMP_ROOT/curl-args.txt"
	run_expect_rc 0 bash -c '
		set -uo pipefail
		PATH="$4:$PATH"
		source "$1/housing-crawl-common.sh"
		LOG="$3"
		CRAWL_ALERT_WEBHOOK="https://hooks.example.invalid/x"
		CRAWL_AGENT_WAIT_S=1
		BRANDBRAIN_DIAG_PORT_FILE="$2/nonexistent-diag-port"
		hc_wait_for_agent
	' _ "$DIR" "$TMP_ROOT" "$TMP_ROOT/wait.log" "$FAKE_TOOLS" || return 1
	if ! /usr/bin/grep -qi "agent control port" "$TMP_ROOT/curl-args.txt"; then
		echo "FAIL: agent-wait timeout did not alert" >&2
		return 1
	fi
}
```

Run list additions (bottom of the file, before the `if ((failures > 0))`):

```bash
test_hc_alert_posts_webhook_when_configured || failures=$((failures + 1))
test_hc_alert_escapes_json_quotes || failures=$((failures + 1))
test_hc_alert_noops_without_webhook || failures=$((failures + 1))
test_hc_wait_for_agent_times_out_alerts_and_proceeds || failures=$((failures + 1))
```

Run: `bash services/house-price-collector/deploy/housing-lifecycle-exit.test.sh`
— the four new tests FAIL (`hc_alert: command not found`).

**Implement** — in
`services/house-price-collector/deploy/housing-crawl-common.sh`, insert the
following directly after the existing `hc_notify` line:

```bash
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
	[[ -z "$webhook" ]] && return 0
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
```

Then wire the existing failure paths through `hc_alert`, in the same file:

- In `hc_drain_until_empty`, case `4)`: add
  `hc_alert "Housing crawl STOPPED: Chrome unusable (rc=4) even after self-warm. See $LOG."`
  before `return 4`.
- Case `8)`: replace the existing `hc_notify "Housing crawl STOPPED: …"` line with
  `hc_alert "Housing crawl STOPPED: Playwright driver missing (rc=8). Re-warming Chrome will NOT fix it — reinstall the driver. See $LOG."`
- The generic-failure `*)` case: replace
  `hc_notify "Housing crawl agent failed (rc=$rc). Check $LOG."` with
  `hc_alert "Housing crawl agent failed (rc=$rc). Check $LOG."`
- In `hc_freshness`, replace the `hc_notify "Housing crawl freshness ALARM …"`
  line with
  `hc_alert "Housing crawl freshness ALARM — the price-drops board is going stale. Check $LOG / the residential rigs."`
  (rc 3 stays silent — it is the expected self-heal path.)

Finally, gate the enqueue on agent readiness — in
`services/house-price-collector/deploy/run-housing-delta.sh`, insert after the
`hc_acquire_lock` line:

```bash
# Don't race the macOS agent's auth mint after a restart — poll its control
# port (bounded), alert if it never comes up, then proceed regardless.
hc_wait_for_agent
```

and the identical two-line-comment + call in
`services/house-price-collector/deploy/run-housing-full.sh` after its
`hc_acquire_lock`.

Run: all lifecycle tests PASS (old and new).

---

## Task 4 — Wall-clock watchdog for a hung drain round

`CRAWL_TIMEOUT_MIN` does not fire on the CDP pipe (a 13h02m hang was observed
holding the crawl lock with zero output). The wrapper is the reliable place to
enforce a wall clock: a round is ≤20 jobs ≈ ~48 min, so 90 min is generous.

**Test first** — append to `housing-lifecycle-exit.test.sh` (before the run
list), plus two run-list lines:

```bash
# A collector round that stops responding must be killed at the wall clock and
# must NOT wedge the drain forever. One kill → continue (the next round
# self-warms Chrome in-process); two kills → stop the drain with rc=4 + alert,
# because a rig that hangs twice needs a human, not a third round.
make_hanging_collector() {
	cat >"$FAKE_COLLECTOR" <<'EOF'
#!/usr/bin/env bash
case "${2:-}" in
agent) sleep 300 ;;
*) exit 0 ;;
esac
EOF
	chmod +x "$FAKE_COLLECTOR"
}

test_watchdog_kills_hung_round_and_stops_after_two() {
	make_fake_tools
	make_hanging_collector
	local log="$TMP_ROOT/watchdog.log"
	local start end
	start=$(date +%s)
	run_expect_rc 4 bash -c '
		set -uo pipefail
		PATH="$4:$PATH"
		source "$1/housing-crawl-common.sh"
		BIN="$2"
		LOG="$3"
		CRAWL_DRAIN_MAX_ROUNDS=5
		CRAWL_ROUND_WALL_S=2
		hc_drain_until_empty
	' _ "$DIR" "$FAKE_COLLECTOR" "$log" "$FAKE_TOOLS" || return 1
	end=$(date +%s)
	if ((end - start > 60)); then
		echo "FAIL: watchdog run took $((end - start))s — the wall clock did not fire" >&2
		return 1
	fi
	if [[ "$(/usr/bin/grep -c "watchdog: agent round exceeded" "$log")" -lt 2 ]]; then
		echo "FAIL: expected two watchdog kills in $log" >&2
		return 1
	fi
}

test_watchdog_does_not_touch_fast_rounds() {
	apply_fake 0 0
	run_expect_rc 0 bash -c '
		set -uo pipefail
		source "$1/housing-crawl-common.sh"
		BIN="$2"
		LOG="$3"
		CRAWL_DRAIN_MAX_ROUNDS=1
		CRAWL_ROUND_WALL_S=30
		hc_drain_until_empty
	' _ "$DIR" "$FAKE_COLLECTOR" "$TMP_ROOT/watchdog-fast.log"
}
```

Run list:

```bash
test_watchdog_kills_hung_round_and_stops_after_two || failures=$((failures + 1))
test_watchdog_does_not_touch_fast_rounds || failures=$((failures + 1))
```

Run — the first new test FAILS (hangs are not killed; use Ctrl-C sparingly:
the 5×`CRAWL_ROUND_WALL_S` bound means the failing form times out the
`run_expect_rc` only after the fake's `sleep 300`; it is acceptable to
observe the failure as "test wedged >60s" and kill it).

**Implement** — in `housing-crawl-common.sh`:

1. Add this function directly above `hc_drain_until_empty`:

```bash
# hc_run_agent_round runs ONE `-mode agent` round under a hard wall clock.
# CRAWL_TIMEOUT_MIN is NOT enforced on the CDP fetch path — a playwright-go
# driver call that stops responding blocks on its pipe and never observes the
# Go context (observed 2026-08-05: a round at 13h02m elapsed, zero output,
# holding the single-drainer lock so every later scheduled run skipped). The
# wrapper owns the wall: TERM at the limit, KILL 10s later. A killed round has
# written nothing since it hung, so no work is lost. Wall: CRAWL_ROUND_WALL_MIN
# (default 90 — a round is ≤20 jobs ≈ 48 min at conservative pacing);
# CRAWL_ROUND_WALL_S overrides in seconds for tests.
hc_run_agent_round() {
	local capture_file="$1"
	local wall_s="${CRAWL_ROUND_WALL_S:-$((${CRAWL_ROUND_WALL_MIN:-90} * 60))}"
	: >"$capture_file"
	"$BIN" -mode agent >"$capture_file" 2>&1 &
	local pid=$!
	(
		sleep "$wall_s"
		if /bin/kill -0 "$pid" 2>/dev/null; then
			echo "$(date -u +%FT%TZ) watchdog: agent round exceeded ${wall_s}s wall clock — killing pid $pid" >>"$LOG"
			/bin/kill "$pid" 2>/dev/null
			sleep 10
			/bin/kill -9 "$pid" 2>/dev/null
		fi
	) &
	local watchdog=$!
	wait "$pid"
	local rc=$?
	/bin/kill "$watchdog" 2>/dev/null
	wait "$watchdog" 2>/dev/null
	/bin/cat "$capture_file" >>"$LOG"
	return "$rc"
}
```

2. Rework the round invocation inside `hc_drain_until_empty`. Replace:

```bash
		: >"$capture_file"
		"$BIN" -mode agent 2>&1 | /usr/bin/tee -a "$LOG" "$capture_file" >/dev/null
		rc=${PIPESTATUS[0]}
```

with:

```bash
		hc_run_agent_round "$capture_file"
		rc=$?
```

(The round's output now reaches `$LOG` when the round ends rather than
streaming — the collector already buffers a whole round internally, so this
changes nothing an operator can observe.)

3. Add a kill counter. In `hc_drain_until_empty`, extend the `local` line to
   include `watchdog_kills=0`, and add a case arm for the kill signals
   (SIGTERM=143, SIGKILL=137) between the `0)` and `*)` arms:

```bash
		137 | 143)
			watchdog_kills=$((watchdog_kills + 1))
			if ((watchdog_kills >= 2)); then
				echo "$(date -u +%FT%TZ) drain: second hung round killed by the watchdog — stopping (treating as unusable Chrome)" >>"$LOG"
				hc_alert "Housing crawl: two drain rounds hung past the wall clock and were killed — stopping this run (rc=4). A wedged CDP/Chrome needs a look. See $LOG."
				return 4
			fi
			echo "$(date -u +%FT%TZ) drain: hung round killed by the watchdog — continuing (next round self-warms)" >>"$LOG"
			continue
			;;
```

Run: both new tests PASS; the whole lifecycle suite stays green.

---

## Task 5 — Move the Playwright driver out of prunable caches + `-mode install-driver`

rc=8 (#435) *names* a deleted driver; this task makes the deletion class not
recur: the driver lives under `~/.shorted-housing-crawl/pw-driver`, a path no
cache sweep owns, and the collector itself can (re)install it with the exact
options the fetchers use.

**Test first** — new file
`services/house-price-collector/crawl_driver_test.go`:

```go
package main

import "testing"

func TestResolveDriverDir(t *testing.T) {
	cases := []struct {
		name string
		env  string
		want string
	}{
		{"unset keeps playwright default", "", ""},
		{"set is honoured", "/Users/rig/.shorted-housing-crawl/pw-driver", "/Users/rig/.shorted-housing-crawl/pw-driver"},
		{"whitespace is trimmed to unset", "   ", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CRAWL_PW_DRIVER_DIR", tc.env)
			if got := resolveDriverDir(); got != tc.want {
				t.Fatalf("resolveDriverDir() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestCrawlDriverRunOptions(t *testing.T) {
	t.Setenv("CRAWL_PW_DRIVER_DIR", "/tmp/pw-driver")
	opts := crawlDriverRunOptions()
	if opts.DriverDirectory != "/tmp/pw-driver" {
		t.Fatalf("DriverDirectory = %q, want /tmp/pw-driver", opts.DriverDirectory)
	}
	if !opts.SkipInstallBrowsers {
		t.Fatal("SkipInstallBrowsers must be true — the CDP client needs only the driver, and a bare install pulls ~500MB of browsers")
	}
	t.Setenv("CRAWL_PW_DRIVER_DIR", "")
	opts = crawlDriverRunOptions()
	if opts.DriverDirectory != "" {
		t.Fatalf("unset env must leave DriverDirectory empty (playwright default), got %q", opts.DriverDirectory)
	}
}
```

Run — FAILS to compile (functions missing).

**Implement** — new file
`services/house-price-collector/crawl_driver.go`:

```go
package main

import (
	"log"
	"os"
	"strings"

	"github.com/mxschmitt/playwright-go"
)

// crawl_driver.go owns WHERE the playwright-go driver lives and HOW it gets
// (re)installed.
//
// Why: the driver's default home is under os.UserCacheDir() —
// ~/Library/Caches/ms-playwright-go/<ver>/ on macOS — which is exactly the
// directory disk-space sweeps prune. On 2026-08-13 one such sweep deleted the
// driver and took the crawl down for two days behind a misleading "Chrome
// wedged" symptom (see crawl_env.go). rc=8 made the symptom honest; this file
// removes the cause: CRAWL_PW_DRIVER_DIR relocates the driver to a path no
// cache tooling owns (the wrappers default it to
// ~/.shorted-housing-crawl/pw-driver), and `-mode install-driver` installs to
// that same path with the same options the fetchers use — so the repair
// command and the runtime can never disagree about the directory again.

// resolveDriverDir returns the configured driver directory, or "" to use the
// playwright-go default (unset/blank env). Trimmed so a whitespace-only value
// in an env file behaves as unset instead of creating a directory named " ".
func resolveDriverDir() string {
	return strings.TrimSpace(os.Getenv("CRAWL_PW_DRIVER_DIR"))
}

// crawlDriverRunOptions builds the playwright RunOptions shared by BOTH
// fetcher constructors and the installer. SkipInstallBrowsers is always true:
// the CDP client drives the HOST Chrome and needs only the driver — a bare
// install pulls all three bundled browsers (~500MB) onto the rig for nothing.
func crawlDriverRunOptions() *playwright.RunOptions {
	opts := &playwright.RunOptions{SkipInstallBrowsers: true}
	if dir := resolveDriverDir(); dir != "" {
		opts.DriverDirectory = dir
	}
	return opts
}

// runInstallDriver implements `-mode install-driver`: install (or repair) the
// playwright driver into the configured directory. Needs no DATABASE_URL, no
// Chrome and no network beyond the driver download — main.go dispatches it
// before the DB connect. Exit 0 = driver present and runnable; 1 = install
// failed.
func runInstallDriver() int {
	opts := crawlDriverRunOptions()
	if opts.DriverDirectory != "" {
		if err := os.MkdirAll(opts.DriverDirectory, 0o755); err != nil {
			log.Printf("[install-driver] cannot create driver dir %q: %v", opts.DriverDirectory, err)
			return 1
		}
	}
	if err := playwright.Install(opts); err != nil {
		log.Printf("[install-driver] playwright driver install failed: %v", err)
		return 1
	}
	where := opts.DriverDirectory
	if where == "" {
		where = "playwright default cache dir"
	}
	log.Printf("[install-driver] playwright driver installed (dir=%s). Verify with: house-price-collector -mode warmcheck", where)
	return 0
}
```

Then four wiring edits:

1. `services/house-price-collector/main.go` — immediately after
   `flag.Parse()` (before the `DATABASE_URL` check), insert:

```go
	// install-driver needs no DB, no Chrome, no timeout plumbing — dispatch it
	// before everything so a rig with a broken environment can repair itself
	// with nothing but the binary.
	if *mode == "install-driver" {
		return runInstallDriver()
	}
```

   and add `install-driver` to the `-mode` usage string (after `warmcheck`).

2. `services/house-price-collector/crawl_cdp.go` line 61 — replace
   `pw, err := playwright.Run()` with
   `pw, err := playwright.Run(crawlDriverRunOptions())`.

3. `services/house-price-collector/crawl_playwright.go` line 59 — same
   replacement.

4. `services/house-price-collector/crawl_env.go` — replace the
   `driverInstallHint` const with:

```go
// driverInstallHint is the runnable repair for a missing driver on a rig. It
// uses the collector's own installer so the install directory ALWAYS matches
// what the fetchers will read (CRAWL_PW_DRIVER_DIR — exported by the wrappers'
// hc_load_env); the old `go run …/cmd/playwright install` form installed into
// the default cache dir, which is both prunable and, once the env var is set,
// the WRONG place. See Dockerfile.crawl, which installs the driver at build
// time (the env var is unset in the image, so the default path still applies
// there).
const driverInstallHint = "~/bin/house-price-collector -mode install-driver   (set CRAWL_PW_DRIVER_DIR first if running outside the wrappers)"
```

5. `services/house-price-collector/deploy/housing-crawl-common.sh` — in
   `hc_load_env`, after the `CRAWL_MAX_DELAY_MS` export, add:

```bash
	# The playwright driver lives OUTSIDE ~/Library/Caches so disk-space sweeps
	# cannot delete it again (the 2026-08-13 outage). Repair/install:
	#   ~/bin/house-price-collector -mode install-driver
	export CRAWL_PW_DRIVER_DIR="${CRAWL_PW_DRIVER_DIR:-$HOME/.shorted-housing-crawl/pw-driver}"
```

6. Update the rc=8 log line in `hc_drain_until_empty`'s `8)` case to name the
   new command — replace its `Reinstall: cd services && GOWORK=off go run
   github.com/mxschmitt/playwright-go/cmd/playwright@v0.6100.0 install` tail
   with `Reinstall: ~/bin/house-price-collector -mode install-driver`. The
   lifecycle test `test_common_names_the_driver_fix_on_broken_env` greps for
   `cmd/playwright` — update that assertion to grep for `install-driver`
   instead (keep the `driver` and NOT-`chrome unusable` assertions).

Run:
`cd services && GOWORK=off go build ./house-price-collector/` (compile gate for
the `RunOptions` field names against the pinned `mxschmitt/playwright-go
v0.6100.0` — if `SkipInstallBrowsers`/`DriverDirectory` differ in that fork,
fix the field names here, not the design),
`GOWORK=off go test ./house-price-collector/ -run 'TestResolveDriverDir|TestCrawlDriverRunOptions'`,
and the lifecycle bash suite. All PASS.

**Operator note (goes in Task 9 docs + Task 10):** after the next rig deploy,
run `~/bin/house-price-collector -mode install-driver` once (with the wrapper
env loaded, or `CRAWL_PW_DRIVER_DIR=$HOME/.shorted-housing-crawl/pw-driver`),
then `-mode warmcheck`. Until that runs, the first scheduled crawl after
deploy exits 8 with the correct instruction — loud, honest, and self-repairing
via the named command.

---

## Task 6 — Log the running binary's provenance at every run start

The rig binary was once 4h17m older than the fix it was assumed to carry.
Make drift visible in the first lines of every scheduled run's log.

**Test first** — append to `housing-lifecycle-exit.test.sh` (+ run-list line):

```bash
# Every scheduled run must open by naming the binary's vcs.revision, so "which
# code is the rig actually running" is answered by the log an operator is
# already reading — not by remembering `go version -m`. Faked `go` on PATH.
test_provenance_logged_at_run_start() {
	FAKE_TOOLS="$TMP_ROOT/tools"
	mkdir -p "$FAKE_TOOLS"
	cat >"$FAKE_TOOLS/go" <<'EOF'
#!/usr/bin/env bash
printf '\tbuild\tvcs.revision=abcdef1234567890abcdef1234567890abcdef12\n'
printf '\tbuild\tvcs.time=2026-08-15T08:02:10Z\n'
EOF
	chmod +x "$FAKE_TOOLS/go"
	local log="$TMP_ROOT/provenance.log"
	run_expect_rc 0 bash -c '
		set -uo pipefail
		PATH="$4:$PATH"
		source "$1/housing-crawl-common.sh"
		BIN="$2"
		LOG="$3"
		hc_log_binary_provenance
	' _ "$DIR" "$FAKE_COLLECTOR" "$log" "$FAKE_TOOLS" || return 1
	if ! /usr/bin/grep -q "vcs.revision=abcdef123456" "$log"; then
		echo "FAIL: provenance line missing or unabbreviated in $log" >&2
		return 1
	fi
}
```

Run — FAILS (`hc_log_binary_provenance: command not found`).

**Implement** — add to `housing-crawl-common.sh` after `hc_wait_for_agent`:

```bash
# hc_log_binary_provenance names the exact code this run executes. The rig
# binary is a HAND deploy (deploy/README.md) — it has drifted from main before
# (built 4h17m before the fix it was assumed to carry, 2026-08-15), and the
# only durable defence is making the running revision impossible to not see.
# Best-effort: a rig without a Go toolchain logs "unknown" rather than failing.
hc_log_binary_provenance() {
	local rev="unknown"
	if command -v go >/dev/null 2>&1; then
		rev="$(go version -m "$BIN" 2>/dev/null \
			| /usr/bin/awk '$1 == "build" && $2 ~ /^vcs\.revision=/ { sub("vcs.revision=", "", $2); print substr($2, 1, 12); exit }')"
		rev="${rev:-unknown}"
	fi
	echo "$(date -u +%FT%TZ) collector binary: $BIN (vcs.revision=${rev})" >>"$LOG"
}
```

and call it from both wrappers — in `run-housing-delta.sh` and
`run-housing-full.sh`, insert `hc_log_binary_provenance` on its own line
directly after `hc_load_env`.

Run: lifecycle suite PASSES.

---

## Task 7 — `deploy/stage-rig.sh`: a checked, repeatable rig deploy

Replaces the ad-hoc "step 1: go build" hand deploy with one script that
refuses to stage drifted code, and a `--check` mode that answers "is the rig
current?" without writing anything.

**Test first** — new file
`services/house-price-collector/deploy/stage-rig.test.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/stage-rig-test.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

failures=0

# Sourcing the script must define its functions without running a deploy.
test_sourceable() {
	bash -c 'source "$1/stage-rig.sh" && declare -F rig_binary_revision >/dev/null && declare -F rig_wrapper_drift >/dev/null' _ "$DIR"
	if [[ $? -ne 0 ]]; then
		echo "FAIL: stage-rig.sh is not sourceable / functions missing" >&2
		return 1
	fi
}

test_rig_binary_revision_parses_go_output() {
	local tools="$TMP_ROOT/tools"
	mkdir -p "$tools"
	cat >"$tools/go" <<'EOF'
#!/usr/bin/env bash
printf '\tbuild\tvcs.revision=1a4b73baf365cdb305336ae5323062411169a7c9\n'
EOF
	chmod +x "$tools/go"
	local got
	got="$(bash -c 'PATH="$2:$PATH"; source "$1/stage-rig.sh"; rig_binary_revision /any/binary' _ "$DIR" "$tools")"
	if [[ "$got" != "1a4b73baf365" ]]; then
		echo "FAIL: rig_binary_revision returned '$got', want 1a4b73baf365" >&2
		return 1
	fi
}

test_rig_wrapper_drift_reports_changed_file() {
	local repo_side="$TMP_ROOT/repo" staged_side="$TMP_ROOT/staged"
	mkdir -p "$repo_side" "$staged_side"
	echo "same" >"$repo_side/a.sh"; echo "same" >"$staged_side/a.sh"
	echo "new"  >"$repo_side/b.sh"; echo "old"  >"$staged_side/b.sh"
	local out
	out="$(bash -c 'source "$1/stage-rig.sh"; STAGE_WRAPPERS=(a.sh b.sh); rig_wrapper_drift "$2" "$3"' _ "$DIR" "$repo_side" "$staged_side")"
	local rc=$?
	if [[ $rc -eq 0 ]]; then
		echo "FAIL: drift not detected (rc=0)" >&2
		return 1
	fi
	if ! grep -q "b.sh" <<<"$out"; then
		echo "FAIL: drift output does not name b.sh: $out" >&2
		return 1
	fi
	if grep -q "a.sh" <<<"$out"; then
		echo "FAIL: unchanged a.sh reported as drifted: $out" >&2
		return 1
	fi
}

test_sourceable || failures=$((failures + 1))
test_rig_binary_revision_parses_go_output || failures=$((failures + 1))
test_rig_wrapper_drift_reports_changed_file || failures=$((failures + 1))

if ((failures > 0)); then
	echo "stage-rig regression: $failures failure(s)" >&2
	exit 1
fi
echo "stage-rig regression: PASS"
```

Run — FAILS (no `stage-rig.sh`).

**Implement** — new file
`services/house-price-collector/deploy/stage-rig.sh` (chmod +x):

```bash
#!/usr/bin/env bash
# stage-rig.sh — build and stage the residential-rig deploy, with drift checks.
#
# The rig binary (~/bin/house-price-collector) and the staged wrappers
# (~/.shorted-housing-crawl-deploy/) are a HAND deploy, invisible to CI. On
# 2026-08-15 the binary was found 4h17m older than the fix it was assumed to
# run. This script makes the hand deploy repeatable and checkable:
#
#   stage-rig.sh            build from a CLEAN checkout at origin/main, install
#                           the binary + wrappers, install the playwright
#                           driver, print the deployed revision.
#   stage-rig.sh --check    read-only: report binary-revision and wrapper drift
#                           against origin/main; exit 0 = current, 1 = drifted.
#
# Refuses to stage a dirty tree or a non-origin/main HEAD unless
# STAGE_ALLOW_DIRTY=1 (for deliberately testing a branch build on the rig).
set -euo pipefail

STAGE_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
STAGE_SERVICES="$STAGE_REPO/services"
STAGE_DEPLOY_SRC="$STAGE_SERVICES/house-price-collector/deploy"
STAGE_BIN_DEST="${HOUSING_CRAWL_BIN:-$HOME/bin/house-price-collector}"
STAGE_DIR="${HOUSING_CRAWL_STAGE_DIR:-$HOME/.shorted-housing-crawl-deploy}"
STAGE_WRAPPERS=(housing-crawl-common.sh run-housing-delta.sh run-housing-full.sh run-housing-rescan.sh)

# rig_binary_revision prints the first 12 chars of a binary's vcs.revision, or
# "unknown". Same parse as hc_log_binary_provenance — keep them in agreement.
rig_binary_revision() {
	local bin="$1" rev=""
	if command -v go >/dev/null 2>&1; then
		rev="$(go version -m "$bin" 2>/dev/null \
			| /usr/bin/awk '$1 == "build" && $2 ~ /^vcs\.revision=/ { sub("vcs.revision=", "", $2); print substr($2, 1, 12); exit }')"
	fi
	echo "${rev:-unknown}"
}

# rig_wrapper_drift diffs each STAGE_WRAPPERS file between a repo dir ($1) and
# a staged dir ($2). Prints each drifted/missing file; returns 1 if any drift.
rig_wrapper_drift() {
	local repo_dir="$1" staged_dir="$2" drifted=0 f
	for f in "${STAGE_WRAPPERS[@]}"; do
		if [[ ! -f "$staged_dir/$f" ]]; then
			echo "MISSING: $f (not staged)"
			drifted=1
		elif ! /usr/bin/diff -q "$repo_dir/$f" "$staged_dir/$f" >/dev/null 2>&1; then
			echo "DRIFTED: $f"
			drifted=1
		fi
	done
	return "$drifted"
}

stage_check() {
	git -C "$STAGE_REPO" fetch origin main --quiet
	local want got rc=0
	want="$(git -C "$STAGE_REPO" rev-parse --short=12 origin/main)"
	got="$(rig_binary_revision "$STAGE_BIN_DEST")"
	if [[ "$got" == "$want" ]]; then
		echo "binary: CURRENT ($got == origin/main)"
	else
		echo "binary: DRIFTED (deployed=$got origin/main=$want)"
		rc=1
	fi
	if rig_wrapper_drift "$STAGE_DEPLOY_SRC" "$STAGE_DIR"; then
		echo "wrappers: CURRENT"
	else
		rc=1
	fi
	return "$rc"
}

stage_install() {
	if [[ "${STAGE_ALLOW_DIRTY:-0}" != "1" ]]; then
		if [[ -n "$(git -C "$STAGE_REPO" status --porcelain)" ]]; then
			echo "refusing to stage a DIRTY tree (set STAGE_ALLOW_DIRTY=1 to override)" >&2
			exit 1
		fi
		git -C "$STAGE_REPO" fetch origin main --quiet
		local head main_sha
		head="$(git -C "$STAGE_REPO" rev-parse HEAD)"
		main_sha="$(git -C "$STAGE_REPO" rev-parse origin/main)"
		if [[ "$head" != "$main_sha" ]]; then
			echo "refusing to stage: HEAD is not origin/main (set STAGE_ALLOW_DIRTY=1 to deploy a branch build deliberately)" >&2
			exit 1
		fi
	fi
	mkdir -p "$(dirname "$STAGE_BIN_DEST")" "$STAGE_DIR"
	(cd "$STAGE_SERVICES" && GOWORK=off go build -o "$STAGE_BIN_DEST" ./house-price-collector/)
	local f
	for f in "${STAGE_WRAPPERS[@]}"; do
		/bin/cp "$STAGE_DEPLOY_SRC/$f" "$STAGE_DIR/$f"
		/bin/chmod +x "$STAGE_DIR/$f"
	done
	# Keep the driver in step with the freshly-built binary's playwright pin,
	# in the sweep-proof directory the wrappers configure.
	CRAWL_PW_DRIVER_DIR="${CRAWL_PW_DRIVER_DIR:-$HOME/.shorted-housing-crawl/pw-driver}" \
		"$STAGE_BIN_DEST" -mode install-driver
	echo "staged: $STAGE_BIN_DEST (vcs.revision=$(rig_binary_revision "$STAGE_BIN_DEST")) + ${#STAGE_WRAPPERS[@]} wrappers → $STAGE_DIR"
	echo "next: ~/bin/house-price-collector -mode warmcheck"
}

# Only run when executed, so the test suite can source the functions.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
	case "${1:-install}" in
	--check) stage_check ;;
	install | "") stage_install ;;
	*)
		echo "usage: stage-rig.sh [--check]" >&2
		exit 2
		;;
	esac
fi
```

Run: `bash services/house-price-collector/deploy/stage-rig.test.sh` — PASS.

---

## Task 8 — Teach the external sentinel the statistic that matters

`.github/workflows/housing-freshness.yml` is the only alarm that survives a
dead rig, and it currently watches `max(observed_at)` over ALL events — green
throughout the 2026-08-13→15 outage and green today at median 117h staleness.
Add two checks: per-suburb catalog staleness (the SQL mirror of
`classifyFreshness`'s oldest-covered rule) and `crawl_run_status` health.

No easy TDD harness exists for workflow YAML; verification is (a) the SQL runs
against the local dev DB, (b) `workflow_dispatch` after merge. Keep the
read-only `PGOPTIONS` guard — these are still pure SELECTs.

**Implement** — in the workflow's SQL heredoc, insert the following two arms
into the `violations` CTE, after the existing `EVENT_SILENCE` arm (i.e.
between its closing `FROM event_maximum / WHERE …'72 hours'` lines and the
final `)` of the CTE):

```sql
            UNION ALL

            -- CATALOG_STALENESS: the per-suburb statistic the global
            -- EVENT_SILENCE check cannot see. A crawl limping at any rate
            -- keeps max(observed_at) fresh while individual suburbs age
            -- without bound (measured 2026-08-18: median 117h, oldest 305h,
            -- sentinel green). Mirrors classifyFreshness (crawl_freshness.go):
            -- oldest COVERED suburb, keyed like queryCatalogFreshness. The
            -- 132-hour line is the rig's 120h alarm + half a day of margin so
            -- the rig-side alarm always fires first. Worst 5 suburbs only —
            -- a wholesale-stale catalog must not file a 500-row issue.
            SELECT
              'CATALOG_STALENESS',
              format('%s %s %s', s.suburb, s.state_code, s.postcode),
              format(
                'suburb last crawled %s (%s hours ago; threshold 132h)',
                s.last_seen,
                to_char(extract(epoch FROM now() - s.last_seen) / 3600.0, 'FM999990')
              )
            FROM (
              SELECT
                lower(suburb) AS suburb,
                upper(state_code) AS state_code,
                trim(postcode) AS postcode,
                MAX(last_seen_at) AS last_seen
              FROM property_listings
              WHERE suburb IS NOT NULL
                AND state_code IS NOT NULL
                AND postcode IS NOT NULL
              GROUP BY 1, 2, 3
              HAVING MAX(last_seen_at) < now() - interval '132 hours'
              ORDER BY MAX(last_seen_at) ASC
              LIMIT 5
            ) AS s

            UNION ALL

            -- RIG_STATUS: the rig's own health record (migration 000089).
            -- error/blocked is critical immediately; a delta row whose
            -- finished_at is older than 30 hours means the daily 10:00 run
            -- did not complete — launchd unloaded, lock wedged, machine
            -- asleep, or the rig is off. (30h matches crawlStaleAfter("delta")
            -- in crawl_jobs.go.) The fortnightly full pass is deliberately
            -- not aged here — its 16-day cadence belongs to /admin.
            SELECT
              'RIG_STATUS',
              format('%s/%s', run_type, host),
              format('status=%s finished_at=%s', status, finished_at)
            FROM crawl_run_status
            WHERE status IN ('error', 'blocked')
               OR (run_type = 'delta' AND finished_at < now() - interval '30 hours')
```

Also update the workflow's header comment (top of the file) — replace the
sentence beginning `The default property_price_events silence threshold` with:

```yaml
# Four checks: official ingest errors, cursor/fact period regressions, global
# event silence (72h), and — because a limping crawl keeps the global check
# green forever — per-suburb catalog staleness (oldest covered suburb > 132h)
# plus the rig's own crawl_run_status health (error/blocked, or a daily delta
# that has not finished in 30h).
```

and in the `GITHUB_STEP_SUMMARY` block, replace
`echo "Default event silence threshold: **72 hours**."` with
`echo "Thresholds: event silence **72h** · catalog per-suburb **132h** · delta run age **30h**."`

**Verify:** run the full SQL by hand against the local dev DB
(`psql postgresql://admin:password@localhost:5438/shorts`) — it must parse and
return rows or none; then after merge,
`gh workflow run housing-freshness.yml` and read the step summary. Given
today's measured staleness, the first run is EXPECTED to go red with
CATALOG_STALENESS rows until the Task-1/2 defaults reach the rig and the
catalog converges (~a week) — that red is the system working; note it on the
tracking issue rather than raising the threshold.

**Operator step (record in the PR):** set the `CRAWL_FRESHNESS_WEBHOOK` GitHub
secret (Slack/Discord webhook) so red runs also push; add the same URL as
`CRAWL_ALERT_WEBHOOK=` to `~/.shorted-housing-crawl.env` on the rig for Task
3's `hc_alert`.

---

## Task 9 — Reconcile the docs that this work touches (and two that were already wrong)

All in `docs/feature/housing/`:

1. `pipeline.md` — wrapper table: correct the schedules to the installed
   plists (`run-housing-delta.sh` daily **10:00 local**; `run-housing-full.sh`
   **1st + 15th, 08:00**; property-resolve 21:20) and annotate
   `run-housing-agent.sh` / `run-housing-property.sh` / `run-housing-crawl.sh`
   as **not currently installed** on the rig. Add `install-driver` to the
   modes table (`Writes: — (driver files only)`) and note the new defaults:
   `CRAWL_DELTA_MAX_SUBURBS=120`, `CRAWL_FRESHNESS_ALARM_HOURS=120`,
   `CRAWL_ROUND_WALL_MIN=90`, `CRAWL_PW_DRIVER_DIR`, `CRAWL_ALERT_WEBHOOK`,
   `CRAWL_AGENT_WAIT_S`.
2. `operations.md` — the freshness section's claim "there is **no housing
   equivalent**" of the register/economy freshness workflows is **already
   false** (`.github/workflows/housing-freshness.yml` shipped in #417/#429);
   rewrite that paragraph to describe the sentinel, its issue-based alerting
   and the new CATALOG_STALENESS / RIG_STATUS checks. Update the driver-repair
   row in the silent-stopper table to `-mode install-driver` and the new
   driver location. Document `stage-rig.sh` / `--check` as the deploy path,
   superseding "hand-build per deploy/README.md step 1".
3. `deploy/README.md` — point the build step at `stage-rig.sh`; keep the
   manual `go build` as the fallback.
4. Root `CLAUDE.md` housing landmines — update the freshness-webhook line
   ("`CRAWL_FRESHNESS_WEBHOOK` is unset, so it goes to a log nobody reads") to
   reflect the webhook secret + sentinel once Tasks 3/8 land.

---

## Task 10 — Ship it to the rig (operator, after merge)

Merging is not shipping (design §1.5). After all code tasks merge to `main`:

```bash
cd ~/projects/shorted && git -C . fetch origin main
bash services/house-price-collector/deploy/stage-rig.sh          # build + stage + install driver
bash services/house-price-collector/deploy/stage-rig.sh --check  # expect: binary CURRENT, wrappers CURRENT
~/bin/house-price-collector -mode warmcheck                      # expect: [warmcheck] REA warm
```

Add to `~/.shorted-housing-crawl.env`: `CRAWL_ALERT_WEBHOOK=<same URL as the
GitHub secret>`. Do NOT run a crawl by hand; the next scheduled delta (10:00)
validates end-to-end. Success is checked over the following week against the
design §5 criteria (median < ~60h, oldest < 120h, sentinel issue closes).
