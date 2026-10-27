package main

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// A cycle stuck behind another installer must exit 8 from the install-lock wait, not let its install step
// reach its own deadline and read as hung (11). The lock is held by another installer for the whole test.
func TestCycleInstallLockWaitExitsEightNotHung(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "pw-driver")
	t.Setenv("CRAWL_PW_DRIVER_DIR", dir)
	f, err := os.OpenFile(dir+".install.lock", os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }()

	h := newCycleHarness(t, []fakeStep{{Exit: 0}})
	h.driverFail = 99
	h.cfg.installTimeout = 5 * time.Second
	h.cfg.installLockWait = 300 * time.Millisecond
	h.deps.installDriver = func() int { return runInstallDriverWait(false, h.cfg.installLockWait) }
	code := h.runGuarded(20 * time.Second)
	s := h.summary()
	if code != exitCrawlEnvBroken || s.ExitCode != exitCrawlEnvBroken {
		t.Fatalf("exit=%d outcome=%q, want 8: a lock wait that runs out inside the cycle is env_broken, not hung (11)", code, s.Outcome)
	}
}

// The cycle's configured lock wait is always below its install step's timeout.
func TestCycleLockWaitIsBelowTheInstallTimeout(t *testing.T) {
	cfg := loadCycleConfig(func(string) string { return "" })
	if cfg.installLockWait >= cfg.installTimeout {
		t.Fatalf("lock wait %s must be below the install timeout %s", cfg.installLockWait, cfg.installTimeout)
	}
	if cfg.installLockWait != cfg.installTimeout-installLockMargin {
		t.Fatalf("lock wait = %s, want the install timeout less the margin", cfg.installLockWait)
	}
}
