package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"
)

// newTestLock is a lock for this process. Its parent is the real parent, so a
// test that wants the passthrough case sets parent explicitly.
func newTestLock(dir string) *crawlLock {
	l := newCrawlLock(dir)
	l.grace = 0
	return l
}

func writePid(t *testing.T, dir string, pid int) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "pid"), []byte(strconv.Itoa(pid)+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// deadPID returns a PID that is certainly not alive: a child we started and reaped.
func deadPID(t *testing.T) int {
	t.Helper()
	cmd := exec.Command("true")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	return cmd.Process.Pid
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func TestCrawlLockAcquireAndRelease(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "x.lockdir")
	l := newTestLock(dir)
	outcome, holder, err := l.acquire()
	if err != nil || outcome != lockAcquired || holder != os.Getpid() {
		t.Fatalf("acquire = (%v, %d, %v), want lockAcquired for this pid", outcome, holder, err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "pid"))
	if string(b) != strconv.Itoa(os.Getpid())+"\n" {
		t.Fatalf("pid file = %q, want the bash format (pid + newline)", b)
	}
	l.release()
	if exists(dir) {
		t.Fatal("release must remove the pid file and the lock directory")
	}
}

func TestCrawlLockMutualExclusionBetweenGoAcquirers(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "x.lockdir")
	first := newTestLock(dir)
	if outcome, _, _ := first.acquire(); outcome != lockAcquired {
		t.Fatal("first acquirer must take the lock")
	}
	second := newTestLock(dir)
	outcome, holder, err := second.acquire()
	if err != nil || outcome != lockHeld || holder != os.Getpid() {
		t.Fatalf("second acquirer = (%v, %d, %v), want lockHeld by this pid", outcome, holder, err)
	}
	if second.owned {
		t.Fatal("a refused acquirer must not own the lock")
	}
	second.release()
	if !exists(dir) {
		t.Fatal("a refused acquirer's release must not remove the holder's lock")
	}
	first.release()
	if outcome, _, _ := second.acquire(); outcome != lockAcquired {
		t.Fatal("after the holder releases, the next acquirer must take it")
	}
}

// Eight acquirers race for one lock. Exactly one must win each round.
func TestCrawlLockRaceHasExactlyOneWinner(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "x.lockdir")
	for round := 0; round < 3; round++ {
		var wg sync.WaitGroup
		var mu sync.Mutex
		winners := 0
		locks := make([]*crawlLock, 8)
		for i := range locks {
			locks[i] = newCrawlLock(dir)
		}
		for _, l := range locks {
			wg.Add(1)
			go func(l *crawlLock) {
				defer wg.Done()
				if outcome, _, _ := l.acquire(); outcome == lockAcquired {
					mu.Lock()
					winners++
					mu.Unlock()
				}
			}(l)
		}
		wg.Wait()
		if winners != 1 {
			t.Fatalf("round %d: %d winners, want exactly 1", round, winners)
		}
		for _, l := range locks {
			l.release()
		}
		if exists(dir) {
			t.Fatalf("round %d: the winner's release left the lock behind", round)
		}
	}
}

// A stale lock (its holder is dead) is reclaimed once, and the acquire then succeeds.
func TestCrawlLockStaleReclaimHappensOnce(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "x.lockdir")
	writePid(t, dir, deadPID(t))
	reclaims := 0
	l := newTestLock(dir)
	l.onReclaim = func() { reclaims++ }
	outcome, _, err := l.acquire()
	if err != nil || outcome != lockAcquired {
		t.Fatalf("stale lock: acquire = (%v, %v), want lockAcquired", outcome, err)
	}
	if reclaims != 1 {
		t.Fatalf("stale reclaim ran %d times, want exactly 1", reclaims)
	}
	l.release()
}

// If the stale lock reappears right after the reclaim (another process won the
// race), the acquire must refuse. It must not reclaim a second time.
func TestCrawlLockStaleReclaimExactlyOnceThenRefuses(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "x.lockdir")
	dead := deadPID(t)
	writePid(t, dir, dead)
	reclaims := 0
	l := newTestLock(dir)
	l.onReclaim = func() {
		reclaims++
		writePid(t, dir, dead)
	}
	outcome, _, err := l.acquire()
	if outcome != lockHeld || err == nil {
		t.Fatalf("acquire = (%v, %v), want lockHeld with an error after the lost race", outcome, err)
	}
	if reclaims != 1 {
		t.Fatalf("reclaims = %d, want exactly 1", reclaims)
	}
}

