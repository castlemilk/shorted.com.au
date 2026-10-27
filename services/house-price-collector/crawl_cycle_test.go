package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// cycleHarness runs a real cycle against the fake child (crawl_cycle_fake_test.go). The
// preflight edges are fakes too, so no test touches Chrome, the playwright driver or ingest.
type cycleHarness struct {
	t          *testing.T
	dir        string // fake child's plan and counters
	lockDir    string
	stdout     bytes.Buffer
	evbuf      bytes.Buffer
	cfg        cycleConfig
	deps       cycleDeps
	sigs       chan os.Signal
	installs   int
	installRC  int
	driverFail int // driverPresent fails this many calls, then passes
	chrome     string
	chromeRC   int
	probeRC    int
	warmRC     int
	gaps       []string
	forceExits atomic.Int32
}

// newCycleHarness builds a drain harness for plan. The fake child repeats the last step once the
// plan runs out.
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

	h := &cycleHarness{t: t, dir: dir, lockDir: lockDir, chrome: "not_used", sigs: make(chan os.Signal, 4)}
	h.cfg = cycleConfig{
		job:            cycleJobDrain,
		maxRounds:      30,
		rewarmCooldown: 0,
		rewarmBudget:   2,
		hungAfter:      10 * time.Minute,
		hungGrace:      300 * time.Millisecond,
		lockDir:        lockDir,
		cycleID:        "cyc-test",
		childArgv:      func() (string, []string) { return os.Args[0], nil },
	}
	h.deps = cycleDeps{
		driverPresent: func() error {
			if h.driverFail > 0 {
				h.driverFail--
				return fmt.Errorf("playwright driver missing (test)")
			}
			return nil
		},
		installDriver: func() int {
			h.installs++
			return h.installRC
		},
		ensureChrome:    func(context.Context) (string, int) { return h.chrome, h.chromeRC },
		chromeReachable: func() string { return "not_used" },
		probeIngest:     func(context.Context) int { return h.probeRC },
		warmcheck:       func(context.Context) int { return h.warmRC },
		reportGap: func(cycleID, outcome string, exit int) {
			h.gaps = append(h.gaps, fmt.Sprintf("%s:%s:%d", cycleID, outcome, exit))
		},
		stdout:    &h.stdout,
		events:    newCrawlEvents(&h.evbuf),
		now:       time.Now,
		sigs:      h.sigs,
		forceExit: func() { h.forceExits.Add(1) },
	}
	t.Cleanup(h.killSurvivors)
	return h
}

