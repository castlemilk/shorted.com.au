package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

const (
	dedicatedTestPID = 54121 // the dedicated-profile Chrome
	foreignTestPID   = 83542 // the operator's everyday Chrome, remote debugging on
)

// withQuietPort fills the port-ownership deps for tests that are not about the port. Nothing
// listens, and ps cannot list dedicated Chrome. A failed ps lookup reads as "unknown", so the
// invisible-holder rule fails open and no stale instance is seen.
func withQuietPort(d chromeDeps) chromeDeps {
	if d.reachable == nil {
		// Nothing answers /json/version. Without this the re-check would probe the real port.
		d.reachable = func(string) bool { return false }
	}
	if d.listeners == nil {
		d.listeners = func(string) ([]cdpListener, error) { return nil, nil }
	}
	if d.dedicated == nil {
		d.dedicated = func(string) ([]int, error) { return nil, errors.New("ps not stubbed") }
	}
	if d.command == nil {
		d.command = func(int) (string, error) { return "", nil }
	}
	if d.kill == nil {
		d.kill = func(string) bool { return true }
	}
	return d
}

// noReprobeWait removes the stale-instance re-probe pause for one test.
func noReprobeWait(t *testing.T) {
	t.Helper()
	prev := staleReprobeWait
	staleReprobeWait = 0
	t.Cleanup(func() { staleReprobeWait = prev })
}

// captureLog routes the package log to a buffer for one test.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(prev) })
	return &buf
}

func dedicatedCommand(profile string) string {
	return "Google Chrome --remote-debugging-port=9333 --user-data-dir=" + profile + " https://www.realestate.com.au/"
}

func foreignCommand(pid int) string {
	return fmt.Sprintf("Google Chrome --remote-debugging-port=9222 --pid=%d", pid)
}

// wildcardListeners is the LISTEN set for pids bound to every address.
func wildcardListeners(pids []int) []cdpListener {
	var ls []cdpListener
	for _, pid := range pids {
		ls = append(ls, cdpListener{pid: pid, host: "*"})
	}
	return ls
}

// portScenario is one ensureChromeWarm run against a port with the given holders.
type portScenario struct {
	name         string
	cdpURL       string
	listeners    []int  // LISTEN pids, bound to every address
	dedicated    []int  // dedicated-profile Chrome PIDs
	reachable    []bool // answers per call; the last value repeats
	killOK       bool
	wantConflict bool
	wantErr      bool
	wantPort     string // the port the listener lookup was asked about
	wantLaunch   int
	wantKill     int
	wantProbe    int
	wantLocks    bool // the profile's SingletonLock is removed
}

