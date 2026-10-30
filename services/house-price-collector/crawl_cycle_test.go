package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// lockedBuf is a buffer safe for the pump's writer goroutine and the test to share.
type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// blockingWriter is an events fd that does not drain until released.
type blockingWriter struct {
	release chan struct{}
	buf     lockedBuf
}

func (w *blockingWriter) Write(p []byte) (int, error) {
	<-w.release
	return w.buf.Write(p)
}

// cycleHarness runs a real cycle against the fake child (crawl_cycle_fake_test.go). The preflight
// edges are fakes too, so no test touches Chrome, the playwright driver or ingest.
type cycleHarness struct {
	exitStdout []string
	t          *testing.T
	dir        string
	lockDir    string
	stdout     lockedBuf
	evbuf      lockedBuf
	cfg        cycleConfig
	deps       cycleDeps
	sigs       chan os.Signal

	mu           sync.Mutex
	installs     int
	installRC    int
	driverFail   int
	recovers     int
	recoverErr   error
	chromeFn     func(ctx context.Context) (string, int)
	portConflict bool
	reach        string
	probeCode    int
	probeWord    string
	warmFn       func(ctx context.Context) int
	warmRC       int
	gaps         []string
	exits        []int
}

func newCycleHarness(t *testing.T, plan []fakeStep) *cycleHarness {
	t.Helper()
	dir := t.TempDir()
	raw, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "plan.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	lockDir := filepath.Join(t.TempDir(), "lockdir")
	t.Setenv(cycleFakeChildEnv, dir)
	t.Setenv(crawlLockDirEnv, lockDir)

	h := &cycleHarness{t: t, dir: dir, lockDir: lockDir, reach: "not_used", probeWord: "ok", sigs: make(chan os.Signal, 4)}
	h.cfg = cycleConfig{
		job:              cycleJobDrain,
		maxRounds:        30,
		noProgressRounds: 3,
		rewarmCooldown:   0,
		rewarmBudget:     2,
		hungAfter:        10 * time.Minute,
		hungGrace:        300 * time.Millisecond,
		installTimeout:   5 * time.Second,
		chromeTimeout:    5 * time.Second,
		probeTimeout:     5 * time.Second,
		stepGrace:        300 * time.Millisecond,
		readyWait:        5 * time.Second,
		warmTimeout:      5 * time.Second,
		lockDir:          lockDir,
		cycleID:          "cyc-test",
		childArgv:        func() (string, []string) { return os.Args[0], nil },
	}
	h.deps = cycleDeps{
		driverPresent: func() error {
			h.mu.Lock()
			defer h.mu.Unlock()
			if h.driverFail > 0 {
				h.driverFail--
				return errors.New("playwright driver missing (test)")
			}
			return nil
		},
		installDriver: func() int {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.installs++
			return h.installRC
		},
		ensureChrome: func(ctx context.Context) (string, int) {
			h.mu.Lock()
			fn := h.chromeFn
			h.mu.Unlock()
			if fn != nil {
				return fn(ctx)
			}
			return "not_used", 0
		},
		chromeReachable: func() string { return h.reach },
		chromePortConflict: func() bool {
			h.mu.Lock()
			defer h.mu.Unlock()
			return h.portConflict
		},
		recoverChrome: func() error {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.recovers++
			return h.recoverErr
		},
		probeIngest: func(context.Context) (int, string) { return h.probeCode, h.probeWord },
		warmcheck: func(ctx context.Context) int {
			h.mu.Lock()
			fn := h.warmFn
			rc := h.warmRC
			h.mu.Unlock()
			if fn != nil {
				return fn(ctx)
			}
			return rc
		},
		reportGap: func(cycleID, outcome string, exit int) {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.gaps = append(h.gaps, fmt.Sprintf("%s:%s:%d", cycleID, outcome, exit))
		},
		stdout: &h.stdout,
		events: newCrawlEvents(&h.evbuf),
		now:    time.Now,
		sigs:   h.sigs,
		exit: func(code int) {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.exits = append(h.exits, code)
			h.exitStdout = append(h.exitStdout, h.stdout.String())
		},
	}
	t.Cleanup(h.killSurvivors)
	return h
}

// killSurvivors kills every group a fake child or grandchild recorded, so a failing test never
// leaks a sleep or a child.
func (h *cycleHarness) killSurvivors() {
	for _, pid := range h.recordedPIDs() {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
}

func (h *cycleHarness) recordedPIDs() []int {
	var out []int
	entries, _ := os.ReadDir(h.dir)
	for _, e := range entries {
		n := e.Name()
		if !strings.HasPrefix(n, "started-") && !strings.HasPrefix(n, "grandchild-") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(h.dir, n))
		if err != nil {
			continue
		}
		if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && pid > 0 {
			out = append(out, pid)
		}
	}
	return out
}

// runGuarded runs the cycle and fails the test if it does not return within d.
func (h *cycleHarness) runGuarded(d time.Duration) int {
	h.t.Helper()
	c := newCycleRunner(h.cfg, h.deps)
	ch := make(chan int, 1)
	go func() { ch <- c.execute() }()
	select {
	case code := <-ch:
		return code
	case <-time.After(d):
		h.t.Fatalf("cycle did not return within %s", d)
		return -1
	}
}

func (h *cycleHarness) summary() cycleSummary {
	h.t.Helper()
	lines := strings.Split(strings.TrimRight(h.stdout.String(), "\n"), "\n")
	if len(lines) != 1 {
		h.t.Fatalf("stdout must be exactly one summary line, got %d: %q", len(lines), h.stdout.String())
	}
	var s cycleSummary
	if err := json.Unmarshal([]byte(lines[0]), &s); err != nil {
		h.t.Fatalf("summary is not JSON: %v (%q)", err, lines[0])
	}
	return s
}

func (h *cycleHarness) events() []map[string]any {
	h.t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimRight(h.evbuf.String(), "\n"), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			h.t.Fatalf("event is not JSON: %v (%q)", err, line)
		}
		out = append(out, m)
	}
	return out
}

func (h *cycleHarness) spawned() int { return len(h.recordedPIDs()) }

func (h *cycleHarness) gapList() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.gaps...)
}

func (h *cycleHarness) installCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.installs
}

func (h *cycleHarness) recoverCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.recovers
}

func (h *cycleHarness) exitCodes() []int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]int(nil), h.exits...)
}

