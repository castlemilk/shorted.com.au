package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// panicWriter is an events fd whose write panics: an internal error on the event writer.
type panicWriter struct{}

func (panicWriter) Write([]byte) (int, error) { panic("writer exploded (test)") }

// --- N2: a step that answers after its deadline, within the grace, keeps its real code ---

func TestProbeAnsweringAfterItsDeadlineKeepsItsCode(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Exit: 0}})
	h.cfg.probeTimeout = 200 * time.Millisecond
	h.cfg.stepGrace = 2 * time.Second
	h.deps.probeIngest = func(context.Context) (int, string) {
		time.Sleep(400 * time.Millisecond)
		return 14, "unavailable"
	}
	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != 14 || s.ExitCode != 14 || s.Outcome != outPreflightFailed {
		t.Fatalf("exit=%d outcome=%q, want 14 preflight_failed: a step that answers in the grace keeps its code (not 11)", code, s.Outcome)
	}
}

func TestChromeAnsweringAfterItsDeadlineKeepsItsCode(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Exit: 0}})
	h.cfg.chromeTimeout = 200 * time.Millisecond
	h.cfg.stepGrace = 2 * time.Second
	h.chromeFn = func(context.Context) (string, int) {
		time.Sleep(400 * time.Millisecond)
		return "unusable", 4
	}
	code := h.runGuarded(20 * time.Second)
	if code != 4 || h.summary().Outcome != outPreflightFailed {
		t.Fatalf("exit=%d, want 4: a Chrome step that answers in the grace keeps its code", code)
	}
}

// The step timeouts cover their budgets: the probe's three attempts, and Chrome's warm probes.
func TestStepTimeoutsCoverTheirWorstCase(t *testing.T) {
	cfg := loadCycleConfig(func(string) string { return "" })
	if cfg.probeTimeout != 4*time.Minute {
		t.Fatalf("probe timeout = %s, want 4m (3 x 60 s attempts + 3 s backoff = 183 s, with margin)", cfg.probeTimeout)
	}
	if cfg.probeTimeout < 183*time.Second {
		t.Fatalf("probe timeout %s is below its worst case of 183 s", cfg.probeTimeout)
	}
	// One warm probe's real worst case: two reconnects and two watchdogs (a stalled fetch reconnects and
	// retries once), plus the settle. Chrome is one launch, 1 + warmMaxAttempts probes, and recoveries.
	none := func(string) string { return "" }
	if want := 2*(cdpReconnectBudget+cdpWatchdog(none)) + settleCap; cfg.warmTimeout != want {
		t.Fatalf("warm timeout %s, want %s (2 x (reconnect + watchdog) + settle)", cfg.warmTimeout, want)
	}
	need := warmProbeWorst(none)*time.Duration(1+warmMaxAttempts) + chromeLaunchWorst
	if limit := hungCeiling(defaultHungGrace); cfg.chromeTimeout != min(need, limit) {
		t.Fatalf("chrome timeout %s, want the real worst case %s clamped to the ceiling %s", cfg.chromeTimeout, need, limit)
	}
}

// --- N3: a child that never reports ready is still stopped gracefully ---

func TestReadyWaitSendsTheStopToAChildThatNeverReportsReady(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{NoReady: true, Hang: true, OnTerm: "exit10"}})
	h.cfg.maxDuration = 100 * time.Millisecond
	h.cfg.readyWait = 300 * time.Millisecond
	h.cfg.hungAfter = 10 * time.Minute
	start := time.Now()
	code := h.runGuarded(20 * time.Second)
	if n := h.countTerms(); n != 1 {
		t.Fatalf("the child received %d graceful stops, want exactly 1 (sent at the ready wait)", n)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("the stop waited for a ready that never comes: took %s", elapsed)
	}
	if s := h.summary(); code != 0 || s.Outcome != outBudget {
		t.Fatalf("exit=%d outcome=%q, want 0 budget", code, s.Outcome)
	}
}