func TestEnsureChromeWarmPortOwnership(t *testing.T) {
	noReprobeWait(t)
	cases := []portScenario{
		{
			name:         "foreign listener while unreachable: conflict, no launch, no kill",
			cdpURL:       "http://localhost:9222",
			listeners:    []int{foreignTestPID},
			reachable:    []bool{false},
			killOK:       true,
			wantConflict: true,
			wantErr:      true,
			wantPort:     "9222",
		},
		{
			name:         "foreign listener while reachable: conflict, no warm probe",
			cdpURL:       "http://localhost:9222",
			listeners:    []int{foreignTestPID},
			reachable:    []bool{true},
			killOK:       true,
			wantConflict: true,
			wantErr:      true,
			wantPort:     "9222",
		},
		{
			name:         "foreign and dedicated listeners: any foreign holder is a conflict",
			cdpURL:       "http://localhost:9222",
			listeners:    []int{dedicatedTestPID, foreignTestPID},
			dedicated:    []int{dedicatedTestPID},
			reachable:    []bool{true},
			killOK:       true,
			wantConflict: true,
			wantErr:      true,
			wantPort:     "9222",
		},
		{
			name:      "127.0.0.1 CDP URL: dedicated listener is warm",
			cdpURL:    "http://127.0.0.1:9333",
			listeners: []int{dedicatedTestPID},
			dedicated: []int{dedicatedTestPID},
			reachable: []bool{true},
			killOK:    true,
			wantPort:  "9333",
			wantProbe: 1,
		},
		{
			name:      "remote CDP host is not checked against local listeners",
			cdpURL:    "http://host.docker.internal:9222",
			listeners: []int{foreignTestPID},
			reachable: []bool{true},
			killOK:    true,
			wantProbe: 1,
		},
		{
			name:       "happy path: nothing listening, launch, then warm",
			cdpURL:     "http://localhost:9333",
			reachable:  []bool{false, true},
			killOK:     true,
			wantLaunch: 1,
			wantProbe:  1,
		},
		{
			name:       "stale dedicated instance on another port: killed, locks cleared, launched",
			cdpURL:     "http://localhost:9333",
			dedicated:  []int{dedicatedTestPID},
			reachable:  []bool{false, false, true}, // initial, re-probe, after launch
			killOK:     true,
			wantKill:   1,
			wantLaunch: 1,
			wantProbe:  1,
			wantLocks:  true,
		},
		{
			name:       "dedicated instance bound to one address family: killed, launched",
			cdpURL:     "http://localhost:9333",
			listeners:  []int{dedicatedTestPID},
			dedicated:  []int{dedicatedTestPID},
			reachable:  []bool{false, false, true},
			killOK:     true,
			wantKill:   1,
			wantLaunch: 1,
			wantProbe:  1,
			wantLocks:  true,
		},
		{
			name:      "stale instance that answers on re-probe is kept, not killed",
			cdpURL:    "http://localhost:9333",
			dedicated: []int{dedicatedTestPID},
			reachable: []bool{false, true}, // a busy warm Chrome that missed the first probe
			killOK:    true,
			wantProbe: 1,
		},
		{
			name:      "stale dedicated instance that will not die: refused, no launch",
			cdpURL:    "http://localhost:9333",
			dedicated: []int{dedicatedTestPID},
			reachable: []bool{false, false},
			killOK:    false,
			wantErr:   true,
			wantKill:  1,
		},
		{
			name:         "port answers, nothing visible, no dedicated Chrome: another user's holder",
			cdpURL:       "http://localhost:9333",
			reachable:    []bool{true},
			killOK:       true,
			wantConflict: true,
			wantErr:      true,
			wantPort:     "9333",
		},
	}
	for _, sc := range cases {
		t.Run(sc.name, func(t *testing.T) {
			captureLog(t)
			profile := t.TempDir()
			lock := filepath.Join(profile, "SingletonLock")
			if err := os.WriteFile(lock, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			cfg := chromeConfig{cdpURL: sc.cdpURL, profileDir: profile, autoWarm: true}

			var calls, launches, kills, probes int
			var gotPort string
			deps := withQuietPort(chromeDeps{
				reachable: func(string) bool {
					i := min(calls, len(sc.reachable)-1)
					calls++
					return sc.reachable[i]
				},
				launch:    func(chromeConfig) error { launches++; return nil },
				recover:   func(chromeConfig) error { t.Fatal("recover must not run in a port scenario"); return nil },
				warmProbe: func() int { probes++; return 0 },
				listeners: func(port string) ([]cdpListener, error) {
					gotPort = port
					return wildcardListeners(sc.listeners), nil
				},
				dedicated: func(string) ([]int, error) { return sc.dedicated, nil },
				command: func(pid int) (string, error) {
					if slices.Contains(sc.dedicated, pid) {
						return dedicatedCommand(profile), nil
					}
					return foreignCommand(pid), nil
				},
				kill: func(string) bool { kills++; return sc.killOK },
			})

			err := ensureChromeWarm(cfg, deps)
			if (err != nil) != sc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, sc.wantErr)
			}
			if errors.Is(err, errChromePortConflict) != sc.wantConflict {
				t.Fatalf("err = %v, want port conflict %v", err, sc.wantConflict)
			}
			if sc.wantPort != "" && gotPort != sc.wantPort {
				t.Fatalf("listener lookup port = %q, want %q", gotPort, sc.wantPort)
			}
			if launches != sc.wantLaunch || kills != sc.wantKill || probes != sc.wantProbe {
				t.Fatalf("launches=%d kills=%d probes=%d, want %d/%d/%d",
					launches, kills, probes, sc.wantLaunch, sc.wantKill, sc.wantProbe)
			}
			_, statErr := os.Stat(lock)
			if removed := os.IsNotExist(statErr); removed != sc.wantLocks {
				t.Fatalf("SingletonLock removed = %v, want %v", removed, sc.wantLocks)
			}
		})
	}
}

