package main

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
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
	for line := range strings.SplitSeq(psOutput, "\n") {
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
// they are chromeReachable / launchDedicatedChrome / recoverWedgedChrome, a
// warmProbe backed by runWarmCheck, and the osChromeDeps lookups.
type chromeDeps struct {
	reachable func(cdpURL string) bool
	launch    func(cfg chromeConfig) error
	recover   func(cfg chromeConfig) error
	warmProbe func() int // 0=warm, 4=wedged/unusable, 5=reachable-but-Kasada-stub
	// Port ownership and the stale-instance kill. listeners is lsof's LISTEN set
	// for a port, dedicated the dedicated-profile PIDs, command a PID's command
	// line (for the log), kill killDedicatedChrome.
	listeners func(port string) []int
	dedicated func(profileDir string) []int
	command   func(pid int) string
	kill      func(profileDir string) bool
}

// osChromeDeps are the production lookups behind the port-ownership check.
func osChromeDeps() chromeDeps {
	return chromeDeps{listeners: listCDPListeners, dedicated: dedicatedChromePIDs, command: processCommand, kill: killDedicatedChrome}
}

const warmMaxAttempts = 2

// errChromePortConflict: a process other than the dedicated Chrome holds the CDP
// port. It is never launched over or killed, because it is not ours to stop.
var errChromePortConflict = errors.New("CDP port held by another process")

// ensureChromeWarm guarantees the dedicated Chrome is reachable over CDP and its
// REA/Kasada session is warm before a crawl runs — the in-process port of
// run-housing-agent.sh steps 1-2. Returns an error (mapped by the caller to a
// re-warm exit) if Chrome can't be made reachable or warm within the bounds.
func ensureChromeWarm(cfg chromeConfig, deps chromeDeps) error {
	// 0. Someone else owns the port: refuse before trusting or launching anything.
	if err := checkCDPPortOwner(cfg, deps); err != nil {
		return err
	}

	// 1. Reachable at all — auto-launch rather than requiring a human.
	if !deps.reachable(cfg.cdpURL) {
		// A dedicated-profile Chrome that is running but not answering on this port is a
		// stale instance (on another port, or bound to one address family only). Launching
		// over it hands off to that instance and never binds, so kill it first.
		if stale := deps.dedicated(cfg.profileDir); len(stale) > 0 {
			log.Printf("[agent] dedicated Chrome %v is running but not answering on %s — killing it before relaunch", stale, cfg.cdpURL)
			if !deps.kill(cfg.profileDir) {
				return fmt.Errorf("dedicated Chrome still alive after SIGKILL — not relaunching (would fork a second instance)")
			}
			clearSingletonLocks(cfg.profileDir)
		}
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

	// rc 8 is the ONE outcome no Chrome action can improve: the Playwright driver
	// is missing, so every browser client fails to construct. Recovering here
	// SIGKILLs a Chrome that is not at fault — and when it is the warm one, throws
	// away a Kasada clearance that only a native REA startup navigation can earn.
	// That is what the 2026-08-13 outage did twice a run for two days.
	if rc == exitCrawlEnvBroken {
		return errCrawlEnvBroken
	}

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

// checkCDPPortOwner refuses with errChromePortConflict when any process listening on the
// loopback CDP port is not the dedicated Chrome. It launches nothing and kills nothing: the
// holder is the operator's, and the fix is theirs (free the port or move CRAWL_CDP_URL). A
// remote CDP host is not checked, because lsof only sees this machine's listeners.
func checkCDPPortOwner(cfg chromeConfig, deps chromeDeps) error {
	if !loopbackCDP(cfg.cdpURL) {
		return nil
	}
	port, err := chromeCDPPort(cfg.cdpURL)
	if err != nil {
		return nil // no usable port: the launch and reachability checks report it
	}
	listeners := deps.listeners(port)
	if len(listeners) == 0 {
		return nil
	}
	dedicated := deps.dedicated(cfg.profileDir)
	for _, pid := range listeners {
		if slices.Contains(dedicated, pid) {
			continue
		}
		cmd := deps.command(pid)
		if len(cmd) > 120 {
			cmd = cmd[:120] + "..."
		}
		log.Printf("[agent] CDP port %s is held by another process (pid %d: %s) — not launching; free the port or set CRAWL_CDP_URL to a free loopback port", port, pid, cmd)
		return fmt.Errorf("%w: port %s, pid %d (%s)", errChromePortConflict, port, pid, cmd)
	}
	return nil
}

// listCDPListeners returns the PIDs LISTENING on a TCP port (IPv4 and IPv6). A failed
// lookup reads as no listeners, so the check stays advisory where lsof is absent.
func listCDPListeners(port string) []int {
	out, _ := exec.Command("/usr/sbin/lsof", "-nP", "-iTCP:"+port, "-sTCP:LISTEN", "-t").Output()
	var pids []int
	for line := range strings.SplitSeq(string(out), "\n") {
		if pid, err := strconv.Atoi(strings.TrimSpace(line)); err == nil {
			pids = append(pids, pid)
		}
	}
	return pids
}

// processCommand returns a PID's command line, or "" if it has already exited.
func processCommand(pid int) string {
	out, err := exec.Command("/bin/ps", "-o", "command=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
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
	// A single kill pass is not enough on a profile with background-capable
	// extensions: Chrome RESURRECTS itself windowless (--no-startup-window) after
	// the kill, so the old wait loop just watched new PIDs appear and gave up with
	// "still alive — not relaunching", leaving the profile permanently wedged.
	// Re-kill anything that comes back, so recovery ends with Chrome actually gone
	// and our own launch (which passes --disable-background-mode) is the one that
	// sticks.
	for i := range chromeKillRounds {
		pids := dedicatedChromePIDs(profileDir)
		if len(pids) == 0 {
			return true
		}
		if i > 0 {
			log.Printf("[chrome] dedicated Chrome came back after SIGKILL (%d pid(s)) — re-killing (round %d/%d)", len(pids), i+1, chromeKillRounds)
		}
		for _, pid := range pids {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
		time.Sleep(time.Second)
	}
	return len(dedicatedChromePIDs(profileDir)) == 0
}

// chromeKillRounds bounds the re-kill loop above. Enough to outlast Chrome's
// background-mode relaunch, low enough that a genuinely unkillable Chrome still
// fails fast rather than spinning.
const chromeKillRounds = 12

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
		// Chrome's BACKGROUND MODE is what makes this profile un-warmable. The
		// profile has accumulated extensions, and any extension with background
		// permission keeps Chrome alive after its last window closes — and
		// resurrects it, windowless, after a kill. Observed live: after SIGKILL a
		// Chrome reappeared as
		//   Google Chrome --no-startup-window --remote-debugging-port=9333 --user-data-dir=...
		// with flags this code never passes and NO startURL, exposing zero `page`
		// targets (only a background_page and 6 extension service workers).
		//
		// That is precisely the wedged state, and it is self-sustaining: the CDP
		// port answers, so ensureChromeWarm's reachability check passes and never
		// launches; the warm probe then finds no usable context, recovers by
		// killing Chrome, and Chrome resurrects windowless again. The loop also
		// silently discards any launch flag we add, which is why an off-screen or
		// re-warmed window would never actually appear.
		"--disable-background-mode",
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
	if _, err := startDetachedReaped(cfg.bin, chromeLaunchArgs(cfg, port)); err != nil {
		return fmt.Errorf("start dedicated Chrome: %w", err)
	}
	// Give Chrome's native startup nav time to bind the port + clear Kasada.
	for range 12 {
		time.Sleep(2 * time.Second)
		if chromeReachable(cfg.cdpURL) {
			return nil
		}
	}
	return nil // reachability is re-checked by the caller; don't hard-fail here
}

// startDetachedReaped starts bin in its own session and returns its pid. A goroutine waits for
// it, so the process is reaped when it exits and no zombie is left under the collector. The
// session is what keeps the browser alive after the collector is gone. Process.Release, which
// this replaced, never reaped, and a launched Chrome stayed a zombie until the collector exited
// (batch 1, minor fixes).
func startDetachedReaped(bin string, args []string) (int, error) {
	cmd := exec.Command(bin, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} // detach from the collector
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	pid := cmd.Process.Pid
	go func() { _ = cmd.Wait() }()
	return pid, nil
}

// recoverWedgedChrome hard-resets a wedged dedicated Chrome (CDP answers but hands
// out no context): SIGKILL, confirm gone, clear locks, relaunch. Port of the
// shell's recover_wedged_chrome — if Chrome won't die it does NOT relaunch (avoids
// a second instance on the profile).
func recoverWedgedChrome(cfg chromeConfig) error {
	// A foreign holder of the port is never killed, and relaunching would only hand off to
	// it. recover is also reached without ensureChromeWarm (the repair path), so check here.
	if err := checkCDPPortOwner(cfg, osChromeDeps()); err != nil {
		return err
	}
	if !killDedicatedChrome(cfg.profileDir) {
		return fmt.Errorf("dedicated Chrome still alive after SIGKILL — not relaunching (would fork a second instance)")
	}
	clearSingletonLocks(cfg.profileDir)
	return launchDedicatedChrome(cfg)
}