func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func waitGone(t *testing.T, pid int, d time.Duration) {
	t.Helper()
	deadline := time.Now().Add(d)
	for alive(pid) {
		if time.Now().After(deadline) {
			t.Fatalf("pid %d is still alive after %s", pid, d)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// waitFileOK polls until path exists, without t.Fatal, so it can run on a helper goroutine.
func waitFileOK(path string, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for {
		if _, err := os.Stat(path); err == nil {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func readPID(t *testing.T, path string) int {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		t.Fatal(err)
	}
	return pid
}

// countTerms counts the graceful stops the fake child received.
func (h *cycleHarness) countTerms() int {
	b, err := os.ReadFile(filepath.Join(h.dir, "terms.txt"))
	if err != nil {
		return 0
	}
	return strings.Count(string(b), "TERM")
}

// signalAfterStart sends sig once the first child has started and d has passed.
func (h *cycleHarness) signalAfterStart(sig syscall.Signal, d time.Duration, n int) {
	go func() {
		if !waitFileOK(filepath.Join(h.dir, "started-0"), 10*time.Second) {
			return
		}
		time.Sleep(d)
		for i := 0; i < n; i++ {
			h.sigs <- sig
			time.Sleep(20 * time.Millisecond)
		}
	}()
}

// ---------------------------------------------------------------------------------------
// Drain policy table.

func TestCycleDrainPolicyTable(t *testing.T) {
	cases := []struct {
		name         string
		plan         []fakeStep
		maxRounds    int
		wantOutcome  string
		wantCode     int
		wantRounds   int
		wantInstalls int
	}{
		{name: "queue empty at once", plan: []fakeStep{{Processed: 0, Exit: 0}}, wantOutcome: outQueueEmpty, wantCode: 0, wantRounds: 1},
		{
			name: "work, then an empty round",
			plan: []fakeStep{
				{Claims: 2, Processed: 2, Succeeded: 2, Exit: 0},
				{Exit: 0},
			},
			wantOutcome: outQueueEmpty, wantCode: 0, wantRounds: 2,
		},
		{name: "re-warm 3 is retried twice, then stops with 3", plan: []fakeStep{{Claims: 1, Processed: 1, Succeeded: 1, Exit: 3}}, wantOutcome: outStopped, wantCode: 3, wantRounds: 3},
		{name: "re-warm 5 shares the budget and stops with 5", plan: []fakeStep{{Claims: 1, Processed: 1, Succeeded: 1, Exit: 5}}, wantOutcome: outStopped, wantCode: 5, wantRounds: 3},
		{
			name: "re-warm then success",
			plan: []fakeStep{
				{Claims: 1, Processed: 1, Succeeded: 1, Exit: 3},
				{Exit: 0},
			},
			wantOutcome: outQueueEmpty, wantCode: 0, wantRounds: 2,
		},
		{name: "4 stops with 4", plan: []fakeStep{{Exit: 4}}, wantOutcome: outStopped, wantCode: 4, wantRounds: 1},
		{name: "7 stops with 7", plan: []fakeStep{{Exit: 7}}, wantOutcome: outStopped, wantCode: 7, wantRounds: 1},
		{name: "12 stops with 12", plan: []fakeStep{{Exit: 12}}, wantOutcome: outStopped, wantCode: 12, wantRounds: 1},
		{name: "13 stops with 13", plan: []fakeStep{{Exit: 13}}, wantOutcome: outStopped, wantCode: 13, wantRounds: 1},
		{name: "14 stops with 14", plan: []fakeStep{{Exit: 14}}, wantOutcome: outStopped, wantCode: 14, wantRounds: 1},
		{name: "15 stops with 15", plan: []fakeStep{{Exit: 15}}, wantOutcome: outStopped, wantCode: 15, wantRounds: 1},
		{name: "an unknown child code is internal: exit 1", plan: []fakeStep{{Exit: 6}}, wantOutcome: outInternal, wantCode: 1, wantRounds: 1},
		{
			name:        "8 installs once, retries once, then stops with 8",
			plan:        []fakeStep{{Exit: 8}},
			wantOutcome: outStopped, wantCode: 8, wantRounds: 2, wantInstalls: 1,
		},
		{
			name:        "8 installs, then the retry succeeds",
			plan:        []fakeStep{{Exit: 8}, {Exit: 0}},
			wantOutcome: outQueueEmpty, wantCode: 0, wantRounds: 2, wantInstalls: 1,
		},
		{name: "10 stops quietly with 10", plan: []fakeStep{{Exit: 10}}, wantOutcome: outCancelled, wantCode: 10, wantRounds: 1},
		{
			name:        "max rounds stops the drain with 0",
			plan:        []fakeStep{{Claims: 1, Processed: 1, Succeeded: 1, Exit: 0}},
			maxRounds:   3,
			wantOutcome: outMaxRounds, wantCode: 0, wantRounds: 3,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newCycleHarness(t, tc.plan)
			if tc.maxRounds > 0 {
				h.cfg.maxRounds = tc.maxRounds
			}
			code := h.runGuarded(20 * time.Second)
			s := h.summary()
			if code != tc.wantCode || s.ExitCode != tc.wantCode {
				t.Fatalf("exit = %d (summary %d), want %d", code, s.ExitCode, tc.wantCode)
			}
			if s.Outcome != tc.wantOutcome {
				t.Fatalf("outcome = %q, want %q", s.Outcome, tc.wantOutcome)
			}
			if s.Rounds != tc.wantRounds {
				t.Fatalf("rounds = %d, want %d", s.Rounds, tc.wantRounds)
			}
			if h.installCount() != tc.wantInstalls {
				t.Fatalf("install-driver ran %d times, want %d", h.installCount(), tc.wantInstalls)
			}
		})
	}
}

// ---------------------------------------------------------------------------------------
// Preflight failures end the drain before any round.

func TestCycleDrainPreflightFailuresStopBeforeAnyRound(t *testing.T) {
	cases := []struct {
		name         string
		setup        func(h *cycleHarness)
		wantCode     int
		wantInstalls int
		wantDriver   string
	}{
		{name: "driver missing and install fails: 8", setup: func(h *cycleHarness) { h.driverFail = 99; h.installRC = 1 }, wantCode: 8, wantInstalls: 1, wantDriver: "missing"},
		{name: "driver still missing after install: 8", setup: func(h *cycleHarness) { h.driverFail = 99 }, wantCode: 8, wantInstalls: 1, wantDriver: "missing"},
		{name: "chrome unusable: 4", setup: func(h *cycleHarness) { h.chromeFn = func(context.Context) (string, int) { return "unusable", 4 } }, wantCode: 4, wantDriver: "ok"},
		{name: "chrome env broken: 8", setup: func(h *cycleHarness) { h.chromeFn = func(context.Context) (string, int) { return "env_broken", 8 } }, wantCode: 8, wantDriver: "ok"},
		{name: "probe refused: 13", setup: func(h *cycleHarness) { h.probeCode = 13; h.probeWord = "unauthenticated" }, wantCode: 13, wantDriver: "ok"},
		{name: "probe unavailable: 14", setup: func(h *cycleHarness) { h.probeCode = 14; h.probeWord = "unavailable" }, wantCode: 14, wantDriver: "ok"},
		{name: "probe contract: 15", setup: func(h *cycleHarness) { h.probeCode = 15; h.probeWord = "contract" }, wantCode: 15, wantDriver: "ok"},
		{name: "probe unimplemented: 8", setup: func(h *cycleHarness) { h.probeCode = 8; h.probeWord = "unavailable" }, wantCode: 8, wantDriver: "ok"},
		{name: "probe token: 7", setup: func(h *cycleHarness) { h.probeCode = 7; h.probeWord = "token" }, wantCode: 7, wantDriver: "ok"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newCycleHarness(t, []fakeStep{{Claims: 1, Processed: 1, Succeeded: 1, Exit: 0}})
			tc.setup(h)
			code := h.runGuarded(20 * time.Second)
			s := h.summary()
			if code != tc.wantCode || s.ExitCode != tc.wantCode {
				t.Fatalf("exit = %d (summary %d), want %d", code, s.ExitCode, tc.wantCode)
			}
			if s.Outcome != outPreflightFailed {
				t.Fatalf("outcome = %q, want preflight_failed", s.Outcome)
			}
			if s.Rounds != 0 || h.spawned() != 0 {
				t.Fatalf("a failed preflight must start no round: rounds=%d children=%d", s.Rounds, h.spawned())
			}
			if h.installCount() != tc.wantInstalls {
				t.Fatalf("install-driver ran %d times, want %d", h.installCount(), tc.wantInstalls)
			}
			if s.Env.Driver != tc.wantDriver {
				t.Fatalf("env.driver = %q, want %q", s.Env.Driver, tc.wantDriver)
			}
		})
	}
}

// ---------------------------------------------------------------------------------------
// Hung: no event for hungAfter kills the child's whole group; the cycle exits 11.

func TestCycleHungKillsTheGroupAndExits11(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Claims: 1, Fetches: 1, Hang: true, OnTerm: "ignore", Grandchild: "sh_ignore_term"}})
	h.cfg.hungAfter = 400 * time.Millisecond

	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != exitCycleHung || s.ExitCode != exitCycleHung || s.Outcome != outHung {
		t.Fatalf("exit=%d outcome=%q, want 11 hung", code, s.Outcome)
	}
	waitGone(t, readPID(t, filepath.Join(h.dir, "started-0")), 5*time.Second)
	waitGone(t, readPID(t, filepath.Join(h.dir, "grandchild-0.pid")), 5*time.Second)
	if g := h.gapList(); len(g) != 1 || g[0] != "cyc-test:failed:11" {
		t.Fatalf("a hung round is reported by the cycle for itself: %v", g)
	}
}