// A listener is classified by its own address family. A 127.0.0.1 URL must not be refused for a
// holder that only binds [::1], because requests to 127.0.0.1 never reach it (reviewer repro R3).
func TestCheckCDPPortOwnerMatchesAddressFamily(t *testing.T) {
	cases := []struct {
		name         string
		cdpURL       string
		listeners    []cdpListener
		wantConflict bool
	}{
		{"127.0.0.1 URL, foreign on [::1] only", "http://127.0.0.1:9333", []cdpListener{{foreignTestPID, "[::1]"}}, false},
		{"127.0.0.1 URL, foreign on 127.0.0.1", "http://127.0.0.1:9333", []cdpListener{{foreignTestPID, "127.0.0.1"}}, true},
		{"127.0.0.1 URL, foreign on wildcard", "http://127.0.0.1:9333", []cdpListener{{foreignTestPID, "*"}}, true},
		{"[::1] URL, foreign on 127.0.0.1 only", "http://[::1]:9333", []cdpListener{{foreignTestPID, "127.0.0.1"}}, false},
		{"[::1] URL, foreign on [::1]", "http://[::1]:9333", []cdpListener{{foreignTestPID, "[::1]"}}, true},
		{"localhost URL, foreign on 127.0.0.1", "http://localhost:9333", []cdpListener{{foreignTestPID, "127.0.0.1"}}, true},
		{"localhost URL, foreign on [::1]", "http://localhost:9333", []cdpListener{{foreignTestPID, "[::1]"}}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			captureLog(t)
			deps := withQuietPort(chromeDeps{
				listeners: func(string) ([]cdpListener, error) { return tc.listeners, nil },
				command:   func(pid int) (string, error) { return foreignCommand(pid), nil },
			})
			err := checkCDPPortOwner(chromeConfig{cdpURL: tc.cdpURL, profileDir: t.TempDir(), autoWarm: true}, deps, true)
			if errors.Is(err, errChromePortConflict) != tc.wantConflict {
				t.Fatalf("err = %v, want conflict %v", err, tc.wantConflict)
			}
		})
	}
}

// lsof -F pn output parses into one entry per listening socket, owned by its process.
func TestParseLsofListeners(t *testing.T) {
	out := "p83542\nn127.0.0.1:9222\nn[::1]:9222\nf5\np54121\nn*:9333\n"
	got := parseLsofListeners(out)
	want := []cdpListener{{83542, "127.0.0.1"}, {83542, "[::1]"}, {54121, "*"}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("parseLsofListeners = %v, want %v", got, want)
	}
}

// Every failed lookup fails open: a conflict is never reported from a guess.
func TestCheckCDPPortOwnerFailsOpen(t *testing.T) {
	cases := []struct {
		name      string
		listeners func(string) ([]cdpListener, error)
		command   func(int) (string, error)
		reachable bool
		dedicated func(string) ([]int, error)
	}{
		{
			name:      "lsof fails",
			listeners: func(string) ([]cdpListener, error) { return nil, errors.New("lsof: timed out") },
			reachable: true,
		},
		{
			name:      "ps fails on our own Chrome (repro R2)",
			listeners: func(string) ([]cdpListener, error) { return []cdpListener{{dedicatedTestPID, "*"}}, nil },
			command:   func(int) (string, error) { return "", errors.New("ps: failed") },
			reachable: true,
		},
		{
			name:      "listener exited between lsof and ps",
			listeners: func(string) ([]cdpListener, error) { return []cdpListener{{foreignTestPID, "*"}}, nil },
			command:   func(int) (string, error) { return "", nil },
			reachable: true,
			dedicated: func(string) ([]int, error) { return nil, errors.New("ps failed") },
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			captureLog(t)
			deps := withQuietPort(chromeDeps{listeners: tc.listeners, command: tc.command, dedicated: tc.dedicated})
			err := checkCDPPortOwner(chromeConfig{cdpURL: "http://localhost:9333", profileDir: t.TempDir(), autoWarm: true}, deps, tc.reachable)
			if err != nil {
				t.Fatalf("err = %v, want nil (fail open)", err)
			}
		})
	}
}

// The holder's pid and command go to the local log only. The error, which the run record keeps,
// carries the sentinel and nothing from the foreign argv.
func TestCheckCDPPortOwnerKeepsHolderArgvOutOfTheError(t *testing.T) {
	logs := captureLog(t)
	long := "Google Chrome --secret-flag " + strings.Repeat("x", 500)
	deps := withQuietPort(chromeDeps{
		listeners: func(string) ([]cdpListener, error) { return []cdpListener{{foreignTestPID, "*"}}, nil },
		command:   func(int) (string, error) { return long, nil },
	})
	err := checkCDPPortOwner(chromeConfig{cdpURL: "http://localhost:9222", profileDir: t.TempDir(), autoWarm: true}, deps, true)
	if !errors.Is(err, errChromePortConflict) {
		t.Fatalf("err = %v, want a port conflict", err)
	}
	if err.Error() != errChromePortConflict.Error() {
		t.Fatalf("error text %q carries more than the sentinel", err.Error())
	}
	logged := logs.String()
	if !strings.Contains(logged, fmt.Sprintf("pid %d", foreignTestPID)) {
		t.Fatalf("log %q does not name the holder pid", logged)
	}
	if strings.Contains(logged, strings.Repeat("x", 121)) || !strings.Contains(logged, "...") {
		t.Fatalf("log %q is not truncated to ~120 characters", logged)
	}
}

