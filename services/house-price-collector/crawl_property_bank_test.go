package main

import (
	"testing"
	"time"
)

// The PID is the whole point of the durable link, so parsing it is worth pinning
// against the shapes property.com.au actually emits (and the ones it does not).
func TestProfilePID(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"canonical with trailing slash", "https://www.property.com.au/vic/rowville-3178/kelletts-rd/33-175-pid-6535276/", "6535276"},
		{"no trailing slash", "https://www.property.com.au/qld/mango-hill-4509/gilmour-st/48-pid-13524505", "13524505"},
		{"unit address", "https://www.property.com.au/vic/melbourne-3000/little-lonsdale-st/371-pid-4535579/", "4535579"},
		{"surrounding whitespace", "  https://www.property.com.au/qld/x-4000/y-st/1-pid-42/  ", "42"},

		{"no pid segment", "https://www.property.com.au/vic/rowville-3178/kelletts-rd/33-175/", ""},
		{"suburb page", "https://www.property.com.au/vic/rowville-3178/", ""},
		{"empty pid", "https://www.property.com.au/vic/x-3000/y-st/1-pid-/", ""},
		{"non-numeric pid must not be trusted", "https://www.property.com.au/vic/x-3000/y-st/1-pid-abc/", ""},
		{"empty string", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := profilePID(c.in); got != c.want {
				t.Errorf("profilePID(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

// The durable per-property permalink is what makes a later crawl possible after a
// listing is withdrawn, so it must be derivable from the profile URL alone.
func TestREAPropertyLookupURL(t *testing.T) {
	got := reaPropertyLookupURL("https://www.property.com.au/qld/mango-hill-4509/gilmour-st/48-pid-13524505/")
	want := "https://www.realestate.com.au/property/lookup?id=13524505"
	if got != want {
		t.Errorf("lookup url = %q, want %q", got, want)
	}

	// A URL we could not parse must yield NO link rather than a plausible-looking
	// wrong one — a lookup id we invented would point at somebody else's property.
	for _, bad := range []string{"", "https://www.property.com.au/vic/rowville-3178/", "not a url"} {
		if got := reaPropertyLookupURL(bad); got != "" {
			t.Errorf("reaPropertyLookupURL(%q) = %q, want empty", bad, got)
		}
	}
}

// The mode's defaults decide how hard a first run leans on a third party's public
// endpoint, so they are part of the contract rather than an implementation detail.
func TestPropertyResolveConfigDefaults(t *testing.T) {
	for _, k := range []string{
		"CRAWL_PROPERTY_RESOLVE_MAX", "CRAWL_PROPERTY_RESOLVE_MIN_MS",
		"CRAWL_PROPERTY_RESOLVE_MAX_MS", "CRAWL_PROPERTY_RESOLVE_TIMEOUT_S",
		"CRAWL_PROPERTY_TTL_DAYS", "CRAWL_DRY_RUN",
	} {
		t.Setenv(k, "")
	}
	cfg := loadPropertyResolveConfig()

	if !cfg.dryRun {
		t.Error("CRAWL_DRY_RUN must default to TRUE: a hand-run must not write or sweep by accident")
	}
	if cfg.max != 200 {
		t.Errorf("default max = %d, want 200 (a first run is a sample somebody reads)", cfg.max)
	}
	if cfg.minDelay <= 0 || cfg.maxDelay <= cfg.minDelay {
		t.Errorf("delays must be a positive jittered range, got %v-%v", cfg.minDelay, cfg.maxDelay)
	}
	if cfg.minDelay < 500*time.Millisecond {
		t.Errorf("min delay %v is too aggressive for a shared public autocomplete", cfg.minDelay)
	}
}
