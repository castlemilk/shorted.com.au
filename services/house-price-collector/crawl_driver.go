package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/mxschmitt/playwright-go"
)

// crawl_driver.go owns WHERE the playwright-go driver lives and HOW it gets
// (re)installed.
//
// Why: the driver's default home is under os.UserCacheDir() —
// ~/Library/Caches/ms-playwright-go/<ver>/ on macOS — which is exactly the
// directory disk-space sweeps prune. On 2026-08-13 one such sweep deleted the
// driver and took the crawl down for two days behind a misleading "Chrome
// wedged" symptom (see crawl_env.go). rc=8 made the symptom honest; this file
// removes the cause: CRAWL_PW_DRIVER_DIR relocates the driver to a path no
// cache tooling owns (the wrappers default it to
// ~/.shorted-housing-crawl/pw-driver), and `-mode install-driver` installs to
// that same path with the same options the fetchers use — so the repair
// command and the runtime can never disagree about the directory again.
//
// Three rules keep the shared directory safe (batch 6):
//
//   - An install is a NO-OP when the live directory already verifies at the library's
//     version (verifyDriverDir): no download, no swap, the same inode. -force reinstalls. This keeps
//     `stage-rig.sh`, which runs install-driver on every staging, offline-safe and harmless to a
//     running drain.
//   - Installs are ATOMIC. The install writes into a sibling temp directory, verifies it, and renames it
//     into place. A killed install leaves the old driver, or none, never a half-written one.
//   - Installs are SERIALISED by a dedicated lock, <dir>.install.lock, separate from the crawl lock,
//     so stage-rig.sh, operators and the cycle cannot race. A waiter gives up after installLockWait
//     and exits 8. Leftover temp and old directories are removed only when no live process owns them.

// driverTempInfix and driverOldInfix name the sibling directories an install uses. The name carries the
// owning process's pid, so a cleanup can tell a live install's directory from a leftover.
const (
	driverTempInfix    = ".tmp-"
	driverOldInfix     = ".old-"
	driverManifestName = ".install-manifest"
)

// installLockWait bounds how long an install waits for another install to finish (batch 6, 2a).
// It is a variable so the tests can shorten it.
var installLockWait = 15 * time.Minute

// errInstallLockTimeout means another install held the lock for the whole wait. The caller exits 8.
var errInstallLockTimeout = errors.New("another driver install still holds the install lock")

// driverManifest is the receipt an install writes beside the driver: the version it was installed at and
// the number of files in package/. A verify compares both, so a truncated package is not accepted.
type driverManifest struct {
	Version string `json:"version"`
	Files   int    `json:"files"`
}

// resolveDriverDir returns the configured driver directory, or "" to use the
// playwright-go default (unset/blank env). Trimmed so a whitespace-only value
// in an env file behaves as unset instead of creating a directory named " ".
func resolveDriverDir() string {
	return strings.TrimSpace(os.Getenv("CRAWL_PW_DRIVER_DIR"))
}

// crawlDriverRunOptions builds the playwright RunOptions shared by BOTH
// fetcher constructors and the installer. SkipInstallBrowsers is always true:
// the CDP client drives the HOST Chrome and needs only the driver — a bare
// install pulls all three bundled browsers (~500MB) onto the rig for nothing.
func crawlDriverRunOptions() *playwright.RunOptions {
	opts := &playwright.RunOptions{SkipInstallBrowsers: true}
	if dir := resolveDriverDir(); dir != "" {
		opts.DriverDirectory = dir
	}
	return opts
}

// expectedDriverVersion is the playwright-core version this binary's library installs. It is read from
// the library, so it cannot drift from what the library checks.
func expectedDriverVersion() (string, error) {
	d, err := playwright.NewDriver(crawlDriverRunOptions())
	if err != nil {
		return "", err
	}
	return d.Version, nil
}

// driverHalfWritten reports a driver directory with cli.js and no node: an install that was killed
// part-way. playwright-go's up-to-date check errors on it, so it must read as missing.
func driverHalfWritten(dir string) bool {
	_, cliErr := os.Stat(filepath.Join(dir, "package", "cli.js"))
	_, nodeErr := os.Stat(filepath.Join(dir, "node"))
	return cliErr == nil && nodeErr != nil
}

// checkPlaywrightDriver reports whether the driver runs, without installing anything.
// playwright.Run starts the driver process and fails when the driver is missing or out of
// date. It does not launch a browser, and the driver is stopped again straight away.
// It never creates or repairs anything: a missing or half-written directory is reported as
// missing, and the install that follows replaces it.
func checkPlaywrightDriver() error {
	if dir := resolveDriverDir(); dir != "" {
		if _, err := os.Stat(dir); err != nil {
			return fmt.Errorf("%w: driver directory %s is absent", errPlaywrightDriverMissing, dir)
		}
		if driverHalfWritten(dir) {
			return fmt.Errorf("%w: driver directory %s is half-written (cli.js without node); the next install replaces it", errPlaywrightDriverMissing, dir)
		}
	}
	pw, err := playwright.Run(crawlDriverRunOptions())
	if err != nil {
		return err
	}
	_ = pw.Stop()
	return nil
}

