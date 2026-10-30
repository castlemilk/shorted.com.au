package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// withQuietPort fills the port-ownership deps for tests that are not about the port: nothing
// listens, nothing is dedicated, and a kill would succeed.
func withQuietPort(d chromeDeps) chromeDeps {
	if d.listeners == nil {
		d.listeners = func(string) []int { return nil }
	}
	if d.dedicated == nil {
		d.dedicated = func(string) []int { return nil }
	}
	if d.command == nil {
		d.command = func(int) string { return "" }
	}
	if d.kill == nil {
		d.kill = func(string) bool { return true }
	}
	return d
}

// portScenario is one ensureChromeWarm run against a port with the given holders.
type portScenario struct {
	name         string
	cdpURL       string
	listeners    []int  // lsof's LISTEN set for the port
	dedicated    []int  // dedicated-profile Chrome PIDs
	reachable    []bool // answers per call; the last value repeats
	killOK       bool
	wantConflict bool
	wantErr      bool   // any error (a conflict counts)
	wantPort     string // the port the listener lookup was asked about
	wantLaunch   int
	wantKill     int
	wantProbe    int
	wantLocks    bool // the profile's SingletonLock is removed
}

const (
	dedicatedTestPID = 54121 // the dedicated-profile Chrome
	foreignTestPID   = 83542 // the operator's everyday Chrome, remote debugging on
)

func TestEnsureChromeWarmPortOwnership(t *testing.T) {
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
			name:      "127.0.0.1 CDP URL: port comes from the URL, dedicated listener is warm",
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
			reachable:  []bool{false, true},
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
			reachable:  []bool{false, true},
			killOK:     true,
			wantKill:   1,
			wantLaunch: 1,
			wantProbe:  1,
			wantLocks:  true,
		},
		{
			name:      "stale dedicated instance that will not die: refused, no launch",
			cdpURL:    "http://localhost:9333",
			dedicated: []int{dedicatedTestPID},
			reachable: []bool{false},
			killOK:    false,
			wantErr:   true,
			wantKill:  1,
		},
	}
	for _, sc := range cases {
		t.Run(sc.name, func(t *testing.T) {
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
				listeners: func(port string) []int { gotPort = port; return sc.listeners },
				dedicated: func(string) []int { return sc.dedicated },
				command:   func(pid int) string { return fmt.Sprintf("Google Chrome --pid=%d", pid) },
				kill:      func(string) bool { kills++; return sc.killOK },
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

// A conflict names the holder, and the command is cut so one process cannot flood the log.
func TestCheckCDPPortOwnerTruncatesHolderCommand(t *testing.T) {
	long := strings.Repeat("x", 500)
	deps := withQuietPort(chromeDeps{
		listeners: func(string) []int { return []int{foreignTestPID} },
		command:   func(int) string { return long },
	})
	err := checkCDPPortOwner(chromeConfig{cdpURL: "http://localhost:9222", profileDir: t.TempDir()}, deps)
	if !errors.Is(err, errChromePortConflict) {
		t.Fatalf("err = %v, want a port conflict", err)
	}
	msg := err.Error()
	if !strings.Contains(msg, fmt.Sprintf("pid %d", foreignTestPID)) {
		t.Fatalf("error %q does not name the holder pid", msg)
	}
	if strings.Contains(msg, strings.Repeat("x", 121)) || !strings.Contains(msg, "...") {
		t.Fatalf("error %q is not truncated to ~120 characters", msg)
	}
}

// The state and exit code a conflict reports to the cycle summary and the agent exit.
func TestChromeStateForWarmError(t *testing.T) {
	cases := []struct {
		name      string
		err       error
		wantState string
		wantCode  int
	}{
		{"port conflict", fmt.Errorf("%w: port 9222, pid %d (Google Chrome)", errChromePortConflict, foreignTestPID), "port_conflict", 8},
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

// listCDPListeners is the real lsof. The test process holds a loopback port, so lsof must name
// this PID. Skipped where lsof is absent.
func TestListCDPListenersFindsOwnListener(t *testing.T) {
	if _, err := os.Stat("/usr/sbin/lsof"); err != nil {
		t.Skip("lsof not available")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	_, port, _ := net.SplitHostPort(ln.Addr().String())

	if pids := listCDPListeners(port); !containsPID(pids, os.Getpid()) {
		t.Fatalf("listCDPListeners(%s) = %v, want it to include this process (%d)", port, pids, os.Getpid())
	}
}

// recoverWedgedChrome is the repair path's recovery, which runs without ensureChromeWarm. With a
// foreign holder on the port it must refuse before any kill. The holder here is this test
// process, and the profile matches nothing, so a missing check would reach the real kill path.
func TestRecoverWedgedChromeRefusesForeignHolder(t *testing.T) {
	if _, err := os.Stat("/usr/sbin/lsof"); err != nil {
		t.Skip("lsof not available")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	_, port, _ := net.SplitHostPort(ln.Addr().String())

	cfg := chromeConfig{
		bin:        "/nonexistent/chrome",
		profileDir: t.TempDir(),
		cdpURL:     "http://127.0.0.1:" + port,
	}
	err = recoverWedgedChrome(cfg)
	if !errors.Is(err, errChromePortConflict) {
		t.Fatalf("recoverWedgedChrome = %v, want a port conflict before any kill or launch", err)
	}
}

func containsPID(pids []int, pid int) bool {
	for _, p := range pids {
		if p == pid {
			return true
		}
	}
	return false
}

// The cycle carries the conflict word through every step that reads Chrome: the drain's preflight,
// the repair's warm gate and recovery, and the read-only preflight. Each is exit 8, never 4.
func TestCyclePortConflictReportsPortConflict(t *testing.T) {
	conflict := fmt.Errorf("%w: port 9222, pid %d (Google Chrome)", errChromePortConflict, foreignTestPID)
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
