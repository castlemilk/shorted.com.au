package picks

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

func entry(kv ...string) map[string]any {
	m := map[string]any{}
	for i := 0; i+1 < len(kv); i += 2 {
		m[kv[i]] = kv[i+1]
	}
	return m
}

// The EPS unit heuristic: the unit is read next to the value's own number.
func TestFilingEPSUnitHeuristic(t *testing.T) {
	cases := []struct {
		e       map[string]any
		dollars float64
		cols    []string
		why     string
	}{
		{entry("source_text", "Basic earnings per share was 94.2 cents", "value_cents", "94.2"), 0.942, []string{"eps_basic"}, "the prompt's own example"},
		{entry("source_text", "EPS of 12.3c (pcp: 10.1c)", "value_cents", "12.3"), 0.123, []string{"eps_basic"}, "c suffix"},
		{entry("source_text", "Earnings per share 45.6 cps", "value", "45.6"), 0.456, []string{"eps_basic"}, "cps suffix beats a unitless key"},
		{entry("source_text", "Earnings per share of $0.94", "value", "0.94"), 0.94, []string{"eps_basic"}, "dollar prefix"},
		{entry("source_text", "Diluted EPS of US$1.56 per share", "value", "1.56"), 1.56, []string{"eps_diluted"}, "US$ is still dollars; diluted"},
		{entry("source_text", "Loss per share of 3.4 cents", "value_cents", "3.4"), -0.034, []string{"eps_basic"}, "loss per share is negative"},
		{entry("source_text", "Basic EPS (2.1) cents", "value_cents", "2.1"), -0.021, []string{"eps_basic"}, "parenthesised is negative"},
		{entry("source_text", "Basic EPS 94.2c, diluted EPS 93.8c", "value_cents", "93.8"), 0.938, []string{"eps_diluted"}, "nearest qualifier before the number"},
		{entry("source_text", "Basic EPS 94.2c, diluted EPS 93.8c", "value_cents", "94.2"), 0.942, []string{"eps_basic"}, "nearest qualifier before the number"},
		{entry("source_text", "Basic and diluted earnings per share: 5.6 cents", "value_cents", "5.6"), 0.056, []string{"eps_basic", "eps_diluted"}, "both"},
		{entry("source_text", "Earnings per share 5.6", "value_cents", "5.6"), 0.056, []string{"eps_basic"}, "no unit in text: the attribute name decides"},
		{entry("source_text", "Earnings per share 0.56", "value_dollars", "0.56"), 0.56, []string{"eps_basic"}, "no unit in text: the attribute name decides"},
	}
	for _, c := range cases {
		got, reason, ok := filingEPS(c.e)
		if assert.True(t, ok, "%v rejected (%s): %s", c.e, reason, c.why) {
			assert.InDelta(t, c.dollars, got.dollars, 1e-12, c.why)
			assert.Equal(t, c.cols, got.cols, c.why)
		}
	}

	rejects := []struct {
		e   map[string]any
		why string
	}{
		{entry("source_text", "Earnings per share 5.6", "value", "5.6"), "no unit anywhere: cents or dollars is a guess"},
		{entry("source_text", "Basic EPS increased 12% to 105.5 cents", "value_cents", "94.2"), "value not in its quote"},
		{entry("source_text", "EPS 94.2 cents", "value_millions", "94.2"), "only value_millions: a confused extraction"},
		{entry("source_text", "Underlying EPS 30.1 cents", "value_cents", "30.1"), "not statutory"},
		{entry("source_text", "EPS $1.2 million", "value", "1.2"), "a scaled amount is not a per-share figure"},
		{entry("value_cents", "30.1"), "no quote"},
	}
	for _, c := range rejects {
		_, _, ok := filingEPS(c.e)
		assert.False(t, ok, "%v accepted: %s", c.e, c.why)
	}
}

