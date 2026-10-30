package main

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"
)

// --- batch 6, 3: each warm probe is bounded and reported on its own ---

// A probe still running at its bound is abandoned and reads as unusable (4), which the Chrome step turns
// into a recovery. Its finish is called once, with that code.
func TestBoundedWarmProbeReadsAStallAsUnusable(t *testing.T) {
	var finished []int
	rc := boundedWarm(context.Background(), 200*time.Millisecond,
		func(context.Context) int { time.Sleep(time.Second); return 0 },
		func(rc int) { finished = append(finished, rc) })
	if rc != 4 || len(finished) != 1 || finished[0] != 4 {
		t.Fatalf("a stalled probe must read as unusable (4): rc=%d finished=%v", rc, finished)
	}
}

// A probe that answers within its bound keeps its code, and finish sees that code.
func TestBoundedWarmProbeKeepsItsCode(t *testing.T) {
	var finished []int
	rc := boundedWarm(context.Background(), time.Second,
		func(context.Context) int { return 5 },
		func(rc int) { finished = append(finished, rc) })
	if rc != 5 || len(finished) != 1 || finished[0] != 5 {
		t.Fatalf("a probe within its bound keeps its code: rc=%d finished=%v", rc, finished)
	}
}

// A panic in a probe is env_broken (8), not a crash of the cycle.
func TestBoundedWarmProbePanicIsEnvBroken(t *testing.T) {
	rc := boundedWarm(context.Background(), time.Second,
		func(context.Context) int { panic("probe boom (test)") },
		func(int) {})
	if rc != exitCrawlEnvBroken {
		t.Fatalf("a panicking probe must read as env_broken (8), got %d", rc)
	}
}

// Each probe's startup events bracket it: a start with no outcome, then a done carrying the warm word.
func TestWarmProbeEventsBracketEachProbe(t *testing.T) {
	h := newCycleHarness(t, []fakeStep{{Exit: 0}})
	c := newCycleRunner(h.cfg, h.deps)
	c.warmEvent("start", "")
	c.warmEvent("done", warmProbeOutcome(5))
	c.pump.close(time.Second)
	var got []map[string]any
	for _, e := range h.events() {
		if e["type"] == "startup" {
			got = append(got, e)
		}
	}
	if len(got) != 2 {
		t.Fatalf("startup events = %d, want 2 (start and done)", len(got))
	}
	if _, has := got[0]["outcome"]; has || got[0]["stage"] != "start" || got[0]["step"] != "warm_probe" {
		t.Fatalf("the start event carries no outcome: %v", got[0])
	}
	if got[1]["outcome"] != "cold" || got[1]["stage"] != "done" {
		t.Fatalf("the done event names the warm word: %v", got[1])
	}
}

// A large CRAWL_FETCH_TIMEOUT_S: each probe's real worst case (2 x 3600 s + ...) is above the ceiling, so
// both the probe and the Chrome step are clamped to it, and the clamp is what the config holds.
func TestLargeFetchTimeoutClampsEachProbeAndTheChromeStep(t *testing.T) {
	fetch600 := func(k string) string {
		if k == "CRAWL_FETCH_TIMEOUT_S" {
			return "600"
		}
		return ""
	}
	if raw := warmProbeWorst(fetch600); raw <= hungCeiling(defaultHungGrace) {
		t.Fatalf("the test needs a probe above the ceiling, got %s", raw)
	}
	cfg := loadCycleConfig(fetch600)
	ceil := hungCeiling(defaultHungGrace)
	if cfg.warmTimeout != ceil {
		t.Fatalf("one warm probe must be clamped to the ceiling %s, got %s", ceil, cfg.warmTimeout)
	}
	if cfg.chromeTimeout != ceil {
		t.Fatalf("the Chrome step must be clamped to the ceiling %s, got %s", ceil, cfg.chromeTimeout)
	}
}

// --- batch 6, 4: CRAWL_HUNG_GRACE is validated; a value outside [10 s, 5 m] is refused with exit 8 ---

func TestHungGraceIsValidatedInItsRange(t *testing.T) {
	cases := []struct {
		raw string
		ok  bool
	}{
		{"5s", false}, {"10s", true}, {"1m", true}, {"5m", true}, {"5m1s", false}, {"29m30s", false}, {"bogus", false},
	}
	for _, tc := range cases {
		err := validateCycleEnv(func(k string) string {
			if k == "CRAWL_HUNG_GRACE" {
				return tc.raw
			}
			return ""
		})
		if (err == nil) != tc.ok {
			t.Fatalf("CRAWL_HUNG_GRACE=%q: err=%v, want ok=%v", tc.raw, err, tc.ok)
		}
	}
}

// The refusal is an exit 8 with one summary line, at the entry point.
func TestHungGraceOutOfRangeExitsEightAtTheEntryPoint(t *testing.T) {
	var out bytes.Buffer
	getenv := func(k string) string {
		switch k {
		case "CRAWL_SINK":
			return "ingest"
		case "SHORTED_INGEST_URL":
			return "https://api.shorted.com.au"
		case "CRAWL_DRY_RUN":
			return "false"
		case "CRAWL_HUNG_GRACE":
			return "29m30s"
		}
		return ""
	}
	isolateCrawlFetchEnv(t)
	code := runCycleMode(&out, cycleJobDrain, false, time.Hour, getenv, nil)
	if code != exitSinkRefused {
		t.Fatalf("exit = %d, want 8", code)
	}
	if n := strings.Count(out.String(), "\n"); n != 1 {
		t.Fatalf("a refused cycle prints one summary line, got %d", n)
	}
}