// --- N5: a child dying of a signal the cycle did not send ---

// A signal death while a stop is pending is cancelled (10), not an internal failure.
func TestChildKilledBySignalWhileStoppingIsCancelled(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{NoReady: true, SelfSignal: "hup", DelayExitMs: 300}})
	h.cfg.readyWait = 2 * time.Second
	h.cfg.hungAfter = 10 * time.Minute
	h.signalAfterStart(syscall.SIGTERM, 50*time.Millisecond, 1)
	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != exitCrawlCancelled || s.Outcome != outCancelled {
		t.Fatalf("exit=%d outcome=%q, want 10 cancelled: a signal death while stopping is the stop's end", code, s.Outcome)
	}
}

// The same signal death with no stop is an internal failure (1): nothing asked the child to end.
func TestChildKilledBySignalWithNoStopIsInternal(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{SelfSignal: "hup", DelayExitMs: 50}})
	h.cfg.hungAfter = 10 * time.Minute
	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != exitCycleInternal || s.Outcome != outInternal {
		t.Fatalf("exit=%d outcome=%q, want 1 internal_error for an unexplained signal death", code, s.Outcome)
	}
}

// --- N4: the hung formula and its clamp ---

func TestHungThresholdFormulaIsTheSumOfTheWorstSilences(t *testing.T) {
	none := func(string) string { return "" }
	if got, want := cycleSilenceWorst(none), 948*time.Second; got != want {
		t.Fatalf("default worst silence = %s, want %s (360 fetch + 120 reconnect + 180 watchdog + 60 pace + 183 push + 45 suburb)", got, want)
	}
	fetch300 := func(k string) string {
		if k == "CRAWL_FETCH_TIMEOUT_S" {
			return "300"
		}
		return ""
	}
	if got, want := cycleSilenceWorst(fetch300), 3108*time.Second; got != want {
		t.Fatalf("worst silence with a 300 s fetch = %s, want %s", got, want)
	}
	if got := derivedHungAfter(none); got != hungFloor {
		t.Fatalf("the default derived limit = %s, want the 20m floor", got)
	}
}

func TestHungThresholdIsClampedBelowTheRuntimeWatchdog(t *testing.T) {
	want := 1675 * time.Second
	if got := hungCeiling(defaultHungGrace); got != want {
		t.Fatalf("ceiling = %s, want %s (30m watchdog - 60s grace - 5s drain - 60s margin)", got, want)
	}
	fetch300 := func(k string) string {
		if k == "CRAWL_FETCH_TIMEOUT_S" {
			return "300"
		}
		return ""
	}
	if got := loadCycleConfig(fetch300).hungAfter; got != want {
		t.Fatalf("a derived limit above the ceiling must be clamped: got %s, want %s", got, want)
	}
	explicit := func(k string) string {
		if k == "CRAWL_HUNG_AFTER" {
			return "2h"
		}
		return ""
	}
	if got := loadCycleConfig(explicit).hungAfter; got != want {
		t.Fatalf("an explicit CRAWL_HUNG_AFTER above the ceiling must be clamped too: got %s, want %s", got, want)
	}
}

func TestClampLogsOnce(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)
	var once sync.Once
	for i := 0; i < 3; i++ {
		if got := clampHungAfter(3*time.Hour, defaultHungGrace, &once); got != hungCeiling(defaultHungGrace) {
			t.Fatalf("clamp returned %s", got)
		}
	}
	if n := strings.Count(buf.String(), "clamped"); n != 1 {
		t.Fatalf("the clamp logged %d times, want once", n)
	}
}

// --- batch 5 item 2: an invalid -job is named unknown, and never echoed ---