func TestFilingMoneyScale(t *testing.T) {
	cases := []struct {
		e    map[string]any
		col  string
		want float64
		why  string
	}{
		{entry("source_text", "Revenue from ordinary activities up 12% to $45.2 million", "value_millions", "45.2"), "revenue", 45.2e6, "the Appendix 4D summary line"},
		{entry("source_text", "Revenue from continuing operations for the half year ended 31 December 2024 was $5,142 million", "value_millions", "5142"), "revenue", 5142e6, "the prompt's example"},
		{entry("source_text", "Revenue of $1.2bn", "value_millions", "1200"), "revenue", 1.2e9, "billions"},
		{entry("source_text", "Total revenue $45,213,000", "value_millions", "45.213"), "revenue", 45.213e6, "whole dollars"},
		{entry("source_text", "Revenue ($m) 45.2", "value_millions", "45.2"), "revenue", 45.2e6, "a $m table heading"},
		{entry("source_text", "Revenue ($'000) 45,213", "value_millions", "45.213"), "revenue", 45.213e6, "a $'000 table heading"},
		{entry("source_text", "Statutory net profit after tax (NPAT) was $1,823 million, up 12% on pcp", "value_millions", "1823"), "net_income", 1823e6, "statutory NPAT"},
		{entry("source_text", "Net loss after tax of $3.2 million", "value_millions", "3.2"), "net_income", -3.2e6, "a loss is negative"},
		{entry("source_text", "Net profit after tax of ($3.2m)", "value_millions", "-3.2"), "net_income", -3.2e6, "a negative value stays negative"},
	}
	for _, c := range cases {
		got, reason, ok := filingMoney(c.e, c.col)
		if assert.True(t, ok, "%v rejected (%s): %s", c.e, reason, c.why) {
			assert.InDelta(t, c.want, got, 1e-3, c.why)
		}
	}
	rejects := []struct {
		e   map[string]any
		col string
		why string
	}{
		{entry("source_text", "Revenue 45.2", "value_millions", "45.2"), "revenue", "no scale: millions or thousands is a guess"},
		{entry("source_text", "Revenue ($'000) 45,213", "value_millions", "45213"), "revenue", "the model read a $'000 table as millions"},
		{entry("source_text", "Revenue $1.2 billion", "value_millions", "1.2"), "revenue", "the model left billions unscaled"},
		{entry("source_text", "Underlying NPAT $12.1 million", "value_millions", "12.1"), "net_income", "not statutory"},
		{entry("source_text", "EBITDA was $2,891 million", "value_millions", "2891"), "revenue", "not revenue"},
		{entry("source_text", "Revenue of $5.1 million", "value_millions", "-5.1"), "revenue", "negative revenue"},
		{entry("source_text", "Revenue of $5.1 million"), "revenue", "no value"},
	}
	for _, c := range rejects {
		_, _, ok := filingMoney(c.e, c.col)
		assert.False(t, ok, "%v accepted: %s", c.e, c.why)
	}
}

func TestTextCurrency(t *testing.T) {
	for text, want := range map[string]string{
		"Revenue of US$5.1bn":            "USD",
		"Basic EPS 94.2 US cents":        "USD",
		"Revenue of NZ$45.2 million":     "NZD",
		"Revenue A$45.2 million":         "AUD",
		"Revenue of $45.2 million":       "XXX", // the default passes through
		"Revenue of £12.1 million":       "GBP",
		"Profit of €3.2 million":         "EUR",
		"Revenue of AUD 45.2 million":    "AUD",
		"Underlying revenue USD 12.0bn.": "USD",
	} {
		got, ok := textCurrency(text, "XXX")
		assert.True(t, ok, text)
		assert.Equal(t, want, got, text)
	}
	_, ok := textCurrency("Revenue US$1.2bn (A$1.8bn)", "AUD")
	assert.False(t, ok, "two currencies in one quote is ambiguous")
}

func metricsJSON(t *testing.T, m map[string]any) string {
	t.Helper()
	b, err := json.Marshal(m)
	require.NoError(t, err)
	return string(b)
}

