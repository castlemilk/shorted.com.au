package houseprices

import (
	"strings"
	"testing"
)

func TestDeriveCrawlRunStatus(t *testing.T) {
	cases := []struct {
		name                  string
		events, blocked, done int
		rewarm, fatalErr      bool
		want                  string
	}{
		{"clean run", 12, 0, 5, false, false, "ok"},
		{"legit no-change sweep", 0, 0, 3, false, false, "ok"},
		{"rewarm wins over blocked", 0, 4, 2, true, false, "rewarm"},
		{"blocked, no events", 0, 3, 2, false, false, "blocked"},
		{"partial: some blocked, some events", 8, 2, 4, false, false, "partial"},
		{"fatal claim error, nothing done", 0, 0, 0, false, true, "error"},
		{"fatal finalizer error after work", 5, 0, 2, false, true, "error"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := deriveCrawlRunStatus(c.events, c.blocked, c.done, c.rewarm, c.fatalErr)
			if got != c.want {
				t.Fatalf("deriveCrawlRunStatus(ev=%d,bl=%d,done=%d,rewarm=%v,fatal=%v) = %q, want %q",
					c.events, c.blocked, c.done, c.rewarm, c.fatalErr, got, c.want)
			}
		})
	}
}

func TestCrawlRunType(t *testing.T) {
	cases := map[string]string{"": "agent", "delta": "delta", "FULL": "full", "Agent": "agent", "bogus": "agent"}
	for in, want := range cases {
		t.Setenv("CRAWL_RUN_TYPE", in)
		if got := crawlRunType(); got != want {
			t.Errorf("crawlRunType() with %q = %q, want %q", in, got, want)
		}
	}
}

func TestCrawlRunID(t *testing.T) {
	// Explicit id is passed through verbatim (so the wrapper's rounds share it).
	t.Setenv("CRAWL_RUN_ID", "delta-20260723T030000Z")
	if got := crawlRunID("delta"); got != "delta-20260723T030000Z" {
		t.Fatalf("crawlRunID passthrough = %q", got)
	}
	// Unset → generated, prefixed by the run-type.
	t.Setenv("CRAWL_RUN_ID", "")
	got := crawlRunID("full")
	if !strings.HasPrefix(got, "full-") {
		t.Fatalf("generated crawlRunID = %q, want full- prefix", got)
	}
}

func TestCrawlHost(t *testing.T) {
	if h := crawlHost(); h == "" {
		t.Fatal("crawlHost() must never be empty")
	}
}