// A stale-kill target is validated first: a bad or remote endpoint never kills or launches on
// behalf of a dedicated Chrome it cannot reach.
func TestEnsureChromeWarmValidatesBeforeKill(t *testing.T) {
	noReprobeWait(t)
	cases := []struct {
		name       string
		cdpURL     string
		wantErr    bool
		wantLaunch int
	}{
		{"no port: refused before any kill", "http://localhost", true, 0},
		{"no port on IPv6: refused before any kill", "http://[::1]", true, 0},
		{"remote host: never killed, the local launch is as before", "http://host.docker.internal:9333", false, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			captureLog(t)
			kills, launches := 0, 0
			reachable := []bool{false, true}
			calls := 0
			deps := withQuietPort(chromeDeps{
				reachable: func(string) bool { i := min(calls, len(reachable)-1); calls++; return reachable[i] },
				launch:    func(chromeConfig) error { launches++; return nil },
				recover:   func(chromeConfig) error { return nil },
				warmProbe: func() int { return 0 },
				dedicated: func(string) ([]int, error) { return []int{dedicatedTestPID}, nil },
				kill:      func(string) bool { kills++; return true },
			})
			err := ensureChromeWarm(chromeConfig{cdpURL: tc.cdpURL, profileDir: t.TempDir(), autoWarm: true}, deps)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if kills != 0 {
				t.Fatalf("kills = %d, want 0 for an endpoint that cannot be validated or is remote", kills)
			}
			if launches != tc.wantLaunch {
				t.Fatalf("launches = %d, want %d", launches, tc.wantLaunch)
			}
		})
	}
}

// recoverWedgedChrome validates the endpoint before it reaches the kill.
func TestRecoverWedgedChromeValidatesFirst(t *testing.T) {
	if err := recoverWedgedChrome(chromeConfig{cdpURL: "http://localhost", profileDir: t.TempDir()}); err == nil {
		t.Fatal("recoverWedgedChrome with no CDP port returned nil, want a validation error")
	}
}

// Nil dependencies fall back to the production implementation, so a hand-built chromeDeps never
// dereferences nil (reviewer repro R5). A nil warmProbe reads as unusable.
func TestEnsureChromeWarmNilDepsFallBack(t *testing.T) {
	captureLog(t)
	deps := chromeDeps{}.withOSDefaults()
	if deps.reachable == nil || deps.listeners == nil || deps.dedicated == nil || deps.command == nil || deps.kill == nil || deps.warmProbe == nil || deps.launch == nil || deps.recover == nil {
		t.Fatal("withOSDefaults left a dependency nil")
	}
	if rc := deps.warmProbe(); rc != 4 {
		t.Fatalf("default warmProbe = %d, want 4 (unusable)", rc)
	}
	// A nil kill, launch or recover refuses. It never reaches a real signal or launch.
	if deps.kill("unused-profile") {
		t.Fatal("a nil kill reported the Chrome gone; it must refuse")
	}
	if err := deps.launch(chromeConfig{}); !errors.Is(err, errChromeNotStubbed) {
		t.Fatalf("nil launch = %v, want errChromeNotStubbed", err)
	}
	if err := deps.recover(chromeConfig{}); !errors.Is(err, errChromeNotStubbed) {
		t.Fatalf("nil recover = %v, want errChromeNotStubbed", err)
	}
}

// isolateCrawlFetchEnv clears the fetch-mode variables for a test that runs the cycle's production
// defaults, so they take the playwright path (no Chrome probe) whatever the developer's shell exports.
func isolateCrawlFetchEnv(t *testing.T) {
	t.Helper()
	t.Setenv("CRAWL_CDP_URL", "")
	t.Setenv("CRAWL_GATEWAY_URL", "")
	t.Setenv("CRAWL_FETCH_MODE", "")
}

