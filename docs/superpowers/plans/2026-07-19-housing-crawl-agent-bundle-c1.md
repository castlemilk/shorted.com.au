# C1 — Collector Self-Warms Dedicated Chrome — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `house-price-collector -mode agent` self-warm and self-recover its dedicated Chrome, so the crawl no longer depends on the external `run-housing-agent.sh` wrapper — the first, independently-shippable slice of the "bundle the crawl into the brandbrain agent" design.

**Architecture:** Port the Chrome warm/recover/preflight logic from `deploy/run-housing-agent.sh` into a new `crawl_chrome.go` in the collector. `runAgent` gains a preflight (`ensureChromeWarm`) that ensures the dedicated Chrome is reachable and its Kasada session is warm before crawling, and a recover-and-retry around the fetcher init. Pure decision logic (port parsing, dedicated-PID matching, the warm state machine) is unit-tested with injected dependencies; the actual browser launch stays a local/manual check.

**Tech Stack:** Go 1.2x, `os/exec`, `net/url`, `net/http`; existing collector helpers (`loadCrawlConfig`, `envStr`/`envInt`, `runWarmCheck`, `reaLooksWarm`, `newCrawlFetcher`).

**Spec:** `docs/superpowers/specs/2026-07-19-agent-bundled-housing-crawl-design.md` (component C1).

**Scope note:** This plan is C1 only. C2 (cross-repo DMG bundling), C3 (Swift `HousingCrawlSupervisor` + Keychain), C4 (Real-estate tab UI), and C5 (validation/observability) are a **separate follow-up plan** — they live in the brandbrain repo and are gated on the `canvas-asset-sets` panel branch merging to brandbrain `main`. C1 ships on its own and immediately makes the standalone/server crawl path (and the current interim drain loop) self-warming.

---

## File Structure

- **Create** `services/house-price-collector/crawl_chrome.go` — all dedicated-Chrome lifecycle: config, port parse, PID matching, reachability, kill/clear/launch, `recoverWedgedChrome`, and the `ensureChromeWarm` preflight state machine. One responsibility: keep the dedicated Chrome reachable + warm.
- **Create** `services/house-price-collector/crawl_chrome_test.go` — unit tests for the pure logic (`chromeCDPPort`, `matchDedicatedPIDs`, `loadChromeConfig`, `ensureChromeWarm` with injected deps).
- **Modify** `services/house-price-collector/crawl_agent.go` — `runAgent`: add the `ensureChromeWarm` preflight before the fetcher is built, and wrap the fetcher-init failure in a recover-and-retry.
- **Modify** `services/house-price-collector/deploy/run-housing-agent.sh` — de-duplicate: the script keeps working, but its warm/recover steps become a thin fallback now that `-mode agent` self-warms (documented, not deleted).

All new symbols live in `package main` alongside the existing collector code.

---

## Task 1: Parse the CDP port from the CDP URL

**Files:**
- Create: `services/house-price-collector/crawl_chrome.go`
- Test: `services/house-price-collector/crawl_chrome_test.go`

- [ ] **Step 1: Write the failing test**

Create `services/house-price-collector/crawl_chrome_test.go`:

```go
package main

import "testing"

func TestChromeCDPPort(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"http://localhost:9333", "9333", false},
		{"http://localhost:9333/json/version", "9333", false},
		{"http://host.docker.internal:9222", "9222", false},
		{"http://127.0.0.1:9222/", "9222", false},
		{"", "", true},
		{"http://localhost", "", true}, // no port
	}
	for _, c := range cases {
		got, err := chromeCDPPort(c.in)
		if c.wantErr {
			if err == nil {
				t.Errorf("chromeCDPPort(%q): want error, got %q", c.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("chromeCDPPort(%q): unexpected error %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("chromeCDPPort(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/house-price-collector && go test -run TestChromeCDPPort ./...`
Expected: FAIL — `undefined: chromeCDPPort`.

- [ ] **Step 3: Write minimal implementation**

Create `services/house-price-collector/crawl_chrome.go`:

```go
package main

import (
	"fmt"
	"net/url"
)

// crawl_chrome.go owns the DEDICATED-profile Chrome lifecycle for -mode agent:
// keeping it reachable over CDP and its Kasada session warm, WITHOUT an external
// shell wrapper. It is a Go port of deploy/run-housing-agent.sh's warm_chrome /
// recover_wedged_chrome / warmcheck-loop logic. It only ever touches the
// dedicated --user-data-dir profile, NEVER the operator's personal Chrome.

// chromeCDPPort extracts the TCP port from a CDP URL (e.g. http://localhost:9333
// -> "9333"), used to build Chrome's --remote-debugging-port launch arg.
func chromeCDPPort(cdpURL string) (string, error) {
	if cdpURL == "" {
		return "", fmt.Errorf("empty CDP URL")
	}
	u, err := url.Parse(cdpURL)
	if err != nil {
		return "", fmt.Errorf("parse CDP URL %q: %w", cdpURL, err)
	}
	if u.Port() == "" {
		return "", fmt.Errorf("CDP URL %q has no port", cdpURL)
	}
	return u.Port(), nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/house-price-collector && go test -run TestChromeCDPPort ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/house-price-collector/crawl_chrome.go services/house-price-collector/crawl_chrome_test.go
git commit -m "feat(collector): chromeCDPPort — parse CDP port for self-warm (C1)"
```

---

## Task 2: Match ONLY dedicated-profile Chrome PIDs (safety-critical)

This is the load-bearing safety unit: the kill path must **never** match the operator's personal Chrome. We factor the matching out of any `ps` call so it is fully unit-testable against canned command lines.

**Files:**
- Modify: `services/house-price-collector/crawl_chrome.go`
- Test: `services/house-price-collector/crawl_chrome_test.go`

- [ ] **Step 1: Write the failing test**

Append to `crawl_chrome_test.go`:

```go
func TestMatchDedicatedPIDs(t *testing.T) {
	profile := "/Users/ben/.shorted-housing-crawl-chrome"
	// Realistic `ps -axww -o pid=,command=` output: the dedicated Chrome, the
	// PERSONAL Chrome (must NEVER match), a helper without the flag, and grep noise.
	psOut := "" +
		"  501 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9333 --user-data-dir=/Users/ben/.shorted-housing-crawl-chrome https://www.realestate.com.au/\n" +
		"  777 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/ben/Library/Application Support/Google/Chrome\n" +
		"  888 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper (Renderer)\n" +
		"  999 grep -F -- --user-data-dir=/Users/ben/.shorted-housing-crawl-chrome\n"

	got := matchDedicatedPIDs(psOut, profile)
	if len(got) != 1 || got[0] != 501 {
		t.Fatalf("matchDedicatedPIDs = %v, want [501] (dedicated only, never the personal profile or grep)", got)
	}

	// Empty profile must match NOTHING (guards against a defaulting bug turning
	// this into "kill every Chrome").
	if pids := matchDedicatedPIDs(psOut, ""); len(pids) != 0 {
		t.Fatalf("matchDedicatedPIDs(_, \"\") = %v, want [] — empty profile must never match", pids)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/house-price-collector && go test -run TestMatchDedicatedPIDs ./...`
Expected: FAIL — `undefined: matchDedicatedPIDs`.

- [ ] **Step 3: Write minimal implementation**

Add to `crawl_chrome.go` (add `"strconv"` and `"strings"` to imports):

```go
// matchDedicatedPIDs returns the PIDs from `ps -axww -o pid=,command=` output whose
// command line contains the EXACT `--user-data-dir=<profileDir>` flag. This is the
// only Chrome that carries the dedicated data dir, so the personal Chrome is never
// matched. An empty profileDir matches nothing (never "every Chrome"). Lines that
// are the grep/ps pipeline itself are excluded.
func matchDedicatedPIDs(psOutput, profileDir string) []int {
	if strings.TrimSpace(profileDir) == "" {
		return nil
	}
	needle := "--user-data-dir=" + profileDir
	var pids []int
	for _, line := range strings.Split(psOutput, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.Contains(line, needle) {
			continue
		}
		if strings.Contains(line, "grep ") || strings.HasPrefix(line, "grep") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		pids = append(pids, pid)
	}
	return pids
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/house-price-collector && go test -run TestMatchDedicatedPIDs ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/house-price-collector/crawl_chrome.go services/house-price-collector/crawl_chrome_test.go
git commit -m "feat(collector): matchDedicatedPIDs — dedicated-profile-only Chrome match (C1 safety)"
```

---

## Task 3: Load Chrome config from env with the shell script's defaults

**Files:**
- Modify: `services/house-price-collector/crawl_chrome.go`
- Test: `services/house-price-collector/crawl_chrome_test.go`

- [ ] **Step 1: Write the failing test**

