package main

// crawl_cycle_parent_test.go tests parent death (batch 3). The cycle's parent is the runtime. The
// test process cannot be the runtime (killing it would kill the test), so the test starts a runtime
// stand-in as a process of its own. The stand-in starts the cycle as its child, and the cycle runs the
// rounds through its fake children. The test SIGKILLs the stand-in while a round, or a cooldown, is
// in progress. The cycle must then behave as on SIGTERM: the round finishes, the cycle exits 10 and
// writes its summary, and no new round starts.

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

const (
	cycleTestRuntimeEnv = "CYCLE_TEST_RUNTIME"
	cycleTestCycleEnv   = "CYCLE_TEST_CYCLE"
	cycleTestOutEnv     = "CYCLE_TEST_OUT"
	cycleTestPIDFile    = "cycle.pid"
	cycleTestAgentEnv   = "CYCLE_TEST_AGENT"
)

// runCycleTestAgent runs -mode agent's runAgent once, with no BrandBrain config, and returns its code.
func runCycleTestAgent() int {
	return runAgent(context.Background(), nil)
}

// runCycleTestRuntime is the runtime stand-in. It starts the cycle as its child, writes the cycle's
// pid where the test can read it, and waits. Its stdout is the summary file.
func runCycleTestRuntime() int {
	self, err := os.Executable()
	if err != nil {
		return 1
	}
	env := make([]string, 0, len(os.Environ())+1)
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, cycleTestRuntimeEnv+"=") {
			continue
		}
		env = append(env, kv)
	}
	env = append(env, cycleTestCycleEnv+"=1")
	out, err := os.Create(os.Getenv(cycleTestOutEnv))
	if err != nil {
		return 1
	}
	defer func() { _ = out.Close() }()
	cmd := exec.Command(self)
	cmd.Env = env
	cmd.Stdout = out
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return 1
	}
	dir := os.Getenv(cycleFakeChildEnv)
	_ = os.WriteFile(filepath.Join(dir, cycleTestPIDFile), []byte(strconv.Itoa(cmd.Process.Pid)), 0o644)
	_ = cmd.Wait()
	return 0
}

// runCycleTestCycle is the cycle. Its rounds are the fake children (crawl_cycle_fake_test.go), and its
// preflight edges are the production-free fakes below, so no Chrome, driver or ingest is touched.
func runCycleTestCycle() int {
	_ = os.Unsetenv(cycleTestCycleEnv)
	cfg := loadCycleConfig(os.Getenv)
	cfg.job = cycleJobDrain
	cfg.cycleID = "cyc-parent"
	deps := cycleDeps{
		driverPresent:   func() error { return nil },
		installDriver:   func() int { return 0 },
		ensureChrome:    func(context.Context) (string, int) { return "not_used", 0 },
		chromeReachable: func() string { return "not_used" },
		recoverChrome:   func() error { return nil },
		probeIngest:     func(context.Context) (int, string) { return 0, "ok" },
		warmcheck:       func(context.Context) int { return 0 },
		reportGap:       func(string, string, int) {},
		stdout:          os.Stdout,
		now:             time.Now,
	}
	return newCycleRunner(cfg, deps).execute()
}

// parentDeathRun starts the runtime stand-in for plan, waits for until (a predicate on the test's
// directory), SIGKILLs the stand-in, and waits for the cycle to exit. It returns the cycle's summary.
type parentDeathRun struct {
	dir     string
	out     string
	summary cycleSummary
	cycle   int
}

func runParentDeath(t *testing.T, plan []fakeStep, extraEnv []string, until func(dir string) bool) parentDeathRun {
	t.Helper()
	dir := t.TempDir()
	raw, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "plan.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	run := parentDeathRun{dir: dir, out: filepath.Join(dir, "summary.out")}
	lockDir := filepath.Join(t.TempDir(), "lockdir")

	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	env := []string{
		cycleTestRuntimeEnv + "=1",
		cycleTestOutEnv + "=" + run.out,
		cycleFakeChildEnv + "=" + dir,
		crawlLockDirEnv + "=" + lockDir,
		"CRAWL_HUNG_AFTER=10m",
	}
	env = append(env, extraEnv...)
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "CYCLE_") || strings.HasPrefix(kv, crawlLockDirEnv+"=") {
			continue
		}
		env = append(env, kv)
	}
	rt := exec.Command(self)
	rt.Env = env
	rt.Stderr = os.Stderr
	if err := rt.Start(); err != nil {
		t.Fatal(err)
	}
	reaped := make(chan struct{})
	go func() {
		_ = rt.Wait()
		close(reaped)
	}()
	t.Cleanup(func() {
		// Never leak a runtime, cycle or child, whatever the outcome: a cycle that outlived its test
		// (a failing assertion) is orphaned, so its pid is read from the file it wrote.
		_ = rt.Process.Kill()
		if b, err := os.ReadFile(filepath.Join(dir, cycleTestPIDFile)); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && pid > 0 {
				_ = syscall.Kill(pid, syscall.SIGKILL)
			}
		}
		for _, pid := range recordedPIDsIn(dir) {
			_ = syscall.Kill(-pid, syscall.SIGKILL)
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	})

	if !waitUntil(15*time.Second, func() bool {
		return until(dir) && fileExists(filepath.Join(dir, cycleTestPIDFile))
	}) {
		t.Fatalf("the round never reached the state the test waits for")
	}
	// Let the cycle act on the state (a cooldown begins a moment after the round's exit is read).
	time.Sleep(300 * time.Millisecond)
	// The runtime dies with no warning: SIGKILL, as a crash or a fleet upgrade would.
	if err := rt.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	<-reaped

	run.cycle = readPID(t, filepath.Join(dir, cycleTestPIDFile))
	waitGoneWithin(t, run.cycle, 20*time.Second)
	b, err := os.ReadFile(run.out)
	if err != nil {
		t.Fatalf("the cycle wrote no summary: %v", err)
	}
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("the cycle's stdout must be one summary line, got %d: %q", len(lines), string(b))
	}
	if err := json.Unmarshal([]byte(lines[0]), &run.summary); err != nil {
		t.Fatalf("summary is not JSON: %v (%q)", err, lines[0])
	}
	return run
}

