package strategies

import (
	"context"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
)

// normalise collapses every run of whitespace, so the copied CTEs compare with
// the migration's indentation ignored and nothing else.
func normalise(s string) string { return strings.Join(strings.Fields(s), " ") }

// TestScreenerCTEsMatchMigration holds the copied CTE bodies to migration 000080
// word for word. The migration is the source of truth; the job copies it because
// the job image carries no migrations.
func TestScreenerCTEsMatchMigration(t *testing.T) {
	src, err := os.ReadFile("../../../../migrations/000080_mv_logo_icons.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	latest := regexp.MustCompile(`(?s)\blatest_shorts AS \((.*?)\n\s*\), short_change AS \(`)
	avg := regexp.MustCompile(`(?s)\bavg_volume AS \((.*?)\n\s*\), price_change AS \(`)
	m1 := latest.FindSubmatch(src)
	m2 := avg.FindSubmatch(src)
	if m1 == nil || m2 == nil {
		t.Fatal("000080 no longer defines latest_shorts and avg_volume in the shape the parity copies")
	}
	if got, want := normalise(latestShortsCTE), normalise(string(m1[1])); got != want {
		t.Errorf("latestShortsCTE drifted from 000080:\n got %s\nwant %s", got, want)
	}
	if got, want := normalise(avgVolumeCTE), normalise(string(m2[1])); got != want {
		t.Errorf("avgVolumeCTE drifted from 000080:\n got %s\nwant %s", got, want)
	}
	// The average is the one the days-to-cover check reads over 35 calendar days.
	if !strings.Contains(avgVolumeCTE, "CURRENT_DATE - '35 days'") {
		t.Error("avgVolumeCTE no longer reads the 35-day window DaysToCoverV0 uses")
	}
}

func TestSweepVerdict(t *testing.T) {
	refresh := time.Date(2026, 11, 5, 13, 30, 0, 0, time.UTC)
	before := refresh.Add(-time.Hour)
	after := refresh.Add(time.Hour)
	cases := []struct {
		name       string
		row        *sweepRow
		conclusive bool
		reason     string
	}{
		{"no sweep row", nil, false, "no_sweep_row"},
		{"sweep still running", &sweepRow{Status: "running"}, false, "sweep_running"},
		{"sweep failed", &sweepRow{Status: "failed"}, false, "sweep_failed"},
		{"completed without a finish time", &sweepRow{Status: "completed"}, false, "sweep_unfinished"},
		{"finished after the refresh began", &sweepRow{Status: "completed", CompletedAt: &after}, false, "sweep_after_refresh"},
		{"finished before the refresh", &sweepRow{Status: "completed", CompletedAt: &before}, true, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ok, reason := sweepVerdict(c.row, refresh)
			if ok != c.conclusive || reason != c.reason {
				t.Errorf("sweepVerdict = (%v, %q), want (%v, %q)", ok, reason, c.conclusive, c.reason)
			}
		})
	}
}

func TestInconclusiveLineKeepsTheComparison(t *testing.T) {
	r := Result{
		D: civil.Date{Year: 2026, Month: 11, Day: 5}, Reason: "sweep_running", Codes: 1800,
		OnlyView: 1, Mismatches: 2, Fields: map[string]int{"sma50": 2}, Examples: []string{"ABC"},
	}
	want := "strategy_parity d=2026-11-05 codes=1800 only_view=1 only_go=0 mismatches=2 fields=sma50:2 examples=ABC conclusive=false inconclusive=sweep_running"
	if got := r.Line(); got != want {
		t.Errorf("Line() =\n %q\nwant %q", got, want)
	}
}

func TestInfoLineNamesTheScreenerCounts(t *testing.T) {
	d := civil.Date{Year: 2026, Month: 11, Day: 5}
	r := Result{Codes: 3, OnlyView: 1, Mismatches: 1, Fields: map[string]int{"days_to_cover": 1}, Examples: []string{"AAA"}}
	want := "strategy_parity_info d=2026-11-05 screener_codes=3 screener_only_view=1 screener_only_go=0 screener_mismatches=1 screener_fields=days_to_cover:1 screener_examples=AAA"
	if got := infoLine(d, r); got != want {
		t.Errorf("infoLine() = %q, want %q", got, want)
	}
}

