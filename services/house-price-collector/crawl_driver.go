package main

import (
	"log"
	"os"
	"strings"

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

// runInstallDriver implements `-mode install-driver`: install (or repair) the
// playwright driver into the configured directory. Needs no DATABASE_URL, no
// Chrome and no network beyond the driver download — main.go dispatches it
// before the DB connect. Exit 0 = driver present and runnable; 1 = install
// failed.
func runInstallDriver() int {
	opts := crawlDriverRunOptions()
	if opts.DriverDirectory != "" {
		if err := os.MkdirAll(opts.DriverDirectory, 0o755); err != nil {
			log.Printf("[install-driver] cannot create driver dir %q: %v", opts.DriverDirectory, err)
			return 1
		}
	}
	if err := playwright.Install(opts); err != nil {
		log.Printf("[install-driver] playwright driver install failed: %v", err)
		return 1
	}
	where := opts.DriverDirectory
	if where == "" {
		where = "playwright default cache dir"
	}
	log.Printf("[install-driver] playwright driver installed (dir=%s). Verify with: house-price-collector -mode warmcheck", where)
	return 0
}
