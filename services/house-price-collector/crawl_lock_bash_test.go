package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// These tests run the REAL hc_acquire_lock from deploy/housing-crawl-common.sh
// in bash, against a lockdir in a temp directory, and check it excludes (and is
// excluded by) the Go lock. They skip cleanly when bash is not present.

const lockHelperEnv = "CRAWL_LOCK_HELPER"

func requireBashCommon(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not found; skipping the cross-language lock test")
	}
	common, err := filepath.Abs(filepath.Join("deploy", "housing-crawl-common.sh"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(common); err != nil {
		t.Fatalf("housing-crawl-common.sh not found: %v", err)
	}
	return common
}

func bashLockEnv(lockDir, logPath string) []string {
	return append(os.Environ(), "HOUSING_CRAWL_LOCKDIR="+lockDir, "LOG="+logPath)
}

// bashHolder starts a bash process that takes the lock with hc_acquire_lock and
// keeps it until its stdin closes. The EXIT trap then releases the lock.
func bashHolder(t *testing.T, common, lockDir string) (*exec.Cmd, *bufio.Reader) {
	t.Helper()
	cmd := exec.Command("bash", "-c", `set -u; source "$1"; hc_acquire_lock; echo ACQUIRED; read -r _ || true`, "bash", common)
	cmd.Env = bashLockEnv(lockDir, filepath.Join(t.TempDir(), "holder.log"))
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = stdin.Close()
		_ = cmd.Wait()
	})
	reader := bufio.NewReader(stdout)
	line, err := reader.ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "ACQUIRED" {
		t.Fatalf("bash holder did not acquire the lock: %q (%v)", line, err)
	}
	return cmd, reader
}

func TestCrossLanguageBashHolderExcludesGo(t *testing.T) {
	common := requireBashCommon(t)
	lockDir := filepath.Join(t.TempDir(), "shared.lockdir")
	cmd, _ := bashHolder(t, common, lockDir)

	l := newCrawlLock(lockDir)
	l.grace = 0
	l.parent = 1 // the bash holder is not our parent: a second drainer
	outcome, holder, err := l.acquire()
	if err != nil || outcome != lockHeld {
		t.Fatalf("Go acquirer vs bash holder: outcome=%v err=%v, want lockHeld", outcome, err)
	}
	if holder != cmd.Process.Pid {
		t.Fatalf("Go saw holder pid %d, want the bash pid %d", holder, cmd.Process.Pid)
	}
}

func TestCrossLanguageGoHolderMakesBashSkip(t *testing.T) {
	common := requireBashCommon(t)
	lockDir := filepath.Join(t.TempDir(), "shared.lockdir")

	l := newCrawlLock(lockDir)
	l.grace = 0
	if outcome, _, err := l.acquire(); err != nil || outcome != lockAcquired {
		t.Fatalf("Go acquire: outcome=%v err=%v", outcome, err)
	}
	defer l.release()

	// bash's skip is `exit 0` and a log line that names the holder (LOG is the
	// log file hc_acquire_lock appends to).
	logPath := filepath.Join(t.TempDir(), "bash.log")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "bash", "-c", `set -u; source "$1"; hc_acquire_lock; echo ACQUIRED`, "bash", common)
	cmd.Env = bashLockEnv(lockDir, logPath)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("bash should skip cleanly (exit 0), got %v: %s", err, out)
	}
	if strings.Contains(string(out), "ACQUIRED") {
		t.Fatalf("bash acquired a lock that Go holds:\n%s", out)
	}
	logged, _ := os.ReadFile(logPath)
	if !strings.Contains(string(logged), "holds the lock (pid") {
		t.Fatalf("bash skip must log the holder, got %q", logged)
	}
	if !exists(lockDir) {
		t.Fatal("bash must not reclaim or remove a live Go lock")
	}
}

// Stale reclaim across languages: bash reclaims a stale lock that Go planted, and
// the Go side then takes the lock.
func TestCrossLanguageBashReclaimsStaleGoLock(t *testing.T) {
	common := requireBashCommon(t)
	lockDir := filepath.Join(t.TempDir(), "shared.lockdir")
	writePid(t, lockDir, deadPID(t))

	logPath := filepath.Join(t.TempDir(), "bash.log")
	cmd := exec.Command("bash", "-c", `set -u; source "$1"; hc_acquire_lock; echo ACQUIRED`, "bash", common)
	cmd.Env = bashLockEnv(lockDir, logPath)
	out, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(out), "ACQUIRED") {
		t.Fatalf("bash should reclaim the stale lock: %v\n%s", err, out)
	}
	logged, _ := os.ReadFile(logPath)
	if !strings.Contains(string(logged), "reclaiming stale housing-crawl lock") {
		t.Fatalf("bash reclaim not logged: %q", logged)
	}
	if exists(lockDir) {
		t.Fatal("bash's EXIT trap must release the lock it took")
	}
}

// The wrapper's real shape: bash holds the lock and runs the Go binary as a child
// in a pipeline (`"$BIN" -mode agent 2>&1 | tee ...`). The child must see the bash
// process as its parent and run as a passthrough. This test binary is the child.
func TestCrossLanguageBashPipelineChildIsPassthrough(t *testing.T) {
	common := requireBashCommon(t)
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	lockDir := filepath.Join(t.TempDir(), "shared.lockdir")

	script := `set -u; source "$1"; hc_acquire_lock; "$2" -test.run='^TestCrawlLockPassthroughHelper$' -test.count=1 2>&1 | cat`
	cmd := exec.Command("bash", "-c", script, "bash", common, self)
	cmd.Env = append(bashLockEnv(lockDir, filepath.Join(t.TempDir(), "bash.log")), lockHelperEnv+"=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("wrapper pipeline: %v\n%s", err, out)
	}
	want := fmt.Sprintf("CRAWL_LOCK_OUTCOME=%d", lockPassthrough)
	if !strings.Contains(string(out), want) {
		t.Fatalf("the Go child under a bash pipeline must be a passthrough (%s), got:\n%s", want, out)
	}
	if exists(lockDir) {
		t.Fatal("bash released its lock on exit; the child must not have touched it")
	}
}

// TestCrawlLockPassthroughHelper is the child process for the pipeline test above.
// It does nothing unless CRAWL_LOCK_HELPER is set.
func TestCrawlLockPassthroughHelper(t *testing.T) {
	if os.Getenv(lockHelperEnv) == "" {
		t.Skip("helper process only")
	}
	l := newCrawlLockFromEnv()
	outcome, _, err := l.acquire()
	fmt.Printf("CRAWL_LOCK_OUTCOME=%d err=%v\n", outcome, err)
	if outcome == lockAcquired {
		l.release()
	}
}