func TestBuildFilingRowsMergesAndGuards(t *testing.T) {
	half := map[string]any{
		"revenue":    entry("source_text", "Revenue from ordinary activities up 20% to $60.0 million", "value_millions", "60", "period", "H1 FY2026"),
		"net_profit": entry("source_text", "Net profit after tax of $6.0 million", "value_millions", "6", "period", "H1 FY2026"),
		"eps":        entry("source_text", "Basic earnings per share 3.0 cents", "value_cents", "3.0", "period", "H1 FY2026"),
		"dividend":   entry("source_text", "Interim dividend 1.5 cents", "value_cents", "1.5", "period", "H1 FY2026"),
	}
	presentation := map[string]any{
		// A presentation rounding the same half differently: loses to the 4D.
		"revenue": entry("source_text", "Revenue $61 million", "value_millions", "61", "period", "1H26"),
		// ...but supplies the prior half, which the 4D row lacks.
		"net_profit": []any{
			entry("source_text", "NPAT $5.0 million", "value_millions", "5", "period", "1H25"),
		},
	}
	annual := map[string]any{
		"revenue": entry("source_text", "Revenue of $100.0 million", "value_millions", "100", "period", "FY2025"),
	}
	exts := []filingExtraction{
		{Code: "abc", URL: "u-pres", Title: "1H26 Results Presentation", ReportDate: date("2026-02-20"), Metrics: metricsJSON(t, presentation)},
		{Code: "ABC", URL: "u-4d", Title: "Appendix 4D - Half Year Report", ReportDate: date("2026-02-20"), Metrics: metricsJSON(t, half)},
		{Code: "ABC", URL: "u-4e", Title: "Appendix 4E and Annual Report", ReportDate: date("2025-08-20"), Metrics: metricsJSON(t, annual)},
		{Code: "ABC", URL: "u-agm", Title: "Results of Meeting", ReportDate: date("2025-11-20"), Metrics: metricsJSON(t, annual)},
		{Code: "ABC", URL: "u-q", Title: "Quarterly Activities Report", ReportDate: date("2025-10-28"), Metrics: metricsJSON(t, half)},
		{Code: "ABC", URL: "u-bad", Title: "Appendix 4D", ReportDate: date("2026-02-20"), Metrics: `not json`},
	}
	vendor := map[string][]vendorAnnual{
		// Yahoo dates this company's year 29 June (a 52/53-week year).
		"ABC": {{PeriodEnd: date("2025-06-29"), Currency: "AUD", Revenue: f64(99e6), Shares: f64(200e6)}},
	}
	var st filingStats
	out := buildFilingRows(exts, vendor, &st)

	assert.Equal(t, 2, st.HeadlineRejected, "AGM results and the quarterly")
	assert.Equal(t, 1, st.BadJSON)
	rows := out["ABC"]
	require.Len(t, rows, 3, "H1 FY25, FY25, H1 FY26")

	h25 := rows[0]
	assert.Equal(t, periodHalf, h25.PeriodType)
	assert.Equal(t, "2024-12-31", h25.PeriodEnd.Format("2006-01-02"))
	assert.Nil(t, h25.Revenue)
	assert.InDelta(t, 5e6, val(t, h25.NetIncome), 1e-6, "the prior half from the presentation")

	fy25 := rows[1]
	assert.Equal(t, periodAnnual, fy25.PeriodType)
	assert.Equal(t, "2025-06-29", fy25.PeriodEnd.Format("2006-01-02"), "snapped onto the vendor's date for the same year")
	assert.InDelta(t, 100e6, val(t, fy25.Revenue), 1e-6)

	h26 := rows[2]
	assert.Equal(t, "2025-12-31", h26.PeriodEnd.Format("2006-01-02"))
	assert.InDelta(t, 60e6, val(t, h26.Revenue), 1e-6, "the statutory 4D beats the presentation")
	assert.InDelta(t, 6e6, val(t, h26.NetIncome), 1e-6)
	assert.InDelta(t, 0.03, val(t, h26.EPSBasic), 1e-12)
	assert.Nil(t, h26.EPSDiluted)
	assert.Equal(t, "AUD", h26.Currency)
	assert.Equal(t, sourceFiling, h26.Source)
	require.NotNil(t, h26.FiscalYear)
	assert.Equal(t, int16(2026), *h26.FiscalYear, "H1 FY26 is FY2026")
}