// withFakeDefaults points the production defaults at a fake holder set for one test. It stands in
// for lsof, ps and the /json/version probe, so the outcome does not depend on the host's tools.
func withFakeDefaults(t *testing.T, d chromeDeps) {
	t.Helper()
	prev := chromeDepsForDefaults
	chromeDepsForDefaults = func() chromeDeps { return withQuietPort(d) }
	t.Cleanup(func() { chromeDepsForDefaults = prev })
}

// requireOSTool skips an OS-integration test when the tool it drives is not installed. These tests
// are named OSIntegration and are the only ones that run lsof, so the rest of the package is hermetic.
func requireOSTool(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Skipf("OS integration test: %s is not installed (%v)", path, err)
	}
}

// withKillSeams replaces the ps lookup and the signal for one test, so the kill loop can be driven
// without a real process. The fake pids are never signalled for real.
func withKillSeams(t *testing.T, lister func(string) ([]int, error)) *[]int {
	t.Helper()
	var signalled []int
	prevLister, prevSignal := dedicatedPIDLister, killSignal
	dedicatedPIDLister = lister
	killSignal = func(pid int) { signalled = append(signalled, pid) }
	t.Cleanup(func() { dedicatedPIDLister, killSignal = prevLister, prevSignal })
	return &signalled
}

// A ps that cannot be read does not confirm a kill. The kill returns false and signals nothing.
func TestKillDedicatedChromeFailsClosedOnPsError(t *testing.T) {
	captureLog(t)
	signalled := withKillSeams(t, func(string) ([]int, error) { return nil, errors.New("ps: timed out") })
	if killDedicatedChrome(t.TempDir()) {
		t.Fatal("killDedicatedChrome reported success when ps could not be read")
	}
	if len(*signalled) != 0 {
		t.Fatalf("signalled %v, want no signal when ps fails", *signalled)
	}
}

// A ps that fails on the confirmation pass after a kill round also refuses: the Chrome may still be
// alive, so it is not reported gone.
func TestKillDedicatedChromeFailsClosedOnLaterPsError(t *testing.T) {
	captureLog(t)
	calls := 0
	signalled := withKillSeams(t, func(string) ([]int, error) {
		calls++
		if calls == 1 {
			return []int{4242}, nil // a fake pid, signalled through the seam
		}
		return nil, errors.New("ps: failed")
	})
	if killDedicatedChrome(t.TempDir()) {
		t.Fatal("killDedicatedChrome reported success when the confirmation ps failed")
	}
	if len(*signalled) != 1 || (*signalled)[0] != 4242 {
		t.Fatalf("signalled %v, want the one fake pid from the first round", *signalled)
	}
}