func TestInvalidJobIsUnknownAndNeverEchoed(t *testing.T) {
	raw := "sweep-" + strings.Repeat("x", 5000)
	var out bytes.Buffer
	var evbuf lockedBuf
	getenv := func(k string) string {
		switch k {
		case "CRAWL_SINK":
			return "ingest"
		case "SHORTED_INGEST_URL":
			return "https://api.shorted.com.au"
		case "CRAWL_DRY_RUN":
			return "false"
		}
		return ""
	}
	isolateCrawlFetchEnv(t)
	code := runCycleMode(&out, raw, false, time.Hour, getenv, newCrawlEvents(&evbuf))
	if code != exitSinkRefused {
		t.Fatalf("exit = %d, want 8", code)
	}
	if strings.Contains(out.String(), "sweep-") || strings.Contains(evbuf.String(), "sweep-") {
		t.Fatalf("the raw -job value was echoed")
	}
	var s cycleSummary
	if err := json.Unmarshal([]byte(strings.TrimRight(out.String(), "\n")), &s); err != nil || s.Job != cycleJobUnknown {
		t.Fatalf("summary job = %q (%v), want unknown", s.Job, err)
	}
	if !strings.Contains(evbuf.String(), `"job":"unknown"`) {
		t.Fatalf("cycle_start must name the job unknown: %s", evbuf.String())
	}

	var flagOut bytes.Buffer
	cycleFlagFailure([]string{"-mode", "cycle", "-job", raw}, &flagOut)
	if strings.Contains(flagOut.String(), "sweep-") {
		t.Fatalf("a flag failure echoed the raw -job value")
	}
}

// --- batch 5 item 3: a preflight step panic is internal_error, exit 1 ---

func TestPreflightPanicIsInternalErrorExit1(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Exit: 0}})
	h.cfg.job = cycleJobPreflight
	h.deps.chromeReachable = func() string { panic("boom (test)") }
	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != exitCycleInternal || s.Outcome != outInternal || s.ExitCode != exitCycleInternal {
		t.Fatalf("exit=%d outcome=%q, want 1 internal_error: a panicking preflight step is not checked/0", code, s.Outcome)
	}
}

// A panic in the ProbeAuth step is the same internal error, in the drain and in the preflight.
func TestProbeStepPanicIsInternalErrorExit1(t *testing.T) {
	for _, job := range []string{cycleJobDrain, cycleJobPreflight} {
		h := newCycleHarness(t, []fakeStep{{Exit: 0}})
		h.cfg.job = job
		h.deps.probeIngest = func(context.Context) (int, string) { panic("probe boom (test)") }
		code := h.runGuarded(20 * time.Second)
		s := h.summary()
		if code != exitCycleInternal || s.Outcome != outInternal {
			t.Fatalf("%s: exit=%d outcome=%q, want 1 internal_error: a panicking ProbeAuth is not a pass", job, code, s.Outcome)
		}
	}
}

// A panic in the driver step (the first preflight step) is the same internal error. The check is
// per step, so each step needs its own case.
func TestPreflightDriverPanicIsInternalErrorExit1(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Exit: 0}})
	h.cfg.job = cycleJobPreflight
	h.deps.driverPresent = func() error { panic("driver boom (test)") }
	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != exitCycleInternal || s.Outcome != outInternal {
		t.Fatalf("exit=%d outcome=%q, want 1 internal_error: a panicking driver check is not checked/0", code, s.Outcome)
	}
}

// --- batch 5 item 4: round_done's events_dropped is this round's drops ---

func TestRoundDoneEventsDroppedIsPerRound(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Exit: 0}})
	c := newCycleRunner(h.cfg, h.deps)
	c.pump.dropped.Add(100) // drops from before this round
	c.runRound(1)
	c.pump.close(time.Second)
	for _, e := range h.events() {
		if e["type"] != "round_done" {
			continue
		}
		counts, _ := e["counts"].(map[string]any)
		if got, _ := counts["events_dropped"].(float64); got != 0 {
			t.Fatalf("round_done events_dropped = %v, want 0: the round's own drops, not the running total", got)
		}
	}
}

// --- batch 5 item 5: a main-path panic closes the round it was in ---

