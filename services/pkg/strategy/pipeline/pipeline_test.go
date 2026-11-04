package pipeline

import (
	"encoding/json"
	"testing"
	"time"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/instrument"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// Inputs is written against by the backtest and the live path. This compiles
// only while every field of the seam is present with its declared type.
func TestInputsCarriesTheSeamFields(t *testing.T) {
	in := Inputs{
		Codes:        nil,
		Bars:         nil,
		XJO:          nil,
		XJT:          nil,
		ASIC:         nil,
		Ingests:      nil,
		ETPSet:       nil,
		Names:        nil,
		Dividends:    nil,
		CashRate:     nil,
		Fundamentals: nil,
	}
	if in.Codes != nil || in.Dividends != nil {
		t.Fatal("zero Inputs must have no codes or dividends")
	}
}

// ---------------------------------------------------------------- fixtures

// day is the session n days after the first date of the fixtures.
func day(n int) civil.Date {
	return civil.Date{Year: 2026, Month: time.January, Day: 1}.AddDays(n)
}

// priceBars is one bar per day for n days at close px, with the given volume.
func priceBars(n int, px, volume float64) []features.Bar {
	out := make([]features.Bar, n)
	for i := range out {
		out[i] = features.Bar{Date: day(i), Open: px, High: px, Low: px, Close: px, AdjClose: px, Volume: volume}
	}
	return out
}

// indexBars is one XJO level per day for n days, rising steadily.
func indexBars(n int) []features.IndexBar {
	out := make([]features.IndexBar, n)
	for i := range out {
		lvl := 7000.0 + float64(i)
		out[i] = features.IndexBar{Date: day(i), High: lvl, Low: lvl, Close: lvl}
	}
	return out
}

// v0Spec and v1Spec are the registered versions' rules, with the universe
// and data policies the tests need set explicitly.
func v0Spec(t *testing.T) spec.Spec {
	t.Helper()
	r, ok := spec.Live("zanger-breakout")
	if !ok {
		t.Fatal("no live version for zanger-breakout")
	}
	s := r.Spec
	s.Universe = spec.UniverseSpec{Instruments: "all", Freshness: "none", MinSessions: 60, LookbackDays: 400, RSPopulation: "candidates"}
	s.Data = spec.DataPolicy{ShortSource: "latest_nonzero_row", PublicationLagSessions: 0, Calendar: "asxcalendar", DTC: "v0_35d_nonzero_bigint"}
	return s
}

func v1Spec(t *testing.T) spec.Spec {
	t.Helper()
	s := v0Spec(t)
	s.Universe = spec.UniverseSpec{Instruments: "ordinary", Freshness: "bar_on_session", MinSessions: 60, LookbackDays: 400, ASICReported: true, RSPopulation: "universe"}
	s.Data.ShortSource = "latest_complete_published"
	s.Data.PublicationLagSessions = 4
	s.Data.MaxReportAgeSessions = 8
	s.Data.Calendar = "xjo_and_asic_dates"
	s.Data.DTC = "v1_20_bars_min10_traded"
	s.Data.CAUpjumpFrom = "2025-01-01"
	return s
}

// inputsFor is one run's rows over n sessions: a priced stock AAA, a stock
// with too short a history, and whatever extra codes the caller adds.
func inputsFor(n int) *Inputs {
	return &Inputs{
		Codes: []string{"AAA", "BBB"},
		Bars: map[string][]features.Bar{
			"AAA": priceBars(n, 10, 1000),
			"BBB": priceBars(10, 5, 1000),
		},
		XJO:       indexBars(n),
		ETPSet:    map[string]bool{},
		Names:     map[string]string{"AAA": "Alpha Ltd", "BBB": "Beta Ltd"},
		Ingests:   nil,
		Dividends: nil,
	}
}

func asicOn(code string, d civil.Date, pos, issued float64) features.ASICRow {
	pct := 100 * pos / issued
	return features.ASICRow{Code: code, ReportDate: d, Product: code + " LIMITED", Positions: pos, Issued: issued, Percent: &pct}
}

func reasonOf(t *testing.T, got []Ineligible, code string) string {
	t.Helper()
	for _, g := range got {
		if g.Code == code {
			return g.Reason
		}
	}
	return ""
}

// The v0 universe admits every stock with 60 priced sessions and nothing else.
func TestBuildCandidatesV0AdmitsEveryPricedStock(t *testing.T) {
	in := inputsFor(70)
	cands, stats, inel := BuildCandidates(day(69), in, v0Spec(t))
	if len(cands) != 1 || cands[0].StockCode != "AAA" {
		t.Fatalf("candidates = %v", codesOf(cands))
	}
	if reasonOf(t, inel, "BBB") != ReasonShortHistory {
		t.Fatalf("BBB reason = %q, want %q", reasonOf(t, inel, "BBB"), ReasonShortHistory)
	}
	if cands[0].Close != 10 || cands[0].SessionsAvailable == 0 {
		t.Errorf("AAA close %v sessions %d", cands[0].Close, cands[0].SessionsAvailable)
	}
	if stats.Session != day(69) {
		t.Errorf("stats session = %v", stats.Session)
	}
}

// The v1 universe is ordinary shares with a bar on the session. An ETP, a
// stock with no bar on the day, and a longer-than-four-letter line are out.
func TestBuildCandidatesV1OrdinaryFreshWithAReason(t *testing.T) {
	in := inputsFor(70)
	in.Codes = []string{"AAA", "BBB", "ETF1", "NOBAR", "LONGCODE"}
	in.Bars["ETF1"] = priceBars(70, 20, 1000)
	in.Names["ETF1"] = "Alpha Ltd"
	in.ETPSet["ETF1"] = true
	in.Bars["NOBAR"] = priceBars(60, 3, 1000) // ends a session before D
	in.Names["NOBAR"] = "Gamma Ltd"
	in.Bars["LONGCODE"] = priceBars(70, 3, 1000)
	in.Names["LONGCODE"] = "Delta Ltd"
	in.ASIC = []features.ASICRow{asicOn("AAA", day(55), 200000, 10000000)}
	in.Ingests = []features.ReportIngest{{ReportDate: day(55), LoadedRows: 1}}

	cands, _, inel := BuildCandidates(day(69), in, v1Spec(t))
	for code, want := range map[string]string{
		"BBB":      ReasonNoBarOnSession,
		"ETF1":     instrument.ReasonExchangeTradedProduct,
		"NOBAR":    ReasonNoBarOnSession,
		"LONGCODE": instrument.ReasonSecondaryLine,
	} {
		if got := reasonOf(t, inel, code); got != want {
			t.Errorf("%s reason = %q, want %q", code, got, want)
		}
	}
	for _, c := range cands {
		if c.StockCode == "AAA" {
			return
		}
	}
	t.Fatalf("AAA is ordinary and fresh but was not admitted; candidates %v, ineligible %+v", codesOf(cands), inel)
}

// The short reading reads the report on or before D only: a row dated after D
// never reaches the candidate, and a stock with no report is not in it.
func TestCandidateShortReadingIsPointInTime(t *testing.T) {
	in := inputsFor(80)
	in.ASIC = []features.ASICRow{
		asicOn("AAA", day(54), 200000, 10000000),  // 2%
		asicOn("AAA", day(60), 900000, 10000000),  // 9%: the latest report on or before day 62
		asicOn("AAA", day(70), 1500000, 10000000), // 15%: after day 62, never read
	}
	c, bad := CandidateAt("AAA", day(62), in, v0Spec(t))
	if bad != nil {
		t.Fatalf("AAA excluded: %+v", bad)
	}
	if c.ShortPct == nil || *c.ShortPct != 9 {
		t.Fatalf("short pct on day 62 = %v, want 9 (the day-60 report)", c.ShortPct)
	}
	if c.ShortReportDate == nil || !c.ShortReportDate.Equal(time.Date(2026, 3, 2, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("report date = %v, want day 60", c.ShortReportDate)
	}
}

// A corroborated-or-known corporate action (here a zero-volume artefact a
// price move coincides with) excludes the code under the v1 guard from its
// known date on, and not before.
func TestCorporateActionGuardExcludesFromTheKnownDate(t *testing.T) {
	in := inputsFor(70)
	bars := priceBars(70, 10, 1000)
	for i := 50; i < 70; i++ {
		bars[i].Close = 20 // a 2x move
	}
	bars[50].Volume = 0
	in.Bars["AAA"] = bars
	s := v1Spec(t)
	s.Universe.ASICReported = false
	s.Universe.Freshness = "none"
	s.Universe.CAGuard = true

	if _, bad := CandidateAt("AAA", day(49), in, s); bad != nil && bad.Reason == ReasonCorporateActionGuard {
		t.Fatal("the suspect is known from day 50, not before")
	}
	if _, bad := CandidateAt("AAA", day(69), in, s); bad == nil || bad.Reason != ReasonCorporateActionGuard {
		t.Fatalf("day 69 = %+v, want the CA guard", bad)
	}
}

// Fundamentals frozen in a blob decode onto the candidate, and a stock without
// one has none.
func TestFundamentalsDecodeOntoTheCandidate(t *testing.T) {
	in := inputsFor(70)
	rev := 12.5
	blob, err := json.Marshal(features.FundamentalsBody{Growth: &engine.Growth{RevenueYoYPct: &rev}})
	if err != nil {
		t.Fatal(err)
	}
	in.Fundamentals = map[string]features.Fundamentals{"AAA": {Hash: "h", Blob: blob}}
	c, bad := CandidateAt("AAA", day(69), in, v0Spec(t))
	if bad != nil {
		t.Fatalf("AAA excluded: %+v", bad)
	}
	if c.Growth == nil || c.Growth.RevenueYoYPct == nil || *c.Growth.RevenueYoYPct != 12.5 {
		t.Fatalf("growth = %+v", c.Growth)
	}
	none, _ := CandidateAt("BBB", day(9), inputsFor(10), v0Spec(t))
	if none.Growth != nil {
		t.Error("a stock without a blob has no growth")
	}
}

// BuildCandidates returns the same candidates as CandidateAt for each code.
func TestBuildCandidatesMatchesCandidateAt(t *testing.T) {
	in := inputsFor(70)
	s := v0Spec(t)
	cands, _, _ := BuildCandidates(day(69), in, s)
	one, bad := CandidateAt("AAA", day(69), in, s)
	if bad != nil || len(cands) != 1 || cands[0].Close != one.Close || cands[0].AsOf != one.AsOf {
		t.Fatalf("BuildCandidates and CandidateAt disagree: %+v vs %+v", cands, one)
	}
}

func codesOf(cs []engine.Candidate) []string {
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = c.StockCode
	}
	return out
}