// A group that empties on SIGTERM must not wait out the grace.
func TestCycleHungGroupEmptiesOnSigtermWithoutSigkill(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Claims: 1, Fetches: 1, Hang: true, Grandchild: "sleep"}})
	h.cfg.hungAfter = 400 * time.Millisecond
	h.cfg.hungGrace = 5 * time.Second

	start := time.Now()
	if code := h.runGuarded(20 * time.Second); code != exitCycleHung {
		t.Fatalf("exit = %d, want 11", code)
	}
	if elapsed := time.Since(start); elapsed > 4*time.Second {
		t.Fatalf("a group that empties on SIGTERM must not wait out the grace: took %s", elapsed)
	}
	waitGone(t, readPID(t, filepath.Join(h.dir, "grandchild-0.pid")), 5*time.Second)
}

// Events within the window keep a slow but working child alive.
func TestCycleFetchEventsKeepAChildAlive(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{
		{Claims: 1, Fetches: 30, FetchEveryMs: 100, Processed: 1, Succeeded: 1, Exit: 0},
		{Exit: 0},
	})
	h.cfg.hungAfter = 2 * time.Second
	if code := h.runGuarded(20 * time.Second); code != 0 {
		t.Fatalf("a child that keeps emitting fetch events must not be hung: exit %d", code)
	}
	if s := h.summary(); s.Outcome != outQueueEmpty {
		t.Fatalf("outcome = %q, want queue_empty", s.Outcome)
	}
}

// ---------------------------------------------------------------------------------------
// Graceful stop: one SIGTERM per child, to the child only, and only after it is ready.

// The budget and an operator signal both want the child stopped. The cycle sends ONE SIGTERM.
func TestCycleSendsOneGracefulSigtermPerChild(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Claims: 1, Fetches: 1, Hang: true, OnTerm: "count"}})
	h.cfg.maxDuration = 300 * time.Millisecond
	h.signalAfterStart(syscall.SIGTERM, 50*time.Millisecond, 1)

	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if n := h.countTerms(); n != 1 {
		t.Fatalf("the child received %d graceful stops, want exactly 1", n)
	}
	if code != exitCrawlCancelled || s.Outcome != outCancelled {
		t.Fatalf("exit=%d outcome=%q, want 10 cancelled (a signal beats the budget)", code, s.Outcome)
	}
}

// The child has no handler until it is ready. A stop asked for before then is sent once ready, so the
// child (whose handler comes after a slow start) never sees a TERM it cannot handle.
func TestCycleSigtermWaitsForTheChildToBeReady(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{DelayReadyMs: 400, Hang: true, OnTerm: "count"}})
	h.cfg.maxDuration = 100 * time.Millisecond

	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if n := h.countTerms(); n != 1 {
		t.Fatalf("the child received %d graceful stops, want exactly 1 (sent after ready)", n)
	}
	if code != 0 || s.Outcome != outBudget {
		t.Fatalf("exit=%d outcome=%q, want 0 budget", code, s.Outcome)
	}
}

// A graceful stop goes to the child PID, not its group: the child's grandchild (its Playwright
// driver, in the real case) keeps running while the child finishes its suburb.
func TestCycleGracefulStopSignalsTheChildPIDNotTheGroup(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Grandchild: "sleep", Hang: true, OnTerm: "exit10"}})
	h.cfg.hungAfter = 10 * time.Minute
	h.signalAfterStart(syscall.SIGTERM, 200*time.Millisecond, 1)

	if code := h.runGuarded(20 * time.Second); code != exitCrawlCancelled {
		t.Fatalf("exit = %d, want 10", code)
	}
	if !alive(readPID(t, filepath.Join(h.dir, "grandchild-0.pid"))) {
		t.Fatalf("the graceful stop must not signal the group: the grandchild is gone")
	}
}

// A child that dies to a signal after the cycle asked it to stop is a clean 10, and it sends no
// failed gap report (batch 1 item 1d).
func TestCycleChildKilledAfterAStopIsCancelledAndNotReportedFailed(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Hang: true}}) // no handler: the TERM kills it
	h.cfg.hungAfter = 10 * time.Minute
	h.signalAfterStart(syscall.SIGTERM, 200*time.Millisecond, 1)

	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != exitCrawlCancelled || s.Outcome != outCancelled {
		t.Fatalf("exit=%d outcome=%q, want 10 cancelled", code, s.Outcome)
	}
	if g := h.gapList(); len(g) != 0 {
		t.Fatalf("a child killed after a stop must not be reported failed: %v", g)
	}
	// The round itself must end as 10, not as a failure: the cycle's round_done carries its exit code.
	var roundExit = -1
	for _, e := range h.events() {
		if e["type"] == "round_done" {
			if v, ok := e["exit_code"].(float64); ok {
				roundExit = int(v)
			}
		}
	}
	if roundExit != exitCrawlCancelled {
		t.Fatalf("the round's exit code = %d, want 10 (a signal-killed child after a stop is cancelled, not failed)", roundExit)
	}
}

// Rounds are not spawned once a stop is pending.
func TestCycleSpawnsNoRoundOnceAStopIsPending(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Exit: 0}})
	c := newCycleRunner(h.cfg, h.deps)
	c.stop.request("signal")
	res := c.runRound(1)
	if h.spawned() != 0 {
		t.Fatalf("a pending stop must spawn nothing: %d child(ren)", h.spawned())
	}
	if res.exit != exitCrawlCancelled {
		t.Fatalf("a skipped round exits 10, got %d", res.exit)
	}
}

// A second signal SIGKILLs the group and finishes with 10. The returned code, the summary and the
// process exit agree in that race.
func TestCycleSecondSignalExitCodeMatchesTheSummary(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Claims: 1, Fetches: 1, Hang: true, OnTerm: "ignore", Grandchild: "sh_ignore_term"}})
	h.cfg.hungAfter = 10 * time.Minute
	go func() {
		if !waitFileOK(filepath.Join(h.dir, "grandchild-0.pid"), 10*time.Second) {
			return
		}
		time.Sleep(50 * time.Millisecond)
		h.sigs <- syscall.SIGTERM
		time.Sleep(50 * time.Millisecond)
		h.sigs <- syscall.SIGTERM
	}()

	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != exitCrawlCancelled || s.ExitCode != code || s.Outcome != outCancelled {
		t.Fatalf("returned %d, summary exit %d outcome %q: want 10 cancelled in all three", code, s.ExitCode, s.Outcome)
	}
	// The forced exit runs on the signal goroutine, which can finish after the main path returns.
	waitUntil(2*time.Second, func() bool { return len(h.exitCodes()) == 1 })
	if ex := h.exitCodes(); len(ex) != 1 || ex[0] != s.ExitCode {
		t.Fatalf("the forced exit must use the summary's code: exits=%v summary=%d", ex, s.ExitCode)
	}
	waitGone(t, readPID(t, filepath.Join(h.dir, "started-0")), 5*time.Second)
	waitGone(t, readPID(t, filepath.Join(h.dir, "grandchild-0.pid")), 5*time.Second)
}