Append to `crawl_chrome_test.go`:

```go
func TestLoadChromeConfigDefaults(t *testing.T) {
	t.Setenv("HOUSING_CRAWL_CHROME_BIN", "")
	t.Setenv("HOUSING_CRAWL_CHROME_PROFILE", "")
	t.Setenv("CRAWL_AUTO_WARM", "")

	cfg := loadChromeConfig("http://localhost:9333")
	if cfg.cdpURL != "http://localhost:9333" {
		t.Errorf("cdpURL = %q", cfg.cdpURL)
	}
	if cfg.bin == "" || !strings.Contains(cfg.bin, "Google Chrome") {
		t.Errorf("bin default = %q, want the macOS Chrome path", cfg.bin)
	}
	if !strings.HasSuffix(cfg.profileDir, ".shorted-housing-crawl-chrome") {
		t.Errorf("profileDir default = %q", cfg.profileDir)
	}
	if !cfg.autoWarm {
		t.Errorf("autoWarm default = false, want true")
	}
	if cfg.startURL != "https://www.realestate.com.au/" {
		t.Errorf("startURL = %q", cfg.startURL)
	}
}

func TestLoadChromeConfigAutoWarmOff(t *testing.T) {
	t.Setenv("CRAWL_AUTO_WARM", "false")
	if loadChromeConfig("http://localhost:9333").autoWarm {
		t.Errorf("CRAWL_AUTO_WARM=false should disable autoWarm")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/house-price-collector && go test -run TestLoadChromeConfig ./...`
Expected: FAIL — `undefined: loadChromeConfig`.

- [ ] **Step 3: Write minimal implementation**

Add to `crawl_chrome.go` (add `"os"` and `"path/filepath"` to imports):

```go
// chromeConfig is the dedicated-Chrome lifecycle config for -mode agent.
type chromeConfig struct {
	bin        string // HOUSING_CRAWL_CHROME_BIN — Chrome executable
	profileDir string // HOUSING_CRAWL_CHROME_PROFILE — dedicated --user-data-dir
	cdpURL     string // from crawlConfig.cdpURL (CRAWL_CDP_URL)
	autoWarm   bool   // CRAWL_AUTO_WARM (default true) — self-warm before crawling
	startURL   string // REA startup URL whose native nav clears Kasada
}

const defaultChromeBin = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

// loadChromeConfig reads the dedicated-Chrome config, mirroring the defaults in
// deploy/run-housing-agent.sh. cdpURL is threaded in from the crawl config.
func loadChromeConfig(cdpURL string) chromeConfig {
	home, _ := os.UserHomeDir()
	return chromeConfig{
		bin:        envStr("HOUSING_CRAWL_CHROME_BIN", defaultChromeBin),
		profileDir: envStr("HOUSING_CRAWL_CHROME_PROFILE", filepath.Join(home, ".shorted-housing-crawl-chrome")),
		cdpURL:     cdpURL,
		autoWarm:   envStr("CRAWL_AUTO_WARM", "true") != "false",
		startURL:   "https://www.realestate.com.au/",
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/house-price-collector && go test -run TestLoadChromeConfig ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/house-price-collector/crawl_chrome.go services/house-price-collector/crawl_chrome_test.go
git commit -m "feat(collector): loadChromeConfig with run-housing-agent.sh defaults (C1)"
```

---

## Task 4: The `ensureChromeWarm` preflight state machine (injected deps)

Port the shell script's steps 1–2 (reachable-or-launch, then warmcheck-loop with recover/relaunch) as a pure state machine with injected dependencies, so it is testable without a browser.

**Files:**
- Modify: `services/house-price-collector/crawl_chrome.go`
- Test: `services/house-price-collector/crawl_chrome_test.go`

- [ ] **Step 1: Write the failing test**

Append to `crawl_chrome_test.go`:

```go
func TestEnsureChromeWarm(t *testing.T) {
	cfg := chromeConfig{cdpURL: "http://localhost:9333", autoWarm: true}

	// Already reachable + warm on the first probe → no launch, no recover.
	t.Run("reachable_and_warm", func(t *testing.T) {
		launches, recovers := 0, 0
		deps := chromeDeps{
			reachable: func(string) bool { return true },
			launch:    func(chromeConfig) error { launches++; return nil },
			recover:   func(chromeConfig) error { recovers++; return nil },
			warmProbe: func() int { return 0 },
		}
		if err := ensureChromeWarm(cfg, deps); err != nil {
			t.Fatalf("err = %v, want nil", err)
		}
		if launches != 0 || recovers != 0 {
			t.Fatalf("launches=%d recovers=%d, want 0/0", launches, recovers)
		}
	})

	// Unreachable, launch makes it reachable, then warm.
	t.Run("unreachable_then_launched_warm", func(t *testing.T) {
		reachableCalls := 0
		launches := 0
		deps := chromeDeps{
			reachable: func(string) bool { reachableCalls++; return reachableCalls > 1 }, // false, then true
			launch:    func(chromeConfig) error { launches++; return nil },
			recover:   func(chromeConfig) error { return nil },
			warmProbe: func() int { return 0 },
		}
		if err := ensureChromeWarm(cfg, deps); err != nil {
			t.Fatalf("err = %v, want nil", err)
		}
		if launches != 1 {
			t.Fatalf("launches=%d, want 1", launches)
		}
	})

	// Reachable but never warm → give up after 2 relaunch attempts (error).
	t.Run("never_warm_gives_up", func(t *testing.T) {
		launches := 0
		deps := chromeDeps{
			reachable: func(string) bool { return true },
			launch:    func(chromeConfig) error { launches++; return nil },
			recover:   func(chromeConfig) error { return nil },
			warmProbe: func() int { return 5 }, // Kasada stub forever
		}
		if err := ensureChromeWarm(cfg, deps); err == nil {
			t.Fatalf("err = nil, want not-warm error")
		}
		if launches != 2 {
			t.Fatalf("launches=%d, want 2 (bounded re-warm attempts)", launches)
		}
	})

	// Wedged (rc 4) on first probe → recover, then warm.
	t.Run("wedged_then_recovered", func(t *testing.T) {
		probeCalls, recovers := 0, 0
		deps := chromeDeps{
			reachable: func(string) bool { return true },
			launch:    func(chromeConfig) error { return nil },
			recover:   func(chromeConfig) error { recovers++; return nil },
			warmProbe: func() int { probeCalls++; if probeCalls == 1 { return 4 }; return 0 },
		}
		if err := ensureChromeWarm(cfg, deps); err != nil {
			t.Fatalf("err = %v, want nil", err)
		}
		if recovers != 1 {
			t.Fatalf("recovers=%d, want 1 (rc4 hard-recovers)", recovers)
		}
	})
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/house-price-collector && go test -run TestEnsureChromeWarm ./...`
Expected: FAIL — `undefined: chromeDeps` / `ensureChromeWarm`.

- [ ] **Step 3: Write minimal implementation**

Add to `crawl_chrome.go` (add `"log"` to imports):

```go
// chromeDeps are the side-effecting operations ensureChromeWarm calls, injected
// so the state machine is unit-testable without a real browser. In production
// they are chromeReachable / launchDedicatedChrome / recoverWedgedChrome and a
// warmProbe backed by runWarmCheck.
type chromeDeps struct {
	reachable func(cdpURL string) bool
	launch    func(cfg chromeConfig) error
	recover   func(cfg chromeConfig) error
	warmProbe func() int // 0=warm, 4=wedged/unusable, 5=reachable-but-Kasada-stub
}

const warmMaxAttempts = 2

// ensureChromeWarm guarantees the dedicated Chrome is reachable over CDP and its
// REA/Kasada session is warm before a crawl runs — the in-process port of
// run-housing-agent.sh steps 1-2. Returns an error (mapped by the caller to a
// re-warm exit) if Chrome can't be made reachable or warm within the bounds.
func ensureChromeWarm(cfg chromeConfig, deps chromeDeps) error {
	// 1. Reachable at all — auto-launch rather than requiring a human.
	if !deps.reachable(cfg.cdpURL) {
		log.Printf("[agent] chrome unreachable at %s — auto-launching dedicated Chrome", cfg.cdpURL)
		if err := deps.launch(cfg); err != nil {
			return fmt.Errorf("launch dedicated Chrome: %w", err)
		}
		if !deps.reachable(cfg.cdpURL) {
			return fmt.Errorf("chrome still unreachable at %s after launch", cfg.cdpURL)
		}
	}

	// 2. Reachable != warm — PROVE the Kasada session cleared. rc 5 (cold stub) →
	//    relaunch; rc 4 (wedged/no context) → hard-recover; re-probe up to twice.
	rc := deps.warmProbe()
	for attempts := 0; (rc == 5 || rc == 4) && attempts < warmMaxAttempts; attempts++ {
		if rc == 4 {
			log.Printf("[agent] warm probe rc=4 (Chrome wedged) — hard-recovering (attempt %d/%d)", attempts+1, warmMaxAttempts)
			if err := deps.recover(cfg); err != nil {
				return fmt.Errorf("recover wedged Chrome: %w", err)
			}
		} else {
			log.Printf("[agent] warm probe rc=5 (Kasada stub) — relaunching to re-warm (attempt %d/%d)", attempts+1, warmMaxAttempts)
			if err := deps.launch(cfg); err != nil {
				return fmt.Errorf("relaunch dedicated Chrome: %w", err)
			}
		}
		rc = deps.warmProbe()
	}
	if rc != 0 {
		return fmt.Errorf("chrome not warm after %d attempt(s) (last warmcheck rc=%d)", warmMaxAttempts, rc)
	}
	return nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd services/house-price-collector && go test -run TestEnsureChromeWarm ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/house-price-collector/crawl_chrome.go services/house-price-collector/crawl_chrome_test.go
git commit -m "feat(collector): ensureChromeWarm preflight state machine (C1)"
```