// killSurvivors kills every process group a fake child or grandchild recorded, so a failing test
// never leaks a sleep or a child.
func (h *cycleHarness) killSurvivors() {
	for _, pid := range h.recordedPIDs() {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
}

// recordedPIDs returns the child and grandchild pids the fake wrote.
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

// runGuarded runs the cycle and fails the test if it does not return within d. A stuck cycle is
// the failure these tests exist to catch, so it must not hang the run.
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

// summary parses the one stdout line, failing if there is any other.
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

// events parses the cycle's event stream.
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

// spawned reports how many children the cycle started.
func (h *cycleHarness) spawned() int {
	return len(h.recordedPIDs())
}

func alive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

// waitGone polls until pid is gone or the timeout passes.
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

// waitFile polls until path exists.
func waitFile(t *testing.T, path string, d time.Duration) {
	t.Helper()
	deadline := time.Now().Add(d)
	for {
		if _, err := os.Stat(path); err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s did not appear within %s", path, d)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// readPID reads a pid file the fake wrote.
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

// ---------------------------------------------------------------------------------------
// Drain policy table: each child exit code, decided from its events and exit.

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
		{
			name:        "queue empty at once",
			plan:        []fakeStep{{Claims: 0, Processed: 0, Exit: 0}},
			wantOutcome: "queue_empty", wantCode: 0, wantRounds: 1,
		},
		{
			name: "work, then an empty round",
			plan: []fakeStep{
				{Claims: 2, Processed: 2, Succeeded: 2, Exit: 0},
				{Claims: 0, Processed: 0, Exit: 0},
			},
			wantOutcome: "queue_empty", wantCode: 0, wantRounds: 2,
		},
		{
			name:        "re-warm 3 is retried twice, then stops with 3",
			plan:        []fakeStep{{Claims: 1, Processed: 1, Exit: 3}},
			wantOutcome: "rewarm", wantCode: 3, wantRounds: 3,
		},
		{
			name:        "re-warm 5 shares the budget and stops with 5",
			plan:        []fakeStep{{Claims: 1, Processed: 1, Exit: 5}},
			wantOutcome: "rewarm", wantCode: 5, wantRounds: 3,
		},
		{
			name: "re-warm then success",
			plan: []fakeStep{
				{Claims: 1, Processed: 1, Exit: 3},
				{Claims: 0, Exit: 0},
			},
			wantOutcome: "queue_empty", wantCode: 0, wantRounds: 2,
		},
		{name: "4 stops with 4", plan: []fakeStep{{Exit: 4}}, wantOutcome: "failed", wantCode: 4, wantRounds: 1},
		{name: "7 stops with 7", plan: []fakeStep{{Exit: 7}}, wantOutcome: "failed", wantCode: 7, wantRounds: 1},
		{name: "12 stops with 12", plan: []fakeStep{{Exit: 12}}, wantOutcome: "failed", wantCode: 12, wantRounds: 1},
		{name: "13 stops with 13", plan: []fakeStep{{Exit: 13}}, wantOutcome: "failed", wantCode: 13, wantRounds: 1},
		{name: "14 stops with 14", plan: []fakeStep{{Exit: 14}}, wantOutcome: "failed", wantCode: 14, wantRounds: 1},
		{name: "15 stops with 15", plan: []fakeStep{{Exit: 15}}, wantOutcome: "failed", wantCode: 15, wantRounds: 1},
		{name: "any other code stops with it", plan: []fakeStep{{Exit: 1}}, wantOutcome: "failed", wantCode: 1, wantRounds: 1},
		{
			name:        "8 installs once, retries once, then stops with 8",
			plan:        []fakeStep{{Exit: 8}},
			wantOutcome: "env_broken", wantCode: 8, wantRounds: 2, wantInstalls: 1,
		},
		{
			name: "8 installs, then the retry succeeds",
			plan: []fakeStep{
				{Exit: 8},
				{Claims: 0, Exit: 0},
			},
			wantOutcome: "queue_empty", wantCode: 0, wantRounds: 2, wantInstalls: 1,
		},
		{name: "10 stops quietly with 10", plan: []fakeStep{{Exit: 10}}, wantOutcome: "cancelled", wantCode: 10, wantRounds: 1},
		{
			name:        "max rounds stops the drain with 0",
			plan:        []fakeStep{{Claims: 1, Processed: 1, Exit: 0}},
			maxRounds:   3,
			wantOutcome: "max_rounds", wantCode: 0, wantRounds: 3,
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
			if h.installs != tc.wantInstalls {
				t.Fatalf("install-driver ran %d times, want %d", h.installs, tc.wantInstalls)
			}
		})
	}
}

// ---------------------------------------------------------------------------------------
// Preflight failures end the cycle before any round, with the S-FETCH and driver codes.

func TestCycleDrainPreflightFailuresStopBeforeAnyRound(t *testing.T) {
	cases := []struct {
		name         string
		setup        func(h *cycleHarness)
		wantCode     int
		wantInstalls int
		wantDriver   string
	}{
		{
			name:     "driver missing and install fails: 8",
			setup:    func(h *cycleHarness) { h.driverFail = 99; h.installRC = 1 },
			wantCode: 8, wantInstalls: 1, wantDriver: "missing",
		},
		{
			name:     "driver still missing after install: 8",
			setup:    func(h *cycleHarness) { h.driverFail = 99 },
			wantCode: 8, wantInstalls: 1, wantDriver: "missing",
		},
		{
			name:     "chrome unusable: 4",
			setup:    func(h *cycleHarness) { h.chrome = "unusable"; h.chromeRC = 4 },
			wantCode: 4, wantDriver: "ok",
		},
		{
			name:     "chrome env broken: 8",
			setup:    func(h *cycleHarness) { h.chrome = "env_broken"; h.chromeRC = 8 },
			wantCode: 8, wantDriver: "ok",
		},
		{name: "probe refused: 13", setup: func(h *cycleHarness) { h.probeRC = 13 }, wantCode: 13, wantDriver: "ok"},
		{name: "probe unavailable: 14", setup: func(h *cycleHarness) { h.probeRC = 14 }, wantCode: 14, wantDriver: "ok"},
		{name: "probe contract: 15", setup: func(h *cycleHarness) { h.probeRC = 15 }, wantCode: 15, wantDriver: "ok"},
		{name: "probe unimplemented: 8", setup: func(h *cycleHarness) { h.probeRC = 8 }, wantCode: 8, wantDriver: "ok"},
		{name: "probe token: 7", setup: func(h *cycleHarness) { h.probeRC = 7 }, wantCode: 7, wantDriver: "ok"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newCycleHarness(t, []fakeStep{{Claims: 1, Processed: 1, Exit: 0}})
			tc.setup(h)
			code := h.runGuarded(20 * time.Second)
			s := h.summary()
			if code != tc.wantCode {
				t.Fatalf("exit = %d, want %d", code, tc.wantCode)
			}
			if s.Rounds != 0 || h.spawned() != 0 {
				t.Fatalf("a failed preflight must start no round: rounds=%d children=%d", s.Rounds, h.spawned())
			}
			if h.installs != tc.wantInstalls {
				t.Fatalf("install-driver ran %d times, want %d", h.installs, tc.wantInstalls)
			}
			if s.Preflight.Driver != tc.wantDriver {
				t.Fatalf("preflight.driver = %q, want %q", s.Preflight.Driver, tc.wantDriver)
			}
		})
	}
}

