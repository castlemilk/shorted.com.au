package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
// Installs are ATOMIC (N1). The driver directory is shared with the live bash wrappers, and a
// playwright install killed half-way left a directory with cli.js and no node. playwright-go's
// up-to-date check then errors on every later install, so the directory stayed broken until someone
// deleted it. Now an install writes into a sibling temp directory, verifies it, and renames it into
// place. A killed install leaves the old directory, or none, never a half-written one. A half-written
// directory left by an older install reads as missing (checkPlaywrightDriver).

// driverTempInfix and driverOldInfix name the sibling directories an install uses: the temp dir it
// writes into, and the old live dir it sets aside during the swap.
const (
	driverTempInfix = ".tmp-"
	driverOldInfix  = ".old-"
)

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

// runInstallDriver implements `-mode install-driver`: install (or repair) the playwright driver into
// the configured directory, atomically (installDriverAtomic). Needs no DATABASE_URL, no Chrome and no
// network beyond the driver download. Exit 0 = driver installed and verified; 1 = install failed.
// With no CRAWL_PW_DRIVER_DIR the playwright default cache is used, which the library owns, so there
// is no sibling directory to write into and the install goes there directly.
func runInstallDriver() int {
	opts := crawlDriverRunOptions()
	if opts.DriverDirectory == "" {
		if err := playwright.Install(opts); err != nil {
			log.Printf("[install-driver] playwright driver install failed: %v", err)
			return 1
		}
		log.Printf("[install-driver] playwright driver installed (dir=playwright default cache dir). Verify with: house-price-collector -mode warmcheck")
		return 0
	}
	if err := installDriverAtomic(opts.DriverDirectory, realDriverInstall); err != nil {
		log.Printf("[install-driver] playwright driver install failed: %v", err)
		return 1
	}
	log.Printf("[install-driver] playwright driver installed (dir=%s). Verify with: house-price-collector -mode warmcheck", opts.DriverDirectory)
	return 0
}

// realDriverInstall installs the playwright driver into dir with playwright-go's installer.
func realDriverInstall(dir string) error {
	opts := crawlDriverRunOptions()
	opts.DriverDirectory = dir
	return playwright.Install(opts)
}

// installDriverAtomic installs the driver so the live directory is never left half-written:
//
//  1. remove the temp and old directories an earlier, interrupted install left behind (N1c);
//  2. install into a fresh sibling temp directory (same filesystem);
//  3. verify it: node exists, is executable, runs; package/cli.js exists;
//  4. set the live directory aside, rename the temp into place, and remove the old one.
//
// A kill before step 4 leaves the live directory exactly as it was. A kill between the two renames
// leaves no live directory, which the next install replaces. Only a verified temp is ever renamed in.
func installDriverAtomic(dir string, install func(dir string) error) error {
	parent := filepath.Dir(dir)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", parent, err)
	}
	removeStaleDriverDirs(dir)
	tmp, err := os.MkdirTemp(parent, filepath.Base(dir)+driverTempInfix)
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
	if err := verifyDriverDir(tmp); err != nil {
		return fmt.Errorf("the installed driver did not verify: %w", err)
	}
	old := fmt.Sprintf("%s%s%d", dir, driverOldInfix, time.Now().UnixNano())
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

// verifyDriverDir checks an installed driver: node exists, is an executable file, and runs; and
// package/cli.js exists. It runs node with --version, under a timeout.
func verifyDriverDir(dir string) error {
	node := filepath.Join(dir, "node")
	st, err := os.Stat(node)
	if err != nil || st.IsDir() || st.Mode()&0o111 == 0 {
		return errors.New("node is missing or not executable")
	}
	if _, err := os.Stat(filepath.Join(dir, "package", "cli.js")); err != nil {
		return errors.New("package/cli.js is missing")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, node, "--version").Run(); err != nil {
		return fmt.Errorf("node does not run: %w", err)
	}
	return nil
}

// removeStaleDriverDirs deletes the temp and old directories an earlier install left beside dir
// (N1c). It matches only the names an install itself creates, never the live directory. An install
// running at the same moment in another process would lose its temp dir; installs run under the
// cycle's lock or by an operator, so that does not happen in practice.
func removeStaleDriverDirs(dir string) {
	parent := filepath.Dir(dir)
	base := filepath.Base(dir)
	entries, err := os.ReadDir(parent)
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, base+driverTempInfix) && !strings.HasPrefix(name, base+driverOldInfix) {
			continue
		}
		if err := os.RemoveAll(filepath.Join(parent, name)); err == nil {
			log.Printf("[install-driver] removed a leftover from an interrupted install: %s", name)
		}
	}
}