// The ensureChromeWarm path: a stale instance is found, the kill cannot read ps, and so nothing is
// cleared and nothing is launched.
func TestEnsureChromeWarmPsErrorDuringKillKeepsLocksAndDoesNotLaunch(t *testing.T) {
	noReprobeWait(t)
	captureLog(t)
	withKillSeams(t, func(string) ([]int, error) { return nil, errors.New("ps: timed out") })
	profile := t.TempDir()
	lock := filepath.Join(profile, "SingletonLock")
	if err := os.WriteFile(lock, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	launches := 0
	deps := withQuietPort(chromeDeps{
		reachable: func(string) bool { return false },
		launch:    func(chromeConfig) error { launches++; return nil },
		recover:   func(chromeConfig) error { return nil },
		warmProbe: func() int { return 0 },
		dedicated: func(string) ([]int, error) { return []int{dedicatedTestPID}, nil },
		kill:      killDedicatedChrome, // the real kill, with its ps seam failing
	})
	err := ensureChromeWarm(chromeConfig{cdpURL: "http://localhost:9333", profileDir: profile, autoWarm: true}, deps)
	if err == nil || !strings.Contains(err.Error(), "still alive") {
		t.Fatalf("err = %v, want the refusal to fork a second instance", err)
	}
	if launches != 0 {
		t.Fatalf("launches = %d, want 0 when the kill cannot be confirmed", launches)
	}
	if _, statErr := os.Stat(lock); statErr != nil {
		t.Fatalf("SingletonLock was cleared under a possibly live Chrome: %v", statErr)
	}
}

func TestRecoverWedgedChromeFailsClosedOnPsError(t *testing.T) {
	captureLog(t)
	withKillSeams(t, func(string) ([]int, error) { return nil, errors.New("ps: timed out") })
	withFakeDefaults(t, chromeDeps{
		reachable: func(string) bool { return false },
		listeners: func(string) ([]cdpListener, error) { return nil, nil },
	})
	profile := t.TempDir()
	lock := filepath.Join(profile, "SingletonLock")
	if err := os.WriteFile(lock, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	err := recoverWedgedChrome(chromeConfig{bin: "/nonexistent/chrome", profileDir: profile, cdpURL: "http://127.0.0.1:9333", autoWarm: true})
	if err == nil || !strings.Contains(err.Error(), "still alive") {
		t.Fatalf("err = %v, want the refusal to fork a second instance", err)
	}
	if _, statErr := os.Stat(lock); statErr != nil {
		t.Fatalf("SingletonLock was cleared under a possibly live Chrome: %v", statErr)
	}
}

// The warm-off gate (CRAWL_AUTO_WARM=false) is one check, in checkCDPPortOwner, that every caller
// goes through. With a foreign holder present, it reports nothing when the warm is off.
func TestCheckCDPPortOwnerWarmOffGate(t *testing.T) {
	captureLog(t)
	deps := withQuietPort(chromeDeps{
		listeners: func(string) ([]cdpListener, error) { return []cdpListener{{foreignTestPID, "*"}}, nil },
		command:   func(pid int) (string, error) { return foreignCommand(pid), nil },
	})
	base := chromeConfig{cdpURL: "http://localhost:9222", profileDir: t.TempDir()}
	off := base
	off.autoWarm = false
	if err := checkCDPPortOwner(off, deps, true); err != nil {
		t.Fatalf("warm off: err = %v, want no ownership check", err)
	}
	on := base
	on.autoWarm = true
	if err := checkCDPPortOwner(on, deps, true); !errors.Is(err, errChromePortConflict) {
		t.Fatalf("warm on: err = %v, want a port conflict", err)
	}
}

func TestDefaultPortHelpersWarmOffGate(t *testing.T) {
	captureLog(t)
	t.Setenv("CRAWL_CDP_URL", "http://127.0.0.1:9333")
	t.Setenv("CRAWL_GATEWAY_URL", "")
	t.Setenv("CRAWL_FETCH_MODE", "")
	t.Setenv("HOUSING_CRAWL_CHROME_PROFILE", t.TempDir())
	// A foreign holder that does not answer /json/version. The fake stands in for lsof, ps and the
	// probe, so the result is the same on a host with or without those tools.
	withFakeDefaults(t, chromeDeps{
		reachable: func(string) bool { return false },
		listeners: func(string) ([]cdpListener, error) { return wildcardListeners([]int{foreignTestPID}), nil },
		command:   func(pid int) (string, error) { return foreignCommand(pid), nil },
		dedicated: func(string) ([]int, error) { return nil, nil },
	})

	t.Run("warm on: the foreign holder is a conflict", func(t *testing.T) {
		t.Setenv("CRAWL_AUTO_WARM", "true")
		if got := defaultChromeReachable(); got != chromePortConflict {
			t.Fatalf("defaultChromeReachable = %q, want %q", got, chromePortConflict)
		}
		if !defaultCDPPortConflict() {
			t.Fatal("defaultCDPPortConflict = false, want a conflict with the warm on")
		}
	})
	t.Run("warm off: the ownership check is skipped", func(t *testing.T) {
		t.Setenv("CRAWL_AUTO_WARM", "false")
		if got := defaultChromeReachable(); got == chromePortConflict {
			t.Fatalf("defaultChromeReachable = %q with the warm off, want no port conflict", got)
		}
		if defaultCDPPortConflict() {
			t.Fatal("defaultCDPPortConflict = true with the warm off, want no conflict")
		}
	})
}

// The invisible-holder verdict is re-checked just before it is returned. If the port has stopped
// answering, or our own dedicated Chrome shows up on the re-scan, there is no conflict.
func TestCheckCDPPortOwnerRechecksBeforeInvisibleVerdict(t *testing.T) {
	captureLog(t)
	cfg := chromeConfig{cdpURL: "http://localhost:9333", profileDir: t.TempDir(), autoWarm: true}
	cases := []struct {
		name         string
		reach        []bool // the re-probe answers, in order
		dedicated    []int  // the re-scan, after the probe
		wantConflict bool
	}{
		{"still answers, nothing running: conflict", []bool{true}, nil, true},
		{"no longer answers on re-probe: no conflict", []bool{false}, nil, false},
		{"our Chrome shows up on re-scan: no conflict", []bool{true}, []int{dedicatedTestPID}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			deps := withQuietPort(chromeDeps{
				reachable: func(string) bool { i := min(calls, len(tc.reach)-1); calls++; return tc.reach[i] },
				listeners: func(string) ([]cdpListener, error) { return nil, nil },
				dedicated: func(string) ([]int, error) { return tc.dedicated, nil },
			})
			err := checkCDPPortOwner(cfg, deps, true)
			if errors.Is(err, errChromePortConflict) != tc.wantConflict {
				t.Fatalf("err = %v, want conflict %v", err, tc.wantConflict)
			}
		})
	}
}

// The cycle carries the conflict through every step that reads Chrome: the drain's preflight, the
// repair's warm gate and recovery, the read-only preflight and a round's exit 8. Each is exit 8, or 0
// for the read-only preflight, and never 4.
func TestCyclePortConflictReportsPortConflict(t *testing.T) {
	conflict := fmt.Errorf("%w", errChromePortConflict)
	cases := []struct {
		name        string
		job         string
		setup       func(h *cycleHarness)
		wantOutcome string
		wantCode    int
		wantChrome  string
		wantRecover int
	}{
		{
			name: "drain: preflight refuses before any round",
			job:  cycleJobDrain,
			setup: func(h *cycleHarness) {
				h.chromeFn = func(context.Context) (string, int) { return chromeStateForWarmError(conflict) }
			},
			wantOutcome: outPreflightFailed,
			wantCode:    8,
			wantChrome:  "port_conflict",
		},
		{
			name: "repair: wedged warm, recovery refuses the foreign holder",
			job:  cycleJobRepair,
			setup: func(h *cycleHarness) {
				h.warmRC = 4
				h.recoverErr = conflict
			},
			wantOutcome: outRepairFailed,
			wantCode:    8,
			wantChrome:  "port_conflict",
			wantRecover: 1,
		},
		{
			name: "preflight: read-only check reports the conflict, exit 0",
			job:  cycleJobPreflight,
			setup: func(h *cycleHarness) {
				h.reach = chromePortConflict
			},
			wantOutcome: outChecked,
			wantCode:    0,
			wantChrome:  "port_conflict",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newCycleHarness(t, []fakeStep{{Claims: 1, Processed: 1, Succeeded: 1, Exit: 0}})
			h.cfg.job = tc.job
			tc.setup(h)
			code := h.runGuarded(20 * time.Second)
			s := h.summary()
			if code != tc.wantCode || s.ExitCode != tc.wantCode {
				t.Fatalf("exit = %d (summary %d), want %d", code, s.ExitCode, tc.wantCode)
			}
			if s.Outcome != tc.wantOutcome {
				t.Fatalf("outcome = %q, want %q", s.Outcome, tc.wantOutcome)
			}
			if s.Env.Chrome != tc.wantChrome {
				t.Fatalf("env.chrome = %q, want %q", s.Env.Chrome, tc.wantChrome)
			}
			if h.recoverCount() != tc.wantRecover {
				t.Fatalf("recoveries = %d, want %d", h.recoverCount(), tc.wantRecover)
			}
			if h.spawned() != 0 {
				t.Fatalf("children spawned = %d, want 0: a port conflict must not run a round", h.spawned())
			}
		})
	}
}