// The parent holds the lock (the bash wrapper, or a -mode cycle round). The child
// runs as a passthrough, takes nothing and releases nothing.
func TestCrawlLockParentHolderPassthrough(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "x.lockdir")
	writePid(t, dir, os.Getpid())
	l := newTestLock(dir)
	l.parent = os.Getpid()
	outcome, holder, err := l.acquire()
	if err != nil || outcome != lockPassthrough || holder != os.Getpid() {
		t.Fatalf("parent holder: acquire = (%v, %d, %v), want lockPassthrough", outcome, holder, err)
	}
	ran := false
	code := withCrawlLock(l, func() int { ran = true; return 0 })
	if !ran || code != 0 {
		t.Fatalf("passthrough must run the round: ran=%v code=%d", ran, code)
	}
	l.release()
	if !exists(dir) {
		t.Fatal("a passthrough must never remove the parent's lock")
	}
}

// A live holder that is not our parent is a second drainer: claim nothing, exit 12.
func TestCrawlLockHeldByOtherLiveProcessExits12(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "x.lockdir")
	writePid(t, dir, os.Getpid())
	l := newTestLock(dir)
	l.parent = 1
	ran := false
	if code := withCrawlLock(l, func() int { ran = true; return 0 }); code != exitLockHeld {
		t.Fatalf("held lock: code = %d, want %d", code, exitLockHeld)
	}
	if ran {
		t.Fatal("a held lock must claim nothing")
	}
	if exitLockHeld != 12 {
		t.Fatalf("exitLockHeld = %d, the documented code is 12", exitLockHeld)
	}
}

// Release happens when the round panics. The panic still propagates to the caller.
func TestCrawlLockReleasedOnPanic(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "x.lockdir")
	l := newTestLock(dir)
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("the panic must propagate")
			}
		}()
		withCrawlLock(l, func() int { panic("boom") })
	}()
	if exists(dir) {
		t.Fatal("a panicking round must release the lock")
	}
}

// Release happens on the error exit path too (a non-zero return from the round).
func TestCrawlLockReleasedOnErrorExit(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "x.lockdir")
	l := newTestLock(dir)
	if code := withCrawlLock(l, func() int { return 7 }); code != 7 {
		t.Fatalf("code = %d, want 7 passed through", code)
	}
	if exists(dir) {
		t.Fatal("an error exit must release the lock")
	}
}

// bash creates the directory and writes the pid a moment later. A racing Go acquirer
// must give that a grace period rather than reclaim a live lock.
func TestCrawlLockUnreadablePidGetsAGrace(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "x.lockdir")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(40 * time.Millisecond)
		_ = os.WriteFile(filepath.Join(dir, "pid"), []byte(strconv.Itoa(os.Getpid())+"\n"), 0o644)
	}()
	l := newCrawlLock(dir)
	l.grace = time.Second // the pid is written after 40ms; a 1s grace leaves 25x headroom
	outcome, _, _ := l.acquire()
	if outcome != lockHeld {
		t.Fatalf("a lock whose pid appears within the grace must be respected, got %v", outcome)
	}
}

func TestReadPidFileMatchesBashTr(t *testing.T) {
	t.Parallel()
	for in, want := range map[string]int{"123\n": 123, " 4 5\n": 45, "7": 7} {
		path := filepath.Join(t.TempDir(), "pid")
		if err := os.WriteFile(path, []byte(in), 0o644); err != nil {
			t.Fatal(err)
		}
		got, ok := readPidFile(path)
		if !ok || got != want {
			t.Fatalf("readPidFile(%q) = (%d, %v), want %d", in, got, ok, want)
		}
	}
	bad := filepath.Join(t.TempDir(), "pid")
	_ = os.WriteFile(bad, []byte("none\n"), 0o644)
	if _, ok := readPidFile(bad); ok {
		t.Fatal("a pid file with no digits is unreadable")
	}
}

func TestDefaultCrawlLockDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv(crawlLockDirEnv, "")
	if got, want := defaultCrawlLockDir(), filepath.Join(home, ".shorted-housing-crawl.lockdir"); got != want {
		t.Fatalf("default lockdir = %q, want %q", got, want)
	}
	t.Setenv(crawlLockDirEnv, "/tmp/override.lockdir")
	if got := defaultCrawlLockDir(); got != "/tmp/override.lockdir" {
		t.Fatalf("HOUSING_CRAWL_LOCKDIR override ignored: %q", got)
	}
}