func TestBuildFilingRowsCrossChecks(t *testing.T) {
	m := map[string]any{
		// Revenue 1000x the vendor's: a unit slip.
		"revenue":    entry("source_text", "Revenue $45,000 million", "value_millions", "45000", "period", "H1 FY2026"),
		"net_profit": entry("source_text", "Net profit after tax $2.0 million", "value_millions", "2", "period", "H1 FY2026"),
		// "$1.00" per share against NPAT $2m / 200m shares = 1 cent: 100x off.
		"eps": entry("source_text", "Earnings per share $1.00", "value", "1.00", "period", "H1 FY2026"),
	}
	two := map[string]any{
		// One document, two different values for one period: ambiguous.
		"revenue": []any{
			entry("source_text", "Revenue $40.0 million", "value_millions", "40", "period", "H1 FY2026"),
			entry("source_text", "Revenue $44.0 million", "value_millions", "44", "period", "H1 FY2026"),
		},
	}
	usd := map[string]any{
		"revenue": entry("source_text", "Revenue of $5,100 million", "value_millions", "5100", "period", "H1 FY2026"),
	}
	exts := []filingExtraction{
		{Code: "XYZ", URL: "a", Title: "Appendix 4D", ReportDate: date("2026-02-20"), Metrics: metricsJSON(t, m)},
		{Code: "TWO", URL: "b", Title: "Appendix 4D", ReportDate: date("2026-02-20"), Metrics: metricsJSON(t, two)},
		{Code: "BHP", URL: "c", Title: "Appendix 4D", ReportDate: date("2026-02-20"), Metrics: metricsJSON(t, usd)},
	}
	vendor := map[string][]vendorAnnual{
		"XYZ": {{PeriodEnd: date("2025-06-30"), Currency: "AUD", Revenue: f64(90e6), Shares: f64(200e6)}},
		"BHP": {{PeriodEnd: date("2025-06-30"), Currency: "USD", Revenue: f64(51e9), Shares: f64(5e9)}},
	}
	var st filingStats
	out := buildFilingRows(exts, vendor, &st)

	require.Len(t, out["XYZ"], 1)
	x := out["XYZ"][0]
	assert.Nil(t, x.Revenue, "1000x the vendor's annual revenue is dropped")
	assert.Nil(t, x.EPSBasic, "100x away from NPAT / shares is dropped")
	assert.InDelta(t, 2e6, val(t, x.NetIncome), 1e-6)
	assert.Equal(t, 1, st.MagnitudeDropped)
	assert.Equal(t, 1, st.EPSCrossChecked)

	assert.NotContains(t, out, "TWO", "an ambiguous document writes nothing")

	require.Len(t, out["BHP"], 1)
	assert.Equal(t, "USD", out["BHP"][0].Currency, "a bare $ in a USD reporter's filing is USD")
}

// The conflict policy lives in the SQL; these pin its shape (the scratch
// Postgres run in the plan's verification exercises it for real, and
// TestFilingUpsertPolicyAgainstPostgres does when PICKS_TEST_DATABASE_URL is
// set).
func TestFilingUpsertSQLShape(t *testing.T) {
	sql := filingUpsertSQL
	for _, col := range []string{"revenue", "net_income", "eps_basic", "eps_diluted"} {
		assert.Regexp(t, regexp.MustCompile(col+`\s+= CASE WHEN f\.source <> 'asx-filing-extraction'\s+THEN CASE WHEN f\.currency = EXCLUDED\.currency THEN COALESCE\(f\.`+col+`, EXCLUDED\.`+col+`\) ELSE f\.`+col+` END\s+ELSE EXCLUDED\.`+col+` END`), sql,
			"%s: a vendor value is never overwritten, only a NULL filled (same currency); a filing row is replaced", col)
	}
	for _, col := range []string{"currency", "source", "source_fetched_at"} {
		assert.Regexp(t, regexp.MustCompile(col+`\s+= CASE WHEN f\.source <> 'asx-filing-extraction' THEN f\.`+col+` ELSE EXCLUDED\.`+col+` END`), sql, col)
	}
	assert.Contains(t, sql, "ON CONFLICT (stock_code, period_type, period_end) DO UPDATE SET")
	assert.NotContains(t, sql, "operating_cash_flow", "a filing never touches the columns it does not carry")
	// The prune is scoped to this code and to the filing source.
	assert.Regexp(t, regexp.MustCompile(`DELETE FROM stock_fundamentals d\s+WHERE d\.stock_code = \$1\s+AND d\.source = 'asx-filing-extraction'`), sql)

	placeholders := map[string]bool{}
	for _, m := range regexp.MustCompile(`\$(\d+)`).FindAllStringSubmatch(sql, -1) {
		placeholders[m[1]] = true
	}
	row := PeriodRow{PeriodType: periodHalf, PeriodEnd: date("2025-12-31"), Currency: "AUD", Revenue: f64(1), Source: sourceFiling}
	assert.Len(t, placeholders, len(filingUpsertArgs("ABC", []PeriodRow{row}, time.Now())))
}