// ---------------------------------------------------------------------------------------
// Hung: no event for hungAfter kills the child's whole group, and the cycle exits 11.

func TestCycleHungKillsTheGroupAndExits11(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{
		Claims: 1, Fetches: 1, Hang: true, OnTerm: "ignore", Grandchild: "sh_ignore_term",
	}})
	h.cfg.hungAfter = 400 * time.Millisecond
	h.cfg.hungGrace = 300 * time.Millisecond

	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != exitCycleHung || s.ExitCode != exitCycleHung || s.Outcome != "hung" {
		t.Fatalf("exit=%d outcome=%q, want 11 hung", code, s.Outcome)
	}
	child := readPID(t, filepath.Join(h.dir, "started-0"))
	grand := readPID(t, filepath.Join(h.dir, "grandchild-0.pid"))
	waitGone(t, child, 5*time.Second)
	waitGone(t, grand, 5*time.Second)
	if len(h.gaps) != 1 || h.gaps[0] != "cyc-test:failed:11" {
		t.Fatalf("a hung round must be reported by the cycle for itself: %v", h.gaps)
	}
}

// A child that leaves SIGTERM alone only gets killed when the group does not empty within the
// grace. A plain sleep grandchild empties on SIGTERM, so it is the leader and the group that
// decide the exit, not the grace.
func TestCycleHungGroupEmptiesOnSigtermWithoutSigkill(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Claims: 1, Fetches: 1, Hang: true, Grandchild: "sleep"}})
	h.cfg.hungAfter = 400 * time.Millisecond
	h.cfg.hungGrace = 5 * time.Second

	start := time.Now()
	code := h.runGuarded(20 * time.Second)
	if code != exitCycleHung {
		t.Fatalf("exit = %d, want 11", code)
	}
	if elapsed := time.Since(start); elapsed > 4*time.Second {
		t.Fatalf("a group that empties on SIGTERM must not wait out the grace: took %s", elapsed)
	}
	waitGone(t, readPID(t, filepath.Join(h.dir, "grandchild-0.pid")), 5*time.Second)
}

// Events within the window keep a slow but working child alive. The run is longer than the
// window (30 fetches 100ms apart is 3s against a 2s window), and each gap is well inside it, so
// the child must not be killed. The window has room for the child's own start-up, which under
// -race can take a while before its first event.
func TestCycleFetchEventsKeepAChildAlive(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{
		Claims: 1, Fetches: 30, FetchEveryMs: 100, Processed: 1, Succeeded: 1, Exit: 0,
	}, {Claims: 0, Exit: 0}})
	h.cfg.hungAfter = 2 * time.Second

	code := h.runGuarded(20 * time.Second)
	if code != 0 {
		t.Fatalf("a child that keeps emitting fetch events must not be hung: exit %d", code)
	}
	s := h.summary()
	if s.Outcome != "queue_empty" {
		t.Fatalf("outcome = %q, want queue_empty", s.Outcome)
	}
}

// ---------------------------------------------------------------------------------------
// SIGTERM: forwarded to the child group; the child finishes and exits 10; the cycle exits 10.

