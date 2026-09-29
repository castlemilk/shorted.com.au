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

func metricsJSON(t *testing.T, m map[string]any) string {
	t.Helper()
	b, err := json.Marshal(m)
	require.NoError(t, err)
	return string(b)
}

// annual / ttm vendor rows for fixtures (Yahoo source unless changed).
func vAnnual(end, cur string, revenue, netIncome, eps, shares *float64) vendorRow {
	return vendorRow{PeriodType: periodAnnual, PeriodEnd: date(end), Currency: cur, Source: sourceYahoo,
		Revenue: revenue, NetIncome: netIncome, EPSBasic: eps, Shares: shares}
}

func vTTM(end, cur string, revenue, eps *float64) vendorRow {
	return vendorRow{PeriodType: periodTTM, PeriodEnd: date(end), Currency: cur, Source: sourceYahoo, Revenue: revenue, EPSBasic: eps}
}

// The EPS unit heuristic: the unit is read next to the value's own number.
// (No case uses the prompt's few-shot example: an echo of it is withheld at
// gate 3 before any value is read.)
func TestFilingEPSUnitHeuristic(t *testing.T) {
	cases := []struct {
		e       map[string]any
		dollars float64
		cols    []string
		why     string
	}{
		{entry("source_text", "Basic earnings per share was 51.0 cents", "value_cents", "51.0"), 0.51, []string{"eps_basic"}, "cents word"},
		{entry("source_text", "EPS of 12.3c (pcp: 10.1c)", "value_cents", "12.3"), 0.123, []string{"eps_basic"}, "c suffix"},
		{entry("source_text", "Earnings per share 45.6 cps", "value", "45.6"), 0.456, []string{"eps_basic"}, "cps suffix beats a unitless key"},
		{entry("source_text", "Earnings per share of $0.94", "value", "0.94"), 0.94, []string{"eps_basic"}, "dollar prefix"},
		{entry("source_text", "Diluted EPS of US$1.56 per share", "value", "1.56"), 1.56, []string{"eps_diluted"}, "US$ is still dollars; diluted"},
		{entry("source_text", "Loss per share of 3.4 cents", "value_cents", "3.4"), -0.034, []string{"eps_basic"}, "loss per share is negative"},
		{entry("source_text", "Basic EPS (2.1) cents", "value_cents", "2.1"), -0.021, []string{"eps_basic"}, "parenthesised is negative"},
		{entry("source_text", "Basic EPS 94.1c, diluted EPS 93.8c", "value_cents", "93.8"), 0.938, []string{"eps_diluted"}, "nearest qualifier before the number"},
		{entry("source_text", "Basic EPS 94.1c, diluted EPS 93.8c", "value_cents", "94.1"), 0.941, []string{"eps_basic"}, "nearest qualifier before the number"},
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
		{entry("source_text", "Cash EPS 30.1 cents", "value_cents", "30.1"), "not statutory (cash earnings)"},
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
		e     map[string]any
		col   string
		units string
		want  float64
		why   string
	}{
		{entry("source_text", "Revenue from ordinary activities up 12% to $45.2 million", "value_millions", "45.2"), "revenue", "", 45.2e6, "the Appendix 4D summary line"},
		{entry("source_text", "Revenue of $1.2bn", "value_millions", "1200"), "revenue", "", 1.2e9, "billions"},
		{entry("source_text", "Total revenue $45,213,000", "value_millions", "45.213"), "revenue", "", 45.213e6, "whole dollars"},
		{entry("source_text", "Revenue ($m) 45.2", "value_millions", "45.2"), "revenue", "", 45.2e6, "a $m table heading"},
		{entry("source_text", "Revenue ($'000) 45,213", "value_millions", "45.213"), "revenue", "", 45.213e6, "a $'000 table heading"},
		{entry("source_text", "Statutory net profit after tax (NPAT) attributable to members was $612 million", "value_millions", "612"), "net_income", "", 612e6, "statutory NPAT"},
		{entry("source_text", "Net loss after tax of $3.2 million", "value_millions", "3.2"), "net_income", "", -3.2e6, "a loss is negative"},
		{entry("source_text", "Net profit after tax of ($3.2m)", "value_millions", "-3.2"), "net_income", "", -3.2e6, "a negative value stays negative"},
		// document_meta.units (plan §4.2, last paragraph): a bare table figure.
		{entry("source_text", "Revenue from ordinary activities 51,262 down 8%", "value_millions", "51262"), "revenue", "millions", 51262e6, "a bare 4E table line under the document's US$ Million header"},
		{entry("source_text", "Revenue from ordinary activities 45,213 up 4%", "value_millions", "45.213"), "revenue", "thousands", 45.213e6, "a bare $'000 table line"},
		{entry("source_text", "Total revenue $45,213,000", "value_millions", "45.213"), "revenue", "thousands", 45.213e6, "a $-prefixed figure is not a bare table figure: whole units"},
		{entry("source_text", "Revenue ($'000) 45,213", "value_millions", "45.213"), "revenue", "millions", 45.213e6, "the quote's own heading beats the document's"},
		// PDF text layers carry the typographic apostrophe as often as ASCII.
		{entry("source_text", "30 June 2026 $’000 Revenue from ordinary activities 115,116", "value_millions", "115.116"), "revenue", "", 115.116e6, "a $’000 heading (curly apostrophe)"},
		{entry("source_text", "Revenue (’000) 45,213", "value_millions", "45.213"), "revenue", "", 45.213e6, "a (’000) heading"},
	}
	for _, c := range cases {
		got, reason, ok := filingMoney(c.e, c.col, c.units)
		if assert.True(t, ok, "%v rejected (%s): %s", c.e, reason, c.why) {
			assert.InDelta(t, c.want, got, 1e-3, c.why)
		}
	}
	rejects := []struct {
		e     map[string]any
		col   string
		units string
		why   string
	}{
		{entry("source_text", "Revenue 45.2", "value_millions", "45.2"), "revenue", "", "no scale: millions or thousands is a guess"},
		{entry("source_text", "Revenue from ordinary activities 51,262 down 8%", "value_millions", "51262"), "revenue", "", "a bare table figure without the document's unit statement"},
		{entry("source_text", "Revenue ($'000) 45,213", "value_millions", "45213"), "revenue", "", "the model read a $'000 table as millions"},
		{entry("source_text", "Revenue $1.2 billion", "value_millions", "1.2"), "revenue", "", "the model left billions unscaled"},
		{entry("source_text", "Underlying NPAT $12.1 million", "value_millions", "12.1"), "net_income", "", "not statutory"},
		{entry("source_text", "EBITDA was $1,529 million", "value_millions", "1529"), "revenue", "", "not revenue"},
		{entry("source_text", "Revenue of $5.1 million", "value_millions", "-5.1"), "revenue", "", "negative revenue"},
		{entry("source_text", "Revenue of $5.1 million"), "revenue", "", "no value"},
	}
	for _, c := range rejects {
		_, _, ok := filingMoney(c.e, c.col, c.units)
		assert.False(t, ok, "%v accepted: %s", c.e, c.why)
	}
}