// ---------------------------------------------------------------------------------------
// Precedence (batch 2 item 2): a pending stop or budget is checked before the exit-8 repair and
// the exit-3 cooldown.

func TestCycleStopPendingBeforeAnExit8Repair(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{OnTerm: "ignore", DelayExitMs: 400, Exit: 8}})
	h.cfg.hungAfter = 10 * time.Minute
	h.signalAfterStart(syscall.SIGTERM, 100*time.Millisecond, 1)

	code := h.runGuarded(20 * time.Second)
	if code != exitCrawlCancelled || h.installCount() != 0 {
		t.Fatalf("exit=%d installs=%d: a pending signal must win over the exit-8 repair", code, h.installCount())
	}
}

func TestCycleBudgetWithAWorseChildCodeKeepsThatCode(t *testing.T) {
	cases := []struct {
		name        string
		exit        int
		wantOutcome string
		wantCode    int
		wantInstall int
	}{
		{name: "8 at the budget is worse: stopped 8, no repair", exit: 8, wantOutcome: outStopped, wantCode: 8, wantInstall: 0},
		{name: "4 at the budget is worse: stopped 4", exit: 4, wantOutcome: outStopped, wantCode: 4, wantInstall: 0},
		{name: "3 at the budget is kept: stopped 3, no cooldown", exit: 3, wantOutcome: outStopped, wantCode: 3, wantInstall: 0},
		{name: "10 at the budget is budget 0", exit: 10, wantOutcome: outBudget, wantCode: 0, wantInstall: 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newCycleHarness(t, []fakeStep{{OnTerm: "ignore", DelayExitMs: 300, Exit: tc.exit}})
			h.cfg.maxDuration = 150 * time.Millisecond
			h.cfg.hungAfter = 10 * time.Minute
			h.cfg.rewarmCooldown = 30 * time.Second
			start := time.Now()
			code := h.runGuarded(20 * time.Second)
			s := h.summary()
			if code != tc.wantCode || s.Outcome != tc.wantOutcome {
				t.Fatalf("exit=%d outcome=%q, want %d %s", code, s.Outcome, tc.wantCode, tc.wantOutcome)
			}
			if h.installCount() != tc.wantInstall {
				t.Fatalf("installs = %d, want %d", h.installCount(), tc.wantInstall)
			}
			if time.Since(start) > 10*time.Second {
				t.Fatalf("no cooldown may run at the budget: took %s", time.Since(start))
			}
		})
	}
}

// ---------------------------------------------------------------------------------------
// Bounded steps (batch 1 item 3): a step that ignores its context is still bounded.

func TestCyclePreflightStepEndsAtTheDeadline(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Exit: 0}})
	h.cfg.maxDuration = 200 * time.Millisecond
	h.chromeFn = func(ctx context.Context) (string, int) {
		<-ctx.Done()
		return "unusable", 4
	}
	start := time.Now()
	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != 0 || s.Outcome != outBudget {
		t.Fatalf("exit=%d outcome=%q, want 0 budget", code, s.Outcome)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("the deadline must end a preflight step at once: took %s", elapsed)
	}
	if _, err := os.Stat(h.lockDir); err == nil {
		t.Fatalf("the lock must be released when the cycle ends")
	}
}

func TestCycleStepIgnoringItsContextIsAHangAndExits11(t *testing.T) {
	block := make(chan struct{})
	t.Cleanup(func() { close(block) })
	h := newCycleHarness(t, []fakeStep{{Exit: 0}})
	h.cfg.chromeTimeout = 200 * time.Millisecond
	h.chromeFn = func(context.Context) (string, int) {
		<-block
		return "warm", 0
	}
	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != exitCycleHung || s.Outcome != outHung {
		t.Fatalf("exit=%d outcome=%q, want 11 hung", code, s.Outcome)
	}
	if _, err := os.Stat(h.lockDir); err == nil {
		t.Fatalf("a hung cycle must still release the lock")
	}
	if g := h.gapList(); len(g) != 0 {
		t.Fatalf("a hung preflight is not a 4/8/15 failure: no gap report, got %v", g)
	}
}

func TestCycleInstallDriverIsBounded(t *testing.T) {
	block := make(chan struct{})
	t.Cleanup(func() { close(block) })
	h := newCycleHarness(t, []fakeStep{{Exit: 0}})
	h.cfg.installTimeout = 200 * time.Millisecond
	h.driverFail = 99
	h.deps.installDriver = func() int { <-block; return 0 }
	if code := h.runGuarded(20 * time.Second); code != exitCycleHung {
		t.Fatalf("a stalled install-driver is a hang: exit %d, want 11", code)
	}
}

func TestCycleStepPanicIsInternalExit1WithOneSummary(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Exit: 0}})
	h.chromeFn = func(context.Context) (string, int) { panic("boom (test)") }
	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != exitCycleInternal || s.ExitCode != exitCycleInternal || s.Outcome != outInternal {
		t.Fatalf("exit=%d outcome=%q, want 1 internal_error", code, s.Outcome)
	}
}

// ---------------------------------------------------------------------------------------
// Lock (batch 1 item 6): the cycle is always the holder.

func TestCycleExits12WhenALiveProcessHoldsTheLock(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Claims: 1, Processed: 1, Exit: 0}})
	if err := os.Mkdir(h.lockDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(h.lockDir, "pid"), []byte(strconv.Itoa(os.Getpid())+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != exitLockHeld || s.Outcome != outLockHeld || s.Rounds != 0 || h.spawned() != 0 {
		t.Fatalf("exit=%d outcome=%q rounds=%d children=%d, want 12 lock_held and nothing run", code, s.Outcome, s.Rounds, h.spawned())
	}
	if s.Lock != lockHeldElsewhere {
		t.Fatalf("lock = %q, want held_elsewhere", s.Lock)
	}
}

// A cycle whose own parent holds the lock is a passenger, and a passenger may not drain: exit 12.
func TestCycleMayNotPassThroughItsParentsLock(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Claims: 1, Processed: 1, Succeeded: 1, Exit: 0}})
	if err := os.Mkdir(h.lockDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(h.lockDir, "pid"), []byte(strconv.Itoa(os.Getppid())+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	code := h.runGuarded(20 * time.Second)
	if code != exitLockHeld || h.spawned() != 0 {
		t.Fatalf("exit=%d children=%d: a cycle under its parent's lock must exit 12 and run nothing", code, h.spawned())
	}
}

func TestCycleExcludedByABashHolder(t *testing.T) {
	common := requireBashCommon(t)
	h := newCycleHarness(t, []fakeStep{{Claims: 1, Processed: 1, Exit: 0}})
	bashHolder(t, common, h.lockDir)
	if code := h.runGuarded(20 * time.Second); code != exitLockHeld {
		t.Fatalf("a bash holder must exclude the cycle: exit %d, want 12", code)
	}
	if h.spawned() != 0 {
		t.Fatalf("no child may run under a held lock")
	}
}

// The cycle holds the lock and its child passes it: the real cross-process path through withCrawlLock.
func TestCycleChildPassesTheLockItsParentHolds(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Lock: true, Exit: 0}})
	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != 0 || s.Outcome != outQueueEmpty {
		t.Fatalf("exit=%d outcome=%q, want 0 queue_empty: a child of the lock holder must pass", code, s.Outcome)
	}
	if s.Lock != lockHeldByCycle {
		t.Fatalf("lock = %q, want held_by_cycle", s.Lock)
	}
	if _, err := os.Stat(h.lockDir); err == nil {
		t.Fatalf("the cycle must release the lock when it ends")
	}
}

// ---------------------------------------------------------------------------------------
// No-progress (batch 1 item 7): rounds that succeed nothing stop the drain.

