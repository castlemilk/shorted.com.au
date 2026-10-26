package main

import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

// The single-drainer lock. It MUST match hc_acquire_lock / hc_release_lock in
// deploy/housing-crawl-common.sh exactly, so a Go holder and a bash holder exclude
// each other:
//
//   - the lock is the directory <lockdir> (default $HOME/.shorted-housing-crawl.lockdir,
//     or $HOUSING_CRAWL_LOCKDIR), created with mkdir, which is atomic;
//   - the holder's PID is written to <lockdir>/pid;
//   - a held lock whose PID is not alive (kill -0 fails) is stale and is reclaimed;
//   - release removes <lockdir>/pid and then rmdirs <lockdir>, only if we own it.
//
// Two deliberate differences, both on the Go side only:
//   - an UNREADABLE pid file is re-read once after a short grace before it counts
//     as stale. A holder creates the directory and then writes the pid, so a racing
//     process can briefly see a directory with no pid. Reclaiming in that window
//     would remove a live lock. Bash has the same window, which is not closed here.
//   - Go reclaims a stale lock exactly once per acquire, not up to twice as bash does.

// exitLockHeld is the `-mode agent` exit code when another live process holds the
// lock. Nothing is claimed. The drain wrapper never hits this under normal operation
// (the wrapper holds the lock and runs us as its child), so it means a second drainer.
const exitLockHeld = 12

const (
	crawlLockDirEnv  = "HOUSING_CRAWL_LOCKDIR"
	crawlLockDirName = ".shorted-housing-crawl.lockdir"
	crawlLockPidName = "pid"
	// crawlLockGrace is how long an unreadable pid file gets before it is stale.
	crawlLockGrace = 150 * time.Millisecond
)

type lockOutcome int

const (
	// lockHeld: a different live process holds the lock. Claim nothing.
	lockHeld lockOutcome = iota
	// lockAcquired: this process took the lock and must release it.
	lockAcquired
	// lockPassthrough: our parent holds the lock (the bash wrapper, or a future
	// -mode cycle round). Run without taking it, and do not release it.
	lockPassthrough
)

// crawlLock is one acquirer. The fields other than dir are injectable for tests.
type crawlLock struct {
	dir    string
	self   int
	parent int
	alive  func(pid int) bool
	grace  time.Duration
	// onReclaim is a test hook, called after a stale lock has been removed and
	// before the retry. Production leaves it nil.
	onReclaim func()
	owned     bool
}

// defaultCrawlLockDir is the bash lockdir path: $HOUSING_CRAWL_LOCKDIR, else
// $HOME/.shorted-housing-crawl.lockdir.
func defaultCrawlLockDir() string {
	if v := os.Getenv(crawlLockDirEnv); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, crawlLockDirName)
}

// newCrawlLock uses the real process identity: self is this PID, parent is the
// PID of whoever launched us, and alive is kill -0.
func newCrawlLock(dir string) *crawlLock {
	return &crawlLock{
		dir:    dir,
		self:   os.Getpid(),
		parent: os.Getppid(),
		alive:  pidAlive,
		grace:  crawlLockGrace,
	}
}

func newCrawlLockFromEnv() *crawlLock {
	return newCrawlLock(defaultCrawlLockDir())
}

// pidAlive mirrors `kill -0 <pid> 2>/dev/null` in bash: alive means the signal
// succeeded. EPERM is not alive, the same as in bash.
func pidAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

func (l *crawlLock) pidPath() string {
	return filepath.Join(l.dir, crawlLockPidName)
}