---

## Task 5: Live Chrome operations (reachability, kill, clear, launch, recover)

These wrap the OS calls the state machine's prod deps use. They aren't unit-tested (they touch the real browser/OS); correctness is verified by the local live check in Task 7. Keep them a faithful port of the shell functions.

**Files:**
- Modify: `services/house-price-collector/crawl_chrome.go`

- [ ] **Step 1: Add the live operations**

Add to `crawl_chrome.go` (add `"net/http"`, `"os/exec"`, `"syscall"`, `"time"` to imports):

```go
// chromeReachable reports whether the CDP endpoint answers /json/version.
func chromeReachable(cdpURL string) bool {
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(strings.TrimRight(cdpURL, "/") + "/json/version")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// dedicatedChromePIDs runs `ps -axww -o pid=,command=` and returns the PIDs of the
// dedicated-profile Chrome only (via matchDedicatedPIDs).
func dedicatedChromePIDs(profileDir string) []int {
	out, err := exec.Command("/bin/ps", "-axww", "-o", "pid=,command=").Output()
	if err != nil {
		return nil
	}
	return matchDedicatedPIDs(string(out), profileDir)
}

// killDedicatedChrome SIGKILLs the dedicated-profile Chrome and waits up to ~10s
// for it to actually exit. Returns true if it is gone. NEVER touches any Chrome
// without the dedicated --user-data-dir.
func killDedicatedChrome(profileDir string) bool {
	for _, pid := range dedicatedChromePIDs(profileDir) {
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
	for i := 0; i < 10; i++ {
		if len(dedicatedChromePIDs(profileDir)) == 0 {
			return true
		}
		time.Sleep(1 * time.Second)
	}
	return len(dedicatedChromePIDs(profileDir)) == 0
}

// clearSingletonLocks removes the profile lock files a SIGKILLed Chrome leaves
// behind, which would otherwise make a relaunch hand off to (a non-existent)
// running instance instead of binding the debug port.
func clearSingletonLocks(profileDir string) {
	for _, f := range []string{"SingletonLock", "SingletonSocket", "SingletonCookie"} {
		_ = os.Remove(filepath.Join(profileDir, f))
	}
}

// launchDedicatedChrome starts the dedicated Chrome with the remote-debugging port
// and a REA startup URL (whose native nav clears Kasada), detached, and waits for
// the CDP port to answer. It is the port of the shell's warm_chrome.
func launchDedicatedChrome(cfg chromeConfig) error {
	port, err := chromeCDPPort(cfg.cdpURL)
	if err != nil {
		return err
	}
	cmd := exec.Command(cfg.bin,
		"--remote-debugging-port="+port,
		"--user-data-dir="+cfg.profileDir,
		cfg.startURL,
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} // detach from the collector
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start dedicated Chrome: %w", err)
	}
	_ = cmd.Process.Release()
	// Give Chrome's native startup nav time to bind the port + clear Kasada.
	for i := 0; i < 12; i++ {
		time.Sleep(2 * time.Second)
		if chromeReachable(cfg.cdpURL) {
			return nil
		}
	}
	return nil // reachability is re-checked by the caller; don't hard-fail here
}

// recoverWedgedChrome hard-resets a wedged dedicated Chrome (CDP answers but hands
// out no context): SIGKILL, confirm gone, clear locks, relaunch. Port of the
// shell's recover_wedged_chrome — if Chrome won't die it does NOT relaunch (avoids
// a second instance on the profile).
func recoverWedgedChrome(cfg chromeConfig) error {
	if !killDedicatedChrome(cfg.profileDir) {
		return fmt.Errorf("dedicated Chrome still alive after SIGKILL — not relaunching (would fork a second instance)")
	}
	clearSingletonLocks(cfg.profileDir)
	return launchDedicatedChrome(cfg)
}
```