func TestCycleStopsAfterConsecutiveRoundsWithNoSuccess(t *testing.T) {
	deferred := fakeStep{Claims: 3, Processed: 3, Deferred: 3, Exit: 0}
	h := newCycleHarness(t, []fakeStep{deferred})
	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != 0 || s.Outcome != outNoProgress || s.Rounds != 3 {
		t.Fatalf("exit=%d outcome=%q rounds=%d, want 0 no_progress after 3 rounds", code, s.Outcome, s.Rounds)
	}
}

func TestCycleNoProgressThresholdIsConfigurable(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Claims: 3, Processed: 3, Failed: 3, Exit: 0}})
	h.cfg.noProgressRounds = 2
	h.runGuarded(20 * time.Second)
	if s := h.summary(); s.Outcome != outNoProgress || s.Rounds != 2 {
		t.Fatalf("outcome=%q rounds=%d, want no_progress after 2 rounds", s.Outcome, s.Rounds)
	}
}

func TestCycleNoProgressCountsResetOnASuccess(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{
		{Claims: 3, Processed: 3, Deferred: 3, Exit: 0},
		{Claims: 3, Processed: 3, Succeeded: 1, Exit: 0},
		{Claims: 3, Processed: 3, Deferred: 3, Exit: 0},
		{Claims: 0, Exit: 0},
	})
	h.cfg.noProgressRounds = 2
	h.runGuarded(20 * time.Second)
	if s := h.summary(); s.Outcome != outQueueEmpty || s.Rounds != 4 {
		t.Fatalf("outcome=%q rounds=%d, want queue_empty after 4 (a success resets the streak)", s.Outcome, s.Rounds)
	}
}

// ---------------------------------------------------------------------------------------
// Dry run (batch 2 item 1): the flag or CRAWL_DRY_RUN=true; the child is told explicitly.

func TestResolveCycleDryRun(t *testing.T) {
	env := func(v string) func(string) string {
		return func(k string) string {
			if k == "CRAWL_DRY_RUN" {
				return v
			}
			return ""
		}
	}
	cases := []struct {
		name string
		flag bool
		env  string
		want bool
	}{
		{name: "env true, no flag: a dry run", flag: false, env: "true", want: true},
		{name: "flag, env false: a dry run", flag: true, env: "false", want: true},
		{name: "flag only", flag: true, env: "", want: true},
		{name: "env false: a real drain", flag: false, env: "false", want: false},
		{name: "neither: a real drain", flag: false, env: "", want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := resolveCycleDryRun(tc.flag, env(tc.env)); got != tc.want {
				t.Fatalf("resolveCycleDryRun(flag=%v, env=%q) = %v, want %v", tc.flag, tc.env, got, tc.want)
			}
		})
	}
}

func TestCycleDryRunIsOneRoundAndTheChildIsToldDry(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Claims: 1, Processed: 1, Succeeded: 1, Exit: 0, RecordEnv: true}})
	h.cfg.dryRun = true
	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != 0 || s.Outcome != outMaxRounds || s.Rounds != 1 || !s.DryRun {
		t.Fatalf("exit=%d outcome=%q rounds=%d dry_run=%v, want 0 max_rounds after 1 round, dry_run true", code, s.Outcome, s.Rounds, s.DryRun)
	}
	env, err := os.ReadFile(filepath.Join(h.dir, "env-0.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(env), "\nCRAWL_DRY_RUN=true\n") && !strings.HasSuffix(string(env), "CRAWL_DRY_RUN=true") {
		t.Fatalf("a dry run must set CRAWL_DRY_RUN=true in the child")
	}
}

// A dry run sends no gap report, even for a hung round (batch 1 item 8a).
func TestCycleDryRunSendsNoGapReports(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Claims: 1, Fetches: 1, Hang: true}})
	h.cfg.dryRun = true
	h.cfg.hungAfter = 400 * time.Millisecond
	h.runGuarded(20 * time.Second)
	if g := h.gapList(); len(g) != 0 {
		t.Fatalf("a dry run must send no ReportCycle, got %v", g)
	}
}

// ---------------------------------------------------------------------------------------
// ReportCycle (batch 1 item 8): a stalled round, and a 4/8/15 preflight, report once. 13 and 14 do not.

func TestCycleReportsAPreflightFailureOnceWhenIngestIsReachable(t *testing.T) {
	cases := []struct {
		name  string
		setup func(h *cycleHarness)
		want  []string
	}{
		{name: "chrome 4 reports", setup: func(h *cycleHarness) { h.chromeFn = func(context.Context) (string, int) { return "unusable", 4 } }, want: []string{"cyc-test:failed:4"}},
		{name: "probe 15 reports", setup: func(h *cycleHarness) { h.probeCode = 15; h.probeWord = "contract" }, want: []string{"cyc-test:failed:15"}},
		{name: "probe 13 does not report", setup: func(h *cycleHarness) { h.probeCode = 13; h.probeWord = "unauthenticated" }, want: nil},
		{name: "probe 14 does not report", setup: func(h *cycleHarness) { h.probeCode = 14; h.probeWord = "unavailable" }, want: nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newCycleHarness(t, []fakeStep{{Exit: 0}})
			tc.setup(h)
			h.runGuarded(20 * time.Second)
			got := h.gapList()
			if fmt.Sprint(got) != fmt.Sprint(tc.want) {
				t.Fatalf("gap reports = %v, want %v", got, tc.want)
			}
		})
	}
}

// A hung round is reported once for itself (batch 1 item 8c keeps zero-count gap reports).
func TestCycleReportsAHungRoundOnce(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Claims: 1, Fetches: 1, Hang: true}})
	h.cfg.hungAfter = 400 * time.Millisecond
	h.runGuarded(20 * time.Second)
	if g := h.gapList(); len(g) != 1 || g[0] != "cyc-test:failed:11" {
		t.Fatalf("gap reports = %v, want one failed:11", g)
	}
}

// ---------------------------------------------------------------------------------------
// Precedence and the preflight's health-only exit (batch 2 item 3).

func TestCyclePreflightExitsZeroWhateverItFinds(t *testing.T) {
	cases := []struct {
		name       string
		setup      func(h *cycleHarness)
		wantDriver string
		wantChrome string
		wantProbe  string
	}{
		{name: "driver missing", setup: func(h *cycleHarness) { h.driverFail = 99 }, wantDriver: "missing", wantChrome: lockUnknown, wantProbe: "ok"},
		{name: "chrome unreachable", setup: func(h *cycleHarness) { h.reach = "unreachable" }, wantDriver: "ok", wantChrome: "unreachable", wantProbe: "ok"},
		{name: "ingest contract mismatch", setup: func(h *cycleHarness) { h.probeCode = 15; h.probeWord = "contract" }, wantDriver: "ok", wantChrome: lockUnknown, wantProbe: "contract"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newCycleHarness(t, []fakeStep{{Exit: 0}})
			h.cfg.job = cycleJobPreflight
			tc.setup(h)
			code := h.runGuarded(20 * time.Second)
			s := h.summary()
			if code != 0 || s.ExitCode != 0 || s.Outcome != outChecked {
				t.Fatalf("exit=%d outcome=%q, want 0 checked: preflight is health-only", code, s.Outcome)
			}
			if s.Env.Driver != tc.wantDriver || s.Env.Chrome != tc.wantChrome || s.Ingest.Probe != tc.wantProbe {
				t.Fatalf("env=%+v ingest=%+v, want driver=%s chrome=%s probe=%s", s.Env, s.Ingest, tc.wantDriver, tc.wantChrome, tc.wantProbe)
			}
			if h.installCount() != 0 || h.spawned() != 0 {
				t.Fatalf("preflight installs nothing and claims nothing: installs=%d children=%d", h.installCount(), h.spawned())
			}
		})
	}
}