// Gate 5 (plan §4.2): the statutory list, including every term the plan adds.
func TestStatutoryGate(t *testing.T) {
	for _, text := range []string{
		"Profit from operations of US$19,547 million", // BHP
		"Operating profit of $245 million",
		"Profit before tax $1.2bn",
		"Profit before income tax of $412m",
		"Cash NPAT of $5,137 million",
		"Cash earnings $5.1bn",
		"Total comprehensive income for the half of $80m",
		"Underlying NPAT up 4% to $300m",
		"Pro forma revenue of $1.1bn",
		"Network sales up 12% to $1,020 million",         // GYG, DMP
		"Online sales of $1,480 million",                 // EDV
		"Channel sales grew to $2.3bn",                   // EDV
		"Total transaction value (TTV) of $12.1 billion", // FLT
		"TTV $12.1bn",
		"Retail segment revenue of $10,532 million",
		"Segmental revenue $3bn",
		"Hotels division revenue $1.1bn",
	} {
		assert.False(t, statutory(text), "gate 5 must reject %q", text)
	}
	for _, text := range []string{
		"Revenue from ordinary activities up 3% to $3,847 million",
		"Net profit after tax attributable to members of $612 million",
		"Profit after taxation from continuing and discontinued operations attributable to BHP shareholders of US$9,019 million",
		"Statutory NPAT2 $5,142m, up 6%",
		"Basic earnings per share 48.3 cents",
	} {
		assert.True(t, statutory(text), "gate 5 must pass %q", text)
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

func TestBuildFilingRowsMergesAndGuards(t *testing.T) {
	half := map[string]any{
		"revenue":    entry("source_text", "Revenue from ordinary activities up 20% to $60.0 million", "value_millions", "60", "period", "H1 FY2026", "alignment", "match_exact"),
		"net_profit": entry("source_text", "Net profit after tax of $6.0 million", "value_millions", "6", "period", "H1 FY2026"),
		"eps":        entry("source_text", "Basic earnings per share 3.0 cents", "value_cents", "3.0", "period", "H1 FY2026"),
		"dividend":   entry("source_text", "Interim dividend 1.5 cents", "value_cents", "1.5", "period", "H1 FY2026"),
	}
	announcement := map[string]any{
		// A results announcement rounding the same half differently: loses
		// to the statutory 4D.
		"revenue": entry("source_text", "Revenue $61 million", "value_millions", "61", "period", "1H26"),
		// Its prior half is a comparative: not the document's own period.
		"net_profit": []any{entry("source_text", "NPAT $5.0 million", "value_millions", "5", "period", "1H25")},
	}
	priorHalf := map[string]any{
		"net_profit": entry("source_text", "Net profit after tax $5.0 million", "value_millions", "5", "period", "H1 FY2025"),
	}
	annual := map[string]any{
		"revenue": entry("source_text", "Revenue of $100.0 million", "value_millions", "100", "period", "FY2025"),
	}
	exts := []filingExtraction{
		{Code: "abc", URL: "u-ann", Title: "1H26 Results Announcement", ReportDate: date("2026-02-20"), Metrics: metricsJSON(t, announcement)},
		{Code: "ABC", URL: "u-pres", Title: "1H26 Results Presentation", ReportDate: date("2026-02-20"), Metrics: metricsJSON(t, announcement)},
		{Code: "ABC", URL: "u-4d", Title: "Appendix 4D - Half Year Report", ReportDate: date("2026-02-20"), Metrics: metricsJSON(t, half)},
		{Code: "ABC", URL: "u-4d-25", Title: "Appendix 4D", ReportDate: date("2025-02-20"), Metrics: metricsJSON(t, priorHalf)},
		{Code: "ABC", URL: "u-4e", Title: "Appendix 4E and Annual Report", ReportDate: date("2025-08-20"), Metrics: metricsJSON(t, annual)},
		{Code: "ABC", URL: "u-agm", Title: "Results of Meeting", ReportDate: date("2025-11-20"), Metrics: metricsJSON(t, annual)},
		{Code: "ABC", URL: "u-q", Title: "Quarterly Activities Report", ReportDate: date("2025-10-28"), Metrics: metricsJSON(t, half)},
		{Code: "ABC", URL: "u-bad", Title: "Appendix 4D", ReportDate: date("2026-02-20"), Metrics: `not json`},
	}
	vendor := map[string][]vendorRow{
		// Yahoo dates this company's year 29 June (a 52/53-week year).
		"ABC": {
			vAnnual("2025-06-29", "AUD", f64(99e6), f64(8e6), f64(0.04), f64(200e6)),
			vAnnual("2024-06-30", "AUD", f64(90e6), f64(7e6), f64(0.035), f64(200e6)),
		},
	}
	var st filingStats
	out := buildFilingRows(exts, filingInputs{vendor: vendor}, &st)

	assert.Equal(t, 3, st.Gates[gateNotResults], "the presentation, the AGM results and the quarterly")
	assert.Equal(t, 1, st.Gates[gateBadJSON])
	assert.Equal(t, 1, st.Gates[gateNotOwnPeriod], "the announcement's 1H25 comparative")
	rows := out["ABC"]
	require.Len(t, rows, 3, "H1 FY25, FY25, H1 FY26")

	h25 := rows[0]
	assert.Equal(t, periodHalf, h25.PeriodType)
	assert.Equal(t, "2024-12-31", h25.PeriodEnd.Format("2006-01-02"))
	assert.Nil(t, h25.Revenue)
	assert.InDelta(t, 5e6, val(t, h25.NetIncome), 1e-6, "the prior half from its own 4D")
	assert.Equal(t, "u-4d-25", h25.SourceDocumentURL)

	fy25 := rows[1]
	assert.Equal(t, periodAnnual, fy25.PeriodType)
	assert.Equal(t, "2025-06-29", fy25.PeriodEnd.Format("2006-01-02"), "snapped onto the vendor's date for the same year")
	assert.InDelta(t, 100e6, val(t, fy25.Revenue), 1e-6)

	h26 := rows[2]
	assert.Equal(t, "2025-12-31", h26.PeriodEnd.Format("2006-01-02"))
	assert.InDelta(t, 60e6, val(t, h26.Revenue), 1e-6, "the statutory 4D beats the announcement")
	assert.InDelta(t, 6e6, val(t, h26.NetIncome), 1e-6)
	assert.InDelta(t, 0.03, val(t, h26.EPSBasic), 1e-12)
	assert.Nil(t, h26.EPSDiluted)
	assert.Equal(t, "AUD", h26.Currency)
	assert.Equal(t, sourceFiling, h26.Source)
	assert.Equal(t, "u-4d", h26.SourceDocumentURL, "the document of the row's revenue")
	require.NotNil(t, h26.SourceDocumentDate)
	assert.Equal(t, "2026-02-20", h26.SourceDocumentDate.Format("2006-01-02"))
	assert.Empty(t, h26.FieldSources, "a filing row's own values carry no exception marker")
	require.NotNil(t, h26.FiscalYear)
	assert.Equal(t, int16(2026), *h26.FiscalYear, "H1 FY26 is FY2026")
}

func TestBuildFilingRowsCrossChecks(t *testing.T) {
	m := map[string]any{
		// Revenue 500x the vendor's: a unit slip.
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
		"revenue":    entry("source_text", "Revenue of $25,100 million", "value_millions", "25100", "period", "H1 FY2026"),
		"net_profit": entry("source_text", "Net profit after tax A$9,000 million", "value_millions", "9000", "period", "H1 FY2026"),
	}
	exts := []filingExtraction{
		{Code: "XYZ", URL: "a", Title: "Appendix 4D", ReportDate: date("2026-02-20"), Metrics: metricsJSON(t, m)},
		{Code: "TWO", URL: "b", Title: "Appendix 4D", ReportDate: date("2026-02-20"), Metrics: metricsJSON(t, two)},
		{Code: "BHP", URL: "c", Title: "Appendix 4D", ReportDate: date("2026-02-20"), Metrics: metricsJSON(t, usd)},
	}
	vendor := map[string][]vendorRow{
		"XYZ": {vAnnual("2025-06-30", "AUD", f64(90e6), f64(4e6), f64(0.02), f64(200e6))},
		"TWO": {vAnnual("2025-06-30", "AUD", f64(80e6), nil, nil, nil)},
		"BHP": {vAnnual("2025-06-30", "USD", f64(51e9), f64(9e9), f64(1.8), f64(5e9))},
	}
	var st filingStats
	out := buildFilingRows(exts, filingInputs{vendor: vendor}, &st)

	require.Len(t, out["XYZ"], 1)
	x := out["XYZ"][0]
	assert.Nil(t, x.Revenue, "500x the vendor's prior-year revenue is out of the half band")
	assert.Nil(t, x.EPSBasic, "100x away from NPAT / shares is dropped")
	assert.InDelta(t, 2e6, val(t, x.NetIncome), 1e-6)
	assert.Equal(t, 1, st.Gates[gateRevenueRange])
	assert.Equal(t, 1, st.Gates[gateEPSRange])

	assert.NotContains(t, out, "TWO", "an ambiguous document writes nothing")

	require.Len(t, out["BHP"], 1)
	b := out["BHP"][0]
	assert.Equal(t, "USD", b.Currency, "a bare $ in a USD reporter's filing is USD")
	assert.InDelta(t, 25.1e9, val(t, b.Revenue), 1)
	assert.Nil(t, b.NetIncome, "an A$ figure in a USD reporter's filing is withheld (gate 7)")
	assert.Equal(t, 1, st.Gates[gateCurrencyQuote])
}

// The rebuild's removal rule, in Go (what the SQL applies and what the
// dry-run and refusal logs print).
func TestPlanPurge(t *testing.T) {
	rows := map[string][]PeriodRow{
		"ABC": {
			{PeriodType: periodHalf, PeriodEnd: date("2025-12-31"), Revenue: f64(1), Source: sourceFiling},
			{PeriodType: periodAnnual, PeriodEnd: date("2025-06-30"), NetIncome: f64(2), Source: sourceFiling},
		},
	}
	stored := []storedFiling{
		{Key: filingRowKey{"ABC", periodHalf, date("2025-12-31")}, Source: sourceFiling}, // reproduced
		{Key: filingRowKey{"ABC", periodHalf, date("2024-12-31")}, Source: sourceFiling}, // not produced: purged
		{Key: filingRowKey{"BHP", periodHalf, date("2025-12-31")}, Source: sourceFiling}, // the echo row: purged
		{Key: filingRowKey{"ABC", periodAnnual, date("2025-06-30")}, Source: sourceYahoo, // vendor row
			FilingCols: []string{"net_income", "revenue"}}, // net_income reproduced, revenue not
		{Key: filingRowKey{"CBA", periodAnnual, date("2025-06-30")}, Source: sourceYahoo, FilingCols: []string{"eps_basic"}},
	}
	purge, null := planPurge(stored, rows)
	assert.Equal(t, []filingRowKey{
		{"ABC", periodHalf, date("2024-12-31")},
		{"BHP", periodHalf, date("2025-12-31")},
	}, purge)
	assert.Equal(t, []filingFieldKey{
		{filingRowKey{"ABC", periodAnnual, date("2025-06-30")}, "revenue"},
		{filingRowKey{"CBA", periodAnnual, date("2025-06-30")}, "eps_basic"},
	}, null)
}

// The upsert policy lives in the SQL; these pin its shape (the env-gated
// real-Postgres test runs it).
func TestFilingSQLShape(t *testing.T) {
	sql := filingUpsertSQL
	for _, col := range filingWriteColumns {
		// A vendor row's value is taken only when the currencies agree and it
		// is NULL or already filing-marked.
		assert.Contains(t, sql, "(f.currency = EXCLUDED.currency AND EXCLUDED."+col+" IS NOT NULL AND (f."+col+" IS NULL OR f.field_sources->>'"+col+"' = 'asx-filing-extraction'))", col)
		// A vendor-origin value on a filing row is kept.
		assert.Contains(t, sql, "f.field_sources ? '"+col+"' AND f.field_sources->>'"+col+"' <> 'asx-filing-extraction'", col)
		// The marker is recorded when the filing's value is taken.
		assert.Regexp(t, regexp.MustCompile(`'`+col+`', CASE WHEN \(f\.currency = EXCLUDED\.currency AND EXCLUDED\.`+col+` IS NOT NULL`), sql, col)

		nsql := filingNullFieldSQL(col)
		assert.Contains(t, nsql, "SET "+col+" = NULL, field_sources = f.field_sources - '"+col+"'")
		assert.Contains(t, nsql, "f.source <> 'asx-filing-extraction'", "only vendor rows are nulled per field")
	}
	for _, col := range []string{"currency", "source_fetched_at"} {
		assert.Contains(t, sql, col+" = CASE WHEN f.source = 'asx-filing-extraction' THEN EXCLUDED."+col+" ELSE f."+col+" END", col)
	}
	assert.NotRegexp(t, regexp.MustCompile(`(?m)^\s+source = `), sql, "the upsert never changes a stored row's source")
	assert.NotContains(t, sql, "operating_cash_flow", "a filing never touches the columns it does not carry")
	assert.Contains(t, sql, "ON CONFLICT (stock_code, period_type, period_end) DO UPDATE SET")
	assert.Contains(t, sql, "IS DISTINCT FROM", "no-op updates are skipped")
	assert.Regexp(t, regexp.MustCompile(`DELETE FROM stock_fundamentals d\s+WHERE d\.source = 'asx-filing-extraction'`), filingPurgeSQL,
		"the purge only ever deletes filing rows")

	placeholders := map[string]bool{}
	for _, m := range regexp.MustCompile(`\$(\d+)`).FindAllStringSubmatch(sql, -1) {
		placeholders[m[1]] = true
	}
	row := PeriodRow{PeriodType: periodHalf, PeriodEnd: date("2025-12-31"), Currency: "AUD", Revenue: f64(1), Source: sourceFiling}
	assert.Len(t, placeholders, len(filingUpsertArgs(map[string][]PeriodRow{"ABC": {row}}, time.Now())))

	legacy := map[string]bool{}
	for _, m := range regexp.MustCompile(`\$(\d+)`).FindAllStringSubmatch(filingUpsertLegacySQL, -1) {
		legacy[m[1]] = true
	}
	assert.Len(t, legacy, len(filingUpsertLegacyArgs("ABC", []PeriodRow{row}, time.Now())))
}

func TestRunFilingsDryRunWritesNothing(t *testing.T) {
	st := newFilingFake([]filingExtraction{{
		Code: "ABC", URL: "u", Title: "Appendix 4D", ReportDate: date("2026-02-20"),
		Metrics: `{"revenue": {"source_text": "Revenue up 20% to $60.0 million", "value_millions": "60", "period": "H1 FY2026"}}`,
	}}, map[string][]vendorRow{"ABC": {vAnnual("2025-06-30", "AUD", f64(100e6), nil, nil, nil)}})
	st.stored = []storedFiling{{Key: filingRowKey{"BHP", periodHalf, date("2025-12-31")}, Source: sourceFiling}}
	logs := &logRecorder{}
	stats, err := runFilings(context.Background(), st, true, logs.logf)
	require.NoError(t, err)
	assert.Equal(t, 1, stats.Rows)
	assert.Empty(t, st.rebuilds, "a dry run never writes")
	assert.Contains(t, logs.joined(), "would purge 1 filing row(s) [1-1]: BHP half 2025-12-31")
	assert.Contains(t, logs.joined(), "dry run: ABC half 2025-12-31 AUD revenue=6e+07")

	stats, err = runFilings(context.Background(), st, false, logs.logf)
	require.NoError(t, err)
	require.Len(t, st.rebuilds, 1)
	assert.Len(t, st.rebuilds[0].Rows["ABC"], 1)
	assert.Equal(t, 1, stats.Purged, "the echo row goes in the same transaction")
	assert.Equal(t, 1, stats.Written)
	assert.True(t, stats.Changed())
}

// The refusal paths of plan §4.3: nothing deleted or upserted, exit 10,
// per-gate counts and the would-purge list logged.
func TestRunFilingsRefusals(t *testing.T) {
	good := []filingExtraction{{Code: "ABC", URL: "u", Title: "Appendix 4D", ReportDate: date("2026-02-20"),
		Metrics: `{"revenue": {"source_text": "Revenue $60.0 million", "value_millions": "60", "period": "H1 FY2026"}}`}}
	vendor := map[string][]vendorRow{"ABC": {vAnnual("2025-06-30", "AUD", f64(100e6), nil, nil, nil)}}
	stored := []storedFiling{
		{Key: filingRowKey{"ABC", periodHalf, date("2025-12-31")}, Source: sourceFiling},
		{Key: filingRowKey{"CBA", periodHalf, date("2025-12-31")}, Source: sourceFiling},
	}
	cases := []struct {
		name  string
		setup func(f *filingFake)
		want  string
	}{
		{"extraction read error", func(f *filingFake) { f.extErr = errors.New("conn reset") }, "the extraction read failed"},
		{"zero extractions", func(f *filingFake) { f.extractions = nil }, "zero extractions were read"},
		{"vendor read error", func(f *filingFake) { f.vendorErr = errors.New("timeout") }, "the vendor read failed"},
		{"profile read error", func(f *filingFake) { f.profileErr = errors.New("timeout") }, "the company profile read failed"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFilingFake(append([]filingExtraction(nil), good...), vendor)
			f.stored = stored
			c.setup(f)
			logs := &logRecorder{}
			stats, err := runFilings(context.Background(), f, false, logs.logf)
			require.Error(t, err)
			assert.Equal(t, exitCodeDegraded, runner.ExitCodeOf(err), "a refusal is exit 10")
			assert.Contains(t, err.Error(), c.want)
			assert.Contains(t, err.Error(), "nothing deleted or upserted")
			assert.True(t, stats.Refused)
			assert.Empty(t, f.rebuilds, "nothing deleted or upserted")
			assert.Contains(t, logs.joined(), "would purge", "the would-purge list is logged")
			assert.Contains(t, logs.joined(), "REFUSED")
		})
	}

	// A would-purge read failing during a refusal is logged, not fatal.
	f := newFilingFake(nil, vendor)
	f.storedErr = errors.New("gone")
	logs := &logRecorder{}
	_, err := runFilings(context.Background(), f, false, logs.logf)
	require.Error(t, err)
	assert.Contains(t, logs.joined(), "would-purge list unavailable")

	// The rebuild transaction failing is exit 1 (it rolled back).
	f = newFilingFake(good, vendor)
	f.rebuildErr = errors.New("deadlock")
	stats, err := runFilings(context.Background(), f, false, logs.logf)
	require.Error(t, err)
	assert.Equal(t, 1, runner.ExitCodeOf(err))
	assert.Equal(t, 1, stats.Failed)

	_, err = runFilings(context.Background(), nil, false, func(string, ...any) {})
	require.Error(t, err)
}

// A large purge is logged in full, never refused (plan §4.3): here every
// stored row goes because no code has vendor context any more.
func TestRunFilingsLargePurgeIsAllowed(t *testing.T) {
	var exts []filingExtraction
	var stored []storedFiling
	for _, code := range []string{"AAA", "BBB", "CCC", "DDD", "EEE"} {
		exts = append(exts, filingExtraction{Code: code, URL: "u-" + code, Title: "Appendix 4D", ReportDate: date("2026-02-20"),
			Metrics: `{"revenue": {"source_text": "Revenue $60.0 million", "value_millions": "60", "period": "H1 FY2026"}}`})
		stored = append(stored, storedFiling{Key: filingRowKey{code, periodHalf, date("2025-12-31")}, Source: sourceFiling})
	}
	f := newFilingFake(exts, map[string][]vendorRow{})
	f.stored = stored
	logs := &logRecorder{}
	stats, err := runFilings(context.Background(), f, false, logs.logf)
	require.NoError(t, err)
	assert.Equal(t, 5, stats.Purged)
	assert.Equal(t, 5, stats.Gates[gateNoVendor])
	assert.Equal(t, 5, stats.NoVendorCodes)
	assert.Contains(t, logs.joined(), "purged 5 filing row(s) [1-5]: AAA half 2025-12-31, BBB half 2025-12-31")
	assert.Contains(t, logs.joined(), `"6_vendor.skipped_no_vendor"=5`, "per-gate counts are logged")
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

func TestWorstError(t *testing.T) {
	degraded := &runner.ExitCodeError{Code: exitCodeDegraded, Err: errors.New("fundamentals degraded")}
	hard := errors.New("refresh failed")
	assert.NoError(t, worstError(nil, nil))
	assert.Equal(t, exitCodeDegraded, runner.ExitCodeOf(worstError(nil, stepError("fundamentals", degraded))))
	err := worstError(stepError("fundamentals", degraded), stepError("refresh", hard))
	assert.Equal(t, 1, runner.ExitCodeOf(err), "a hard failure beats DEGRADED")
	assert.True(t, strings.Contains(err.Error(), "fundamentals degraded"), "the other verdict rides along: %v", err)
}

func readSource(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(name)
	require.NoError(t, err)
	return string(b)
}
