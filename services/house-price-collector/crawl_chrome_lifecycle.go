package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// crawl_chrome_lifecycle.go is the dedicated Chrome's end-of-cycle quit and its disk hygiene.
//
// With CRAWL_CHROME_LIFECYCLE=cycle (the default) the cycle parent quits the dedicated Chrome after
// its last round, so no browser lingers between cycles. The next cycle's ensureChromeWarm launches it
// fresh, and the native startup navigation re-warms Kasada. The quit is graceful first: Browser.close
// lets Chrome flush its cookie database, and a SIGKILL can lose the Kasada clearance cookie. The kill
// (killDedicatedChrome) is only the fallback, and it fails closed when ps is unreadable.
//
// Only a dedicated-profile Chrome is ever quit or pruned. A holder of the CDP port that is not ours
// is refused before anything is sent to it (checkCDPPortOwner). CRAWL_CHROME_LIFECYCLE=persistent
// keeps the old behaviour.

const chromeLifecycleEnv = "CRAWL_CHROME_LIFECYCLE"

// chromeQuitWait bounds the wait for the dedicated PIDs to vanish after Browser.close; chromeQuitPoll
// is the poll interval. Tests shorten both.
var (
	chromeQuitWait = 15 * time.Second
	chromeQuitPoll = 500 * time.Millisecond
)

// chromeCacheAllowlist is every directory the cycle-end prune may delete, relative to the profile.
// These hold only rebuildable caches. It must never name Default/Network (the cookie database lives
// there in current Chrome), Default/Cookies, Local Storage, IndexedDB, Session Storage, Preferences
// or Local State. A test pins that.
var chromeCacheAllowlist = []string{
	"Default/Cache",
	"Default/Code Cache",
	"Default/GPUCache",
	"GPUCache",
	"ShaderCache",
	"GrShaderCache",
	"GraphiteDawnCache",
	"Default/DawnGraphiteCache",
	"Default/DawnWebGPUCache",
	"Default/Service Worker/CacheStorage",
	"Default/Service Worker/ScriptCache",
}

// chromeLifecycleIsCycle reports whether the cycle parent quits Chrome at its end. persistent turns
// it off. Unset or cycle is the default. Any other value is logged and treated as the default.
func chromeLifecycleIsCycle(getenv func(string) string) bool {
	switch v := strings.ToLower(strings.TrimSpace(getenv(chromeLifecycleEnv))); v {
	case "persistent":
		return false
	case "", "cycle":
		return true
	default:
		log.Printf("[chrome] %s=%q is not cycle or persistent — using cycle", chromeLifecycleEnv, v)
		return true
	}
}

// defaultCycleEndChrome is the production cycle-end step, run by the cycle parent after its last
// round. It does nothing in persistent mode, outside CDP mode, or with CRAWL_AUTO_WARM=false.
func defaultCycleEndChrome() {
	if !chromeLifecycleIsCycle(os.Getenv) {
		return
	}
	cfg := loadListingsConfig()
	if selectFetcherMode(cfg.crawlConfig) != fetcherModeCDP {
		return
	}
	endCycleChrome(loadChromeConfig(cfg.cdpURL), chromeDepsForDefaults())
}

// endCycleChrome quits the dedicated Chrome and, only once it is confirmed gone, prunes the profile's
// caches. A Chrome that cannot be confirmed gone is never pruned under.
func endCycleChrome(cfg chromeConfig, deps chromeDeps) {
	if !cfg.autoWarm {
		return
	}
	deps = deps.withOSDefaults()
	if !quitDedicatedChrome(cfg, deps) {
		log.Printf("[chrome] dedicated Chrome is still running after the cycle — not pruning its profile")
		return
	}
	pruneChromeProfile(cfg.profileDir)
}

