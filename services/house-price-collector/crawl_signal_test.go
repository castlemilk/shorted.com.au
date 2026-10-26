package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
)

const sigpipeHelperEnv = "CRAWL_SIGPIPE_HELPER"

// TestSIGPIPEHelperProcess is the child for TestSIGPIPESurvivesDeadPipeReader. It
// does nothing unless the env is set.
func TestSIGPIPEHelperProcess(t *testing.T) {
	if os.Getenv(sigpipeHelperEnv) == "" {
		t.Skip("helper process only")
	}
	sigs := make(chan os.Signal, 2)
	remove := installRoundSignals(newStopSignal(), nil, sigs, os.Exit)
	defer remove()
	// stderr's reader has gone (`| tee` died). Without SIGPIPE ignored, the first
	// write raises SIGPIPE and this process dies before printing SURVIVED.
	for i := 0; i < 50; i++ {
		_, _ = fmt.Fprintln(os.Stderr, "log line after the reader closed")
	}
	_, _ = fmt.Fprintln(os.Stdout, "SURVIVED")
	os.Exit(0)
}

// A process whose stderr reader has gone must not die of SIGPIPE: the writes fail
// with EPIPE and the round carries on. This is the `| tee` pipeline shape.
func TestSIGPIPESurvivesDeadPipeReader(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	pr, pw, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	_ = pr.Close() // the reader is gone before the child writes

	var stdout bytes.Buffer
	cmd := exec.Command(self, "-test.run=^TestSIGPIPEHelperProcess$", "-test.count=1")
	cmd.Env = append(os.Environ(), sigpipeHelperEnv+"=1")
	cmd.Stdout = &stdout
	cmd.Stderr = pw
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	_ = pw.Close()
	waitErr := cmd.Wait()
	if waitErr != nil {
		t.Fatalf("helper died (SIGPIPE not ignored?): %v\nstdout:\n%s", waitErr, stdout.String())
	}
	if !bytes.Contains(stdout.Bytes(), []byte("SURVIVED")) {
		t.Fatalf("helper did not reach its end:\n%s", stdout.String())
	}
}

// The second signal releases the lock BEFORE it exits, so the next run does not have
// to reclaim it. Driven through installRoundSignals, the same path runAgentRound uses.
func TestSecondSignalReleasesLockBeforeExit(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sig.lockdir")
	lock := newTestLock(dir)
	if outcome, _, err := lock.acquire(); outcome != lockAcquired || err != nil {
		t.Fatalf("acquire: %v %v", outcome, err)
	}

	type exitInfo struct {
		code        int
		lockExisted bool
	}
	exited := make(chan exitInfo, 1)
	stop := newStopSignal()
	sigs := make(chan os.Signal, 2)
	remove := installRoundSignals(stop, lock, sigs, func(c int) {
		exited <- exitInfo{code: c, lockExisted: exists(dir)}
	})
	defer remove()

	sigs <- syscall.SIGTERM
	sigs <- syscall.SIGTERM
	got := <-exited
	if got.code != exitCrawlCancelled {
		t.Fatalf("second signal exit code = %d, want %d", got.code, exitCrawlCancelled)
	}
	if got.lockExisted {
		t.Fatal("the second signal must release the lock before exiting")
	}
}

// startParentPID must be the real parent at process start, read before the lock and
// the Chrome warm-up, not a value read later.
func TestStartParentPIDCapturedAtStart(t *testing.T) {
	t.Parallel()
	if startParentPID != os.Getppid() {
		t.Fatalf("startParentPID = %d, want the process parent %d", startParentPID, os.Getppid())
	}
}
