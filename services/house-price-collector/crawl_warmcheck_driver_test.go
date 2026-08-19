package main

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

func containsFold(haystack, needle string) bool {
	return strings.Contains(strings.ToLower(haystack), strings.ToLower(needle))
}

// The 2026-08-13..15 outage: the playwright-go DRIVER cache
// (~/Library/Caches/ms-playwright-go/<v>/) was emptied, so playwright.Run()
// failed inside newCrawlFetcher. runWarmCheck reported that as rc=4 "Chrome
// unreachable", which made ensureChromeWarm kill and relaunch the (perfectly
// healthy, Kasada-warm) dedicated Chrome twice per run before giving up. Both
// scheduled crawls exited 4 for two days, the operator was pointed at the
// re-warm runbook — which cannot fix a missing driver — and 500/500 suburbs
// went stale. A missing driver is an ENVIRONMENT fault, not a Chrome fault, and
// must be reported as such without touching the browser.

func TestWarmCheckInitExitCode(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{
			name: "missing driver is an environment fault, not a Chrome fault",
			err:  fmt.Errorf("playwright driver unavailable: %w", errPlaywrightDriverMissing),
			want: exitCrawlEnvBroken,
		},
		{
			name: "missing driver stays classified through extra wrapping",
			err:  fmt.Errorf("warm probe: %w", fmt.Errorf("init: %w", errPlaywrightDriverMissing)),
			want: exitCrawlEnvBroken,
		},
		{
			name: "chrome genuinely unreachable over CDP stays rc=4",
			err:  errors.New("connect over CDP to http://localhost:9333: connection refused"),
			want: 4,
		},
		{
			name: "wedged chrome with zero browser contexts stays rc=4",
			err:  errors.New("host Chrome on http://localhost:9333 has 0 browser contexts (no open tab)"),
			want: 4,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := warmCheckInitExitCode(c.err); got != c.want {
				t.Fatalf("warmCheckInitExitCode(%v) = %d, want %d", c.err, got, c.want)
			}
		})
	}
}

// A broken environment must fail fast: relaunching or hard-recovering Chrome
// cannot install a driver, and recoverWedgedChrome KILLS the dedicated Chrome —
// throwing away the warm Kasada session that took a native REA startup
// navigation to earn. That is strictly destructive here.
func TestEnsureChromeWarmDoesNotThrashChromeOnBrokenEnv(t *testing.T) {
	cfg := chromeConfig{cdpURL: "http://localhost:9333", autoWarm: true}
	launches, recovers, probes := 0, 0, 0
	deps := chromeDeps{
		reachable: func(string) bool { return true },
		launch:    func(chromeConfig) error { launches++; return nil },
		recover:   func(chromeConfig) error { recovers++; return nil },
		warmProbe: func() int { probes++; return exitCrawlEnvBroken },
	}

	err := ensureChromeWarm(cfg, deps)
	if err == nil {
		t.Fatalf("err = nil, want a broken-environment error")
	}
	if recovers != 0 {
		t.Fatalf("recovers=%d, want 0 — killing a warm Chrome cannot install a driver", recovers)
	}
	if launches != 0 {
		t.Fatalf("launches=%d, want 0 — relaunching Chrome cannot install a driver", launches)
	}
	if probes != 1 {
		t.Fatalf("warmProbe called %d times, want 1 (no retry loop on an environment fault)", probes)
	}
	if !errors.Is(err, errCrawlEnvBroken) {
		t.Fatalf("err = %v, want it to wrap errCrawlEnvBroken so runAgent can map the exit code", err)
	}
}

// The classification is worthless unless runAgent propagates it: the wrapper
// only ever sees the collector's PROCESS exit code, so a broken environment
// reported as 4 still reads as "Chrome unusable" in the scheduler log.
func TestAgentExitForWarmFailure(t *testing.T) {
	if got := agentExitForWarmFailure(errCrawlEnvBroken); got != exitCrawlEnvBroken {
		t.Errorf("agentExitForWarmFailure(errCrawlEnvBroken) = %d, want %d", got, exitCrawlEnvBroken)
	}
	wrapped := fmt.Errorf("self-warm failed: %w", errCrawlEnvBroken)
	if got := agentExitForWarmFailure(wrapped); got != exitCrawlEnvBroken {
		t.Errorf("agentExitForWarmFailure(wrapped) = %d, want %d", got, exitCrawlEnvBroken)
	}
	chrome := errors.New("chrome still unreachable at http://localhost:9333 after launch")
	if got := agentExitForWarmFailure(chrome); got != 4 {
		t.Errorf("agentExitForWarmFailure(chrome fault) = %d, want 4", got)
	}
}

// The operator-facing message is the whole point of the new code: the previous
// message sent a human to the Chrome re-warm runbook for a fault that runbook
// cannot fix. It must instead name the driver and the install command.
func TestBrokenEnvErrorNamesTheFix(t *testing.T) {
	msg := errCrawlEnvBroken.Error()
	for _, want := range []string{"driver", "playwright"} {
		if !containsFold(msg, want) {
			t.Errorf("errCrawlEnvBroken = %q, want it to mention %q", msg, want)
		}
	}
	if !containsFold(driverInstallHint, "install-driver") {
		t.Errorf("driverInstallHint = %q, want the runnable install command", driverInstallHint)
	}
}
