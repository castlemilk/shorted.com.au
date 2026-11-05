package pipeline

import (
	"testing"
	"time"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// v1Crowded is the v1 Crowded-Short universe: ordinary names in the latest
// complete report, which the rules read through sf1.
func v1Crowded(t *testing.T) spec.Spec {
	t.Helper()
	r, ok := spec.Version(spec.StrategyCrowdedShortBreakout, "v1")
	if !ok {
		t.Fatal("no v1 crowded-short version")
	}
	return r.Spec
}

// The short reading is the newest COMPLETE report public on the session. A
// zero is a reading (no ShortReason, so the rule fails), and a stock absent
// from that report has no reportable position.
func TestShortPolicyV1ZeroAndAbsent(t *testing.T) {
	in := inputsFor(80)
	in.ASIC = []features.ASICRow{
		asicOn("AAA", day(40), 0, 10000000),
		asicOn("AAA", day(60), 0, 10000000),
		asicOn("BBB", day(40), 900000, 10000000),
		asicOn("BBB", day(60), 900000, 10000000),
	}
	in.Ingests = []features.ReportIngest{{ReportDate: day(40), LoadedRows: 2}, {ReportDate: day(60), LoadedRows: 2}}
	// Day 70 is four sessions after day 60 and before day 61+4 would be a
	// different report; the day-60 report is complete and public.
	c, bad := CandidateAt("AAA", day(70), in, v1Crowded(t))
	if bad != nil {
		t.Fatalf("AAA excluded: %+v", bad)
	}
	if c.ShortPct == nil || *c.ShortPct != 0 || c.ShortReason != "" {
		t.Fatalf("a reported zero: pct %v reason %q, want 0 and no reason", c.ShortPct, c.ShortReason)
	}

	// CCC has no row in the report: absent, so it is outside the universe.
	in.Codes = append(in.Codes, "CCC")
	in.Bars["CCC"] = priceBars(80, 7, 1000)
	in.Names["CCC"] = "Gamma Ltd"
	_, bad = CandidateAt("CCC", day(70), in, v1Crowded(t))
	if bad == nil || bad.Reason != ReasonNotInASICReport {
		t.Fatalf("CCC absent from the complete report: %+v, want %s", bad, ReasonNotInASICReport)
	}
}

// A newest report with fewer rows than its file lists is partial, so the
// reading falls back to the report before it, and the stock reads that one.
func TestShortPolicyV1FallsBackFromAPartialReport(t *testing.T) {
	in := inputsFor(80)
	in.ASIC = []features.ASICRow{
		asicOn("AAA", day(58), 900000, 10000000),
		asicOn("AAA", day(60), 100000, 10000000),
		asicOn("BBB", day(58), 900000, 10000000),
		asicOn("BBB", day(60), 900000, 10000000),
	}
	file := 2
	in.Ingests = []features.ReportIngest{
		{ReportDate: day(58), LoadedRows: 2, FileRows: &file},
		{ReportDate: day(60), LoadedRows: 1, FileRows: &file},
	}
	// Day 60's report is partial (1 of its 2 file rows), so day 63 reads day 58's
	// complete report, which was public on day 62 and is five sessions old.
	c, bad := CandidateAt("AAA", day(63), in, v1Crowded(t))
	if bad != nil {
		t.Fatalf("AAA excluded: %+v", bad)
	}
	if c.ShortReportDate == nil || !c.ShortReportDate.Equal(timeOf(day(58))) {
		t.Errorf("report date = %v, want the complete day-58 report", c.ShortReportDate)
	}
	if c.ShortPct == nil || *c.ShortPct != 9 {
		t.Errorf("short pct = %v, want 9 from the complete report", c.ShortPct)
	}
}

// With no complete report within eight sessions, the reading is stale and
// the short rules are unknown, not failed: the code stays in the universe.
func TestShortPolicyV1StaleIsUnknown(t *testing.T) {
	in := inputsFor(90)
	in.ASIC = []features.ASICRow{
		asicOn("AAA", day(20), 900000, 10000000),
		asicOn("BBB", day(20), 900000, 10000000),
	}
	in.Ingests = []features.ReportIngest{{ReportDate: day(20), LoadedRows: 2}}
	// Day 20 is published on day 24; day 70 is fifty sessions later.
	c, bad := CandidateAt("AAA", day(70), in, v1Crowded(t))
	if bad != nil {
		t.Fatalf("AAA excluded: %+v", bad)
	}
	if c.ShortReason != features.ReasonASICReportStale || c.ShortPct != nil || c.DaysToCover != nil {
		t.Fatalf("stale reading: reason %q pct %v dtc %v, want asic_report_stale with no figure", c.ShortReason, c.ShortPct, c.DaysToCover)
	}
}

// The v1 corporate-action guard reads up-jumps dated on or after
// ca_upjump_from (2026-09-29): a jump of exactly 3x on a bar from then on guards
// the code from that bar, and the same jump before the date is not a suspect.
func TestCAUpjumpGuardStartsAtTheV1Date(t *testing.T) {
	s := v1Crowded(t)
	upjump, err := civil.ParseDate(s.Data.CAUpjumpFrom)
	if err != nil || upjump.String() != "2026-09-29" {
		t.Fatalf("v1 ca_upjump_from = %q, want 2026-09-29", s.Data.CAUpjumpFrom)
	}
	n := 300
	before := day(200) // 2026-07-20: before the up-jump date
	after := day(280)  // 2026-10-08
	// One 3x step, flat before and after it: the step is the only event.
	bars := priceBars(n, 10, 1000)
	for i := range bars {
		if !bars[i].Date.Before(before) {
			bars[i].Close, bars[i].AdjClose = 30, 30
		}
	}
	in := inputsFor(n)
	in.Codes = []string{"AAA"}
	in.Bars["AAA"] = bars
	in.ASIC = []features.ASICRow{asicOn("AAA", day(0), 1000, 10000000)}
	in.Ingests = []features.ReportIngest{{ReportDate: day(0), LoadedRows: 1}}

	// Before the date: the same 3x jump on day 200 is not a suspect, so the
	// guard does not apply on day 201.
	if _, bad := CandidateAt("AAA", day(201), in, s); bad != nil && bad.Reason == ReasonCorporateActionGuard {
		t.Fatalf("a 3x jump before ca_upjump_from guarded the code")
	}

	// From the date: a 3x up-jump on day 280 guards the code on that session.
	bars = priceBars(n, 10, 1000)
	for i := range bars {
		if !bars[i].Date.Before(after) {
			bars[i].Close, bars[i].AdjClose = 30, 30
		}
	}
	in.Bars["AAA"] = bars
	if _, bad := CandidateAt("AAA", day(280), in, s); bad == nil || bad.Reason != ReasonCorporateActionGuard {
		t.Fatalf("a 3x up-jump on %v: %+v, want %s", day(280), bad, ReasonCorporateActionGuard)
	}
}

// timeOf is a civil date at UTC midnight, the form a candidate's dates take.
func timeOf(d civil.Date) time.Time {
	return time.Date(d.Year, d.Month, d.Day, 0, 0, 0, 0, time.UTC)
}
