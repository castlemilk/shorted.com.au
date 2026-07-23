package shorts

import (
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

func hoursAgo(now time.Time, h float64) *time.Time {
	t := now.Add(-time.Duration(h * float64(time.Hour)))
	return &t
}

// TestCrawlRunHealth exercises the status+staleness → Health derivation, including
// the DEAD-RIG path (a last-"ok" run whose finished_at has gone silent past the
// dead horizon must escalate warning → critical).
func TestCrawlRunHealth(t *testing.T) {
	now := time.Date(2026, 7, 23, 3, 0, 0, 0, time.UTC)
	cases := []struct {
		name     string
		status   string
		runType  string
		finished *time.Time
		want     jobmonitor.Health
	}{
		{"ok fresh delta", "ok", "delta", hoursAgo(now, 2), jobmonitor.HealthOK},
		{"ok stale delta (>30h)", "ok", "delta", hoursAgo(now, 40), jobmonitor.HealthWarning},
		{"ok DEAD delta (>60h)", "ok", "delta", hoursAgo(now, 70), jobmonitor.HealthCritical},
		{"ok fresh full (10d)", "ok", "full", hoursAgo(now, 10*24), jobmonitor.HealthOK},
		{"ok stale full (>16d)", "ok", "full", hoursAgo(now, 18*24), jobmonitor.HealthWarning},
		{"ok DEAD full (>32d)", "ok", "full", hoursAgo(now, 40*24), jobmonitor.HealthCritical},
		{"error → critical", "error", "delta", hoursAgo(now, 1), jobmonitor.HealthCritical},
		{"blocked → critical", "blocked", "delta", hoursAgo(now, 1), jobmonitor.HealthCritical},
		{"rewarm fresh → warning", "rewarm", "delta", hoursAgo(now, 1), jobmonitor.HealthWarning},
		{"partial fresh → warning", "partial", "delta", hoursAgo(now, 1), jobmonitor.HealthWarning},
		{"rewarm DEAD → critical", "rewarm", "delta", hoursAgo(now, 70), jobmonitor.HealthCritical},
		{"empty status → unknown", "", "delta", hoursAgo(now, 1), jobmonitor.HealthUnknown},
		{"nil finish, ok → ok (no age)", "ok", "delta", nil, jobmonitor.HealthOK},
		{"agent 24h fresh", "ok", "agent", hoursAgo(now, 24), jobmonitor.HealthOK},
		{"agent 50h stale (>48h)", "ok", "agent", hoursAgo(now, 50), jobmonitor.HealthWarning},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := crawlRunHealth(c.status, c.runType, c.finished, now)
			if got != c.want {
				t.Fatalf("crawlRunHealth(%q,%q,age) = %q, want %q", c.status, c.runType, got, c.want)
			}
		})
	}
}

func TestCrawlLastRunStatus(t *testing.T) {
	cases := map[string]string{
		"ok": "succeeded", "partial": "succeeded", "rewarm": "succeeded",
		"error": "failed", "blocked": "failed", "": "unknown", "weird": "unknown",
	}
	for in, want := range cases {
		if got := crawlLastRunStatus(in); got != want {
			t.Errorf("crawlLastRunStatus(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestCrawlRunToJobStatus verifies the record → dashboard-JobStatus mapping.
func TestCrawlRunToJobStatus(t *testing.T) {
	now := time.Date(2026, 7, 23, 3, 0, 0, 0, time.UTC)
	fin := hoursAgo(now, 2)
	start := hoursAgo(now, 3) // 1h run
	fresh := 12.0
	rec := &shortsstore.CrawlRunStatus{
		RunType:              "delta",
		Host:                 "mac-mini-1",
		StartedAt:            start,
		FinishedAt:           fin,
		Status:               "ok",
		SuburbsSelected:      20,
		SuburbsDone:          18,
		ListingsTouched:      340,
		EventsWritten:        12,
		BlockedCount:         0,
		FreshnessOldestHours: &fresh,
		Detail:               "18/20 suburbs done, 340 listings, 12 events, 0 blocked sweep(s)",
	}

	js := crawlRunToJobStatus(rec, now)

	if js.Name != "housing-crawl-delta-mac-mini-1" {
		t.Errorf("Name = %q", js.Name)
	}
	if js.DisplayName != "Housing Crawl — Delta" {
		t.Errorf("DisplayName = %q", js.DisplayName)
	}
	if js.Category != "Housing crawl" {
		t.Errorf("Category = %q", js.Category)
	}
	if js.Type != "rig" {
		t.Errorf("Type = %q, want rig", js.Type)
	}
	if js.LastRunStatus != "succeeded" {
		t.Errorf("LastRunStatus = %q, want succeeded", js.LastRunStatus)
	}
	if js.Health != jobmonitor.HealthOK {
		t.Errorf("Health = %q, want ok", js.Health)
	}
	if js.LastRunAt != fin.UTC().Format(time.RFC3339) {
		t.Errorf("LastRunAt = %q", js.LastRunAt)
	}
	if js.DurationSeconds < 3599 || js.DurationSeconds > 3601 {
		t.Errorf("DurationSeconds = %v, want ~3600", js.DurationSeconds)
	}
	if !strings.Contains(js.Message, "18/20 suburbs") ||
		!strings.Contains(js.Message, "freshness 12h") ||
		!strings.Contains(js.Message, "rig mac-mini-1") {
		t.Errorf("Message missing parts: %q", js.Message)
	}
	if js.ScheduleHuman == "" {
		t.Errorf("ScheduleHuman should be set for a rig")
	}
}

func TestCrawlRunToJobStatus_FailedMapsToNoSuccess(t *testing.T) {
	now := time.Date(2026, 7, 23, 3, 0, 0, 0, time.UTC)
	rec := &shortsstore.CrawlRunStatus{
		RunType: "full", Host: "rig2", FinishedAt: hoursAgo(now, 1),
		Status: "blocked", Detail: "blocked/poisoned sweep(s)",
	}
	js := crawlRunToJobStatus(rec, now)
	if js.Health != jobmonitor.HealthCritical {
		t.Errorf("Health = %q, want critical", js.Health)
	}
	if js.LastRunStatus != "failed" {
		t.Errorf("LastRunStatus = %q, want failed", js.LastRunStatus)
	}
	if js.LastSuccessAt != "" {
		t.Errorf("LastSuccessAt = %q, want empty for a blocked run", js.LastSuccessAt)
	}
}

// TestCrawlRunStatusesToJobs checks the slice mapper is nil-safe.
func TestCrawlRunStatusesToJobs(t *testing.T) {
	now := time.Now().UTC()
	recs := []*shortsstore.CrawlRunStatus{
		{RunType: "delta", Host: "a", Status: "ok", FinishedAt: &now},
		nil,
		{RunType: "full", Host: "b", Status: "ok", FinishedAt: &now},
	}
	jobs := crawlRunStatusesToJobs(recs, now)
	if len(jobs) != 2 {
		t.Fatalf("got %d jobs, want 2 (nil skipped)", len(jobs))
	}
	for _, j := range jobs {
		if j.Type != "rig" || j.Category != "Housing crawl" {
			t.Errorf("unexpected job: %+v", j)
		}
	}
}
