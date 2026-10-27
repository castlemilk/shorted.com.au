package main

// crawl_driver_atomic_test.go tests the atomic driver install (N1). The install is interrupted for real:
// a child process runs installDriverAtomic with a stub installer that writes a partial driver and then
// stalls, the way a stalled download does. The test kills the child mid-write. The stub installer is
// injected because playwright-go's download host is not configurable, so no HTTP stub registry can
// be pointed at it; the atomic logic is what is under test, and the real installer is called only by
// -mode install-driver.

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	driverInstallDirEnv = "CYCLE_TEST_INSTALL_DIR"
	driverMarkerEnv     = "CYCLE_TEST_MARKER"
)

// stubCompleteInstall writes a driver that verifies: an executable node that runs, and cli.js. It
// also writes a version file, so a test can tell which install is live.
func stubCompleteInstall(dir string) error {
	if err := os.MkdirAll(filepath.Join(dir, "package"), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "node"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "package", "cli.js"), []byte("// stub\n"), 0o644); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "version"), []byte("v1"), 0o644)
}

// stubNoNodeInstall writes cli.js and no node: an install that cannot verify.
func stubNoNodeInstall(dir string) error {
	if err := os.MkdirAll(filepath.Join(dir, "package"), 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "package", "cli.js"), []byte("// stub\n"), 0o644)
}

// stubStallInstall writes a partial driver, signals the test through the marker file, and stalls, as
// a stalled download does. Only a kill ends it.
func stubStallInstall(dir string) error {
	if err := os.MkdirAll(filepath.Join(dir, "package"), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "package", "cli.js"), []byte("// partial\n"), 0o644); err != nil {
		return err
	}
	if marker := os.Getenv(driverMarkerEnv); marker != "" {
		_ = os.WriteFile(marker, []byte("1"), 0o644)
	}
	time.Sleep(time.Hour)
	return nil
}

// runDriverInstallChild is the subprocess body (testmain_test.go). It returns the exit code.
func runDriverInstallChild() int {
	if err := installDriverAtomic(os.Getenv(driverInstallDirEnv), stubStallInstall); err != nil {
		return 1
	}
	return 0
}

// killAtStalledInstall starts an install that stalls mid-write in dir, waits for it to reach the
// stall, and kills it there.
func killAtStalledInstall(t *testing.T, dir string) {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "marker")
	cmd := exec.Command(self)
	cmd.Env = append(os.Environ(), "CYCLE_TEST_INSTALL=1", driverInstallDirEnv+"="+dir, driverMarkerEnv+"="+marker)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	reaped := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(reaped)
	}()
	if !waitUntil(15*time.Second, func() bool { return fileExists(marker) }) {
		_ = cmd.Process.Kill()
		<-reaped
		t.Fatalf("the stalled install never reached its mid-write point")
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	<-reaped
}

// driverSiblings counts the temp and old directories beside dir.
func driverSiblings(dir string) int {
	entries, _ := os.ReadDir(filepath.Dir(dir))
	base := filepath.Base(dir)
	n := 0
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, base+driverTempInfix) || strings.HasPrefix(name, base+driverOldInfix) {
			n++
		}
	}
	return n
}

// A killed install leaves no live directory, and the next install succeeds and leaves nothing behind.
func TestInstallDriverAtomicKilledInstallLeavesNoLiveDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "pw-driver")
	killAtStalledInstall(t, dir)
	if _, err := os.Lstat(dir); err == nil {
		t.Fatalf("a killed install left a live driver directory behind: %s", dir)
	}
	if err := installDriverAtomic(dir, stubCompleteInstall); err != nil {
		t.Fatalf("the next install must succeed: %v", err)
	}
	if err := verifyDriverDir(dir); err != nil {
		t.Fatalf("the installed driver does not verify: %v", err)
	}
	if n := driverSiblings(dir); n != 0 {
		t.Fatalf("%d leftover temp or old dir(s) after a successful install", n)
	}
}

// A killed install over a working driver leaves the working driver exactly as it was.
func TestInstallDriverAtomicKilledInstallKeepsTheOldDriver(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "pw-driver")
	if err := installDriverAtomic(dir, stubCompleteInstall); err != nil {
		t.Fatal(err)
	}
	killAtStalledInstall(t, dir)
	b, err := os.ReadFile(filepath.Join(dir, "version"))
	if err != nil || string(b) != "v1" {
		t.Fatalf("the live driver was replaced by a killed install: version=%q err=%v", b, err)
	}
	if err := verifyDriverDir(dir); err != nil {
		t.Fatalf("the live driver no longer verifies: %v", err)
	}
	if driverHalfWritten(dir) {
		t.Fatalf("the live driver was left half-written")
	}
}

// An install that does not verify is refused, and the live driver is not touched.
func TestInstallDriverAtomicRejectsAnInstallThatDoesNotVerify(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "pw-driver")
	if err := installDriverAtomic(dir, stubCompleteInstall); err != nil {
		t.Fatal(err)
	}
	if err := installDriverAtomic(dir, stubNoNodeInstall); err == nil {
		t.Fatalf("an install with no node must fail")
	}
	if b, err := os.ReadFile(filepath.Join(dir, "version")); err != nil || string(b) != "v1" {
		t.Fatalf("a refused install replaced the live driver: version=%q err=%v", b, err)
	}
}

// A half-written directory (cli.js and no node) is treated as missing, and the check creates nothing.
func TestHalfWrittenDriverDirReadsAsMissing(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "pw-driver")
	if err := os.MkdirAll(filepath.Join(dir, "package"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "package", "cli.js"), []byte("// partial\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CRAWL_PW_DRIVER_DIR", dir)
	err := checkPlaywrightDriver()
	if !errors.Is(err, errPlaywrightDriverMissing) {
		t.Fatalf("a half-written driver must read as missing, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "node")); err == nil {
		t.Fatalf("the check created node in a half-written driver")
	}
	if _, err := os.Stat(filepath.Join(dir, "package", "cli.js")); err != nil {
		t.Fatalf("the check changed the half-written driver: %v", err)
	}
}

// Leftover temp and old directories from earlier interrupted installs are removed (N1c).
func TestInstallDriverAtomicRemovesLeftoverTemps(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "pw-driver")
	for _, name := range []string{dir + driverTempInfix + "stale1", dir + driverOldInfix + "stale2"} {
		if err := os.Mkdir(name, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := installDriverAtomic(dir, stubCompleteInstall); err != nil {
		t.Fatal(err)
	}
	if n := driverSiblings(dir); n != 0 {
		t.Fatalf("%d leftover dir(s) survived the install", n)
	}
}

// The install's temp dir is verified before it is renamed in: a half-written temp is never live.
func TestDriverVerifyNeedsNodeAndCliJs(t *testing.T) {
	dir := t.TempDir()
	if err := verifyDriverDir(dir); err == nil {
		t.Fatalf("an empty directory must not verify")
	}
	if err := stubNoNodeInstall(dir); err != nil {
		t.Fatal(err)
	}
	if err := verifyDriverDir(dir); err == nil {
		t.Fatalf("a directory with no node must not verify")
	}
}
