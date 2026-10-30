package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// quitFake is every side effect the cycle-end quit reaches, recorded in call order. It never touches
// lsof, ps, a signal, a launch or a socket.
type quitFake struct {
	mu        sync.Mutex
	calls     []string
	pids      []int // the dedicated PIDs the lookup reports
	dedErr    error // a failing ps lookup
	reach     bool  // whether the CDP port answers
	listeners []cdpListener
	foreign   bool // the port's listener is not the dedicated Chrome
	// closeRemoves makes Browser.close end the dedicated Chrome. Otherwise only kill does.
	closeRemoves bool
	closeErr     error
	killOK       bool
}

func (f *quitFake) note(s string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, s)
}

func (f *quitFake) snapshot() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

// deps returns the fake as chromeDeps. Launch and recover are stubbed to a recording refusal, so a
// test shows a relaunch if one ever happens.
func (f *quitFake) deps(profile string) chromeDeps {
	return chromeDeps{
		reachable: func(string) bool { return f.reach },
		listeners: func(string) ([]cdpListener, error) {
			return f.listeners, nil
		},
		command: func(int) (string, error) {
			if f.foreign {
				return foreignCommand(foreignTestPID), nil
			}
			return dedicatedCommand(profile), nil
		},
		dedicated: func(string) ([]int, error) {
			f.note("dedicated")
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.dedErr != nil {
				return nil, f.dedErr
			}
			return append([]int(nil), f.pids...), nil
		},
		closeBrowser: func(string) error {
			f.note("close")
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.closeRemoves {
				f.pids = nil
			}
			return f.closeErr
		},
		kill: func(string) bool {
			f.note("kill")
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.killOK {
				f.pids = nil
			}
			return f.killOK
		},
		rss:    func([]int) (int64, error) { return 300 * 1024 * 1024, nil },
		launch: func(chromeConfig) error { f.note("launch"); return errors.New("launch must not run (test)") },
		recover: func(chromeConfig) error {
			f.note("recover")
			return errors.New("recover must not run (test)")
		},
	}
}

// fastQuit shortens the wait for one test.
func fastQuit(t *testing.T) {
	t.Helper()
	prevWait, prevPoll := chromeQuitWait, chromeQuitPoll
	chromeQuitWait, chromeQuitPoll = 30*time.Millisecond, time.Millisecond
	t.Cleanup(func() { chromeQuitWait, chromeQuitPoll = prevWait, prevPoll })
}

func quitCfg(t *testing.T) chromeConfig {
	t.Helper()
	return chromeConfig{
		cdpURL:     "http://127.0.0.1:9333",
		profileDir: t.TempDir(),
		autoWarm:   true,
		startURL:   "https://www.realestate.com.au/",
	}
}

func indexOfCall(calls []string, s string) int {
	return slices.Index(calls, s)
}

// The order is fixed: the graceful Browser.close first, then the wait, and the SIGKILL only once the
// wait has run out. A Chrome that exits on the close is never killed.
func TestCycleEndQuitsGracefullyBeforeAnyKill(t *testing.T) {
	fastQuit(t)
	f := &quitFake{pids: []int{54121}, reach: true, listeners: wildcardListeners([]int{54121}), closeRemoves: true}
	cfg := quitCfg(t)
	if !quitDedicatedChrome(cfg, f.deps(cfg.profileDir)) {
		t.Fatalf("a Chrome that exits on Browser.close must read as gone")
	}
	calls := f.snapshot()
	if indexOfCall(calls, "kill") >= 0 {
		t.Fatalf("a Chrome that exited on Browser.close must not be killed: %v", calls)
	}
	if indexOfCall(calls, "close") < 0 {
		t.Fatalf("Browser.close never ran: %v", calls)
	}
}

// When the graceful close does not end the process, the wait runs, and only then does the kill run.
func TestCycleEndKillsOnlyAfterTheWaitRunsOut(t *testing.T) {
	fastQuit(t)
	f := &quitFake{pids: []int{54121}, reach: true, listeners: wildcardListeners([]int{54121}), killOK: true}
	cfg := quitCfg(t)
	if !quitDedicatedChrome(cfg, f.deps(cfg.profileDir)) {
		t.Fatalf("the kill fallback that confirms exit must read as gone")
	}
	calls := f.snapshot()
	iClose, iKill := indexOfCall(calls, "close"), indexOfCall(calls, "kill")
	if iClose < 0 || iKill < 0 {
		t.Fatalf("expected close then kill, got %v", calls)
	}
	if iClose > iKill {
		t.Fatalf("the kill ran before the graceful close: %v", calls)
	}
	// Between the close and the kill there must be at least one wait poll.
	polls := 0
	for _, c := range calls[iClose+1 : iKill] {
		if c == "dedicated" {
			polls++
		}
	}
	if polls == 0 {
		t.Fatalf("no wait between the close and the kill: %v", calls)
	}
}