func recordedPIDsIn(dir string) []int {
	var out []int
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		n := e.Name()
		if !strings.HasPrefix(n, "started-") && !strings.HasPrefix(n, "grandchild-") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, n))
		if err != nil {
			continue
		}
		if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && pid > 0 {
			out = append(out, pid)
		}
	}
	return out
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func waitUntil(d time.Duration, ok func() bool) bool {
	deadline := time.Now().Add(d)
	for {
		if ok() {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func waitGoneWithin(t *testing.T, pid int, d time.Duration) {
	t.Helper()
	if !waitUntil(d, func() bool { return !alive(pid) }) {
		t.Fatalf("the cycle (pid %d) is still running %s after its parent died", pid, d)
	}
}

// Killing the runtime during a round: the round finishes its suburb, the cycle exits 10 with a
// summary, and no new round starts.
func TestCycleParentDeathDuringARoundStopsAfterTheRoundAndStartsNothingNew(t *testing.T) {
	plan := []fakeStep{
		{Claims: 1, Fetches: 1, Hang: true, OnTerm: "count"},
		{Claims: 1, Processed: 1, Succeeded: 1, Exit: 0},
	}
	run := runParentDeath(t, plan, nil, func(dir string) bool { return fileExists(filepath.Join(dir, "started-0")) })

	if run.summary.ExitCode != exitCrawlCancelled || run.summary.Outcome != outCancelled {
		t.Fatalf("summary exit=%d outcome=%q, want 10 cancelled", run.summary.ExitCode, run.summary.Outcome)
	}
	if run.summary.Rounds != 1 {
		t.Fatalf("rounds = %d after the parent died: no new round may start", run.summary.Rounds)
	}
	if fileExists(filepath.Join(run.dir, "started-1")) {
		t.Fatalf("a second child was started after the parent died")
	}
	if n := countLinesFile(filepath.Join(run.dir, "terms.txt"), "TERM"); n != 1 {
		t.Fatalf("the round received %d graceful stops, want exactly 1", n)
	}
}

// Killing the runtime during a cooldown: the cooldown ends at once, the cycle exits 10, and the round
// that would have followed the cooldown never starts.
func TestCycleParentDeathDuringACooldownStartsNoRound(t *testing.T) {
	plan := []fakeStep{
		{Exit: 3},
		{Claims: 1, Processed: 1, Succeeded: 1, Exit: 0},
	}
	extra := []string{"CRAWL_REWARM_COOLDOWN_SEC=60"}
	run := runParentDeath(t, plan, extra, func(dir string) bool {
		// The round has exited with 3 and the cooldown is under way: give it a moment to begin.
		return fileExists(filepath.Join(dir, "done-0"))
	})
	if run.summary.ExitCode != exitCrawlCancelled {
		t.Fatalf("summary exit=%d, want 10 (the cooldown was cut short by the parent's death)", run.summary.ExitCode)
	}
	if fileExists(filepath.Join(run.dir, "started-1")) {
		t.Fatalf("the round after the cooldown started after the parent died")
	}
}

func countLinesFile(path, word string) int {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	return strings.Count(string(b), word)
}

// The cycle's own events fd breaks (its reader is gone): the cycle stops after the round in flight.
// A failing writer stands in for the broken pipe.
type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, syscall.EPIPE }

func TestCycleBrokenOwnEventsFdStopsTheCycle(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{
		{Claims: 1, Processed: 1, Succeeded: 1, Exit: 0},
		{Exit: 0},
	})
	h.deps.events = newCrawlEvents(failingWriter{})
	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != exitCrawlCancelled || s.Outcome != outCancelled || s.Rounds != 1 {
		t.Fatalf("exit=%d outcome=%q rounds=%d, want 10 cancelled after 1 round when the events fd is broken", code, s.Outcome, s.Rounds)
	}
}