// The preflight's chrome value is reachable, never warm, and it never launches Chrome.
func TestCyclePreflightChromeIsReachableNeverWarm(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Exit: 0}})
	h.cfg.job = cycleJobPreflight
	h.reach = "reachable"
	h.chromeFn = func(context.Context) (string, int) {
		t.Errorf("preflight must not warm Chrome")
		return "warm", 0
	}
	h.runGuarded(20 * time.Second)
	if s := h.summary(); s.Env.Chrome != "reachable" {
		t.Fatalf("env.chrome = %q, want reachable", s.Env.Chrome)
	}
}

// ---------------------------------------------------------------------------------------
// Repair (batch 1 item 10): the wedged-Chrome recovery runs when the warm check fails or stalls.

func TestCycleRepairRecoversAWedgedChrome(t *testing.T) {
	cases := []struct {
		name         string
		warm         []int // successive warm answers
		recoverErr   error
		wantOutcome  string
		wantCode     int
		wantRecovers int
	}{
		{name: "warm first time: repaired, no recovery", warm: []int{0}, wantOutcome: outRepaired, wantCode: 0, wantRecovers: 0},
		{name: "rc 4, recovered, warm: repaired", warm: []int{4, 0}, wantOutcome: outRepaired, wantCode: 0, wantRecovers: 1},
		{name: "rc 5 twice: repair_failed 4", warm: []int{5, 5}, wantOutcome: outRepairFailed, wantCode: 4, wantRecovers: 1},
		{name: "recovery itself fails: repair_failed 4", warm: []int{4}, recoverErr: errors.New("still alive (test)"), wantOutcome: outRepairFailed, wantCode: 4, wantRecovers: 1},
		{name: "env broken is not a Chrome fault: repair_failed 8, no recovery", warm: []int{8}, wantOutcome: outRepairFailed, wantCode: 8, wantRecovers: 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newCycleHarness(t, []fakeStep{{Exit: 0}})
			h.cfg.job = cycleJobRepair
			h.recoverErr = tc.recoverErr
			var n int
			h.warmFn = func(context.Context) int {
				rc := tc.warm[min(n, len(tc.warm)-1)]
				n++
				return rc
			}
			code := h.runGuarded(20 * time.Second)
			s := h.summary()
			if code != tc.wantCode || s.Outcome != tc.wantOutcome {
				t.Fatalf("exit=%d outcome=%q, want %d %s", code, s.Outcome, tc.wantCode, tc.wantOutcome)
			}
			if h.recoverCount() != tc.wantRecovers {
				t.Fatalf("recoveries = %d, want %d", h.recoverCount(), tc.wantRecovers)
			}
		})
	}
}

// A warm check that stalls is recovered too, and a second stall is a hang (exit 11).
func TestCycleRepairStalledWarmCheckIsRecoveredThenHangs(t *testing.T) {
	block := make(chan struct{})
	t.Cleanup(func() { close(block) })
	h := newCycleHarness(t, []fakeStep{{Exit: 0}})
	h.cfg.job = cycleJobRepair
	h.cfg.chromeTimeout = 200 * time.Millisecond
	h.warmFn = func(context.Context) int { <-block; return 0 }
	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != exitCycleHung || s.Outcome != outRepairFailed {
		t.Fatalf("exit=%d outcome=%q, want 11 repair_failed", code, s.Outcome)
	}
	if h.recoverCount() != 1 {
		t.Fatalf("a stalled warm check must be recovered once: recoveries=%d", h.recoverCount())
	}
}

func TestCycleRepairInstallFailureIsEnvBroken(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Exit: 0}})
	h.cfg.job = cycleJobRepair
	h.installRC = 1
	code := h.runGuarded(20 * time.Second)
	if code != exitCrawlEnvBroken || h.summary().Outcome != outRepairFailed {
		t.Fatalf("a failed forced install is repair_failed 8, got exit %d", code)
	}
}

// ---------------------------------------------------------------------------------------
// Config refusals and the flag-failure path: one summary line, exit 8.

func TestCycleRefusesBadConfigWithOneSummaryLine(t *testing.T) {
	cases := []struct {
		name string
		job  string
		env  map[string]string
	}{
		{name: "max rounds zero", job: cycleJobDrain, env: map[string]string{"CRAWL_DRAIN_MAX_ROUNDS": "0"}},
		{name: "max rounds not a number", job: cycleJobDrain, env: map[string]string{"CRAWL_DRAIN_MAX_ROUNDS": "many"}},
		{name: "bad hung threshold", job: cycleJobDrain, env: map[string]string{"CRAWL_HUNG_AFTER": "-1s"}},
		{name: "db sink", job: cycleJobDrain, env: map[string]string{"CRAWL_SINK": "db"}},
		{name: "unset sink on repair", job: cycleJobRepair, env: map[string]string{}},
		{name: "unknown job", job: "sweep", env: map[string]string{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			getenv := func(k string) string { return tc.env[k] }
			isolateCrawlFetchEnv(t)
			code := runCycleMode(&out, tc.job, false, time.Hour, getenv, nil)
			if code != exitSinkRefused {
				t.Fatalf("exit = %d, want 8", code)
			}
			lines := strings.Split(strings.TrimRight(out.String(), "\n"), "\n")
			if len(lines) != 1 {
				t.Fatalf("a refused cycle prints one summary line: %q", out.String())
			}
			var s cycleSummary
			if err := json.Unmarshal([]byte(lines[0]), &s); err != nil {
				t.Fatal(err)
			}
			if s.ExitCode != 8 || s.Rounds != 0 {
				t.Fatalf("summary = %+v", s)
			}
		})
	}
}

// A bad flag in -mode cycle still prints the summary and exits 8. Any other mode exits 2.
func TestCycleFlagFailurePrintsTheSummary(t *testing.T) {
	var out bytes.Buffer
	code := cycleFlagFailure([]string{"-mode", "cycle", "-job", "drain", "-max-duration", "bogus"}, &out)
	if code != exitSinkRefused {
		t.Fatalf("exit = %d, want 8", code)
	}
	var s cycleSummary
	if err := json.Unmarshal([]byte(strings.TrimRight(out.String(), "\n")), &s); err != nil || s.Job != cycleJobDrain || s.ExitCode != 8 {
		t.Fatalf("summary = %q (%v)", out.String(), err)
	}
	var other bytes.Buffer
	if code := cycleFlagFailure([]string{"-mode", "agent", "-bogus"}, &other); code != 2 || other.Len() != 0 {
		t.Fatalf("a non-cycle flag error exits 2 with no summary: exit=%d out=%q", code, other.String())
	}
}

// The driver directory defaults for the cycle only (batch 2 item 4).
func TestCycleDefaultsTheDriverDirectory(t *testing.T) {
	var set string
	got := applyCycleDriverDefault(func(string) string { return "" }, func(k, v string) error {
		if k == "CRAWL_PW_DRIVER_DIR" {
			set = v
		}
		return nil
	})
	if set == "" || set != got || !strings.HasSuffix(got, filepath.Join(".shorted-housing-crawl", "pw-driver")) {
		t.Fatalf("driver dir = %q (set %q), want the wrapper's ~/.shorted-housing-crawl/pw-driver", got, set)
	}
	called := false
	kept := applyCycleDriverDefault(func(k string) string {
		if k == "CRAWL_PW_DRIVER_DIR" {
			return "/custom/dir"
		}
		return ""
	}, func(string, string) error { called = true; return nil })
	if kept != "/custom/dir" || called {
		t.Fatalf("an explicit CRAWL_PW_DRIVER_DIR is kept and not overwritten: got %q", kept)
	}
}