func TestCompareScreenerIsCountedOnItsOwn(t *testing.T) {
	d := civil.Date{Year: 2026, Month: 11, Day: 5}
	two := 2.0
	c := newComparison()
	compareScreener(
		map[string]shortRead{"AAA": {ReportDate: d, Positions: 1, DTC: &two}, "BBB": {ReportDate: d, Positions: 1}},
		map[string]float64{"AAA": 3, "CCC": 1},
		c,
	)
	r := c.result(d)
	if r.OnlyGo != 1 || r.OnlyView != 1 || r.Mismatches != 1 || r.Fields["days_to_cover"] != 1 {
		t.Errorf("screener diff = only_go %d only_view %d mismatches %d fields %v", r.OnlyGo, r.OnlyView, r.Mismatches, r.Fields)
	}
}

func TestConclusiveLineNamesCountsFieldsAndExamples(t *testing.T) {
	r := Result{
		D: civil.Date{Year: 2026, Month: 11, Day: 5}, Conclusive: true, Codes: 1800,
		OnlyView: 1, OnlyGo: 0, Mismatches: 2,
		Fields:   map[string]int{"sma50": 2, "close": 1},
		Examples: []string{"ABC", "XYZ"},
	}
	want := "strategy_parity d=2026-11-05 codes=1800 only_view=1 only_go=0 mismatches=2 fields=close:1,sma50:2 examples=ABC,XYZ conclusive=true"
	if got := r.Line(); got != want {
		t.Errorf("Line() =\n %q\nwant %q", got, want)
	}
	clean := Result{D: r.D, Conclusive: true, Codes: 3}
	if got := clean.Line(); !strings.HasSuffix(got, "mismatches=0 fields=none examples=none conclusive=true") {
		t.Errorf("clean Line() = %q", got)
	}
}

// priceRow is a feature row and its view row that agree on every column.
func priceRow(d civil.Date, close float64) (features.PriceFeatures, features.ViewPrice) {
	return features.PriceFeatures{AsOf: d, Close: close, Volume: 5},
		features.ViewPrice{AsOf: time.Date(d.Year, d.Month, d.Day, 0, 0, 0, 0, time.UTC), Close: close, Volume: 5}
}

func TestComparePricesCountsBothSidesAndMismatches(t *testing.T) {
	d := civil.Date{Year: 2026, Month: 11, Day: 5}
	gA, vA := priceRow(d, 10)
	gB, vB := priceRow(d, 10)
	vB.Close = 11 // a column that disagrees
	gC, _ := priceRow(d, 10)
	_, vD := priceRow(d, 10) // view only
	goRows := map[string]features.PriceFeatures{"AAA": gA, "BBB": gB, "CCC": gC}
	view := map[string]features.ViewPrice{"AAA": vA, "BBB": vB, "DDD": vD}

	c := newComparison()
	comparePrices(goRows, view, c)
	r := c.result(d)
	if r.Codes != 4 {
		t.Errorf("codes = %d, want 4 (AAA BBB CCC DDD)", r.Codes)
	}
	if r.OnlyGo != 1 || r.OnlyView != 1 {
		t.Errorf("only_go=%d only_view=%d, want 1 and 1", r.OnlyGo, r.OnlyView)
	}
	if r.Mismatches != 1 || r.Fields["close"] != 1 {
		t.Errorf("mismatches=%d fields=%v, want one close mismatch", r.Mismatches, r.Fields)
	}
	if want := []string{"BBB", "CCC", "DDD"}; strings.Join(r.Examples, ",") != strings.Join(want, ",") {
		t.Errorf("examples = %v, want %v", r.Examples, want)
	}
}

func TestExamplesAreCapped(t *testing.T) {
	d := civil.Date{Year: 2026, Month: 11, Day: 5}
	goRows := map[string]features.PriceFeatures{}
	view := map[string]features.ViewPrice{}
	for _, code := range []string{"A1", "A2", "A3", "A4", "A5", "A6", "A7"} {
		g, v := priceRow(d, 10)
		v.Close = 12
		goRows[code] = g
		view[code] = v
	}
	c := newComparison()
	comparePrices(goRows, view, c)
	r := c.result(d)
	if r.Mismatches != 7 || len(r.Examples) != examplesCap {
		t.Errorf("mismatches=%d examples=%d, want 7 and %d", r.Mismatches, len(r.Examples), examplesCap)
	}
}

func TestCompareRegimeMissingRowIsADisagreement(t *testing.T) {
	c := newComparison()
	compareRegime(engine.Regime{IndexCode: engine.DefaultIndexCode}, features.ViewRegime{}, false, c)
	r := c.result(civil.Date{Year: 2026, Month: 11, Day: 5})
	if r.Mismatches != 1 || r.Fields["regime_row"] != 1 {
		t.Errorf("missing regime row: mismatches=%d fields=%v", r.Mismatches, r.Fields)
	}
}