// A ps error means the quit cannot see what it would signal. It sends no graceful close, the kill
// fails closed, nothing is launched and no profile cache is pruned.
func TestCycleEndPsErrorNeverPrunesOrRelaunches(t *testing.T) {
	fastQuit(t)
	f := &quitFake{dedErr: errors.New("ps: exit 1 (test)"), reach: true, killOK: false}
	cfg := quitCfg(t)
	cache := filepath.Join(cfg.profileDir, "Default", "Cache", "data_0")
	mustWrite(t, cache, "cache")
	captureLog(t)
	endCycleChrome(cfg, f.deps(cfg.profileDir))
	calls := f.snapshot()
	if indexOfCall(calls, "close") >= 0 {
		t.Fatalf("with ps unreadable there must be no graceful close: %v", calls)
	}
	if indexOfCall(calls, "launch") >= 0 || indexOfCall(calls, "recover") >= 0 {
		t.Fatalf("a ps error must never relaunch Chrome: %v", calls)
	}
	if _, err := os.Stat(cache); err != nil {
		t.Fatalf("a ps error must never prune the profile: %v", err)
	}
}

// A Chrome that cannot be confirmed gone is never pruned under.
func TestCycleEndNeverPrunesUnderALiveChrome(t *testing.T) {
	fastQuit(t)
	f := &quitFake{pids: []int{54121}, reach: true, listeners: wildcardListeners([]int{54121}), killOK: false}
	cfg := quitCfg(t)
	cache := filepath.Join(cfg.profileDir, "GPUCache", "entry")
	mustWrite(t, cache, "gpu")
	buf := captureLog(t)
	endCycleChrome(cfg, f.deps(cfg.profileDir))
	if _, err := os.Stat(cache); err != nil {
		t.Fatalf("a live Chrome's profile must not be pruned: %v", err)
	}
	if !strings.Contains(buf.String(), "not pruning") {
		t.Fatalf("the skipped prune must be logged, got %q", buf.String())
	}
}

// A foreign process on the CDP port is refused before any signal: no Browser.close, no kill.
func TestCycleEndRefusesForeignHolder(t *testing.T) {
	fastQuit(t)
	f := &quitFake{pids: []int{54121}, reach: true, foreign: true, listeners: wildcardListeners([]int{foreignTestPID}), killOK: true}
	cfg := quitCfg(t)
	captureLog(t)
	if quitDedicatedChrome(cfg, f.deps(cfg.profileDir)) {
		t.Fatalf("a foreign holder must not read as the dedicated Chrome quitting")
	}
	calls := f.snapshot()
	if indexOfCall(calls, "close") >= 0 || indexOfCall(calls, "kill") >= 0 {
		t.Fatalf("a foreign holder must never be signalled: %v", calls)
	}
}

// With nothing running and nothing answering, the quit is a no-op that reads as gone, and the
// profile is pruned.
func TestCycleEndNothingRunningPrunes(t *testing.T) {
	fastQuit(t)
	f := &quitFake{}
	cfg := quitCfg(t)
	mustWrite(t, filepath.Join(cfg.profileDir, "ShaderCache", "s"), "s")
	captureLog(t)
	endCycleChrome(cfg, f.deps(cfg.profileDir))
	if got := f.snapshot(); len(got) != 1 || got[0] != "dedicated" {
		t.Fatalf("with nothing running only the lookup runs, got %v", got)
	}
	if _, err := os.Stat(filepath.Join(cfg.profileDir, "ShaderCache")); !os.IsNotExist(err) {
		t.Fatalf("the cache must be pruned once Chrome is confirmed gone")
	}
}

// CRAWL_AUTO_WARM=false means the collector does not manage Chrome: no quit, no prune.
func TestCycleEndSkippedWhenNotManaged(t *testing.T) {
	fastQuit(t)
	f := &quitFake{pids: []int{54121}, reach: true, killOK: true}
	cfg := quitCfg(t)
	cfg.autoWarm = false
	endCycleChrome(cfg, f.deps(cfg.profileDir))
	if got := f.snapshot(); len(got) != 0 {
		t.Fatalf("an unmanaged Chrome must not be touched, got %v", got)
	}
}

