package main

import (
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
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

// matchDedicatedPIDs returns the PIDs from `ps -axww -o pid=,command=` output whose
// command line contains the EXACT `--user-data-dir=<profileDir>` flag. This is the
// only Chrome that carries the dedicated data dir, so the personal Chrome is never
// matched. An empty profileDir matches nothing (never "every Chrome"). Lines that
// are the grep/ps pipeline itself are excluded. The flag value must end exactly at
// profileDir — a bare substring match would also catch a sibling profile whose path
// merely has profileDir as a prefix (e.g. "...-backup"), which must NEVER be killed.
func matchDedicatedPIDs(psOutput, profileDir string) []int {
	if strings.TrimSpace(profileDir) == "" {
		return nil
	}
	needle := "--user-data-dir=" + profileDir
	var pids []int
	for _, line := range strings.Split(psOutput, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		idx := strings.Index(line, needle)
		if idx < 0 {
			continue
		}
		// The flag value must end here: the next character (if any) must be
		// whitespace, not more path (e.g. a "-backup" sibling profile dir).
		after := idx + len(needle)
		if after < len(line) && line[after] != ' ' && line[after] != '\t' {
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

// chromeConfig is the dedicated-Chrome lifecycle config for -mode agent.
type chromeConfig struct {
	bin        string // HOUSING_CRAWL_CHROME_BIN — Chrome executable
	profileDir string // HOUSING_CRAWL_CHROME_PROFILE — dedicated --user-data-dir
	cdpURL     string // from crawlConfig.cdpURL (CRAWL_CDP_URL)
	autoWarm   bool   // CRAWL_AUTO_WARM (default true) — self-warm before crawling.
	// NOTE: not read anywhere in this file — it gates the ensureChromeWarm
	// preflight call from the runAgent caller (Task 6), not crawl_chrome.go itself.
	startURL string // REA startup URL whose native nav clears Kasada
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

// chromeReachable reports whether the CDP endpoint answers /json/version.
func chromeReachable(cdpURL string) bool {
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(strings.TrimRight(cdpURL, "/") + "/json/version")
	if err != nil {
		return false
	}
	defer func() { _ = resp.Body.Close() }()
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

// chromeLaunchArgs builds the dedicated Chrome command line.
//
// The warm window is positioned OFF-SCREEN by default so an unattended rig does
// not have Chrome windows appearing and stealing focus every time a sweep
// re-warms. It cannot simply run headless: headless is reliably detected, and
// this whole tier depends on Chrome's own NATIVE startup navigation clearing
// Kasada (a Playwright-driven nav does not). So the window stays real, natively
// navigated and rendered at a normal viewport — it just sits outside the visible
// desktop.
//
// Verified rather than assumed: a COLD profile launched at -32000,-32000 with a
// 1440x900 viewport loaded live REA and warmcheck reported
// "REA warm (1542006 bytes, ArgonautExchange present)" — the same clearance an
// on-screen window gets.
//
// HOUSING_CRAWL_CHROME_ONSCREEN=true restores an on-desktop window, which is what
// you want when debugging a warm that will not clear. The startURL MUST stay last:
// Chrome treats the first non-flag argument as the page to open, and that startup
// navigation is the load-bearing part.
func chromeLaunchArgs(cfg chromeConfig, port string) []string {
	args := []string{
		"--remote-debugging-port=" + port,
		"--user-data-dir=" + cfg.profileDir,
	}
	if !truthyEnv("HOUSING_CRAWL_CHROME_ONSCREEN") {
		args = append(args,
			"--window-position="+envStr("HOUSING_CRAWL_CHROME_POSITION", "-32000,-32000"),
			"--window-size="+envStr("HOUSING_CRAWL_CHROME_SIZE", "1440,900"),
		)
	}
	return append(args, cfg.startURL)
}

// launchDedicatedChrome starts the dedicated Chrome with the remote-debugging port
// and a REA startup URL (whose native nav clears Kasada), detached, and waits for
// the CDP port to answer. It is the port of the shell's warm_chrome.
func launchDedicatedChrome(cfg chromeConfig) error {
	port, err := chromeCDPPort(cfg.cdpURL)
	if err != nil {
		return err
	}
	cmd := exec.Command(cfg.bin, chromeLaunchArgs(cfg, port)...)
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