// acquire takes the lock. The holder PID is returned for logging (0 when unknown).
// It never blocks beyond the grace period.
func (l *crawlLock) acquire() (lockOutcome, int, error) {
	acquired, err := l.mkdirOwn()
	if err != nil {
		return lockHeld, 0, err
	}
	if acquired {
		return lockAcquired, l.self, nil
	}
	if holder, live := l.liveHolder(); live {
		return l.classifyBlocked(holder)
	}

	// Stale: reclaim exactly once, then retry the acquire. A second failure is a
	// race another process won, so we do not loop.
	l.reclaim()
	if l.onReclaim != nil {
		l.onReclaim()
	}
	acquired, err = l.mkdirOwn()
	if err != nil {
		return lockHeld, 0, err
	}
	if acquired {
		return lockAcquired, l.self, nil
	}
	if holder, live := l.liveHolder(); live {
		return l.classifyBlocked(holder)
	}
	return lockHeld, 0, errors.New("lost the reclaim race: lock dir exists without a live holder")
}

// classifyBlocked reports the parent passthrough when the live holder is our parent.
func (l *crawlLock) classifyBlocked(holder int) (lockOutcome, int, error) {
	if holder == l.parent {
		return lockPassthrough, holder, nil
	}
	return lockHeld, holder, nil
}

// mkdirOwn returns true when this call created the directory and wrote our pid.
// It returns false when the directory already exists.
func (l *crawlLock) mkdirOwn() (bool, error) {
	if err := os.Mkdir(l.dir, 0o755); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return false, nil
		}
		return false, fmt.Errorf("create lock dir %s: %w", l.dir, err)
	}
	if err := os.WriteFile(l.pidPath(), []byte(strconv.Itoa(l.self)+"\n"), 0o644); err != nil {
		_ = os.Remove(l.pidPath())
		_ = os.Remove(l.dir)
		return false, fmt.Errorf("write lock pid: %w", err)
	}
	l.owned = true
	return true, nil
}

// liveHolder reads the holder and reports whether it is alive. An unreadable pid
// gets one grace re-read before it counts as stale (see the file comment).
func (l *crawlLock) liveHolder() (int, bool) {
	pid, ok := readPidFile(l.pidPath())
	if !ok && l.grace > 0 {
		time.Sleep(l.grace)
		pid, ok = readPidFile(l.pidPath())
	}
	if !ok {
		return 0, false
	}
	return pid, l.alive(pid)
}

// reclaim removes a stale lock the way bash does: the pid file, then the directory.
func (l *crawlLock) reclaim() {
	log.Printf("[agent] reclaiming stale housing-crawl lock at %s (holder not alive)", l.dir)
	_ = os.Remove(l.pidPath())
	_ = os.Remove(l.dir)
}

// release removes the lock if and only if we own it. A passthrough or held
// acquirer never does.
func (l *crawlLock) release() {
	if !l.owned {
		return
	}
	_ = os.Remove(l.pidPath())
	_ = os.Remove(l.dir)
	l.owned = false
}

// readPidFile returns the digits in the file as a PID. It mirrors bash's
// `tr -dc '0-9'`, so trailing newlines and stray characters are dropped.
func readPidFile(path string) (int, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	digits := make([]byte, 0, len(b))
	for _, c := range b {
		if c >= '0' && c <= '9' {
			digits = append(digits, c)
		}
	}
	if len(digits) == 0 {
		return 0, false
	}
	pid, err := strconv.Atoi(string(digits))
	if err != nil {
		return 0, false
	}
	return pid, true
}

// withCrawlLock runs fn under the single-drainer lock and returns fn's exit code.
// A held lock returns exitLockHeld without calling fn. A passthrough runs fn
// without the lock. An acquired lock is released when fn returns or panics.
func withCrawlLock(l *crawlLock, fn func() int) int {
	outcome, holder, err := l.acquire()
	switch outcome {
	case lockHeld:
		if err != nil {
			log.Printf("[agent] skipped: cannot take the housing-crawl lock at %s (%v) — claiming nothing (exit %d)", l.dir, err, exitLockHeld)
		} else {
			log.Printf("[agent] skipped: lock held by pid %d (%s) — another housing crawl is draining; claiming nothing (exit %d)", holder, l.dir, exitLockHeld)
		}
		return exitLockHeld
	case lockPassthrough:
		log.Printf("[agent] lock held by parent pid %d — running as its child, not taking the lock", holder)
		return fn()
	default:
		defer l.release()
		return fn()
	}
}