// quitDedicatedChrome ends the dedicated Chrome and reports whether none is left running. The order is
// fixed: log the telemetry, Browser.close over CDP, wait up to chromeQuitWait for the PIDs to go, and
// only then the SIGKILL fallback. A foreign CDP holder is refused before any signal is sent.
func quitDedicatedChrome(cfg chromeConfig, deps chromeDeps) bool {
	pids, perr := deps.dedicated(cfg.profileDir)
	reachable := deps.reachable(cfg.cdpURL)
	if perr == nil && len(pids) == 0 && !reachable {
		return true // nothing is running
	}
	if err := checkCDPPortOwner(cfg, deps, reachable); err != nil {
		log.Printf("[chrome] cycle end: the CDP port is held by another process — not quitting it")
		return false
	}
	switch {
	case perr != nil:
		// Without a PID list the dedicated Chrome cannot be told from a foreign one. Skip the
		// graceful close and let the fail-closed kill decide.
		log.Printf("[chrome] cycle end: cannot list dedicated Chrome (%v) — not sending a graceful quit", perr)
	case len(pids) > 0:
		logCycleEndTelemetry(cfg, deps, pids)
		if reachable {
			if err := deps.closeBrowser(cfg.cdpURL); err != nil {
				log.Printf("[chrome] cycle end: Browser.close failed (%v) — waiting for the process to exit", err)
			}
		}
	}
	if waitForDedicatedGone(cfg, deps) {
		log.Printf("[chrome] cycle end: dedicated Chrome quit gracefully")
		return true
	}
	log.Printf("[chrome] cycle end: dedicated Chrome still running after %s — SIGKILL fallback", chromeQuitWait)
	if !deps.kill(cfg.profileDir) {
		log.Printf("[chrome] cycle end: dedicated Chrome could not be confirmed gone")
		return false
	}
	log.Printf("[chrome] cycle end: dedicated Chrome killed")
	return true
}