// runInstallDriver implements `-mode install-driver`: install (or repair) the playwright driver into the
// configured directory. Needs no DATABASE_URL, no Chrome and no network when the driver already verifies.
// Exit 0 = the driver is installed and verified (or already was); 1 = install failed; 8 = another install
// held the install lock for the whole wait. force reinstalls even when the driver verifies.
func runInstallDriver(force bool) int {
	opts := crawlDriverRunOptions()
	if opts.DriverDirectory == "" {
		// The playwright default cache is the library's own, and its up-to-date check makes a current
		// install a no-op. There is no sibling directory to write into, so the install goes there.
		if err := playwright.Install(opts); err != nil {
			log.Printf("[install-driver] playwright driver install failed: %v", err)
			return 1
		}
		log.Printf("[install-driver] playwright driver installed (dir=playwright default cache dir). Verify with: house-price-collector -mode warmcheck")
		return 0
	}
	version, err := expectedDriverVersion()
	if err != nil {
		log.Printf("[install-driver] cannot read the driver version: %v", err)
		return 1
	}
	dir := opts.DriverDirectory
	err = withInstallLock(dir, func() error {
		installed, err := installDriverIfNeeded(dir, version, force, realDriverInstall)
		if err != nil {
			return err
		}
		if installed {
			log.Printf("[install-driver] playwright driver %s installed (dir=%s). Verify with: house-price-collector -mode warmcheck", version, dir)
		} else {
			log.Printf("[install-driver] playwright driver %s already installed and verified (dir=%s): nothing downloaded; -force reinstalls", version, dir)
		}
		return nil
	})
	switch {
	case errors.Is(err, errInstallLockTimeout):
		log.Printf("[install-driver] %v after %s — exit 8", err, installLockWait)
		return exitCrawlEnvBroken
	case err != nil:
		log.Printf("[install-driver] playwright driver install failed: %v", err)
		return 1
	}
	return 0
}

// realDriverInstall installs the playwright driver into dir with playwright-go's installer.
func realDriverInstall(dir string) error {
	opts := crawlDriverRunOptions()
	opts.DriverDirectory = dir
	return playwright.Install(opts)
}

// withInstallLock runs fn while holding the driver install lock for dir: an exclusive flock on
// <dir>.install.lock. It polls for the lock until installLockWait has passed (batch 6, 2a).
func withInstallLock(dir string, fn func() error) error {
	lockPath := dir + ".install.lock"
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return fmt.Errorf("create the install lock directory: %w", err)
	}
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return fmt.Errorf("open the install lock: %w", err)
	}
	defer func() { _ = f.Close() }()
	deadline := time.Now().Add(installLockWait)
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) {
			return fmt.Errorf("take the install lock: %w", err)
		}
		if time.Now().After(deadline) {
			return errInstallLockTimeout
		}
		time.Sleep(200 * time.Millisecond)
	}
	defer func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }()
	return fn()
}

// installDriverIfNeeded installs unless the live driver already verifies at version. force skips the
// check. The caller holds the install lock. It reports whether an install ran.
func installDriverIfNeeded(dir, version string, force bool, install func(dir string) error) (bool, error) {
	if !force && verifyDriverDir(dir, version) == nil {
		return false, nil
	}
	if err := installDriverAtomic(dir, version, install); err != nil {
		return false, err
	}
	return true, nil
}

// installDriverAtomic installs the driver so the live directory is never left half-written:
//
//  1. remove the temp and old directories no live process owns (leftovers of an interrupted install);
//  2. install into a fresh sibling temp directory, owned by this pid;
//  3. write the manifest (version and file count) and verify the temp directory;
//  4. set the live directory aside, rename the temp into place, and remove the old one.
//
// A kill before step 4 leaves the live directory exactly as it was. A kill between the two renames
// leaves no live directory, which the next install replaces. Only a verified temp is ever renamed in.
// The caller holds the install lock.
func installDriverAtomic(dir, version string, install func(dir string) error) error {
	parent := filepath.Dir(dir)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", parent, err)
	}
	removeStaleDriverDirs(dir)
	tmp, err := os.MkdirTemp(parent, filepath.Base(dir)+driverTempInfix+strconv.Itoa(os.Getpid())+"-")
	if err != nil {
		return fmt.Errorf("create a temp dir beside %s: %w", dir, err)
	}
	installed := false
	defer func() {
		if !installed {
			_ = os.RemoveAll(tmp)
		}
	}()
	if err := install(tmp); err != nil {
		return fmt.Errorf("install into the temp dir: %w", err)
	}
	if err := writeDriverManifest(tmp, version); err != nil {
		return fmt.Errorf("write the install manifest: %w", err)
	}
	if err := verifyDriverDir(tmp, version); err != nil {
		return fmt.Errorf("the installed driver did not verify: %w", err)
	}
	old := fmt.Sprintf("%s%s%d-%d", dir, driverOldInfix, os.Getpid(), time.Now().UnixNano())
	hadLive := false
	if _, err := os.Lstat(dir); err == nil {
		hadLive = true
		if err := os.Rename(dir, old); err != nil {
			return fmt.Errorf("set the old driver dir aside: %w", err)
		}
	}
	if err := os.Rename(tmp, dir); err != nil {
		if hadLive {
			_ = os.Rename(old, dir) // put the old driver back: the live dir is never lost
		}
		return fmt.Errorf("rename the verified driver into place: %w", err)
	}
	installed = true
	if hadLive {
		_ = os.RemoveAll(old)
	}
	return nil
}