func TestMainPathPanicEmitsTheInFlightRoundDone(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Claims: 1, Fetches: 1, Hang: true}})
	h.cfg.hungAfter = 300 * time.Millisecond
	h.deps.reportGap = func(string, string, int) { panic("boom (test)") }
	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != exitCycleInternal || s.Outcome != outInternal {
		t.Fatalf("exit=%d outcome=%q, want 1 internal_error", code, s.Outcome)
	}
	var started, done bool
	for _, e := range h.events() {
		if e["type"] == "round_start" && e["round"] == float64(1) {
			started = true
		}
		if e["type"] == "round_done" && e["round"] == float64(1) && e["exit_code"] == float64(1) {
			done = true
		}
	}
	if !started || !done {
		t.Fatalf("the in-flight round must end with round_done exit 1 (started=%v done=%v)", started, done)
	}
}

// --- batch 5 item 6: the deadline keeps a routine child code (covered in the budget table) ---

// --- batch 5 item 7: a second signal during the final flush has the summary already out ---

func TestSecondSignalDuringTheFlushHasItsSummaryBeforeExit(t *testing.T) {
	bw := &blockingWriter{release: make(chan struct{})}
	t.Cleanup(func() { close(bw.release) })
	h := newCycleHarness(t, []fakeStep{{Exit: 0}})
	h.deps.events = newCrawlEvents(bw)
	go func() {
		time.Sleep(400 * time.Millisecond)
		h.sigs <- syscall.SIGTERM
		time.Sleep(20 * time.Millisecond)
		h.sigs <- syscall.SIGTERM
	}()
	code := h.runGuarded(20 * time.Second)
	h.mu.Lock()
	exits := append([]int(nil), h.exits...)
	atExit := append([]string(nil), h.exitStdout...)
	h.mu.Unlock()
	if len(exits) != 1 {
		t.Fatalf("the second signal must exit once, exited %d time(s)", len(exits))
	}
	if !strings.Contains(atExit[0], `"outcome"`) {
		t.Fatalf("the process exits with no summary on stdout: %q", atExit[0])
	}
	if exits[0] != code {
		t.Fatalf("the exit code %d differs from the returned %d", exits[0], code)
	}
	if s := h.summary(); s.ExitCode != exits[0] {
		t.Fatalf("summary exit %d differs from the process exit %d", s.ExitCode, exits[0])
	}
}

// --- batch 5 item 8: a background panic is internal_error with its summary ---

func TestBackgroundPanicIsInternalWithItsSummary(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Claims: 1, Fetches: 1, Hang: true}})
	h.cfg.hungAfter = 2 * time.Second
	h.deps.events = newCrawlEvents(panicWriter{})
	h.runGuarded(20 * time.Second)
	h.mu.Lock()
	exits := append([]int(nil), h.exits...)
	atExit := append([]string(nil), h.exitStdout...)
	h.mu.Unlock()
	if len(exits) != 1 || exits[0] != exitCycleInternal {
		t.Fatalf("a background panic must exit 1 once, exits=%v", exits)
	}
	if !strings.Contains(atExit[0], `"outcome":"internal_error"`) || !strings.Contains(atExit[0], `"exit_code":1`) {
		t.Fatalf("the background panic wrote no internal_error summary: %q", atExit[0])
	}
}

// --- batch 5 item 1: the probe words ---

func TestProbeWordsAreTheContractsWords(t *testing.T) {
	if got := contractProbeCode("data_loss"); got != "other" {
		t.Fatalf("a code outside the contract is other, got %q", got)
	}
	if got := contractProbeCode("unauthenticated"); got != "unauthenticated" {
		t.Fatalf("a contract code is kept, got %q", got)
	}
	if got := summaryProbeWord("invalid_argument"); got != "unavailable" {
		t.Fatalf("a code outside the summary subset reads unavailable, got %q", got)
	}
	if got := summaryProbeWord("contract"); got != "contract" {
		t.Fatalf("a summary subset code is kept, got %q", got)
	}
}