func TestCompareRegimeAgreesOnAMatchingRow(t *testing.T) {
	d := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	label := engine.RegimeUptrend
	level := 7000.0
	got := engine.Regime{IndexCode: engine.DefaultIndexCode, AsOf: &d, Close: &level, Label: label}
	view := features.ViewRegime{AsOf: &d, Close: &level, Label: &label}
	c := newComparison()
	compareRegime(got, view, true, c)
	if r := c.result(civil.Date{Year: 2026, Month: 11, Day: 5}); r.Mismatches != 0 {
		t.Errorf("matching regime reported %d mismatches: %v", r.Mismatches, r.Fields)
	}
}

func TestCompareSharesReadsTheDaysToCoverRule(t *testing.T) {
	d := civil.Date{Year: 2026, Month: 11, Day: 5}
	// positions 2500 over an average of 1000 is 2.5 days, rounded as the view rounds it.
	dtc := 2.5
	good := shortRead{ReportDate: d, Positions: 2500, DTC: &dtc}
	goodView := shortView{ReportDate: d, Positions: 2500, DTC: 2.5}

	unknownGo := shortRead{ReportDate: d, Positions: 2500, DTC: nil}
	unknownView := shortView{ReportDate: d, Positions: 2500, DTC: 0} // the view stores 0

	wrongDate := shortRead{ReportDate: d.AddDays(-7), Positions: 2500, DTC: &dtc}

	goRows := map[string]shortRead{"GOOD": good, "UNKN": unknownGo, "DATE": wrongDate, "GONLY": good}
	view := map[string]shortView{"GOOD": goodView, "UNKN": unknownView, "DATE": goodView, "VONLY": goodView}

	c := newComparison()
	compareShorts(goRows, view, c)
	r := c.result(d)
	if r.OnlyGo != 1 || r.OnlyView != 1 {
		t.Errorf("only_go=%d only_view=%d, want 1 and 1", r.OnlyGo, r.OnlyView)
	}
	if r.Mismatches != 1 || r.Fields["report_date"] != 1 {
		t.Errorf("mismatches=%d fields=%v, want one report_date mismatch", r.Mismatches, r.Fields)
	}
	if strings.Contains(strings.Join(r.Examples, ","), "GOOD") {
		t.Errorf("GOOD agrees on every column but is named: %v", r.Examples)
	}
}

func TestCompareSharesFlagsADifferentDaysToCover(t *testing.T) {
	d := civil.Date{Year: 2026, Month: 11, Day: 5}
	wrong := 9.9
	c := newComparison()
	compareShorts(
		map[string]shortRead{"AAA": {ReportDate: d, Positions: 2500, DTC: &wrong}},
		map[string]shortView{"AAA": {ReportDate: d, Positions: 2500, DTC: 2.5}},
		c,
	)
	if r := c.result(d); r.Fields["days_to_cover"] != 1 || r.Mismatches != 1 {
		t.Errorf("fields=%v mismatches=%d, want one days_to_cover", r.Fields, r.Mismatches)
	}
}

func TestBarsFromCopiesTheWindow(t *testing.T) {
	bars := []features.Bar{
		{Date: civil.Date{Year: 2026, Month: 10, Day: 1}},
		{Date: civil.Date{Year: 2026, Month: 10, Day: 20}},
		{Date: civil.Date{Year: 2026, Month: 11, Day: 4}},
	}
	got := barsFrom(bars, civil.Date{Year: 2026, Month: 10, Day: 15})
	if len(got) != 2 || got[0].Date.Day != 20 {
		t.Fatalf("barsFrom = %v", got)
	}
	got[0].Close = 99
	if bars[1].Close == 99 {
		t.Error("barsFrom shares its backing array with the history")
	}
}

// TestRunParityRecoversAPanic: a broken pool must not escape as a panic into
// the picks run that called the shadow.
func TestRunParityRecoversAPanic(t *testing.T) {
	var logged []string
	logf := func(format string, args ...any) { logged = append(logged, format) }
	_, err := RunParity(context.Background(), nil, time.Now(), logf)
	if err == nil {
		t.Fatal("RunParity with no pool returned no error")
	}
	if len(logged) == 0 {
		t.Error("the failure was not logged")
	}
}