// The driver check is read-only: a missing directory is reported, never created.
func TestCheckPlaywrightDriverNeverCreatesTheDirectory(t *testing.T) {
	absent := filepath.Join(t.TempDir(), "absent", "pw-driver")
	t.Setenv("CRAWL_PW_DRIVER_DIR", absent)
	if err := checkPlaywrightDriver(); err == nil {
		t.Fatalf("a missing driver directory must fail the check")
	}
	if _, err := os.Stat(absent); err == nil {
		t.Fatalf("the driver check created %s", absent)
	}
}

// The hung threshold follows the page budget, with a 20-minute floor (batch 1 item 9).
func TestDerivedHungAfterFollowsTheFetchBudget(t *testing.T) {
	none := func(string) string { return "" }
	if got := derivedHungAfter(none); got != hungFloor {
		t.Fatalf("default hung threshold = %s, want the 20m floor", got)
	}
	slow := func(k string) string {
		if k == "CRAWL_FETCH_TIMEOUT_S" {
			return "600"
		}
		return ""
	}
	// The derived limit is the worst silence (N4 formula): 2x3x600 + 120 + 1800 + 60 + 183 + 45 = 5808 s.
	// The config clamps it to the ceiling (see TestHungThresholdIsClampedBelowTheRuntimeWatchdog).
	if got, want := derivedHungAfter(slow), 5808*time.Second; got != want {
		t.Fatalf("derived hung threshold = %s, want %s", got, want)
	}
	if got := loadCycleConfig(slow).hungAfter; got != hungCeiling(defaultHungGrace) {
		t.Fatalf("the config must clamp a derived limit above the ceiling: got %s", got)
	}
}

func TestCycleSkipsTheCooldownAfterTheLastRound(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Exit: 3}})
	h.cfg.maxRounds = 1
	h.cfg.rewarmCooldown = 30 * time.Second
	start := time.Now()
	h.runGuarded(20 * time.Second)
	s := h.summary()
	if s.Outcome != outMaxRounds || time.Since(start) > 10*time.Second {
		t.Fatalf("outcome=%q after %s: no cooldown may run after the last round", s.Outcome, time.Since(start))
	}
}

// ---------------------------------------------------------------------------------------
// The events fd is never waited on (batch 1 item 4): a stalled writer drops and counts.

func TestCycleSlowEventsFdDropsAndNeverStallsSupervision(t *testing.T) {
	bw := &blockingWriter{release: make(chan struct{})}
	t.Cleanup(func() { close(bw.release) })
	h := newCycleHarness(t, []fakeStep{
		{Claims: 5000, Processed: 5000, Succeeded: 1, Exit: 0},
		{Exit: 0},
	})
	h.deps.events = newCrawlEvents(bw)
	start := time.Now()
	code := h.runGuarded(30 * time.Second)
	s := h.summary()
	if code != 0 || s.Outcome != outQueueEmpty || s.Rounds != 2 {
		t.Fatalf("exit=%d outcome=%q rounds=%d: a stalled events fd must not stop the cycle", code, s.Outcome, s.Rounds)
	}
	if s.Counts.Claimed != 5000 {
		t.Fatalf("claimed = %d, want 5000 (counted from the child, not the fd)", s.Counts.Claimed)
	}
	if s.Counts.EventsDropped == 0 {
		t.Fatalf("a stalled fd must drop and count events")
	}
	if time.Since(start) > 25*time.Second {
		t.Fatalf("supervision waited on the events fd")
	}
}

// ---------------------------------------------------------------------------------------
// Events and output hygiene.

func TestCycleOutputIsOneCleanLineAndEventsAreWellFormed(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{
		{Claims: 2, Fetches: 3, Pushed: 2, Quarantined: 1, PushFailed: 1, Processed: 2, Succeeded: 2, Exit: 0, Noise: true, RecordEnv: true, Startup: true},
		{Exit: 0, Noise: true},
	})
	if code := h.runGuarded(20 * time.Second); code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if strings.Contains(h.stdout.String(), "NOISE") {
		t.Fatalf("a child's stdout must go to the cycle's stderr, not stdout: %q", h.stdout.String())
	}
	s := h.summary()
	if s.Schema != cycleSchema || s.CycleID != "cyc-test" || s.Job != cycleJobDrain || s.Counts.Claimed != 2 || s.Counts.Pushed != 2 || s.Counts.Quarantined != 1 || s.Counts.PushFailed != 1 || s.Counts.Blocked != 0 || s.Counts.Succeeded != 2 {
		t.Fatalf("summary = %+v", s)
	}

	evs := h.events()
	if len(evs) == 0 {
		t.Fatal("no events")
	}
	if evs[0]["type"] != "cycle_start" || evs[len(evs)-1]["type"] != "cycle_done" {
		t.Fatalf("the stream must open with cycle_start and close with cycle_done: first=%v last=%v", evs[0]["type"], evs[len(evs)-1]["type"])
	}
	allowed := map[string]bool{
		"cycle_start": true, "phase": true, "preflight": true, "round_start": true, "round_done": true, "cycle_done": true,
		"claim": true, "fetch": true, "submit": true, "finalize_started": true, "startup": true,
		"ingest_ok": true, "ingest_error": true, "shadow": true, "shadow_circuit": true, "page": true,
	}
	roundDone := 0
	sawReady := false
	for _, e := range evs {
		typ, _ := e["type"].(string)
		if !allowed[typ] {
			t.Fatalf("unexpected event type %q", typ)
		}
		if typ == "ready" {
			sawReady = true
		}
		if _, ok := e["ts"]; !ok {
			t.Fatalf("event %q has no ts", typ)
		}
		if e["cycle_id"] != "cyc-test" {
			t.Fatalf("event %q has no cycle_id", typ)
		}
		if typ == "round_done" {
			roundDone++
			if _, ok := e["counts"]; !ok {
				t.Fatalf("the cycle's round_done carries counts")
			}
		}
		if typ == "claim" || typ == "fetch" || typ == "startup" {
			if _, ok := e["round"]; !ok {
				t.Fatalf("forwarded child event %q has no round number", typ)
			}
		}
	}
	if sawReady {
		t.Fatalf("ready is the cycle's signal, never forwarded")
	}
	if roundDone != 2 {
		t.Fatalf("round_done events = %d, want one per round (2)", roundDone)
	}
	env, err := os.ReadFile(filepath.Join(h.dir, "env-0.txt"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"CRAWL_CYCLE_ID=cyc-test", "CRAWL_RUN_ID=cyc-test", "CRAWL_EVENTS_FD=3", "CRAWL_DRY_RUN=false"} {
		if !strings.Contains(string(env), want+"\n") && !strings.HasSuffix(string(env), want) {
			t.Fatalf("child environment is missing %s", want)
		}
	}
}

// The events the cycle sends must not carry listing data: only the fields the contract names.
func TestCycleSummaryCarriesNoListingData(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Claims: 1, Processed: 1, Succeeded: 1, Exit: 0}, {Exit: 0}})
	h.runGuarded(20 * time.Second)
	var top map[string]json.RawMessage
	if err := json.Unmarshal([]byte(strings.TrimRight(h.stdout.String(), "\n")), &top); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"address", "url", "suburb", "listing_url", "title", "description", "listings"} {
		if _, ok := top[bad]; ok {
			t.Fatalf("the summary must not carry %q", bad)
		}
	}
}

// ---------------------------------------------------------------------------------------
// Child-side pieces (batch 1 items 1c, 5 and minor fixes).

