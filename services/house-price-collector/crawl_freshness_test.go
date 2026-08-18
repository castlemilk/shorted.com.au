package main

import (
	"testing"
	"time"
)

func defaultFreshnessCfg() freshnessConfig {
	return freshnessConfig{ttl: 24 * time.Hour, alarmAfter: 72 * time.Hour, churnDays: 7}
}

func TestClassifyFreshness_AlarmsOnOldestCovered(t *testing.T) {
	now := time.Date(2026, 7, 22, 3, 0, 0, 0, time.UTC)
	cfg := defaultFreshnessCfg()
	rows := []suburbFreshness{
		{Target: tgt("Fresh", "NSW", "2000"), LastCrawled: ago(now, 2*time.Hour)},
		{Target: tgt("Mid", "VIC", "3000"), LastCrawled: ago(now, 30*time.Hour)},
		{Target: tgt("Oldest", "QLD", "4000"), LastCrawled: ago(now, 80*time.Hour)}, // > 72h → alarm
		{Target: tgt("NeverA", "SA", "5000"), LastCrawled: nil},
	}

	rep := classifyFreshness(rows, cfg, now)

	if !rep.Alarm {
		t.Fatalf("expected alarm (oldest covered 80h > 72h)")
	}
	if rep.OldestSuburb.Display != "Oldest" {
		t.Fatalf("OldestSuburb = %q, want Oldest", rep.OldestSuburb.Display)
	}
	if rep.Covered != 3 {
		t.Fatalf("Covered = %d, want 3", rep.Covered)
	}
	if rep.NeverCrawled != 1 {
		t.Fatalf("NeverCrawled = %d, want 1", rep.NeverCrawled)
	}
	if rep.StaleOverTTL != 2 { // Mid (30h) + Oldest (80h) exceed 24h TTL
		t.Fatalf("StaleOverTTL = %d, want 2", rep.StaleOverTTL)
	}
	if rep.FreshestAge != 2*time.Hour {
		t.Fatalf("FreshestAge = %s, want 2h", rep.FreshestAge)
	}
	if rep.OldestAge != 80*time.Hour {
		t.Fatalf("OldestAge = %s, want 80h", rep.OldestAge)
	}
	if rep.MedianAge != 30*time.Hour { // median of {2h,30h,80h}
		t.Fatalf("MedianAge = %s, want 30h", rep.MedianAge)
	}
}

func TestClassifyFreshness_NoAlarmWhenFresh(t *testing.T) {
	now := time.Date(2026, 7, 22, 3, 0, 0, 0, time.UTC)
	cfg := defaultFreshnessCfg()
	rows := []suburbFreshness{
		{Target: tgt("A", "NSW", "2000"), LastCrawled: ago(now, 2*time.Hour)},
		{Target: tgt("B", "VIC", "3000"), LastCrawled: ago(now, 20*time.Hour)},
	}
	rep := classifyFreshness(rows, cfg, now)
	if rep.Alarm {
		t.Fatalf("did not expect alarm (oldest 20h < 72h)")
	}
	if rep.StaleOverTTL != 0 {
		t.Fatalf("StaleOverTTL = %d, want 0", rep.StaleOverTTL)
	}
}

func TestClassifyFreshness_NeverCrawledDoesNotAlarm(t *testing.T) {
	now := time.Date(2026, 7, 22, 3, 0, 0, 0, time.UTC)
	cfg := defaultFreshnessCfg()
	// Every covered suburb is fresh; there are also never-crawled coverage gaps —
	// those must NOT trip the alarm (else a partially-seeded catalog alarms forever).
	rows := []suburbFreshness{
		{Target: tgt("Fresh", "NSW", "2000"), LastCrawled: ago(now, 1*time.Hour)},
		{Target: tgt("Never1", "VIC", "3000"), LastCrawled: nil},
		{Target: tgt("Never2", "QLD", "4000"), LastCrawled: nil},
	}
	rep := classifyFreshness(rows, cfg, now)
	if rep.Alarm {
		t.Fatalf("never-crawled coverage gaps must not alarm")
	}
	if rep.NeverCrawled != 2 || rep.Covered != 1 {
		t.Fatalf("Covered=%d NeverCrawled=%d, want 1/2", rep.Covered, rep.NeverCrawled)
	}
}

func TestClassifyFreshness_NoCoverageNoAlarm(t *testing.T) {
	now := time.Date(2026, 7, 22, 3, 0, 0, 0, time.UTC)
	cfg := defaultFreshnessCfg()
	rows := []suburbFreshness{
		{Target: tgt("Never1", "NSW", "2000"), LastCrawled: nil},
		{Target: tgt("Never2", "VIC", "3000"), LastCrawled: nil},
	}
	rep := classifyFreshness(rows, cfg, now)
	if rep.Alarm {
		t.Fatalf("covered==0 (fresh env) must not alarm")
	}
	if rep.Covered != 0 || rep.NeverCrawled != 2 {
		t.Fatalf("Covered=%d NeverCrawled=%d, want 0/2", rep.Covered, rep.NeverCrawled)
	}
}

func TestClassifyFreshness_ClockSkewFutureLastSeen(t *testing.T) {
	now := time.Date(2026, 7, 22, 3, 0, 0, 0, time.UTC)
	cfg := defaultFreshnessCfg()
	future := now.Add(2 * time.Hour)
	rows := []suburbFreshness{
		{Target: tgt("Future", "NSW", "2000"), LastCrawled: &future},
	}
	rep := classifyFreshness(rows, cfg, now)
	if rep.Alarm {
		t.Fatalf("a future last_seen_at (clock skew) must not alarm")
	}
	if rep.OldestAge != 0 || rep.FreshestAge != 0 {
		t.Fatalf("future timestamp should clamp age to 0, got oldest=%s freshest=%s", rep.OldestAge, rep.FreshestAge)
	}
}

// The alarm horizon must be one the configured throughput can actually meet:
// at CRAWL_DELTA_MAX_SUBURBS=120 the catalog rotates in ~4.2 days (~101h), so
// 120h alarms only on genuine trouble. The old 72h default alarmed on the
// steady state itself, which is how a 305h-oldest catalog became normal.
func TestLoadFreshnessConfig_DefaultHorizonMatchesConfiguredThroughput(t *testing.T) {
	t.Setenv("CRAWL_DELTA_TTL_HOURS", "")
	t.Setenv("CRAWL_FRESHNESS_ALARM_HOURS", "")
	t.Setenv("CRAWL_DELTA_CHURN_DAYS", "")
	t.Setenv("CRAWL_FRESHNESS_WEBHOOK", "")
	cfg := loadFreshnessConfig()
	if cfg.alarmAfter != 120*time.Hour {
		t.Fatalf("default CRAWL_FRESHNESS_ALARM_HOURS = %s, want 120h", cfg.alarmAfter)
	}
	if cfg.ttl != 24*time.Hour {
		t.Fatalf("default CRAWL_DELTA_TTL_HOURS changed to %s — the stale-count line must keep meaning 'older than a day'", cfg.ttl)
	}
}
