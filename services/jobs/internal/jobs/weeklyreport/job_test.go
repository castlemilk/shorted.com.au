package weeklyreport

import (
	"testing"
	"time"
)

func TestResolveTarget(t *testing.T) {
	// A Wednesday in ISO week 2026-W10.
	now := time.Date(2026, 3, 4, 9, 0, 0, 0, time.UTC)

	tests := []struct {
		name     string
		cfg      config
		env      string
		wantKind reportKind
		wantSlug string
	}{
		{"explicit week", config{week: "2026-W06"}, "", reportWeekly, "2026-W06"},
		{"explicit month", config{month: "2026-01"}, "", reportMonthly, "2026-01"},
		{"explicit year", config{year: "2025"}, "", reportYearly, "2025"},
		// An explicit -year wins over -month/-week (the original checked year first).
		{"year beats month", config{year: "2025", month: "2026-01", week: "2026-W06"}, "", reportYearly, "2025"},
		{"month beats week", config{month: "2026-01", week: "2026-W06"}, "", reportMonthly, "2026-01"},
		{"default is current ISO week", config{}, "", reportWeekly, "2026-W10"},
		{"report-type monthly is previous month", config{reportType: "monthly"}, "", reportMonthly, "2026-02"},
		{"report-type yearly is previous year", config{reportType: "yearly"}, "", reportYearly, "2025"},
		{"report-type weekly is current week", config{reportType: "weekly"}, "", reportWeekly, "2026-W10"},
		// Cloud Scheduler env overrides can't pass args, so REPORT_TYPE is the
		// fallback for the hint.
		{"REPORT_TYPE env fallback", config{}, "monthly", reportMonthly, "2026-02"},
		{"flag beats REPORT_TYPE env", config{reportType: "yearly"}, "monthly", reportYearly, "2025"},
		// An unrecognised hint must not silently change cadence.
		{"unknown hint falls back to weekly", config{reportType: "fortnightly"}, "", reportWeekly, "2026-W10"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("REPORT_TYPE", tt.env)
			kind, slug := resolveTarget(tt.cfg, now)
			if kind != tt.wantKind || slug != tt.wantSlug {
				t.Errorf("resolveTarget() = (%v, %q), want (%v, %q)", kind, slug, tt.wantKind, tt.wantSlug)
			}
		})
	}
}

func TestResolveTargetMonthlyRollsBackOverYearBoundary(t *testing.T) {
	t.Setenv("REPORT_TYPE", "")
	now := time.Date(2026, 1, 5, 0, 0, 0, 0, time.UTC)
	kind, slug := resolveTarget(config{reportType: "monthly"}, now)
	if kind != reportMonthly || slug != "2025-12" {
		t.Fatalf("resolveTarget() = (%v, %q), want (monthly, 2025-12)", kind, slug)
	}
}