// The prune deletes the allowlisted caches and only those. Cookies, Network, storage and
// preferences stay.
func TestPruneDeletesOnlyAllowlistedCaches(t *testing.T) {
	profile := t.TempDir()
	keep := []string{
		"Default/Network/Cookies",
		"Default/Cookies",
		"Default/Local Storage/leveldb/000003.log",
		"Default/IndexedDB/x.leveldb/000001.ldb",
		"Default/Session Storage/000005.log",
		"Default/Preferences",
		"Local State",
		"Default/Service Worker/Database/j",
	}
	drop := []string{
		"Default/Cache/data_0",
		"Default/Code Cache/js/index",
		"Default/GPUCache/data_0",
		"GPUCache/data_1",
		"ShaderCache/s",
		"GrShaderCache/g",
		"GraphiteDawnCache/h",
		"Default/DawnGraphiteCache/i",
		"Default/DawnWebGPUCache/k",
		"Default/Service Worker/CacheStorage/c",
		"Default/Service Worker/ScriptCache/s",
	}
	for _, p := range append(append([]string{}, keep...), drop...) {
		mustWrite(t, filepath.Join(profile, filepath.FromSlash(p)), "x")
	}
	captureLog(t)
	pruneChromeProfile(profile)
	for _, p := range keep {
		if _, err := os.Stat(filepath.Join(profile, filepath.FromSlash(p))); err != nil {
			t.Errorf("prune removed %s, which must be kept: %v", p, err)
		}
	}
	for _, p := range drop {
		if _, err := os.Stat(filepath.Join(profile, filepath.FromSlash(p))); !os.IsNotExist(err) {
			t.Errorf("prune kept %s, which is an allowlisted cache", p)
		}
	}
}

// The allowlist can never name cookies, the network state, storage or preferences, whatever is
// added to it later.
func TestPruneAllowlistNeverNamesProtectedState(t *testing.T) {
	protected := []string{
		"Default/Network", "Default/Cookies", "Cookies", "Default/Local Storage",
		"Default/IndexedDB", "Default/Session Storage", "Default/Preferences", "Local State",
	}
	for _, rel := range chromeCacheAllowlist {
		for _, p := range protected {
			if rel == p || strings.HasPrefix(rel, p+"/") || strings.HasPrefix(p, rel+"/") {
				t.Fatalf("allowlist entry %q overlaps protected %q", rel, p)
			}
		}
	}
}

// The prune never follows a symlink. A cache directory that is a link out of the profile, and a
// cache that is a plain file, are skipped, and the directory they point at is not emptied.
func TestPruneIsSymlinkSafe(t *testing.T) {
	profile := t.TempDir()
	outside := t.TempDir()
	victim := filepath.Join(outside, "precious.txt")
	mustWrite(t, victim, "keep me")
	if err := os.MkdirAll(filepath.Join(profile, "Default"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(profile, "Default", "Cache")); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(profile, "GPUCache"), "a file, not a dir")
	if err := os.MkdirAll(filepath.Join(outside, "SW"), 0o700); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(outside, "SW", "CacheStorage"), "outside")
	if err := os.Symlink(filepath.Join(outside, "SW"), filepath.Join(profile, "Default", "Service Worker")); err != nil {
		t.Fatal(err)
	}
	captureLog(t)
	pruneChromeProfile(profile)
	if _, err := os.Stat(victim); err != nil {
		t.Fatalf("a symlinked cache must not be followed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "SW", "CacheStorage")); err != nil {
		t.Fatalf("a symlinked parent must not be followed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(profile, "GPUCache")); err != nil {
		t.Fatalf("a non-directory in place of a cache must be left alone: %v", err)
	}
}

// A profile that is itself a symlink is not pruned at all.
func TestPruneRefusesSymlinkedProfile(t *testing.T) {
	real := t.TempDir()
	mustWrite(t, filepath.Join(real, "ShaderCache", "s"), "s")
	link := filepath.Join(t.TempDir(), "profile")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	buf := captureLog(t)
	pruneChromeProfile(link)
	if _, err := os.Stat(filepath.Join(real, "ShaderCache", "s")); err != nil {
		t.Fatalf("a symlinked profile must not be pruned: %v", err)
	}
	if !strings.Contains(buf.String(), "not a real directory") {
		t.Fatalf("the refusal must be logged, got %q", buf.String())
	}
}

// The cycle-end step is on only in cycle mode. persistent keeps today's behaviour, and an unknown
// value falls back to the default.
func TestChromeLifecycleModes(t *testing.T) {
	captureLog(t)
	cases := map[string]bool{
		"":             true,
		"cycle":        true,
		"CYCLE":        true,
		"persistent":   false,
		" Persistent ": false,
		"bogus":        true,
	}
	for v, want := range cases {
		got := chromeLifecycleIsCycle(func(k string) string {
			if k == chromeLifecycleEnv {
				return v
			}
			return ""
		})
		if got != want {
			t.Errorf("CRAWL_CHROME_LIFECYCLE=%q: cycle=%v, want %v", v, got, want)
		}
	}
}

// Persistent mode runs no quit and no prune, even with a Chrome running and a profile to clean.
// The mode check is the only gate in front of endCycleChrome.
func TestPersistentModeLeavesChromeAndCachesAlone(t *testing.T) {
	t.Setenv(chromeLifecycleEnv, "persistent")
	if chromeLifecycleIsCycle(os.Getenv) {
		t.Fatalf("persistent must turn the cycle end off")
	}
}

// Preflight takes no lock and never reaches the cycle end: it stays read-only.
func TestPreflightNeverRunsTheCycleEnd(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{})
	calls := 0
	h.deps.cycleEnd = func() { calls++ }
	h.cfg.job = cycleJobPreflight
	c := newCycleRunner(h.cfg, h.deps)
	c.dispatch()
	if calls != 0 {
		t.Fatalf("preflight ran the cycle end %d time(s)", calls)
	}
}