func TestVendorUpsertTakesOverAFilingRow(t *testing.T) {
	// The reverse direction: Yahoo arriving for a period a filing wrote first.
	// Its values win (COALESCE(EXCLUDED, stored)) and its source replaces
	// the filing's, so the filing policy treats the row as a vendor's after.
	assert.Contains(t, upsertSQL, "COALESCE(EXCLUDED.revenue, f.revenue)")
	assert.Contains(t, upsertSQL, "source              = EXCLUDED.source")
}

func TestRunFilingsDryRunWritesNothing(t *testing.T) {
	st := &fakeStore{extractions: []filingExtraction{{
		Code: "ABC", URL: "u", Title: "Appendix 4D", ReportDate: date("2026-02-20"),
		Metrics: `{"revenue": {"source_text": "Revenue up 20% to $60.0 million", "value_millions": "60", "period": "H1 FY2026"}}`,
	}}}
	stats, err := runFilings(context.Background(), st, true, func(string, ...any) {})
	require.NoError(t, err)
	assert.Equal(t, 1, stats.Rows)
	assert.Equal(t, 0, st.writes())

	stats, err = runFilings(context.Background(), st, false, func(string, ...any) {})
	require.NoError(t, err)
	assert.Equal(t, 1, stats.Written)
	require.Len(t, st.filingUpserts["ABC"], 1)
}

func TestRunFilingsExitRule(t *testing.T) {
	ext := func(code string) filingExtraction {
		return filingExtraction{Code: code, URL: "u-" + code, Title: "Appendix 4D", ReportDate: date("2026-02-20"),
			Metrics: `{"revenue": {"source_text": "Revenue $60.0 million", "value_millions": "60", "period": "H1 FY2026"}}`}
	}
	st := &fakeStore{
		extractions:     []filingExtraction{ext("AAA"), ext("BBB")},
		filingUpsertErr: map[string]error{"AAA": errors.New("boom")},
	}
	_, err := runFilings(context.Background(), st, false, func(string, ...any) {})
	require.Error(t, err)
	assert.Equal(t, exitCodeDegraded, runner.ExitCodeOf(err), "some codes failed: DEGRADED")

	st.filingUpsertErr["BBB"] = errors.New("boom")
	st.filingUpserts = nil
	_, err = runFilings(context.Background(), st, false, func(string, ...any) {})
	require.Error(t, err)
	assert.Equal(t, 1, runner.ExitCodeOf(err), "every write failed: DOWN")

	_, err = runFilings(context.Background(), nil, false, func(string, ...any) {})
	require.Error(t, err)
}

func TestWorstError(t *testing.T) {
	degraded := &runner.ExitCodeError{Code: exitCodeDegraded, Err: errors.New("fundamentals degraded")}
	hard := errors.New("refresh failed")
	assert.NoError(t, worstError(nil, nil))
	assert.Equal(t, exitCodeDegraded, runner.ExitCodeOf(worstError(nil, stepError("fundamentals", degraded))))
	err := worstError(stepError("fundamentals", degraded), stepError("refresh", hard))
	assert.Equal(t, 1, runner.ExitCodeOf(err), "a hard failure beats DEGRADED")
	assert.True(t, strings.Contains(err.Error(), "fundamentals degraded"), "the other verdict rides along: %v", err)
}

func TestModeAllRunsFilingsBetweenFundamentalsAndRefresh(t *testing.T) {
	// Structural: Run's -mode all order is fundamentals -> filings -> refresh.
	src := readSource(t, "job.go")
	f := strings.Index(src, "runFundamentals(ctx, cfg)")
	g := strings.Index(src, "runFilings(ctx, st, *dryRun, log.Printf)")
	r := strings.Index(src, "runRefresh(ctx, st, *dryRun, log.Printf)")
	require.True(t, f > 0 && g > 0 && r > 0)
	assert.True(t, f < g && g < r, "fundamentals, then filings, then refresh")
}

func readSource(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(name)
	require.NoError(t, err)
	return string(b)
}