func TestCycleSigtermIsForwardedAndExits10(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Claims: 1, Fetches: 1, Hang: true, OnTerm: "exit10"}})
	h.cfg.hungAfter = 10 * time.Minute

	go func() {
		waitFile(t, filepath.Join(h.dir, "started-0"), 10*time.Second)
		time.Sleep(50 * time.Millisecond)
		h.sigs <- syscall.SIGTERM
	}()
	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != exitCrawlCancelled || s.Outcome != "cancelled" || s.Rounds != 1 {
		t.Fatalf("exit=%d outcome=%q rounds=%d, want 10 cancelled after 1 round", code, s.Outcome, s.Rounds)
	}
	if h.forceExits.Load() != 0 {
		t.Fatalf("the first signal must not force an exit")
	}
}

// A second signal SIGKILLs the group at once. The child ignores the first SIGTERM, so only the
// second signal can stop it, and the forced exit is taken.
func TestCycleSecondSignalSigkillsTheGroup(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Claims: 1, Fetches: 1, Hang: true, OnTerm: "ignore", Grandchild: "sh_ignore_term"}})
	h.cfg.hungAfter = 10 * time.Minute

	go func() {
		waitFile(t, filepath.Join(h.dir, "grandchild-0.pid"), 10*time.Second)
		time.Sleep(50 * time.Millisecond)
		h.sigs <- syscall.SIGTERM
		time.Sleep(50 * time.Millisecond)
		h.sigs <- syscall.SIGTERM
	}()
	code := h.runGuarded(20 * time.Second)
	if code != exitCrawlCancelled {
		t.Fatalf("exit = %d, want 10", code)
	}
	if h.forceExits.Load() != 1 {
		t.Fatalf("the second signal must take the forced exit once, took %d", h.forceExits.Load())
	}
	waitGone(t, readPID(t, filepath.Join(h.dir, "started-0")), 5*time.Second)
	waitGone(t, readPID(t, filepath.Join(h.dir, "grandchild-0.pid")), 5*time.Second)
}

// ---------------------------------------------------------------------------------------
// -max-duration: the deadline stops new rounds and stops the running one. Outcome budget, exit 0.

func TestCycleMaxDurationStopsTheRunningRoundAsBudget(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Claims: 1, Fetches: 1, Hang: true, OnTerm: "exit10"}})
	h.cfg.hungAfter = 10 * time.Minute
	h.cfg.maxDuration = time.Second

	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != 0 || s.Outcome != "budget" || s.ExitCode != 0 || s.Rounds != 1 {
		t.Fatalf("exit=%d outcome=%q rounds=%d, want 0 budget after 1 round", code, s.Outcome, s.Rounds)
	}
}

// The deadline also ends a re-warm cooldown: no new round starts after it.
func TestCycleMaxDurationEndsACooldownWithoutANewRound(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Exit: 3}})
	h.cfg.rewarmCooldown = 30 * time.Second
	h.cfg.maxDuration = time.Second

	start := time.Now()
	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != 0 || s.Outcome != "budget" || s.Rounds != 1 {
		t.Fatalf("exit=%d outcome=%q rounds=%d, want 0 budget after 1 round", code, s.Outcome, s.Rounds)
	}
	if time.Since(start) > 10*time.Second {
		t.Fatalf("the cooldown must end at the deadline, took %s", time.Since(start))
	}
}

// ---------------------------------------------------------------------------------------
// Sinks: the cycle runs only on ingest. db, shadow and unset are exit 8.

func TestCycleRefusesEverySinkButIngest(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
	}{
		{name: "unset", env: map[string]string{}},
		{name: "db", env: map[string]string{"CRAWL_SINK": "db"}},
		{name: "shadow", env: map[string]string{"CRAWL_SINK": "shadow", "DATABASE_URL": "postgres://x", "SHORTED_INGEST_URL": "https://api.shorted.com.au", "CRAWL_DRY_RUN": "false"}},
		{name: "ingest with DATABASE_URL", env: map[string]string{"CRAWL_SINK": "ingest", "DATABASE_URL": "postgres://x", "SHORTED_INGEST_URL": "https://api.shorted.com.au", "CRAWL_DRY_RUN": "false"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			getenv := func(k string) string { return tc.env[k] }
			code := runCycleMode(&out, cycleJobDrain, false, time.Hour, getenv, nil)
			if code != exitSinkRefused {
				t.Fatalf("exit = %d, want 8", code)
			}
			lines := strings.Split(strings.TrimRight(out.String(), "\n"), "\n")
			if len(lines) != 1 {
				t.Fatalf("a refused cycle still prints one summary line: %q", out.String())
			}
			var s cycleSummary
			if err := json.Unmarshal([]byte(lines[0]), &s); err != nil {
				t.Fatal(err)
			}
			if s.Outcome != "refused" || s.ExitCode != 8 || s.Rounds != 0 {
				t.Fatalf("summary = %+v", s)
			}
		})
	}
}

