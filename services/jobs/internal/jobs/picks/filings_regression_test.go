package picks

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Regression fixtures for the fail-closed filings ingest (plan
// docs/plans/fundamentals-coverage.md §4.4). Each one is a shape measured on
// prod on 2026-09-28 that the permissive ingest published; the figures are
// illustrative except where a comment says otherwise.

// oldEchoMetrics is exactly what the extractor stored for the five echo
// documents: the prompt's own few-shot example, returned by the model as the
// company's results (stored before the extractor recorded alignment, so the
// entries carry no "alignment" key: only the few-shot denylist catches them).
func oldEchoMetrics(t *testing.T) string {
	return metricsJSON(t, map[string]any{
		"revenue":    entry("source_text", "Revenue from continuing operations for the half year ended 31 December 2024 was $5,142 million", "value_millions", "5142", "period", "H1 FY2025", "change_pct", "+8"),
		"net_profit": entry("source_text", "Statutory net profit after tax (NPAT) was $1,823 million, up 12% on pcp", "value_millions", "1823", "period", "H1 FY2025", "change_pct", "+12"),
		"eps":        entry("source_text", "Basic earnings per share was 94.2 cents", "value_cents", "94.2", "period", "H1 FY2025"),
		"dividend":   entry("source_text", "interim dividend of 45 cents per share, fully franked", "value_cents", "45", "period", "H1 FY2025"),
		"cash_flow":  entry("source_text", "Operating cash flow was $2,156 million", "value_millions", "2156", "period", "H1 FY2025"),
	})
}

func TestRegressionFiveEchoDocumentsWriteNothing(t *testing.T) {
	docs := []filingExtraction{
		{Code: "BHP", URL: "u-bhp", Title: "BHP Results for the half year ended 31 December 2024", ReportDate: date("2025-02-18")},
		{Code: "CBA", URL: "u-cba", Title: "CBA 2025 Half Year Results", ReportDate: date("2025-02-12")},
		{Code: "DRO", URL: "u-dro", Title: "Half Yearly Report and Accounts", ReportDate: date("2025-02-20")},
		{Code: "EDV", URL: "u-edv", Title: "Appendix 4D and Half Year Report", ReportDate: date("2025-02-19")},
		{Code: "MSB", URL: "u-msb", Title: "Appendix 4D", ReportDate: date("2025-02-27")},
	}
	for i := range docs {
		docs[i].Metrics = oldEchoMetrics(t)
	}
	// Every other gate would pass: each company has vendor context in the
	// currency of a bare "$", and the echo's figures sit inside every band.
	vendor := map[string][]vendorRow{
		"BHP": {vAnnual("2024-06-30", "USD", f64(55.7e9), f64(7.9e9), f64(1.5), f64(5.07e9))},
		"CBA": {vAnnual("2024-06-30", "AUD", f64(27e9), f64(9.5e9), f64(5.7), f64(1.67e9))},
		"DRO": {vAnnual("2024-06-30", "AUD", f64(20e9), f64(3e9), f64(1), f64(2e9))},
		"EDV": {vAnnual("2024-06-30", "AUD", f64(12e9), f64(0.5e9), f64(0.28), f64(1.79e9))},
		"MSB": {vAnnual("2024-06-30", "AUD", f64(15e9), f64(2e9), f64(1), f64(2e9))},
	}
	var st filingStats
	out := buildFilingRows(docs, filingInputs{vendor: vendor}, &st)
	assert.Empty(t, out, "no row with revenue 5,142,000,000 and NPAT 1,823,000,000 (plan §9 step 4)")
	assert.Equal(t, 15, st.Gates[gateFewShot], "revenue, NPAT and EPS of five documents, all at gate 3")

	// The synthetic example that replaces it is caught the same way.
	newEcho := filingExtraction{Code: "EDV", URL: "u-edv-2", Title: "Appendix 4D", ReportDate: date("2031-02-20"),
		Metrics: metricsJSON(t, map[string]any{"revenue": entry(
			"source_text", "Revenue from continuing operations for the half year ended 31 December 2030 was $3,847 million",
			"value_millions", "3847", "period", "H1 FY2031", "alignment", "match_exact")})}
	st = filingStats{}
	out = buildFilingRows([]filingExtraction{newEcho}, filingInputs{vendor: vendor}, &st)
	assert.Empty(t, out)
	assert.Equal(t, 1, st.Gates[gateFewShot], "an aligned echo of the new example is still an echo")
}

// CBA: a profit announcement's comparatives read as the current half. The
// real 1H26 statutory NPAT survives even though it equals the old example's
// revenue figure: the denylist is by text, never by value.
func TestRegressionCBAComparatives(t *testing.T) {
	doc := filingExtraction{
		Code: "CBA", URL: "u-cba-1h26", Title: "Profit Announcement for the half year ended 31 December 2025", ReportDate: date("2026-02-11"),
		DocumentMeta: `{"currency":"AUD","units":"millions","entity":"Commonwealth Bank of Australia","period_end":"2025-12-31","period_type":"half","report_kind":"results_announcement"}`,
		Metrics: metricsJSON(t, map[string]any{
			"net_profit": []any{
				entry("source_text", "Statutory NPAT of $5,142 million, up 6% on the prior corresponding period", "value_millions", "5142", "period", "1H26", "alignment", "match_exact"),
				// The comparative, labelled as the current half.
				entry("source_text", "Statutory NPAT for the half year ended 31 December 2024 was $4,856 million", "value_millions", "4856", "period", "1H26", "alignment", "match_exact"),
				// The comparative, labelled as what it is.
				entry("source_text", "Statutory NPAT $4,856m", "value_millions", "4856", "period", "1H25", "alignment", "match_exact"),
			},
			"eps": entry("source_text", "Statutory basic earnings per share 307.6 cents", "value_cents", "307.6", "period", "1H26", "alignment", "match_fuzzy"),
		}),
	}
	in := filingInputs{
		vendor:   map[string][]vendorRow{"CBA": {vAnnual("2025-06-30", "AUD", f64(28e9), f64(10.1e9), f64(6.04), f64(1.67e9))}},
		profiles: map[string]companyProfile{"CBA": {Name: "COMMONWEALTH BANK OF AUSTRALIA", Industry: "Banks"}},
	}
	var st filingStats
	out := buildFilingRows([]filingExtraction{doc}, in, &st)
	require.Len(t, out["CBA"], 1)
	r := out["CBA"][0]
	assert.Equal(t, periodHalf, r.PeriodType)
	assert.Equal(t, "2025-12-31", r.PeriodEnd.Format("2006-01-02"))
	assert.InDelta(t, 5142e6, val(t, r.NetIncome), 1, "the real statutory NPAT, not the comparative")
	assert.InDelta(t, 3.076, val(t, r.EPSBasic), 1e-9)
	assert.Equal(t, 1, st.Gates[gateQuoteOtherPeriod], "the mislabelled comparative")
	assert.Equal(t, 1, st.Gates[gateNotOwnPeriod], "the labelled comparative")
}

// EDV: channel and segment sales stored as revenue, and the few-shot EPS that
// produced its -85.4% EPS growth.
func TestRegressionEDVChannelSales(t *testing.T) {
	doc := filingExtraction{
		Code: "EDV", URL: "u-edv-4d", Title: "Appendix 4D and Half Year Report", ReportDate: date("2026-02-18"),
		Metrics: metricsJSON(t, map[string]any{
			"revenue": []any{
				entry("source_text", "Online sales of $1,480 million, up 9%", "value_millions", "1480", "period", "1H26"),
				entry("source_text", "Channel sales grew to $2,301 million", "value_millions", "2301", "period", "1H26"),
				entry("source_text", "Retail segment sales revenue of $5,532 million", "value_millions", "5532", "period", "1H26"),
				entry("source_text", "Revenue from ordinary activities $6,512 million, up 1.0%", "value_millions", "6512", "period", "1H26"),
			},
			"net_profit": entry("source_text", "Net profit after tax attributable to shareholders of $287 million", "value_millions", "287", "period", "1H26"),
			"eps": []any{
				entry("source_text", "Basic earnings per share was 94.2 cents", "value_cents", "94.2", "period", "1H26"),
				entry("source_text", "Basic earnings per share 16.0 cents", "value_cents", "16.0", "period", "1H26"),
			},
		}),
	}
	in := filingInputs{vendor: map[string][]vendorRow{"EDV": {vAnnual("2025-06-30", "AUD", f64(12.3e9), f64(0.5e9), f64(0.28), f64(1.79e9))}}}
	var st filingStats
	out := buildFilingRows([]filingExtraction{doc}, in, &st)
	require.Len(t, out["EDV"], 1)
	r := out["EDV"][0]
	assert.InDelta(t, 6512e6, val(t, r.Revenue), 1, "the statutory line, not a channel or segment")
	assert.InDelta(t, 287e6, val(t, r.NetIncome), 1)
	assert.InDelta(t, 0.16, val(t, r.EPSBasic), 1e-12, "the real EPS, not the echo")
	assert.Equal(t, 3, st.Gates[gateNonStatutory], "online, channel and segment sales")
	assert.Equal(t, 1, st.Gates[gateFewShot])
}

// BHP: "Profit from operations" (US$19.5bn) stored as NPAT.
func TestRegressionBHPProfitFromOperations(t *testing.T) {
	doc := filingExtraction{
		Code: "BHP", URL: "u-bhp-4e", Title: "Appendix 4E", ReportDate: date("2025-08-19"),
		DocumentMeta: `{"currency":"USD","units":"millions","entity":"BHP Group Limited","period_end":"2025-06-30","period_type":"annual","report_kind":"appendix_4e"}`,
		Metrics: metricsJSON(t, map[string]any{"net_profit": []any{
			entry("source_text", "Profit from operations US$19,547 million", "value_millions", "19547", "period", "FY2025"),
			entry("source_text", "Profit after taxation attributable to BHP shareholders US$9,019 million", "value_millions", "9019", "period", "FY2025"),
		}}),
	}
	in := filingInputs{
		vendor:   map[string][]vendorRow{"BHP": {vAnnual("2025-06-30", "USD", f64(51.3e9), nil, f64(1.78), f64(5.07e9))}},
		profiles: map[string]companyProfile{"BHP": {Name: "BHP GROUP LIMITED", Industry: "Materials"}},
	}
	var st filingStats
	out := buildFilingRows([]filingExtraction{doc}, in, &st)
	require.Len(t, out["BHP"], 1)
	assert.InDelta(t, 9019e6, val(t, out["BHP"][0].NetIncome), 1, "statutory NPAT, never profit from operations")
	assert.Equal(t, "USD", out["BHP"][0].Currency)
	assert.Equal(t, 1, st.Gates[gateNonStatutory])
}

// LFT: another company's report (Winsome's) stored against LFT's code. The
// company name here is a stand-in; the gate compares tokens.
func TestRegressionLFTForeignDocument(t *testing.T) {
	doc := func(meta string) filingExtraction {
		return filingExtraction{Code: "LFT", URL: "u-lft", Title: "Appendix 4D", ReportDate: date("2026-02-26"), DocumentMeta: meta,
			Metrics: metricsJSON(t, map[string]any{"revenue": entry("source_text", "Revenue from ordinary activities $12.4 million", "value_millions", "12.4", "period", "H1 FY2026")})}
	}
	vendor := map[string][]vendorRow{"LFT": {vAnnual("2025-06-30", "AUD", f64(20e6), nil, nil, nil)}}
	foreign := `{"entity":"Winsome Resources Limited","report_kind":"appendix_4d"}`

	var st filingStats
	out := buildFilingRows([]filingExtraction{doc(foreign)}, filingInputs{vendor: vendor, profiles: map[string]companyProfile{"LFT": {Name: "LFT Limited"}}}, &st)
	assert.Empty(t, out)
	assert.Equal(t, 1, st.Gates[gateForeignEntity])

	st = filingStats{}
	out = buildFilingRows([]filingExtraction{doc(foreign)}, filingInputs{vendor: vendor}, &st)
	assert.Empty(t, out, "no company name to compare with: withheld, never guessed")
	assert.Equal(t, 1, st.Gates[gateEntityUnverifiable])

	st = filingStats{}
	out = buildFilingRows([]filingExtraction{doc(`{"entity":"LFT Limited","report_kind":"appendix_4d"}`)}, filingInputs{vendor: vendor, profiles: map[string]companyProfile{"LFT": {Name: "LFT LIMITED"}}}, &st)
	assert.Len(t, out["LFT"], 1, "its own document passes")

	st = filingStats{}
	out = buildFilingRows([]filingExtraction{doc("")}, filingInputs{vendor: vendor}, &st)
	assert.Len(t, out["LFT"], 1, "a document without document_meta (every row before 000132) is not gated on entity")
}

// DRO: a December year end the permissive ingest dated June (it defaulted to
// June without vendor rows). With vendor context the year and the half land on
// December and June; without it nothing is written.
func TestRegressionDRODecemberYearEnd(t *testing.T) {
	docs := []filingExtraction{
		{Code: "DRO", URL: "u-dro-4e", Title: "Appendix 4E - Preliminary Final Report", ReportDate: date("2026-02-24"),
			Metrics: metricsJSON(t, map[string]any{"revenue": entry("source_text", "Revenue from ordinary activities up 83% to $105.2 million", "value_millions", "105.2", "period", "FY2025")})},
		{Code: "DRO", URL: "u-dro-hy", Title: "Half Yearly Report and Accounts", ReportDate: date("2025-08-27"),
			Metrics: metricsJSON(t, map[string]any{"revenue": entry("source_text", "Revenue from ordinary activities of $72.3 million", "value_millions", "72.3", "period", "1H25")})},
	}
	vendor := map[string][]vendorRow{"DRO": {vAnnual("2024-12-31", "AUD", f64(57.5e6), nil, nil, f64(870e6))}}
	var st filingStats
	out := buildFilingRows(docs, filingInputs{vendor: vendor}, &st)
	require.Len(t, out["DRO"], 2)
	h, a := out["DRO"][0], out["DRO"][1]
	assert.Equal(t, periodHalf, h.PeriodType)
	assert.Equal(t, "2025-06-30", h.PeriodEnd.Format("2006-01-02"), "a December company's first half ends in June")
	assert.Equal(t, periodAnnual, a.PeriodType)
	assert.Equal(t, "2025-12-31", a.PeriodEnd.Format("2006-01-02"), "its year ends in December, never June")
	require.NotNil(t, a.FiscalYear)
	assert.Equal(t, int16(2025), *a.FiscalYear)
	require.NotNil(t, h.FiscalYear)
	assert.Equal(t, int16(2025), *h.FiscalYear)

	st = filingStats{}
	out = buildFilingRows(docs, filingInputs{vendor: map[string][]vendorRow{}}, &st)
	assert.Empty(t, out, "no vendor rows: no balance date, no currency, no filing rows")
	assert.Equal(t, 2, st.Gates[gateNoVendor])
	assert.Equal(t, 1, st.NoVendorCodes)
}

// A bare 4D/4E summary-table line: the figure has no unit of its own; the
// document's "US$ Million" header (document_meta.units) scales it.
func TestRegressionBare4ETableLineWithDocumentUnits(t *testing.T) {
	doc := func(meta string) filingExtraction {
		return filingExtraction{Code: "BHP", URL: "u-bhp-4e-26", Title: "Appendix 4E", ReportDate: date("2026-08-18"), DocumentMeta: meta,
			Metrics: metricsJSON(t, map[string]any{"revenue": entry("source_text", "Revenue from ordinary activities 51,262 down 8%", "value_millions", "51262", "period", "FY2026", "alignment", "match_exact")})}
	}
	in := filingInputs{
		vendor:   map[string][]vendorRow{"BHP": {vAnnual("2025-06-30", "USD", f64(55.7e9), nil, nil, nil)}},
		profiles: map[string]companyProfile{"BHP": {Name: "BHP GROUP LIMITED"}},
	}
	var st filingStats
	out := buildFilingRows([]filingExtraction{doc(`{"currency":"USD","units":"millions","units_evidence":"US$ Million","entity":"BHP Group Limited","period_end":"2026-06-30","period_type":"annual","report_kind":"appendix_4e"}`)}, in, &st)
	require.Len(t, out["BHP"], 1)
	assert.InDelta(t, 51262e6, val(t, out["BHP"][0].Revenue), 1)

	st = filingStats{}
	out = buildFilingRows([]filingExtraction{doc(`{"currency":"USD","period_end":"2026-06-30","report_kind":"appendix_4e"}`)}, in, &st)
	assert.Empty(t, out, "without the document's unit statement the bare figure is ambiguous")

	st = filingStats{}
	out = buildFilingRows([]filingExtraction{doc(`{"currency":"AUD","units":"millions","period_end":"2026-06-30","report_kind":"appendix_4e"}`)}, in, &st)
	assert.Empty(t, out, "document_meta.currency must equal the vendor currency (gate 7)")
	assert.Equal(t, 1, st.Gates[gateCurrencyMeta])
}

// Gate 1's other conditions.
func TestGateDocumentConfidenceAndKind(t *testing.T) {
	low, high := 0.2, 0.3
	mk := func(conf *float64, meta string) filingExtraction {
		return filingExtraction{Code: "ABC", URL: "u", Title: "Appendix 4D", ReportDate: date("2026-02-20"), DigestConfidence: conf, DocumentMeta: meta,
			Metrics: metricsJSON(t, map[string]any{"revenue": entry("source_text", "Revenue $60.0 million", "value_millions", "60", "period", "H1 FY2026")})}
	}
	in := filingInputs{vendor: map[string][]vendorRow{"ABC": {vAnnual("2025-06-30", "AUD", f64(100e6), nil, nil, nil)}}}
	var st filingStats
	assert.Empty(t, buildFilingRows([]filingExtraction{mk(&low, "")}, in, &st))
	assert.Equal(t, 1, st.Gates[gateLowConfidence])
	st = filingStats{}
	assert.Len(t, buildFilingRows([]filingExtraction{mk(&high, "")}, in, &st), 1, "0.3 passes")
	st = filingStats{}
	assert.Len(t, buildFilingRows([]filingExtraction{mk(nil, "")}, in, &st), 1, "NULL passes")
	st = filingStats{}
	assert.Empty(t, buildFilingRows([]filingExtraction{mk(nil, `{"report_kind":"other"}`)}, in, &st))
	assert.Equal(t, 1, st.Gates[gateReportKindOther])
	st = filingStats{}
	assert.Len(t, buildFilingRows([]filingExtraction{mk(nil, `{not json`)}, in, &st), 1, "unreadable document_meta reads as absent")
	assert.Equal(t, 1, st.Skipped["document_meta unreadable (treated as absent)"])
}

// Gate 2: an entry the extractor could not align is withheld.
func TestGateGroundingDropsUnaligned(t *testing.T) {
	doc := filingExtraction{Code: "ABC", URL: "u", Title: "Appendix 4D", ReportDate: date("2026-02-20"),
		Metrics: metricsJSON(t, map[string]any{"revenue": []any{
			entry("source_text", "Revenue $61.0 million", "value_millions", "61", "period", "H1 FY2026", "alignment", "unaligned"),
			entry("source_text", "Revenue $60.0 million", "value_millions", "60", "period", "H1 FY2026", "alignment", "match_greater"),
		}})}
	in := filingInputs{vendor: map[string][]vendorRow{"ABC": {vAnnual("2025-06-30", "AUD", f64(100e6), nil, nil, nil)}}}
	var st filingStats
	out := buildFilingRows([]filingExtraction{doc}, in, &st)
	require.Len(t, out["ABC"], 1)
	assert.InDelta(t, 60e6, val(t, out["ABC"][0].Revenue), 1, "only the aligned value; no ambiguity with the unaligned one")
	assert.Equal(t, 1, st.Gates[gateUnaligned])
}

// Gate 6 / plan §3.4: a vendor currency that cannot be trusted means no
// filing rows, unless Markit supplies the native currency.
func TestGateVendorCurrencyFXAndMixed(t *testing.T) {
	doc := filingExtraction{Code: "ABC", URL: "u", Title: "Appendix 4D", ReportDate: date("2026-02-20"),
		Metrics: metricsJSON(t, map[string]any{"revenue": entry("source_text", "Revenue $60.0 million", "value_millions", "60", "period", "H1 FY2026")})}
	fx := vAnnual("2025-06-30", "AUD", f64(100123456.37), nil, nil, nil) // a converted, fractional figure
	var st filingStats
	assert.Empty(t, buildFilingRows([]filingExtraction{doc}, filingInputs{vendor: map[string][]vendorRow{"ABC": {fx}}}, &st))
	assert.Equal(t, 1, st.Gates[gateVendorCurrency], "fx_converted: currency unknown")

	mixed := []vendorRow{vAnnual("2025-06-30", "AUD", f64(100e6), nil, nil, nil), vAnnual("2024-06-30", "USD", f64(70e6), nil, nil, nil)}
	st = filingStats{}
	assert.Empty(t, buildFilingRows([]filingExtraction{doc}, filingInputs{vendor: map[string][]vendorRow{"ABC": mixed}}, &st))
	assert.Equal(t, 1, st.Gates[gateVendorCurrency], "mixed vendor currencies: ambiguous")

	epsOnly := []vendorRow{vAnnual("2025-06-30", "AUD", nil, nil, f64(0.1), f64(100e6))}
	st = filingStats{}
	assert.Empty(t, buildFilingRows([]filingExtraction{doc}, filingInputs{vendor: map[string][]vendorRow{"ABC": epsOnly}}, &st))
	assert.Equal(t, 1, st.Gates[gateVendorCurrency], "monetary fields all rejected: the label cannot be checked")

	markit := vendorRow{PeriodType: periodAnnual, PeriodEnd: date("2025-06-30"), Currency: "AUD", Source: sourceMarkit, Revenue: f64(100e6)}
	st = filingStats{}
	out := buildFilingRows([]filingExtraction{doc}, filingInputs{vendor: map[string][]vendorRow{"ABC": {fx, markit}}}, &st)
	require.Len(t, out["ABC"], 1, "Markit's native currency is used for an fx_converted code")
	assert.Equal(t, "AUD", out["ABC"][0].Currency)

	old := []vendorRow{vAnnual("2025-06-30", "USD", f64(100e6), nil, nil, nil), vAnnual("2021-06-30", "AUD", f64(70e6), nil, nil, nil)}
	c, note := resolveVendorCurrency(old)
	assert.Equal(t, "USD", c, "a currency change years ago is history, not ambiguity")
	assert.Empty(t, note)

	// The persisted verdict (stock_fundamentals_sync.fx_converted) decides
	// before the rows do: an integral AUD label proves nothing for XRO.
	persisted := vAnnual("2025-06-30", "AUD", f64(100e6), nil, nil, nil)
	persisted.FXConverted, persisted.NativeCurrency = true, "nzd"
	c, note = resolveVendorCurrency([]vendorRow{persisted})
	assert.Equal(t, "NZD", c, "the persisted native currency")
	assert.Contains(t, note, "persisted")
	persisted.NativeCurrency = ""
	markitNZD := markit
	markitNZD.Currency = "NZD"
	c, _ = resolveVendorCurrency([]vendorRow{persisted, markitNZD})
	assert.Equal(t, "NZD", c, "no persisted native currency: a stored Markit row's currency")
	st = filingStats{}
	assert.Empty(t, buildFilingRows([]filingExtraction{doc}, filingInputs{vendor: map[string][]vendorRow{"ABC": {persisted}}}, &st))
	assert.Equal(t, 1, st.Gates[gateVendorCurrency])
}

// Gate 8: the bands and the profit / EPS checks.
func TestGateMagnitude(t *testing.T) {
	vc := newVendorContext([]vendorRow{
		vAnnual("2025-06-30", "AUD", f64(100e6), f64(10e6), f64(0.10), f64(100e6)),
		vAnnual("2024-06-30", "AUD", f64(90e6), f64(9e6), f64(0.09), f64(100e6)),
		vTTM("2024-12-31", "AUD", f64(95e6), f64(0.095)),
	})
	cases := []struct {
		typ, end string
		basis    string
		lo, hi   float64
	}{
		{periodHalf, "2024-12-31", "ttm at the same end", 23.75e6, 71.25e6},
		{periodHalf, "2023-12-31", "containing FY", 22.5e6, 67.5e6},
		{periodHalf, "2025-12-31", "prior FY", 15e6, 150e6},
		{periodAnnual, "2025-06-30", "same FY", 70e6, 140e6},
		{periodAnnual, "2026-06-30", "prior FY", 50e6, 250e6},
	}
	for _, c := range cases {
		b, ok := vc.revenueBand(c.typ, date(c.end), "AUD")
		if assert.True(t, ok, c.end) {
			assert.Equal(t, c.basis, b.basis, c.end)
			assert.InDelta(t, c.lo, b.lo*b.ref, 1, c.end)
			assert.InDelta(t, c.hi, b.upper(), 1, c.end)
		}
	}
	_, ok := vc.revenueBand(periodAnnual, date("2028-06-30"), "AUD")
	assert.False(t, ok, "no reference: the revenue is withheld")
	_, ok = vc.revenueBand(periodAnnual, date("2025-06-30"), "USD")
	assert.False(t, ok, "references are same-currency only")

	vendor := map[string][]vendorRow{"ABC": {vAnnual("2025-06-30", "AUD", f64(100e6), f64(10e6), f64(0.10), f64(100e6))}}
	mk := func(m map[string]any) []filingExtraction {
		return []filingExtraction{{Code: "ABC", URL: "u", Title: "Appendix 4D", ReportDate: date("2026-02-20"), Metrics: metricsJSON(t, m)}}
	}
	// A profit above 1.5x the half's own revenue: withheld (a unit slip).
	var st filingStats
	out := buildFilingRows(mk(map[string]any{
		"revenue":    entry("source_text", "Revenue $40.0 million", "value_millions", "40", "period", "H1 FY2026"),
		"net_profit": entry("source_text", "Net profit after tax $80.0 million", "value_millions", "80", "period", "H1 FY2026"),
	}), filingInputs{vendor: vendor}, &st)
	require.Len(t, out["ABC"], 1)
	assert.Nil(t, out["ABC"][0].NetIncome)
	assert.Equal(t, 1, st.Gates[gateNetIncome])
	// ...unless the company books revaluations through profit.
	st = filingStats{}
	out = buildFilingRows(mk(map[string]any{
		"revenue":    entry("source_text", "Revenue $40.0 million", "value_millions", "40", "period", "H1 FY2026"),
		"net_profit": entry("source_text", "Net profit after tax $80.0 million", "value_millions", "80", "period", "H1 FY2026"),
	}), filingInputs{vendor: vendor, profiles: map[string]companyProfile{"ABC": {Industry: "Equity Real Estate Investment Trusts (REITs)"}}}, &st)
	assert.InDelta(t, 80e6, val(t, out["ABC"][0].NetIncome), 1)
	// An EPS without a net income to check it against is withheld.
	st = filingStats{}
	out = buildFilingRows(mk(map[string]any{
		"revenue": entry("source_text", "Revenue $40.0 million", "value_millions", "40", "period", "H1 FY2026"),
		"eps":     entry("source_text", "Basic EPS 5.0 cents", "value_cents", "5.0", "period", "H1 FY2026"),
	}), filingInputs{vendor: vendor}, &st)
	require.Len(t, out["ABC"], 1)
	assert.Nil(t, out["ABC"][0].EPSBasic)
	assert.Equal(t, 1, st.Gates[gateEPSUncheckable])
	// A loss-maker's EPS checks against its (negative) profit.
	st = filingStats{}
	out = buildFilingRows(mk(map[string]any{
		"net_profit": entry("source_text", "Net loss after tax of $5.0 million", "value_millions", "5", "period", "H1 FY2026"),
		"eps":        entry("source_text", "Loss per share 5.0 cents", "value_cents", "5.0", "period", "H1 FY2026"),
	}), filingInputs{vendor: vendor}, &st)
	require.Len(t, out["ABC"], 1)
	assert.InDelta(t, -5e6, val(t, out["ABC"][0].NetIncome), 1)
	assert.InDelta(t, -0.05, val(t, out["ABC"][0].EPSBasic), 1e-12)
}

// Gate 9: the TTM-EPS identity catches a half whose EPS is another period's.
func TestGateTTMEPSIdentity(t *testing.T) {
	vendor := map[string][]vendorRow{"ABC": {
		vAnnual("2025-06-30", "AUD", f64(100e6), f64(40e6), f64(0.40), f64(100e6)),
		vAnnual("2024-06-30", "AUD", f64(90e6), f64(35e6), f64(0.35), f64(100e6)),
		vTTM("2025-12-31", "AUD", f64(110e6), f64(0.50)),
	}}
	prior := filingExtraction{Code: "ABC", URL: "u-4d-25", Title: "Appendix 4D", ReportDate: date("2025-02-20"),
		Metrics: metricsJSON(t, map[string]any{
			"net_profit": entry("source_text", "Net profit after tax $18.0 million", "value_millions", "18", "period", "H1 FY2025"),
			"eps":        entry("source_text", "Basic EPS 18.0 cents", "value_cents", "18.0", "period", "H1 FY2025"),
		})}
	current := func(npat, eps string) filingExtraction {
		return filingExtraction{Code: "ABC", URL: "u-4d-26", Title: "Appendix 4D", ReportDate: date("2026-02-20"),
			Metrics: metricsJSON(t, map[string]any{
				"net_profit": entry("source_text", "Net profit after tax $"+npat+" million", "value_millions", npat, "period", "H1 FY2026"),
				"eps":        entry("source_text", "Basic EPS "+eps+" cents", "value_cents", eps, "period", "H1 FY2026"),
			})}
	}
	// TTM(Dec 2025) - FY(Jun 2025) = 0.10, so H1 FY26 = 0.18 + 0.10 = 0.28.
	var st filingStats
	out := buildFilingRows([]filingExtraction{prior, current("28", "28.0")}, filingInputs{vendor: vendor}, &st)
	require.Len(t, out["ABC"], 2)
	assert.InDelta(t, 0.28, val(t, out["ABC"][1].EPSBasic), 1e-12, "consistent with the identity")
	assert.Zero(t, st.Gates[gateTTMIdentity])

	// The full-year figure read as the half (EPS 40c, profit 40m): it passes
	// the magnitude check against its own profit, but not the identity.
	st = filingStats{}
	out = buildFilingRows([]filingExtraction{prior, current("40", "40.0")}, filingInputs{vendor: vendor}, &st)
	require.Len(t, out["ABC"], 2)
	assert.Nil(t, out["ABC"][1].EPSBasic)
	assert.Equal(t, 1, st.Gates[gateTTMIdentity])

	// Without the prior half the identity cannot run and the half passes.
	st = filingStats{}
	out = buildFilingRows([]filingExtraction{current("40", "40.0")}, filingInputs{vendor: vendor}, &st)
	require.Len(t, out["ABC"], 1)
	assert.NotNil(t, out["ABC"][0].EPSBasic)
}

func TestMonthEndOffset(t *testing.T) {
	assert.Equal(t, "2026-06-30", monthEndOffset(date("2025-12-31"), 6).Format("2006-01-02"))
	assert.Equal(t, "2024-12-31", monthEndOffset(date("2025-12-31"), -12).Format("2006-01-02"))
	assert.Equal(t, "2025-02-28", monthEndOffset(date("2025-08-31"), -6).Format("2006-01-02"))
	assert.Equal(t, time.UTC, monthEndOffset(date("2025-08-31"), 1).Location())
}