// countDriverFiles counts the regular files under package/, the directory the manifest records.
func countDriverFiles(dir string) (int, error) {
	n := 0
	err := filepath.WalkDir(filepath.Join(dir, "package"), func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type().IsRegular() {
			n++
		}
		return nil
	})
	return n, err
}

// writeDriverManifest records the installed version and file count beside the driver.
func writeDriverManifest(dir, version string) error {
	n, err := countDriverFiles(dir)
	if err != nil {
		return err
	}
	b, err := json.Marshal(driverManifest{Version: version, Files: n})
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, driverManifestName), b, 0o644)
}

// verifyDriverDir checks a driver is complete and at version:
//
//   - node is an executable file;
//   - package/cli.js exists, and package/package.json names version;
//   - the manifest names version and the same file count as package/ now;
//   - the driver runs: `node package/cli.js --version` prints version (the library's own check).
func verifyDriverDir(dir, version string) error {
	node := filepath.Join(dir, "node")
	st, err := os.Stat(node)
	if err != nil || st.IsDir() || st.Mode()&0o111 == 0 {
		return errors.New("node is missing or not executable")
	}
	cli := filepath.Join(dir, "package", "cli.js")
	if _, err := os.Stat(cli); err != nil {
		return errors.New("package/cli.js is missing")
	}
	pkgBytes, err := os.ReadFile(filepath.Join(dir, "package", "package.json"))
	if err != nil {
		return errors.New("package/package.json is missing")
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(pkgBytes, &pkg); err != nil || pkg.Version != version {
		return fmt.Errorf("package/package.json does not name version %s", version)
	}
	manBytes, err := os.ReadFile(filepath.Join(dir, driverManifestName))
	if err != nil {
		return errors.New("the install manifest is missing")
	}
	var man driverManifest
	if err := json.Unmarshal(manBytes, &man); err != nil || man.Version != version {
		return fmt.Errorf("the install manifest does not name version %s", version)
	}
	n, err := countDriverFiles(dir)
	if err != nil || n != man.Files {
		return fmt.Errorf("package/ holds %d files, the manifest says %d: the install is incomplete", n, man.Files)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, node, cli, "--version").Output()
	if err != nil {
		return fmt.Errorf("the driver does not run: %w", err)
	}
	if !strings.Contains(string(out), version) {
		return fmt.Errorf("the driver reports a version other than %s", version)
	}
	return nil
}

// removeStaleDriverDirs deletes the temp and old directories an earlier install left beside dir. A
// directory whose name carries the pid of a LIVE process is that process's work and is kept (batch 6,
// 2b). A name with no readable pid is a leftover from before the names carried one, and is removed.
// It runs under the install lock, so no install of this directory is in progress while it runs.
func removeStaleDriverDirs(dir string) {
	parent := filepath.Dir(dir)
	base := filepath.Base(dir)
	entries, err := os.ReadDir(parent)
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		rest, ok := strings.CutPrefix(name, base+driverTempInfix)
		if !ok {
			rest, ok = strings.CutPrefix(name, base+driverOldInfix)
		}
		if !ok {
			continue
		}
		if pid := leadingPID(rest); pid > 0 && pidAlive(pid) {
			continue
		}
		if err := os.RemoveAll(filepath.Join(parent, name)); err == nil {
			log.Printf("[install-driver] removed a leftover from an interrupted install: %s", name)
		}
	}
}

// leadingPID reads the pid that starts a temp or old directory's name (the digits before the first "-").
// It returns 0 when there is none.
func leadingPID(rest string) int {
	digits, _, _ := strings.Cut(rest, "-")
	pid, err := strconv.Atoi(digits)
	if err != nil || pid <= 0 {
		return 0
	}
	return pid
}