// A round's exit 8 is a port conflict when a foreign process holds the port (reviewer repro R1). The
// check runs before any driver install, so the install and its one retry stay unspent, and the
// summary names the conflict. Without a conflict the same exit 8 still installs the driver once.
func TestCycleRoundExit8PortConflictSkipsDriverRepair(t *testing.T) {
	cases := []struct {
		name         string
		conflict     bool
		wantChrome   string
		wantInstalls int
		wantSpawned  int
	}{
		{name: "port conflict: no install, no retry round", conflict: true, wantChrome: "port_conflict", wantInstalls: 0, wantSpawned: 1},
		{name: "no conflict: the driver repair runs once, as before", conflict: false, wantChrome: "warm", wantInstalls: 1, wantSpawned: 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newCycleHarness(t, []fakeStep{{Exit: 8}, {Exit: 8}})
			h.chromeFn = func(context.Context) (string, int) { return "warm", 0 }
			h.portConflict = tc.conflict
			code := h.runGuarded(20 * time.Second)
			s := h.summary()
			if code != 8 || s.ExitCode != 8 {
				t.Fatalf("exit = %d (summary %d), want 8", code, s.ExitCode)
			}
			if s.Env.Chrome != tc.wantChrome {
				t.Fatalf("env.chrome = %q, want %q", s.Env.Chrome, tc.wantChrome)
			}
			if h.installCount() != tc.wantInstalls {
				t.Fatalf("driver installs = %d, want %d", h.installCount(), tc.wantInstalls)
			}
			if h.spawned() != tc.wantSpawned {
				t.Fatalf("children spawned = %d, want %d", h.spawned(), tc.wantSpawned)
			}
		})
	}
}

