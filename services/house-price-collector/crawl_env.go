package main

import (
	"errors"
	"fmt"
)

// crawl_env.go separates an ENVIRONMENT fault from a BROWSER fault in the crawl
// preflight.
//
// Why this exists: late on 2026-08-13 a disk-space sweep of ~/Library/Caches on
// the residential rig took the playwright-go driver with it (the whole dev-cache
// family — Homebrew, golangci-lint, node-gyp, the Go module cache — was recreated
// in the same window). playwright.Run() then failed inside newCrawlFetcher, and
// because runWarmCheck collapsed EVERY fetcher-init error into rc=4 ("Chrome
// unreachable"), the agent concluded Chrome was wedged. ensureChromeWarm duly
// SIGKILLed and relaunched the dedicated Chrome twice per run — on the 2026-08-15
// runs that was the pre-existing, Kasada-warm instance — to fix a fault that had
// nothing to do with Chrome, then exited 4. Both scheduled crawls did this every
// run for two days while the log's trailing conclusion pointed at the Chrome
// re-warm runbook, which cannot install a driver. 500/500 suburbs went stale and
// the listings corpus froze at 2026-08-13T12:15Z.
//
// The distinction the exit codes now carry:
//
//	rc 4 — Chrome/CDP is genuinely unreachable or wedged. Relaunching or
//	       hard-recovering Chrome is the right response, and the agent does it.
//	rc 8 — the crawl ENVIRONMENT is broken (the Playwright driver is missing).
//	       No amount of Chrome lifecycle management fixes it; touching Chrome is
//	       strictly destructive. Fail fast and name the install command.
const exitCrawlEnvBroken = 8

// driverInstallHint is the runnable repair for a missing driver on a rig. It
// uses the collector's own installer so the install directory ALWAYS matches
// what the fetchers will read (CRAWL_PW_DRIVER_DIR — exported by the wrappers'
// hc_load_env); the old `go run …/cmd/playwright install` form installed into
// the default cache dir, which is both prunable and, once the env var is set,
// the WRONG place. See Dockerfile.crawl, which installs the driver at build
// time (the env var is unset in the image, so the default path still applies
// there).
const driverInstallHint = "~/bin/house-price-collector -mode install-driver   (set CRAWL_PW_DRIVER_DIR first if running outside the wrappers)"

// errPlaywrightDriverMissing is wrapped by every fetcher constructor whose
// playwright.Run() fails, so the classification below survives arbitrary
// re-wrapping on the way up (errors.Is, never string matching).
var errPlaywrightDriverMissing = errors.New("playwright driver not installed")

// errCrawlEnvBroken is what ensureChromeWarm returns when the preflight proved
// the environment — not the browser — is at fault. runAgent maps it to
// exitCrawlEnvBroken. The message is operator-facing and deliberately names the
// fix, because the failure it replaces sent humans to the wrong runbook.
var errCrawlEnvBroken = fmt.Errorf(
	"crawl environment broken: the playwright driver is missing, so no browser client can start — "+
		"this is NOT a cold or wedged Chrome and re-warming cannot fix it. Reinstall it with: %s",
	driverInstallHint,
)

// agentExitForWarmFailure maps an ensureChromeWarm failure to runAgent's process
// exit code. The wrapper only ever sees this number, so the classification has
// to survive the trip out of the process or the scheduler log lies again.
func agentExitForWarmFailure(err error) int {
	if errors.Is(err, errCrawlEnvBroken) {
		return exitCrawlEnvBroken
	}
	return 4
}

// warmCheckInitExitCode classifies a newCrawlFetcher error into the warmcheck
// exit code. A missing driver is an environment fault (rc 8); everything else —
// a refused CDP connection, a Chrome with zero browser contexts — remains a
// browser fault (rc 4) that the Chrome lifecycle can and should try to recover.
func warmCheckInitExitCode(err error) int {
	if errors.Is(err, errPlaywrightDriverMissing) {
		return exitCrawlEnvBroken
	}
	return 4
}