func TestCycleRefusesAnUnknownJob(t *testing.T) {
	var out bytes.Buffer
	code := runCycleMode(&out, "sweep", false, time.Hour, func(string) string { return "" }, nil)
	if code != exitUsage {
		t.Fatalf("exit = %d, want %d", code, exitUsage)
	}
}

// ---------------------------------------------------------------------------------------
// Lock: held exits 12 and runs nothing. A bash holder excludes the cycle. A child of the cycle passes.

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
	if code != exitLockHeld || s.Outcome != "lock_held" || s.Rounds != 0 || h.spawned() != 0 {
		t.Fatalf("exit=%d outcome=%q rounds=%d children=%d, want 12 lock_held and nothing run", code, s.Outcome, s.Rounds, h.spawned())
	}
	if s.Preflight.Lock.State != "held" || s.Preflight.Lock.PID != os.Getpid() {
		t.Fatalf("preflight.lock = %+v, want held by this pid", s.Preflight.Lock)
	}
}

func TestCycleExcludedByABashHolder(t *testing.T) {
	common := requireBashCommon(t)
	h := newCycleHarness(t, []fakeStep{{Claims: 1, Processed: 1, Exit: 0}})
	bashHolder(t, common, h.lockDir)

	code := h.runGuarded(20 * time.Second)
	if code != exitLockHeld {
		t.Fatalf("a bash holder must exclude the cycle: exit %d, want 12", code)
	}
	if h.spawned() != 0 {
		t.Fatalf("no child may run under a held lock")
	}
}

// The cycle holds the lock, and its child, which is the cycle's own child, passes the lock
// without taking it. This is the real cross-process path through withCrawlLock.
func TestCycleChildPassesTheLockItsParentHolds(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Lock: true, Exit: 0}})
	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != 0 || s.Outcome != "queue_empty" {
		t.Fatalf("exit=%d outcome=%q, want 0 queue_empty: a child of the lock holder must pass", code, s.Outcome)
	}
	if s.Preflight.Lock.State != "acquired" {
		t.Fatalf("preflight.lock = %+v, want acquired", s.Preflight.Lock)
	}
	if _, err := os.Stat(h.lockDir); err == nil {
		t.Fatalf("the cycle must release the lock when it ends")
	}
}

// ---------------------------------------------------------------------------------------
// preflight: takes no lock, claims nothing, installs nothing.

func TestCyclePreflightTakesNoLockAndClaimsNothing(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Claims: 1, Processed: 1, Exit: 0}})
	h.cfg.job = cycleJobPreflight
	h.chrome = "reachable"
	h.deps.chromeReachable = func() string { return "reachable" }

	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != 0 || s.Outcome != "ok" {
		t.Fatalf("exit=%d outcome=%q, want 0 ok", code, s.Outcome)
	}
	if _, err := os.Stat(h.lockDir); err == nil {
		t.Fatalf("preflight must not create the lock directory")
	}
	if h.spawned() != 0 || s.Rounds != 0 {
		t.Fatalf("preflight must claim nothing: rounds=%d children=%d", s.Rounds, h.spawned())
	}
	if h.installs != 0 {
		t.Fatalf("preflight must not install the driver")
	}
	if s.Preflight.Driver != "ok" || s.Preflight.Chrome != "reachable" || s.Preflight.Ingest != "ok" || s.Preflight.Lock.State != "free" {
		t.Fatalf("preflight = %+v", s.Preflight)
	}
}

func TestCyclePreflightReportsADeadDriverWithoutInstalling(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Exit: 0}})
	h.cfg.job = cycleJobPreflight
	h.driverFail = 99
	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != exitCrawlEnvBroken || s.Preflight.Driver != "missing" {
		t.Fatalf("exit=%d driver=%q, want 8 missing", code, s.Preflight.Driver)
	}
	if h.installs != 0 {
		t.Fatalf("preflight must not install the driver")
	}
}