- [ ] **Step 2: Verify it compiles + existing tests still pass**

Run: `cd services/house-price-collector && go build ./... && go test -run 'TestChrome|TestMatch|TestLoadChrome|TestEnsureChromeWarm' ./...`
Expected: build OK; PASS.

- [ ] **Step 3: Commit**

```bash
git add services/house-price-collector/crawl_chrome.go
git commit -m "feat(collector): live dedicated-Chrome ops (reachable/kill/clear/launch/recover) (C1)"
```

---

## Task 6: Wire the preflight + fetcher-init recovery into `runAgent`

**Files:**
- Modify: `services/house-price-collector/crawl_agent.go:444-468` (`runAgent`)

- [ ] **Step 1: Add the preflight before the fetcher is built**

In `runAgent`, immediately after `cfg := loadListingsConfig()` (currently line 451) and before the `var fetcher crawlFetcher` block, insert:

```go
	// Self-warm the dedicated Chrome before crawling (in-process port of
	// run-housing-agent.sh). Skipped for FIXTURE runs (no browser) and when
	// CRAWL_AUTO_WARM=false or no CDP URL is configured. On failure, exit 4 so an
	// unattended scheduler re-runs after a cooldown.
	if cfg.fixtureDir == "" {
		if ccfg := loadChromeConfig(cfg.cdpURL); ccfg.autoWarm && ccfg.cdpURL != "" {
			deps := chromeDeps{
				reachable: chromeReachable,
				launch:    launchDedicatedChrome,
				recover:   recoverWedgedChrome,
				warmProbe: func() int { return runWarmCheck(ctx, pool) },
			}
			if err := ensureChromeWarm(ccfg, deps); err != nil {
				log.Printf("[agent] self-warm failed (%v) — exiting for re-warm (exit 4)", err)
				return 4
			}
			log.Printf("[agent] dedicated Chrome warm (self-managed)")
		}
	}
```

Note: `cfg` here is the `listingsConfig` from `loadListingsConfig()`, which embeds `crawlConfig` — so `cfg.cdpURL` and `cfg.fixtureDir` are valid fields (see `crawl_listings.go:62`).

- [ ] **Step 2: Add recover-and-retry around the fetcher init**

Replace the existing fetcher-init block (`crawl_agent.go:456-467`, the `else { f, err := newCrawlFetcher(...) ... }`) with a version that hard-recovers once if the fetcher still can't get a context:

```go
	} else {
		f, err := newCrawlFetcher(cfg.crawlConfig)
		if err != nil {
			// The warm preflight passed but the host Chrome lost its context between
			// probe and crawl (a closed tab). Hard-recover once, then retry — mirrors
			// the shell runner's agent-rc4 retry so an unattended run self-heals.
			log.Printf("[agent] crawl fetcher init failed (%v) — hard-recovering Chrome and retrying", err)
			if ccfg := loadChromeConfig(cfg.cdpURL); ccfg.cdpURL != "" {
				_ = recoverWedgedChrome(ccfg)
			}
			f, err = newCrawlFetcher(cfg.crawlConfig)
			if err != nil {
				log.Printf("[agent] crawl fetcher init failed after recovery (%v) — exit 4", err)
				return 4
			}
		}
		fetcher = f
	}
```

- [ ] **Step 3: Verify it compiles + all collector tests pass**

Run: `cd services/house-price-collector && go build ./... && go test ./...`
Expected: build OK; existing agent tests (`crawl_agent_test.go`, `crawl_agent_retry_test.go`) + the new chrome tests PASS. (The agent tests use FIXTURE mode / no CDP URL, so the preflight is skipped — confirm no test regressed.)

- [ ] **Step 4: Commit**

```bash
git add services/house-price-collector/crawl_agent.go
git commit -m "feat(collector): runAgent self-warms Chrome + recovers fetcher init (C1)"
```

