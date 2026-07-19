package main

import (
	"fmt"
	"strings"
	"testing"
)

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

func TestMatchDedicatedPIDs(t *testing.T) {
	profile := "/Users/ben/.shorted-housing-crawl-chrome"
	// Realistic `ps -axww -o pid=,command=` output: the dedicated Chrome, the
	// PERSONAL Chrome (must NEVER match), a helper without the flag, grep noise,
	// and a SIBLING profile whose path is a prefix-superset of the dedicated one
	// (must NEVER match either — a bare substring match would catch it).
	psOut := "" +
		"  501 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9333 --user-data-dir=/Users/ben/.shorted-housing-crawl-chrome https://www.realestate.com.au/\n" +
		"  777 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/ben/Library/Application Support/Google/Chrome\n" +
		"  888 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper (Renderer)\n" +
		"  999 grep -F -- --user-data-dir=/Users/ben/.shorted-housing-crawl-chrome\n" +
		"  606 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/ben/.shorted-housing-crawl-chrome-backup\n"

	got := matchDedicatedPIDs(psOut, profile)
	if len(got) != 1 || got[0] != 501 {
		t.Fatalf("matchDedicatedPIDs = %v, want [501] (dedicated only, never the personal profile, a sibling-prefix profile, or grep)", got)
	}

	// Empty profile must match NOTHING (guards against a defaulting bug turning
	// this into "kill every Chrome").
	if pids := matchDedicatedPIDs(psOut, ""); len(pids) != 0 {
		t.Fatalf("matchDedicatedPIDs(_, \"\") = %v, want [] — empty profile must never match", pids)
	}
}

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
			warmProbe: func() int {
				probeCalls++
				if probeCalls == 1 {
					return 4
				}
				return 0
			},
		}
		if err := ensureChromeWarm(cfg, deps); err != nil {
			t.Fatalf("err = %v, want nil", err)
		}
		if recovers != 1 {
			t.Fatalf("recovers=%d, want 1 (rc4 hard-recovers)", recovers)
		}
	})

	// Wedged (rc 4) and recover itself fails → fail fast. Refusing to proceed is
	// safer than risking a second Chrome instance, so launch/warmProbe must NOT
	// be called again after the failed recover.
	t.Run("recover_error_fails_fast", func(t *testing.T) {
		launches, probes := 0, 0
		deps := chromeDeps{
			reachable: func(string) bool { return true },
			launch:    func(chromeConfig) error { launches++; return nil },
			recover:   func(chromeConfig) error { return fmt.Errorf("kill failed: still alive") },
			warmProbe: func() int { probes++; return 4 }, // wedged on every probe
		}
		err := ensureChromeWarm(cfg, deps)
		if err == nil {
			t.Fatalf("err = nil, want non-nil (recover failure must fail fast)")
		}
		if probes != 1 {
			t.Fatalf("warmProbe called %d times, want 1 (no re-probe after failed recover)", probes)
		}
		if launches != 0 {
			t.Fatalf("launches=%d, want 0 (no launch after failed recover)", launches)
		}
	})
}