// A lock held by someone else is reported, not failed, so the exit stays 0 while the legacy
// drainer runs in shadow.
func TestCyclePreflightReportsAHeldLockWithoutFailing(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Exit: 0}})
	h.cfg.job = cycleJobPreflight
	if err := os.Mkdir(h.lockDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(h.lockDir, "pid"), []byte(strconv.Itoa(os.Getpid())), 0o644); err != nil {
		t.Fatal(err)
	}
	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != 0 || s.Preflight.Lock.State != "held" || s.Preflight.Lock.PID != os.Getpid() {
		t.Fatalf("exit=%d lock=%+v, want 0 held by this pid", code, s.Preflight.Lock)
	}
}

// ---------------------------------------------------------------------------------------
// repair: a forced install, Chrome warm, then warmcheck. Exit 0, 4 or 8.

func TestCycleRepairCodes(t *testing.T) {
	cases := []struct {
		name         string
		setup        func(h *cycleHarness)
		wantCode     int
		wantInstalls int
	}{
		{name: "all ok", setup: func(h *cycleHarness) {}, wantCode: 0, wantInstalls: 1},
		{name: "install fails: 8", setup: func(h *cycleHarness) { h.installRC = 1 }, wantCode: 8, wantInstalls: 1},
		{name: "chrome unusable: 4", setup: func(h *cycleHarness) { h.chrome = "unusable"; h.chromeRC = 4 }, wantCode: 4, wantInstalls: 1},
		{name: "warmcheck not warm: 4", setup: func(h *cycleHarness) { h.warmRC = 5 }, wantCode: 4, wantInstalls: 1},
		{name: "warmcheck env broken: 8", setup: func(h *cycleHarness) { h.warmRC = 8 }, wantCode: 8, wantInstalls: 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newCycleHarness(t, []fakeStep{{Exit: 0}})
			h.cfg.job = cycleJobRepair
			tc.setup(h)
			code := h.runGuarded(20 * time.Second)
			if code != tc.wantCode {
				t.Fatalf("exit = %d, want %d", code, tc.wantCode)
			}
			if h.installs != tc.wantInstalls {
				t.Fatalf("install-driver ran %d times, want %d (repair forces it)", h.installs, tc.wantInstalls)
			}
			if h.spawned() != 0 {
				t.Fatalf("repair runs no round")
			}
		})
	}
}

// ---------------------------------------------------------------------------------------
// Output hygiene, the child environment and the events.