---

## Task 7: Local live verification (manual — no browser in CI)

**Files:** none (verification only).

- [ ] **Step 1: Prove a COLD start self-warms**

Ensure no dedicated Chrome is running (`pkill -f '.shorted-housing-crawl-chrome'` if needed), then run a tiny real batch against the prod queue with a small cap:

```bash
cd services/house-price-collector
DB=$(grep -E '^DATABASE_URL=' ../.env | head -1 | cut -d= -f2- | tr -d '"' | sed 's/:5432/:6543/')
env DATABASE_URL="$DB" \
    CRAWL_CDP_URL=http://localhost:9333 \
    CRAWL_AGENT_MAX_JOBS=2 \
    CRAWL_DRY_RUN=true \
    BRANDBRAIN_AGENT_URL=https://api.brandbrain.dev \
    go run . -mode agent 2>&1 | grep -E 'self-warm|warm \(self-managed\)|warmcheck|job .* →'
```

Expected: logs show `chrome unreachable ... auto-launching`, then `dedicated Chrome warm (self-managed)`, then it claims + crawls (DRY, no writes). Confirms the collector self-warmed a cold Chrome with no shell wrapper.

- [ ] **Step 2: Prove a WEDGED Chrome recovers**

With the dedicated Chrome running, close all its tabs (or `kill -9` a renderer to wedge it), then re-run the same command. Expected: a `warm probe rc=4 (Chrome wedged) — hard-recovering` line followed by a successful warm + crawl.

- [ ] **Step 3: Confirm the personal Chrome was untouched**

`ps -axww | grep -c 'Application Support/Google/Chrome'` before and after — the count of personal-profile Chrome processes must be unchanged.

Document the outcomes (paste the key log lines) in the PR description. No commit.

---

## Task 8: Note the collector self-warms; make the shell wrapper a fallback

**Files:**
- Modify: `services/house-price-collector/deploy/run-housing-agent.sh` (header comment only)
- Modify: `docs/housing-architecture.md` (the crawl-ops section that references the wrapper)

- [ ] **Step 1: Update the shell script header**

Add a note near the top of `run-housing-agent.sh` (after the existing purpose comment) stating that `-mode agent` now self-warms in-process (Task C1), so the script's warm/recover steps are a **belt-and-braces fallback** for older binaries / non-collector schedulers; a current binary no-ops the redundant warm because `ensureChromeWarm` already ran.

```bash
# NOTE (C1, 2026-07): `house-price-collector -mode agent` now SELF-WARMS the
# dedicated Chrome in-process (crawl_chrome.go). This wrapper's warm/recover
# steps are now a belt-and-braces fallback for older binaries or non-collector
# schedulers; with a current binary they are redundant (the collector re-checks
# reachability + warmth itself). The wrapper stays valid for headless/server use.
```

- [ ] **Step 2: Update the architecture doc**

In `docs/housing-architecture.md`, find the §6 crawl-ops paragraph that describes `run-housing-crawl.sh` / `run-housing-agent.sh` as the self-healing launcher and add one sentence: the self-warm now lives in the collector binary (`crawl_chrome.go`, `-mode agent`), so the macOS/scheduler path no longer depends on the shell wrapper for warming.

- [ ] **Step 3: Commit**

```bash
git add services/house-price-collector/deploy/run-housing-agent.sh docs/housing-architecture.md
git commit -m "docs(collector): note -mode agent self-warms; wrapper is now fallback (C1)"
```

---

## Definition of done (C1)

- `go test ./...` passes in `services/house-price-collector` (new chrome unit tests + unchanged agent tests).
- `-mode agent` self-warms a cold Chrome and recovers a wedged one locally (Task 7), with the personal Chrome provably untouched.
- The shell wrapper + docs note the collector self-warms.
- Ship: PR from `feat/housing-crawl-agent-bundle` (collector changes only) → review → merge. The interim `/tmp/housing-drain.sh` loop and any server/launchd path immediately benefit (each `-mode agent` call now self-warms).

## Follow-up (separate plan — brandbrain repo)

C2–C5 (DMG cross-repo bundle → Swift `HousingCrawlSupervisor` + Keychain → Real-estate tab UI → validation/observability) will be planned once C1 is merged and the brandbrain `canvas-asset-sets` panel branch is on `main`. They consume C1's self-warming binary — the app just spawns `-mode agent` and the binary handles Chrome.
