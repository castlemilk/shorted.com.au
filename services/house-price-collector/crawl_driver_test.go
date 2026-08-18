package main

import "testing"

func TestResolveDriverDir(t *testing.T) {
	cases := []struct {
		name string
		env  string
		want string
	}{
		{"unset keeps playwright default", "", ""},
		{"set is honoured", "/Users/rig/.shorted-housing-crawl/pw-driver", "/Users/rig/.shorted-housing-crawl/pw-driver"},
		{"whitespace is trimmed to unset", "   ", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CRAWL_PW_DRIVER_DIR", tc.env)
			if got := resolveDriverDir(); got != tc.want {
				t.Fatalf("resolveDriverDir() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestCrawlDriverRunOptions(t *testing.T) {
	t.Setenv("CRAWL_PW_DRIVER_DIR", "/tmp/pw-driver")
	opts := crawlDriverRunOptions()
	if opts.DriverDirectory != "/tmp/pw-driver" {
		t.Fatalf("DriverDirectory = %q, want /tmp/pw-driver", opts.DriverDirectory)
	}
	if !opts.SkipInstallBrowsers {
		t.Fatal("SkipInstallBrowsers must be true — the CDP client needs only the driver, and a bare install pulls ~500MB of browsers")
	}
	t.Setenv("CRAWL_PW_DRIVER_DIR", "")
	opts = crawlDriverRunOptions()
	if opts.DriverDirectory != "" {
		t.Fatalf("unset env must leave DriverDirectory empty (playwright default), got %q", opts.DriverDirectory)
	}
}