func TestCycleOutputIsOneCleanLineAndEventsAreWellFormed(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{
		{Claims: 2, Fetches: 3, Pushed: 2, Quarantined: 1, PushFailed: 1, Processed: 2, Succeeded: 2, Exit: 0, Noise: true, RecordEnv: true},
		{Claims: 0, Exit: 0, Noise: true},
	})
	code := h.runGuarded(20 * time.Second)
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}

	// stdout: exactly one JSON object, with the agreed keys and no listing data.
	if strings.Contains(h.stdout.String(), "NOISE") {
		t.Fatalf("a child's stdout must go to the cycle's stderr, not stdout: %q", h.stdout.String())
	}
	var top map[string]json.RawMessage
	lines := strings.Split(strings.TrimRight(h.stdout.String(), "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("stdout lines = %d", len(lines))
	}
	if err := json.Unmarshal([]byte(lines[0]), &top); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"cycle_id", "job", "outcome", "exit_code", "rounds", "started_at", "finished_at", "collector", "counts", "preflight"} {
		if _, ok := top[k]; !ok {
			t.Fatalf("summary is missing %q", k)
		}
	}
	var counts map[string]int
	if err := json.Unmarshal(top["counts"], &counts); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"address", "url", "suburb", "listing_url", "title", "description"} {
		if _, ok := counts[bad]; ok {
			t.Fatalf("counts must not carry %q", bad)
		}
	}
	if counts["claimed"] != 2 || counts["pushed"] != 2 || counts["quarantined"] != 1 || counts["push_failed"] != 1 || counts["processed"] != 2 {
		t.Fatalf("counts = %v", counts)
	}

	// events: every line is an event with a name and a time, the cycle brackets the stream,
	// child events carry their round, and each round has exactly one cycle round_done.
	evs := h.events()
	if len(evs) == 0 {
		t.Fatal("no events")
	}
	if evs[0]["event"] != "cycle_start" || evs[len(evs)-1]["event"] != "cycle_done" {
		t.Fatalf("the stream must open with cycle_start and close with cycle_done: first=%v last=%v", evs[0]["event"], evs[len(evs)-1]["event"])
	}
	allowed := map[string]bool{
		"cycle_start": true, "preflight": true, "round_start": true, "round_done": true, "cycle_done": true,
		"claim": true, "page": true, "fetch": true, "submit": true, "finalize_started": true,
		"ingest_ok": true, "ingest_error": true, "shadow": true, "shadow_circuit": true,
	}
	roundDone := 0
	for _, e := range evs {
		name, _ := e["event"].(string)
		if !allowed[name] {
			t.Fatalf("unexpected event %q", name)
		}
		if _, ok := e["ts"]; !ok {
			t.Fatalf("event %q has no ts", name)
		}
		if name == "round_done" {
			roundDone++
			if _, ok := e["exit_code"]; !ok {
				t.Fatalf("the cycle's round_done carries the child's exit code")
			}
		}
		if name == "claim" || name == "fetch" || name == "ingest_ok" {
			if _, ok := e["round"]; !ok {
				t.Fatalf("child event %q has no round number", name)
			}
		}
		if name == "ingest_ok" {
			if _, ok := e["quarantined"]; !ok {
				t.Fatalf("ingest_ok must carry quarantined")
			}
		}
	}
	if roundDone != 2 {
		t.Fatalf("round_done events = %d, want one per round (2)", roundDone)
	}

	// The child saw the cycle's identity, its own events fd, and no database.
	env, err := os.ReadFile(filepath.Join(h.dir, "env-0.txt"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"CRAWL_CYCLE_ID=cyc-test", "CRAWL_RUN_ID=cyc-test", "CRAWL_EVENTS_FD=3"} {
		if !strings.Contains(string(env), want+"\n") && !strings.HasSuffix(string(env), want) {
			t.Fatalf("child environment is missing %s", want)
		}
	}
	if strings.Contains(string(env), "CRAWL_DRY_RUN=true") {
		t.Fatalf("a real drain must not dry-run its children")
	}
}

// A dry run runs one round, and the child pushes dry.
func TestCycleDryRunRunsOneRoundAndPushesDry(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Claims: 1, Processed: 1, Exit: 0, RecordEnv: true}})
	h.cfg.dryRun = true
	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != 0 || s.Outcome != "dry_run" || s.Rounds != 1 {
		t.Fatalf("exit=%d outcome=%q rounds=%d, want 0 dry_run after 1 round", code, s.Outcome, s.Rounds)
	}
	env, err := os.ReadFile(filepath.Join(h.dir, "env-0.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(env), "CRAWL_DRY_RUN=true") {
		t.Fatalf("a dry run must set CRAWL_DRY_RUN=true in the child")
	}
}

// ---------------------------------------------------------------------------------------
// Events and the child's own writer: the new per-page fetch event, and quarantine on ingest_ok.

func TestFetchEventIsAllowlistedAndClamped(t *testing.T) {
	var buf bytes.Buffer
	ev := newCrawlEvents(&buf)
	ev.fetch("job-1", "rea", 3, "ok")
	ev.fetch("job-1", "domain", 0, "blocked")
	ev.fetch("job-1", "gumtree", 1, "ok")         // source outside the enum: dropped
	ev.fetch("job-1", "rea", 2, "some free text") // outcome outside the enum: dropped
	ev.fetch("job-1", "rea", 999999, "error")     // clamped

	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("fetch events = %d, want 3: %q", len(lines), buf.String())
	}
	var second, third map[string]any
	_ = json.Unmarshal([]byte(lines[1]), &second)
	_ = json.Unmarshal([]byte(lines[2]), &third)
	if second["page"].(float64) != 1 {
		t.Fatalf("a page below 1 is clamped to 1: %v", second)
	}
	if third["page"].(float64) != maxFetchPage {
		t.Fatalf("a page above the cap is clamped: %v", third)
	}
}

func TestIngestOKCarriesQuarantine(t *testing.T) {
	var buf bytes.Buffer
	newCrawlEvents(&buf).ingestOK("job-1", "rea", "blocked", false, true)
	if !strings.Contains(buf.String(), `"quarantined":true`) {
		t.Fatalf("ingest_ok must carry quarantined: %s", buf.String())
	}
}