// A drain runs the cycle end once, after its work and before the lock is released.
func TestDrainRunsTheCycleEndUnderTheLock(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{})
	var calls []string
	h.deps.cycleEnd = func() {
		calls = append(calls, "end:"+inspectLock(h.lockDir))
	}
	c := newCycleRunner(h.cfg, h.deps)
	out, code := c.withLock(cycleJobDrain, func() (string, int) {
		calls = append(calls, "work")
		return outQueueEmpty, 0
	})
	if out != outQueueEmpty || code != 0 {
		t.Fatalf("the work's outcome must pass through: %s/%d", out, code)
	}
	want := []string{"work", "end:held_elsewhere"}
	if !slices.Equal(calls, want) {
		t.Fatalf("order = %v, want %v (the cycle end runs while the cycle still holds the lock)", calls, want)
	}
	if inspectLock(h.lockDir) != lockFree {
		t.Fatalf("the lock must be released after the cycle end")
	}
}

// The launch flag caps the disk cache, and the start URL stays last.
func TestChromeLaunchArgsCapDiskCache(t *testing.T) {
	cfg := chromeConfig{profileDir: "/p", startURL: "https://www.realestate.com.au/"}
	args := chromeLaunchArgs(cfg, "9333")
	if !slices.Contains(args, "--disk-cache-size=268435456") {
		t.Fatalf("missing the 256 MiB disk-cache cap: %v", args)
	}
	if args[len(args)-1] != cfg.startURL {
		t.Fatalf("the start URL must stay last, got %v", args)
	}
}

// The graceful close speaks CDP Browser.close over the browser socket, and only to loopback.
func TestCloseDedicatedBrowserSendsBrowserClose(t *testing.T) {
	var got struct {
		ID     int    `json:"id"`
		Method string `json:"method"`
	}
	done := make(chan struct{})
	upgrader := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/json/version":
			_ = json.NewEncoder(w).Encode(map[string]string{
				"webSocketDebuggerUrl": fmt.Sprintf("ws://%s/devtools/browser/test", r.Host),
			})
		case "/devtools/browser/test":
			conn, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer func() { _ = conn.Close() }()
			_ = conn.ReadJSON(&got)
			close(done)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	if err := closeDedicatedBrowserCDP(srv.URL); err != nil {
		t.Fatalf("close: %v", err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("the browser socket never saw a message")
	}
	if got.Method != "Browser.close" {
		t.Fatalf("method = %q, want Browser.close", got.Method)
	}
}

// A browser socket that is not loopback is refused before anything is dialled.
func TestCloseDedicatedBrowserRefusesRemoteSocket(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"webSocketDebuggerUrl": "ws://203.0.113.9:9333/devtools/browser/x"})
	}))
	defer srv.Close()
	if err := closeDedicatedBrowserCDP(srv.URL); err == nil || !strings.Contains(err.Error(), "not loopback") {
		t.Fatalf("a remote browser socket must be refused, got %v", err)
	}
}

func mustWrite(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}
