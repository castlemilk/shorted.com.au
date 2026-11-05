package backtest

import (
	"math"
	"testing"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// TestCoverageMeasuresBothNamedAndCountsNameDays: on a fixture where the report
// is public from its first session, the qualifying measure counts the names at
// or above 5% and the all-reported measure every ordinary name in the report. The
// ratios are priced over qualifying, per session.
func TestCoverageMeasuresBothNamedAndCountsNameDays(t *testing.T) {
	sessions := monthSessions(civil.Date{Year: 2024, Month: 1, Day: 2}, 10)
	xjo := make([]features.IndexBar, len(sessions))
	for k, d := range sessions {
		xjo[k] = features.IndexBar{Date: d, High: 100, Low: 100, Close: 100}
	}
	bars := func(days int) []features.Bar {
		var out []features.Bar
		for k := 0; k < days; k++ {
			out = append(out, features.Bar{Date: sessions[k], Open: 10, High: 10, Low: 10, Close: 10, AdjClose: 10, Volume: 1e6})
		}
		return out
	}
	pct := func(v float64) *float64 { return &v }
	report := sessions[0]
	in := &MemoryInputs{
		BarsByCode: map[string][]features.Bar{"AAA": bars(10), "BBB": bars(5), "CCC": bars(10)},
		Divs:       map[string][]features.Dividend{},
		Funds:      map[string]features.Fundamentals{},
	}
	in.Mkt = Market{
		XJO: xjo, XJT: xjo,
		ASIC: []features.ASICRow{
			{Code: "AAA", ReportDate: report, Positions: 1, Issued: 1e6, Percent: pct(10)},
			{Code: "BBB", ReportDate: report, Positions: 1, Issued: 1e6, Percent: pct(7)},
			{Code: "CCC", ReportDate: report, Positions: 1, Issued: 1e6, Percent: pct(2)},
		},
		Ingests: []features.ReportIngest{{ReportDate: report, FileRows: intPtr(3), LoadedRows: 3}},
		ETPs:    map[string]bool{},
		Names:   map[string]string{"AAA": "Alpha Ltd", "BBB": "Bravo Ltd", "CCC": "Charlie Ltd"},
	}
	s := spec.Spec{}
	s.Data.PublicationLagSessions = 0
	cov, err := MeasureCoverage(in, s, sessions, CoverageMinPct)
	if err != nil {
		t.Fatal(err)
	}
	if cov.Qualifying.Measure != MeasureQualifying || cov.AllReported.Measure != MeasureAllReported {
		t.Fatalf("measures %q and %q are not named", cov.Qualifying.Measure, cov.AllReported.Measure)
	}
	// Qualifying: AAA and BBB, 2 names a session over 10 sessions, priced on 10 and
	// 5 sessions: 15 of 20.
	q := cov.Qualifying.Total
	if q.Qualifying != 20 || q.Priced != 15 || math.Abs(q.Ratio-0.75) > 1e-12 {
		t.Fatalf("qualifying %+v, want 15 of 20", q)
	}
	// All reported: AAA, BBB and CCC, 30 name-days, 25 priced.
	a := cov.AllReported.Total
	if a.Qualifying != 30 || a.Priced != 25 || math.Abs(a.Ratio-25.0/30) > 1e-12 {
		t.Fatalf("all reported %+v, want 25 of 30", a)
	}
	if len(cov.Qualifying.Months) != 1 || len(cov.Qualifying.Years) != 1 {
		t.Fatalf("months %d years %d, want one of each", len(cov.Qualifying.Months), len(cov.Qualifying.Years))
	}
	if cov.Qualifying.Months[0].Period != "2024-01" || cov.Qualifying.Years[0].Period != "2024" {
		t.Fatalf("periods %q and %q", cov.Qualifying.Months[0].Period, cov.Qualifying.Years[0].Period)
	}
}

// TestCoverageRatiosAreConsistentOnGolden: on the golden market the qualifying
// measure is a subset of the all-reported one, the priced count never exceeds its
// measure's name-days, and the yearly and monthly rows add back to the total.
func TestCoverageRatiosAreConsistentOnGolden(t *testing.T) {
	in := loadGolden(t)
	res, err := Run(in, goldenSpec(t), goldenRecipe(t))
	if err != nil {
		t.Fatal(err)
	}
	cov, err := MeasureCoverage(in, goldenSpec(t), res.Sessions, CoverageMinPct)
	if err != nil {
		t.Fatal(err)
	}
	q, a := cov.Qualifying.Total, cov.AllReported.Total
	if q.Qualifying > a.Qualifying || q.Priced > q.Qualifying || a.Priced > a.Qualifying {
		t.Fatalf("qualifying %+v is not a subset of all reported %+v", q, a)
	}
	for _, m := range []CoverageMeasure{cov.Qualifying, cov.AllReported} {
		sumQ, sumP := 0, 0
		for _, y := range m.Months {
			sumQ += y.Qualifying
			sumP += y.Priced
		}
		if sumQ != m.Total.Qualifying || sumP != m.Total.Priced {
			t.Fatalf("%s: months sum to %d/%d, total %d/%d", m.Measure, sumP, sumQ, m.Total.Priced, m.Total.Qualifying)
		}
	}
}

// TestSurvivorshipStatementCarriesTheMeasurement: a measured run prints the
// statement, Minervini adds its measurement caveat, and an approximate run is not
// measurable.
func TestSurvivorshipStatementCarriesTheMeasurement(t *testing.T) {
	csb := SurvivorshipOf(spec.R1Recipes()[0])
	if csb.Measurement != MeasurementMeasured || csb.Direction != DirectionFlatters || csb.Caveat != "" {
		t.Fatalf("crowded-short block %+v", csb)
	}
	mtt := SurvivorshipOf(spec.R1Recipes()[1])
	if mtt.Measurement != MeasurementASICOnly || mtt.Caveat == "" {
		t.Fatalf("minervini block %+v, want the ASIC-only measurement and its caveat", mtt)
	}
	approx := spec.R1Recipes()[2]
	approx.Fundamentals = spec.FundamentalsApprox
	if got := SurvivorshipOf(approx); got.Measurement != MeasurementNotMeasurable || got.Direction != DirectionFlatters {
		t.Fatalf("approximate block %+v, want not measurable, flatters", got)
	}
}

// TestDataQualityCountsTheRun: the counts follow the run's trades and events.
func TestDataQualityCountsTheRun(t *testing.T) {
	res := Result{
		Trades: []Trade{
			{ExitReason: ReasonDelisted, Flags: []string{FlagFallbackClose}},
			{ExitReason: ReasonCorporateAction, Flags: []string{FlagPriceReturnOnly}},
			{ExitReason: ReasonPivotStop, OpenAtEnd: true, Flags: []string{FlagStaleMarks}},
		},
		Events: []Event{
			{Kind: EventEntryCancelled, Reason: CancelGap},
			{Kind: EventEntryCancelled, Reason: CancelGap},
			{Kind: EventExitDelayed},
			{Kind: EventDividendCredit},
		},
	}
	dq := DataQualityOf(res)
	if dq.DelistingExits != 1 || dq.CorporateActionExit != 1 || dq.FallbackClose != 1 || dq.PriceReturnTrades != 1 {
		t.Fatalf("trade counts %+v", dq)
	}
	if dq.StaleMarkTrades != 0 {
		t.Fatalf("an open trade is not counted: %+v", dq)
	}
	if dq.CancelledEntries[CancelGap] != 2 || dq.DelayedExits != 1 || dq.DividendsCredited != 1 {
		t.Fatalf("event counts %+v", dq)
	}
}

func intPtr(v int) *int { return &v }