// The child writes ready first, before any work and before its config checks. runAgent runs in a
// subprocess (CYCLE_TEST_AGENT, testmain_test.go): its events fd is wrapped in an os.File, and a
// finalizer would close that fd number in this process once the test had closed it, which can close
// another test's socket. The subprocess owns its fd.
func TestRunAgentWritesReadyBeforeAnythingElse(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = r.Close() }()
	env := []string{cycleTestAgentEnv + "=1", crawlEventsFDEnv + "=3"}
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if k == crawlSinkEnv || k == "BRANDBRAIN_AGENT_URL" || k == crawlEventsFDEnv || strings.HasPrefix(k, "CYCLE_") {
			continue
		}
		env = append(env, kv)
	}
	cmd := exec.Command(self)
	cmd.Env = env
	cmd.ExtraFiles = []*os.File{w}
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	_ = w.Close()
	out, _ := io.ReadAll(r)
	err = cmd.Wait()
	code := 0
	if exitErr, ok := err.(*exec.ExitError); ok {
		code = exitErr.ExitCode()
	}
	if code != 7 {
		t.Fatalf("runAgent without BrandBrain config exits 7, got %d", code)
	}
	lines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
	if len(lines) < 2 || !strings.Contains(lines[0], `"event":"ready"`) || !strings.Contains(lines[len(lines)-1], `"event":"round_done"`) {
		t.Fatalf("the first event must be ready and the last round_done: %q", string(out))
	}
}

// Broken events make the page loop stop: the per-page check answers false and the round's context
// is cancelled, so the fetch in flight is abandoned.
func TestBrokenEventsStopThePageLoop(t *testing.T) {
	signal.Ignore(syscall.SIGPIPE)
	t.Cleanup(func() { signal.Reset(syscall.SIGPIPE) })
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	_ = r.Close()
	stop := newStopSignal()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ev := newCrawlEvents(w)
	ev.onBroken = func() {
		stop.request("event-pipe")
		cancel()
	}
	check := agentPageStop(stop, cancel, startParentPID)
	if !check() {
		t.Fatalf("a healthy page check must continue")
	}
	ev.fetch("job-1", "rea", 1, "ok") // EPIPE: the reader is gone
	if check() {
		t.Fatalf("after the events pipe breaks, the page check must stop the sweep")
	}
	if ctx.Err() == nil {
		t.Fatalf("the round's context must be cancelled, abandoning the fetch in flight")
	}
}

// A sweep asks the page check after each page and abandons the page at once when it says no. The
// abandoned page is never classified: an empty body would count as a blocked sweep (blockCounter),
// and only the classification path, which runs after the check, increments it. So the check is seen
// by the counter: it stays at 0 when the check stops the sweep first.
func TestSweepStopsAfterThePageThatFailsTheCheck(t *testing.T) {
	f := &countingFetcher{}
	lc := &listingsCrawler{fetcher: f, cfg: loadListingsConfig(), pageStop: func() bool { return false }}
	var blocks int
	urlFor := func(p int) string { return fmt.Sprintf("https://example.test/search?page=%d", p) }
	lc.sweepSuburbSource(context.Background(), CrawlTarget{Display: "Testville"}, "rea", urlFor, &blocks)
	if f.calls != 1 {
		t.Fatalf("the sweep fetched %d pages after its stop, want exactly the one in flight", f.calls)
	}
	if blocks != 0 {
		t.Fatalf("the abandoned page was classified (blocks=%d): the page check must run before classification", blocks)
	}
}

// countingFetcher returns an empty body and counts the fetches.
type countingFetcher struct{ calls int }

func (f *countingFetcher) fetch(_ context.Context, url string) ([]byte, string, error) {
	f.calls++
	return nil, url, nil
}

// A launched browser is reaped: no zombie is left under the collector (batch 1 minor fixes).
func TestStartDetachedReapsTheProcess(t *testing.T) {
	pid, err := startDetachedReaped("/bin/sh", []string{"-c", "exit 0"})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for alive(pid) {
		if time.Now().After(deadline) {
			t.Fatalf("pid %d is a zombie: the launched process was never reaped", pid)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// The events pipe read end is closed on every path out of supervision.
func TestSuperviseClosesTheEventsPipeOnEveryPath(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Exit: 0}})
	c := newCycleRunner(h.cfg, h.deps)
	p, err := c.spawn(1)
	if err != nil {
		t.Fatal(err)
	}
	c.supervise(p, 1)
	if _, err := p.pipe.Read(make([]byte, 1)); err == nil {
		t.Fatalf("the events pipe's read end must be closed once supervision returns")
	}
}

// The cycle's own parser refuses values that are not contract words (sanity check on the closed sets).
func TestCycleEnumsAreTheContractsWords(t *testing.T) {
	for _, w := range []string{outQueueEmpty, outBudget, outNoProgress, outMaxRounds, outCancelled, outLockHeld, outPreflightFailed, outStopped, outHung, outInternal, outRepaired, outRepairFailed, outChecked} {
		if strings.ContainsAny(w, " -|") {
			t.Fatalf("outcome %q is not a bare contract word", w)
		}
	}
	for _, w := range []string{lockFree, lockHeldByCycle, lockHeldElsewhere, lockUnknown} {
		if strings.ContainsAny(w, " -|") {
			t.Fatalf("lock value %q is not a bare contract word", w)
		}
	}
}

// ProbeAuth's answer is an ingest_ok or ingest_error event with probe true and the contract's
// code word, not only a push's event (contract: "ProbeAuth results emit these too").
func TestProbeResultEventsCarryTheContractWords(t *testing.T) {
	var buf lockedBuf
	ev := newCrawlEvents(&buf)
	ev.probeResult(true, "")
	ev.probeResult(false, "unauthenticated")
	ev.probeResult(false, "not-a-word")
	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("probe events = %d, want 3: %q", len(lines), buf.String())
	}
	if !strings.Contains(lines[0], `"event":"ingest_ok"`) || !strings.Contains(lines[0], `"probe":true`) {
		t.Fatalf("a probe success is ingest_ok with probe true: %s", lines[0])
	}
	if !strings.Contains(lines[1], `"event":"ingest_error"`) || !strings.Contains(lines[1], `"code":"unauthenticated"`) {
		t.Fatalf("a probe failure carries its contract word: %s", lines[1])
	}
	if !strings.Contains(lines[2], `"code":"other"`) {
		t.Fatalf("a code outside the set is written as other, never echoed: %s", lines[2])
	}
}

// An accepted push carries quarantined, so the cycle can count the held-back sweeps.
func TestIngestOKCarriesQuarantine(t *testing.T) {
	var buf lockedBuf
	newCrawlEvents(&buf).ingestOK("job-1", "rea", "blocked", false, true)
	if !strings.Contains(buf.String(), `"quarantined":true`) {
		t.Fatalf("ingest_ok must carry quarantined: %s", buf.String())
	}
}

// The fetch event's source, outcome and page are enums and bounded numbers, never free text.
func TestFetchEventIsAllowlistedAndClamped(t *testing.T) {
	var buf lockedBuf
	ev := newCrawlEvents(&buf)
	ev.fetch("job-1", "rea", 3, "ok")
	ev.fetch("job-1", "domain", 0, "blocked")
	ev.fetch("job-1", "gumtree", 1, "ok")         // a source outside the enum is dropped
	ev.fetch("job-1", "rea", 2, "some free text") // an outcome outside the enum is dropped
	ev.fetch("job-1", "rea", 999999, "error")     // a page above the cap is clamped
	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("fetch events = %d, want 3: %q", len(lines), buf.String())
	}
	if !strings.Contains(lines[1], `"page":1`) {
		t.Fatalf("a page below 1 is clamped to 1: %s", lines[1])
	}
	if !strings.Contains(lines[2], fmt.Sprintf(`"page":%d`, maxFetchPage)) {
		t.Fatalf("a page above the cap is clamped: %s", lines[2])
	}
}

// keep io referenced for the blockingWriter's contract with crawlEvents.
var _ io.Writer = (*blockingWriter)(nil)
