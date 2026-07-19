package main

import (
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