// The run record keeps a port conflict as its word. The foreign pid and command never reach the DB.
func TestRunRecordDetailKeepsArgvOut(t *testing.T) {
	if got := runRecordDetail("self-warm failed: ", fmt.Errorf("%w", errChromePortConflict)); got != "self-warm failed: port_conflict" {
		t.Fatalf("detail = %q, want the port_conflict word only", got)
	}
	other := errors.New("chrome still unreachable")
	if got := runRecordDetail("x: ", other); got != "x: chrome still unreachable" {
		t.Fatalf("detail = %q", got)
	}
}

// chromeStateForWarmError names a conflict and keeps the word and exit code the cycle reports.
func TestChromeStateForWarmError(t *testing.T) {
	cases := []struct {
		name      string
		err       error
		wantState string
		wantCode  int
	}{
		{"port conflict", fmt.Errorf("%w", errChromePortConflict), "port_conflict", 8},
		{"driver missing", errCrawlEnvBroken, "env_broken", 8},
		{"chrome still unreachable", errors.New("chrome still unreachable at http://localhost:9333 after launch"), "unusable", 4},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			state, code := chromeStateForWarmError(tc.err)
			if state != tc.wantState || code != tc.wantCode {
				t.Fatalf("state=%q code=%d, want %q %d", state, code, tc.wantState, tc.wantCode)
			}
		})
	}
	if got := chromeWord("port_conflict"); got != "port_conflict" {
		t.Fatalf("chromeWord(port_conflict) = %q, want port_conflict (not collapsed to unusable)", got)
	}
}

// listCDPListeners is the real lsof. The test process holds a loopback port, so lsof must name this
// PID on 127.0.0.1. Skipped where lsof is absent.
func TestOSIntegrationListCDPListenersFindsOwnListener(t *testing.T) {
	requireOSTool(t, "/usr/sbin/lsof")
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	_, port, _ := net.SplitHostPort(ln.Addr().String())

	ls, err := listCDPListeners(port)
	if err != nil {
		t.Fatalf("listCDPListeners(%s): %v", port, err)
	}
	for _, l := range ls {
		if l.pid == os.Getpid() && l.host == "127.0.0.1" {
			return
		}
	}
	t.Fatalf("listCDPListeners(%s) = %v, want this process (%d) on 127.0.0.1", port, ls, os.Getpid())
}

func TestRecoverWedgedChromeRefusesForeignHolder(t *testing.T) {
	captureLog(t)
	// The kill must never be reached: a holder on the port is refused first.
	withKillSeams(t, func(string) ([]int, error) { t.Error("ps reached the kill path"); return nil, nil })
	withFakeDefaults(t, chromeDeps{
		reachable: func(string) bool { return true },
		listeners: func(string) ([]cdpListener, error) { return wildcardListeners([]int{foreignTestPID}), nil },
		command:   func(pid int) (string, error) { return foreignCommand(pid), nil },
	})
	profile := t.TempDir()
	cfg := chromeConfig{bin: "/nonexistent/chrome", profileDir: profile, cdpURL: "http://127.0.0.1:9333", autoWarm: true}
	err := recoverWedgedChrome(cfg)
	if !errors.Is(err, errChromePortConflict) {
		t.Fatalf("recoverWedgedChrome = %v, want a port conflict before any kill or launch", err)
	}
}

// OS integration: the real lsof and a real socket, on the URL's loopback port.
func TestOSIntegrationRecoverWedgedChromeRefusesRealHolder(t *testing.T) {
	requireOSTool(t, "/usr/sbin/lsof")
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	cfg := chromeConfig{bin: "/nonexistent/chrome", profileDir: t.TempDir(), cdpURL: "http://127.0.0.1:" + port, autoWarm: true}
	if err := recoverWedgedChrome(cfg); !errors.Is(err, errChromePortConflict) {
		t.Fatalf("recoverWedgedChrome = %v, want a port conflict before any kill or launch", err)
	}
}