// waitForDedicatedGone polls the dedicated PIDs until none remain (true), the wait runs out, or the
// lookup fails (false, so the caller falls back to the fail-closed kill).
func waitForDedicatedGone(cfg chromeConfig, deps chromeDeps) bool {
	deadline := time.Now().Add(chromeQuitWait)
	for {
		pids, err := deps.dedicated(cfg.profileDir)
		if err != nil {
			return false
		}
		if len(pids) == 0 {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(chromeQuitPoll)
	}
}

// logCycleEndTelemetry logs the dedicated Chrome's summed resident memory and the profile size before
// the quit. It is log output only, and an error is reported as unavailable.
func logCycleEndTelemetry(cfg chromeConfig, deps chromeDeps, pids []int) {
	rss, err := deps.rss(pids)
	rssText := "unavailable"
	if err == nil {
		rssText = fmt.Sprintf("%.1f MB", mb(rss))
	}
	log.Printf("[chrome] cycle end: %d dedicated pid(s), RSS %s, profile %.1f MB", len(pids), rssText, mb(dirSizeNoFollow(cfg.profileDir)))
}

// mb converts bytes to MiB for log lines.
func mb(n int64) float64 { return float64(n) / (1024 * 1024) }

// closeDedicatedBrowserCDP sends Browser.close to the dedicated Chrome over its browser-level
// DevTools socket. Chrome answers by closing the socket, so the read error is the expected end. The
// socket is only dialled on a loopback host, the same rule the port checks use.
func closeDedicatedBrowserCDP(cdpURL string) error {
	ctx, cancel := context.WithTimeout(context.Background(), cdpToolTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(cdpURL, "/")+"/json/version", nil)
	if err != nil {
		return err
	}
	resp, err := (&http.Client{Timeout: cdpToolTimeout}).Do(req)
	if err != nil {
		return fmt.Errorf("read /json/version: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	var v struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&v); err != nil {
		return fmt.Errorf("decode /json/version: %w", err)
	}
	u, err := url.Parse(v.WebSocketDebuggerURL)
	if err != nil || v.WebSocketDebuggerURL == "" {
		return fmt.Errorf("no browser websocket in /json/version")
	}
	switch strings.ToLower(u.Hostname()) {
	case "127.0.0.1", "localhost", "::1":
	default:
		return fmt.Errorf("browser websocket %q is not loopback", u.Host)
	}
	dialer := websocket.Dialer{HandshakeTimeout: cdpToolTimeout}
	conn, _, err := dialer.DialContext(ctx, v.WebSocketDebuggerURL, nil)
	if err != nil {
		return fmt.Errorf("dial browser websocket: %w", err)
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetWriteDeadline(time.Now().Add(cdpToolTimeout))
	if err := conn.WriteJSON(map[string]any{"id": 1, "method": "Browser.close"}); err != nil {
		return fmt.Errorf("send Browser.close: %w", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(cdpToolTimeout))
	_, _, _ = conn.ReadMessage()
	return nil
}

// dedicatedChromeRSS sums the resident set size, in bytes, of pids via ps. A pid that has already
// exited contributes nothing; ps exits 1 with no output when none is left.
func dedicatedChromeRSS(pids []int) (int64, error) {
	if len(pids) == 0 {
		return 0, nil
	}
	list := make([]string, 0, len(pids))
	for _, p := range pids {
		list = append(list, strconv.Itoa(p))
	}
	ctx, cancel := context.WithTimeout(context.Background(), cdpToolTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/bin/ps", "-o", "rss=", "-p", strings.Join(list, ",")).Output()
	if ctx.Err() != nil {
		return 0, ctx.Err()
	}
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && ee.ExitCode() == 1 && strings.TrimSpace(string(out)) == "" {
			return 0, nil
		}
		return 0, err
	}
	var total int64
	for line := range strings.SplitSeq(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		kb, err := strconv.ParseInt(line, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("parse rss %q: %w", line, err)
		}
		total += kb * 1024
	}
	return total, nil
}

// pruneChromeProfile deletes the allowlisted cache directories under profileDir. Each path is checked
// component by component with Lstat: a symlink anywhere on it, or a non-directory in place of the
// directory, is skipped and never followed. os.RemoveAll then removes only inside a real directory.
// Callers must only call it once the dedicated Chrome is confirmed gone.
func pruneChromeProfile(profileDir string) {
	fi, err := os.Lstat(profileDir)
	if errors.Is(err, fs.ErrNotExist) {
		return // no profile yet: nothing to prune
	}
	if err != nil || !fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 {
		log.Printf("[chrome] prune skipped: profile %s is not a real directory", profileDir)
		return
	}
	var freed int64
	var removed []string
	for _, rel := range chromeCacheAllowlist {
		present, ok := safeProfileDir(profileDir, rel)
		if !ok {
			log.Printf("[chrome] prune skipped %s: not a plain directory under the profile", rel)
			continue
		}
		if !present {
			continue
		}
		p := filepath.Join(profileDir, filepath.FromSlash(rel))
		size := dirSizeNoFollow(p)
		if err := os.RemoveAll(p); err != nil {
			log.Printf("[chrome] prune %s failed: %v", rel, err)
			continue
		}
		freed += size
		removed = append(removed, rel)
	}
	log.Printf("[chrome] pruned %d cache dir(s), freed %.1f MB; profile now %.1f MB", len(removed), mb(freed), mb(dirSizeNoFollow(profileDir)))
}

// safeProfileDir reports whether rel, joined under root, is absent (present=false, ok=true), or is a
// real directory with no symlink on the way (present=true, ok=true). Anything else is ok=false.
func safeProfileDir(root, rel string) (present, ok bool) {
	cur := root
	parts := strings.Split(rel, "/")
	for _, part := range parts {
		cur = filepath.Join(cur, part)
		fi, err := os.Lstat(cur)
		if errors.Is(err, fs.ErrNotExist) {
			return false, true
		}
		if err != nil || fi.Mode()&os.ModeSymlink != 0 {
			return false, false
		}
		if !fi.IsDir() {
			return false, false
		}
	}
	return true, true
}

// dirSizeNoFollow sums the sizes of regular files under root. It does not follow symlinks, and an
// unreadable entry counts for nothing.
func dirSizeNoFollow(root string) int64 {
	var total int64
	_ = filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d == nil {
			return nil
		}
		if d.Type().IsRegular() {
			if info, ierr := d.Info(); ierr == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total
}
