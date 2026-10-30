package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

// The deterministic double-reclaim interleaving. A and B both observe the same dead
// pid. A is paused after it judged the pid stale; B reclaims and takes the lock. A
// then re-reads the pid, sees B's, and must back off. Only one may end up holding.
func TestCrawlLockDoubleReclaimOnlyOneHolds(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "x.lockdir")
	writePid(t, dir, deadPID(t))

	b := newTestLock(dir)
	b.self = os.Getppid() // alive, and not us
	b.parent = 1

	a := newTestLock(dir)
	a.parent = 1
	var bOutcome lockOutcome = -1
	a.beforeReclaim = func() {
		bOutcome, _, _ = b.acquire()
	}

	aOutcome, _, err := a.acquire()
	if bOutcome != lockAcquired {
		t.Fatalf("B must take the stale lock during A's pause, got %v", bOutcome)
	}
	if aOutcome != lockHeld || err == nil {
		t.Fatalf("A must back off once the pid changed under its reclaim: outcome=%v err=%v", aOutcome, err)
	}
	if got := readPidOrFail(t, dir); got != b.self {
		t.Fatalf("the lock must still name B (%d), got pid %d", b.self, got)
	}

	// A's release must not touch B's lock. A is marked as a former owner (it held
	// the lock before it was taken over), so release reaches the ownership check
	// instead of returning early because A never acquired.
	a.owned = true
	a.release()
	if !exists(dir) {
		t.Fatal("A.release() deleted B's lock")
	}
	b.release()
	if exists(dir) {
		t.Fatal("B.release() must remove its own lock")
	}
}

// release removes the lock only while the pid still names us. A takeover that wrote
// another live pid must be left alone.
func TestCrawlLockReleaseLeavesTakenOverLock(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "x.lockdir")
	a := newTestLock(dir)
	if outcome, _, _ := a.acquire(); outcome != lockAcquired {
		t.Fatal("A must acquire")
	}
	other := os.Getppid()
	writePid(t, dir, other)
	a.release()
	if !exists(dir) {
		t.Fatal("release removed a lock that now names another pid")
	}
	if got := readPidOrFail(t, dir); got != other {
		t.Fatalf("pid = %d, want the takeover pid %d", got, other)
	}
}

// A mkdir failure other than "exists" is an infrastructure fault: lockError, and the
// round exits 7 without running. It is not a second drainer (exit 12).
func TestCrawlLockMkdirErrorIsInfraNotExit12(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "missing-parent", "x.lockdir")
	l := newTestLock(dir)
	outcome, _, err := l.acquire()
	if outcome != lockError || err == nil {
		t.Fatalf("a missing parent must be lockError with an error, got %v (%v)", outcome, err)
	}
	ran := false
	if code := withCrawlLock(newTestLock(dir), func() int { ran = true; return 0 }); code != exitAgentInfra {
		t.Fatalf("code = %d, want %d", code, exitAgentInfra)
	}
	if ran {
		t.Fatal("a lock error must claim nothing")
	}
}

// runAgent itself must refuse to run the round while another live drainer holds the
// lock, and must claim nothing. This drives the production entry point, so a
// refactor that bypasses withCrawlLock fails here, not only in withCrawlLock's test.
func TestRunAgentHeldLockExits12AndClaimsNothing(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	lockDir := filepath.Join(t.TempDir(), "held.lockdir")
	writePid(t, lockDir, os.Getpid())
	t.Setenv(crawlLockDirEnv, lockDir)

	var claims atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		claims.Add(1)
		http.Error(w, "claim refused in test", http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("BRANDBRAIN_AGENT_URL", srv.URL)
	t.Setenv("BRANDBRAIN_AGENT_TOKEN", "test-token")
	t.Setenv("BRANDBRAIN_CONTROL_PORT", "")
	t.Setenv("BRANDBRAIN_CONTROL_SECRET", "")

	isolateCircuitState(t)
	if got := runAgent(context.Background(), nil); got != exitLockHeld {
		t.Fatalf("runAgent with a live foreign holder = %d, want %d", got, exitLockHeld)
	}
	if n := claims.Load(); n != 0 {
		t.Fatalf("runAgent claimed %d job(s) while the lock was held", n)
	}
	if !exists(lockDir) {
		t.Fatal("runAgent must not touch another drainer's lock")
	}
}

// Bash release: a lock taken over by another pid is not removed by the bash EXIT trap.
func TestCrossLanguageBashReleaseLeavesTakenOverLock(t *testing.T) {
	common := requireBashCommon(t)
	lockDir := filepath.Join(t.TempDir(), "shared.lockdir")
	other := os.Getppid()
	script := `set -u; source "$1"; hc_acquire_lock; echo "$2" >"$HC_LOCK_DIR/pid"; echo ACQUIRED`
	cmd := exec.Command("bash", "-c", script, "bash", common, strconv.Itoa(other))
	cmd.Env = bashLockEnv(lockDir, filepath.Join(t.TempDir(), "bash.log"))
	out, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(out), "ACQUIRED") {
		t.Fatalf("bash acquire: %v\n%s", err, out)
	}
	if !exists(lockDir) {
		t.Fatal("bash's EXIT trap removed a lock that names another pid")
	}
	if got := readPidOrFail(t, lockDir); got != other {
		t.Fatalf("pid = %d, want %d", got, other)
	}
}

// Bash reclaim abort: the pid changes between the stale judgement and the re-read.
// bash must skip (exit 0) and leave the new holder's lock alone.
func TestCrossLanguageBashReclaimAbortsWhenPidChanged(t *testing.T) {
	common := requireBashCommon(t)
	lockDir := filepath.Join(t.TempDir(), "shared.lockdir")
	writePid(t, lockDir, deadPID(t))
	other := os.Getppid()
	logPath := filepath.Join(t.TempDir(), "bash.log")
	script := `set -u; source "$1"; other="$2"; hc_lock_before_reclaim() { echo "$other" >"$HC_LOCK_DIR/pid"; }; hc_acquire_lock; echo ACQUIRED`
	cmd := exec.Command("bash", "-c", script, "bash", common, strconv.Itoa(other))
	cmd.Env = bashLockEnv(lockDir, logPath)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("bash must skip cleanly on a changed pid, got %v\n%s", err, out)
	}
	if strings.Contains(string(out), "ACQUIRED") {
		t.Fatalf("bash reclaimed a lock whose pid changed:\n%s", out)
	}
	logged, _ := os.ReadFile(logPath)
	if !strings.Contains(string(logged), "changed during reclaim") {
		t.Fatalf("the abort must be logged, got %q", logged)
	}
	if got := readPidOrFail(t, lockDir); got != other {
		t.Fatalf("pid = %d, want the new holder %d", got, other)
	}
}

func readPidOrFail(t *testing.T, dir string) int {
	t.Helper()
	pid, ok := readPidFile(filepath.Join(dir, "pid"))
	if !ok {
		t.Fatalf("pid file in %s is unreadable", dir)
	}
	return pid
}
