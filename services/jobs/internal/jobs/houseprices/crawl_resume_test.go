package houseprices

import (
	"testing"
	"time"
)

// These tests cover the pure checkpoint/resume logic (shouldSkip, resumeSet)
// with fixtures — the one piece of Task 8 that talks to a real database
// (lastSweptBySuburbSource) is exercised live by the operator, not here.

func TestShouldSkip(t *testing.T) {
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name   string
		last   time.Time
		window time.Duration
		want   bool
	}{
		{"never swept (zero last)", time.Time{}, 20 * time.Hour, false},
		{"swept 5h ago, 20h window -> within", now.Add(-5 * time.Hour), 20 * time.Hour, true},
		{"swept 25h ago, 20h window -> outside", now.Add(-25 * time.Hour), 20 * time.Hour, false},
		{"swept 5h ago, window disabled (0)", now.Add(-5 * time.Hour), 0, false},
		{"swept 5h ago, window disabled (negative)", now.Add(-5 * time.Hour), -1 * time.Hour, false},
		{"swept exactly at the window boundary -> not within", now.Add(-20 * time.Hour), 20 * time.Hour, false},
		{"swept in the future (clock skew) -> within", now.Add(1 * time.Hour), 20 * time.Hour, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := shouldSkip(c.last, now, c.window); got != c.want {
				t.Errorf("shouldSkip(%v, now, %v) = %v want %v", c.last, c.window, got, c.want)
			}
		})
	}
}

func TestResumeSet_RoundTrips(t *testing.T) {
	last := time.Date(2026, 7, 15, 6, 0, 0, 0, time.UTC)
	rs := resumeSet{
		resumeKey("rea", "SUBURB:NSW-2026-BONDI"): last,
	}
	if got := rs.lastSweptAt("rea", "SUBURB:NSW-2026-BONDI"); !got.Equal(last) {
		t.Errorf("lastSweptAt round-trip = %v want %v", got, last)
	}
	if got := rs.lastSweptAt("domain", "SUBURB:NSW-2026-BONDI"); !got.IsZero() {
		t.Errorf("a different source should be a zero-value miss, got %v", got)
	}
	if got := rs.lastSweptAt("rea", "SUBURB:VIC-3182-ST-KILDA"); !got.IsZero() {
		t.Errorf("an absent suburb should be a zero-value miss, got %v", got)
	}
	// A nil resumeSet (resume disabled / load skipped) must behave exactly
	// like an empty one — Go map reads on a nil map are safe.
	var nilRS resumeSet
	if got := nilRS.lastSweptAt("rea", "SUBURB:NSW-2026-BONDI"); !got.IsZero() {
		t.Errorf("a nil resumeSet should always miss, got %v", got)
	}
}

func TestResumeSet_ShouldSkipTarget(t *testing.T) {
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	rs := resumeSet{
		resumeKey("rea", bondi.regionCode()): now.Add(-5 * time.Hour),
	}
	if !rs.shouldSkipTarget("rea", bondi, now, 20*time.Hour) {
		t.Error("bondi/rea swept 5h ago within a 20h window should be skipped")
	}
	if rs.shouldSkipTarget("domain", bondi, now, 20*time.Hour) {
		t.Error("bondi/domain was never swept in this snapshot, should NOT be skipped")
	}
	if rs.shouldSkipTarget("rea", bondi, now, 0) {
		t.Error("window<=0 disables resume entirely, even for a recently-swept suburb")
	}
}

func TestResumeKey_DistinctPerSourceAndSuburb(t *testing.T) {
	if resumeKey("rea", "SUBURB:NSW-2026-BONDI") == resumeKey("domain", "SUBURB:NSW-2026-BONDI") {
		t.Error("different sources for the same suburb must not collide")
	}
	if resumeKey("rea", "SUBURB:NSW-2026-BONDI") == resumeKey("rea", "SUBURB:VIC-3182-ST-KILDA") {
		t.Error("different suburbs for the same source must not collide")
	}
}
