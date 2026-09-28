package picks

import (
	"math"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func f64(v float64) *float64 { return &v }

func TestStorableMatchesTheTableCheck(t *testing.T) {
	// Mirrors stock_fundamentals_finite_check in 000129: zero, or finite with
	// 1e-12 <= |v| <= 1e18.
	for _, v := range []float64{0, 1, -1, 0.0001, -0.0334, 58760000000, -30833000, 1e-12, 1e18, -1e18} {
		assert.True(t, storable(v), "%v", v)
	}
	for _, v := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), 1e19, -1e19, 1e-13, 5e-324, math.MaxFloat64} {
		assert.False(t, storable(v), "%v", v)
	}
}

func TestSanitizeRowsRejectsNonFiniteBeforeWrite(t *testing.T) {
	rows := []PeriodRow{
		{PeriodType: periodAnnual, PeriodEnd: date("2025-06-30"), Currency: "AUD", Source: sourceYahoo,
			Revenue: f64(math.Inf(1)), NetIncome: f64(5), EPSDiluted: f64(math.NaN())},
		{PeriodType: periodAnnual, PeriodEnd: date("2024-06-30"), Currency: "AUD", Source: sourceYahoo,
			Revenue: f64(math.NaN())}, // nothing survives but the mask
		{PeriodType: periodHalf, PeriodEnd: date("2024-12-31"), Currency: "AUD", Source: sourceYahoo, Revenue: f64(1)},
		{PeriodType: periodTTM, PeriodEnd: date("2024-12-31"), Currency: "", Source: sourceYahoo, Revenue: f64(1)},
		{PeriodType: periodTTM, PeriodEnd: time.Time{}, Currency: "AUD", Source: sourceYahoo, Revenue: f64(1)},
		{PeriodType: periodTTM, PeriodEnd: date("2025-12-31"), Currency: "USD", Source: sourceYahoo, EPSDiluted: f64(0)},
		{PeriodType: periodQuarter, PeriodEnd: date("2025-12-31"), Currency: "USD", Source: sourceFiling, TotalAssets: f64(1)},
	}
	out, rejected := sanitizeRows(rows)
	assert.Equal(t, 3, rejected, "Inf revenue, NaN EPS, NaN revenue")
	require.Len(t, out, 3, "a vendor half row, a row with no currency or date, and a filing snapshot are dropped")
	assert.Nil(t, out[0].Revenue)
	assert.Nil(t, out[0].EPSDiluted)
	assert.Equal(t, 5.0, *out[0].NetIncome)
	assert.Equal(t, []string{"revenue", "eps_diluted"}, out[0].Rejected, "a vendor value that fails is nulled in the table too")
	assert.False(t, out[1].hasValues())
	assert.Equal(t, []string{"revenue"}, out[1].Rejected, "a mask-only row survives so the stored value is nulled")
	assert.Equal(t, 0.0, *out[2].EPSDiluted, "zero is a value (a break-even EPS), not a missing one")
	assert.True(t, math.IsInf(*rows[0].Revenue, 1), "the input slice is not mutated")
	assert.Empty(t, rows[0].Rejected)
}

func TestSanitizeRowsSnapshotsAndMasks(t *testing.T) {
	rows := []PeriodRow{
		{PeriodType: periodQuarter, PeriodEnd: date("2025-12-31"), Currency: "USD", Source: sourceYahoo,
			TotalAssets: f64(100), Revenue: f64(5), SharesOutstanding: f64(9),
			FieldSources: map[string]string{"revenue": sourceMarkit, "total_assets": sourceYahoo}},
		{PeriodType: periodAnnual, PeriodEnd: date("2025-06-30"), Currency: "USD", Source: sourceYahoo,
			Revenue: f64(5), NetIncome: f64(1), Rejected: []string{"net_income"},
			FieldSources: map[string]string{"revenue": fieldSourceDerivedTTMAtFYE, "net_income": sourceMarkit, "bogus": sourceMarkit}},
	}
	out, _ := sanitizeRows(rows)
	require.Len(t, out, 2)
	q := out[1]
	if q.PeriodType != periodQuarter {
		q = out[0]
	}
	assert.Nil(t, q.Revenue, "a snapshot keeps its balance lines only")
	assert.Equal(t, 9.0, val(t, q.SharesOutstanding))
	assert.Nil(t, q.FieldSources, "no exception survives: revenue went, total_assets is the row's own source")
	a := out[0]
	if a.PeriodType != periodAnnual {
		a = out[1]
	}
	assert.Nil(t, a.NetIncome, "a Rejected column is NULL whatever the value")
	assert.Equal(t, map[string]string{"revenue": fieldSourceDerivedTTMAtFYE}, a.FieldSources,
		"FieldSources keeps only present values' entries, and only column keys")
}

func TestFiscalYear(t *testing.T) {
	cases := []struct {
		end  string
		fye  time.Month
		want int16
		why  string
	}{
		{"2026-06-30", time.June, 2026, "a June year is named by its end"},
		{"2025-12-31", time.June, 2026, "H1 FY26 ends in December 2025"},
		{"2025-07-01", time.June, 2025, "first-week July: a 52/53-week June year"},
		{"2023-07-02", time.June, 2023, "BHP-style 53-week year ending Sunday 2 July"},
		{"2025-07-31", time.June, 2026, "a genuine July period end is next FY"},
		{"2025-12-31", time.December, 2025, "a December year (DRO) is its calendar year"},
		{"2026-06-30", time.December, 2026, "H1 of a December year"},
		{"2026-01-03", time.December, 2025, "a 53-week December year ending early January"},
		{"2025-09-30", time.September, 2025, "a September year"},
		{"2025-12-31", time.September, 2026, "Q1 of a September year"},
	}
	for _, c := range cases {
		assert.Equal(t, c.want, fiscalYear(date(c.end), c.fye), "%s (%s)", c.end, c.why)
	}
}

func TestAssignFiscalYearsFromFixtures(t *testing.T) {
	bhp := fixtureRows(t, "yahoo_full_BHP.json")
	assignFiscalYears(bhp)
	assert.Equal(t, int16(2026), *find(t, bhp, periodAnnual, "2026-06-30").FiscalYear)
	assert.Equal(t, int16(2026), *find(t, bhp, periodTTM, "2025-12-31").FiscalYear, "H1 FY26")
	assert.Equal(t, int16(2026), *find(t, bhp, periodQuarter, "2025-12-31").FiscalYear, "the H1 FY26 snapshot")
	assert.Equal(t, int16(2024), *find(t, bhp, periodTTM, "2023-12-31").FiscalYear, "H1 FY24")
	assert.Equal(t, date("2025-12-31"), find(t, bhp, periodTTM, "2025-12-31").PeriodEnd, "period_end untouched")

	dro := fixtureRows(t, "yahoo_timeseries_DRO.json")
	assignFiscalYears(dro)
	assert.Equal(t, int16(2025), *find(t, dro, periodAnnual, "2025-12-31").FiscalYear,
		"December year end: FY2025, where the June-only rule would say FY2026")
	assert.Equal(t, int16(2026), *find(t, dro, periodTTM, "2026-06-30").FiscalYear, "H1 FY26 of a December year")

	// No annual row: the ASX default (June) applies, i.e. month >= 7 -> year+1.
	ttmOnly := []PeriodRow{
		{PeriodType: periodTTM, PeriodEnd: date("2025-12-31")},
		{PeriodType: periodTTM, PeriodEnd: date("2026-06-30")},
	}
	assignFiscalYears(ttmOnly)
	assert.Equal(t, int16(2026), *ttmOnly[0].FiscalYear)
	assert.Equal(t, int16(2026), *ttmOnly[1].FiscalYear)
}

// ---------------------------------------------------------------------------
// Gates

func annual(end string, cur string) PeriodRow {
	return PeriodRow{PeriodType: periodAnnual, PeriodEnd: date(end), Currency: cur, Source: sourceYahoo}
}

func TestGateFXConverted(t *testing.T) {
	rows := []PeriodRow{annual("2026-03-31", "AUD"), annual("2025-03-31", "AUD")}
	rows[0].Revenue, rows[0].EPSBasic, rows[0].SharesOutstanding = f64(2295764676.451), f64(0.85), f64(170569000)
	rows[1].Revenue, rows[1].TotalAssets = f64(1910806979), f64(4056018720)
	out, rep := applyVendorGates(rows)
	assert.True(t, rep.fxConverted, "one fractional monetary value marks the code (XRO)")
	assert.Equal(t, 1, rep.counts[gateFXConverted])
	for _, r := range out {
		for _, c := range fundamentalsColumns {
			if c.isMonetary() || c.isPerShare() {
				assert.Nil(t, c.get(&r), c.name)
				assert.Contains(t, r.Rejected, c.name, "every monetary and per-share column is masked, present or not")
			}
		}
	}
	assert.Nil(t, out[0].EPSBasic, "Yahoo converted the EPS too: withheld, never relabelled")
	assert.Contains(t, out[1].Rejected, "eps_diluted", "a converted EPS stored by an earlier run is nulled too")
	assert.Equal(t, 170569000.0, val(t, out[0].SharesOutstanding), "the share count is currency-free and stays")
	assert.Equal(t, 2295764676.451, *rows[0].Revenue, "the input is not mutated")

	noise := []PeriodRow{annual("2026-06-30", "USD")}
	noise[0].TotalAssets, noise[0].TotalEquity = f64(38021999999.9999), f64(14797000000.0001)
	_, rep = applyVendorGates(noise)
	assert.False(t, rep.fxConverted, "1e-4 is Yahoo's float noise (CSL, FMG), under the 0.001 tolerance")
	eps := []PeriodRow{annual("2026-06-30", "USD")}
	eps[0].EPSBasic, eps[0].Revenue = f64(1.936), f64(58760000000)
	_, rep = applyVendorGates(eps)
	assert.False(t, rep.fxConverted, "a fractional EPS is normal")
}

func TestGateStrayTTM(t *testing.T) {
	rows := []PeriodRow{
		annual("2026-06-30", "AUD"),
		{PeriodType: periodTTM, PeriodEnd: date("2022-06-30"), Currency: "AUD", Source: sourceYahoo, NetIncome: f64(40855000)},
		{PeriodType: periodTTM, PeriodEnd: date("2024-12-31"), Currency: "AUD", Source: sourceYahoo, EPSBasic: f64(-0.02)},
		{PeriodType: periodTTM, PeriodEnd: date("2024-12-29"), Currency: "AUD", Source: sourceYahoo, EPSBasic: f64(-0.02)},
	}
	rows[0].Revenue = f64(639136000)
	out, rep := applyVendorGates(rows)
	assert.Equal(t, 2, rep.counts[gateStrayTTM], "older than the latest annual end minus 18 months (LTR's 2022 point)")
	require.Len(t, out, 2)
	find(t, out, periodTTM, "2024-12-31") // the half-year end 18 months back: kept

	onlyTTM := []PeriodRow{{PeriodType: periodTTM, PeriodEnd: date("2015-06-30"), Currency: "AUD", Source: sourceYahoo, EPSBasic: f64(1)}}
	out, rep = applyVendorGates(onlyTTM)
	assert.Len(t, out, 1, "no annual row: no reference, nothing dropped")
	assert.Zero(t, rep.counts[gateStrayTTM])
}

func TestGateSignRules(t *testing.T) {
	r := annual("2026-06-30", "AUD")
	r.EPSBasic, r.EPSDiluted = f64(0.8506), f64(-0.1584)
	r.CapitalExpenditure, r.DividendsPaid, r.ShareBuybacks = f64(5), f64(0), f64(-3)
	r.Revenue = f64(100)
	out, rep := applyVendorGates([]PeriodRow{r})
	o := out[0]
	assert.Nil(t, o.EPSBasic, "basic and diluted of opposite signs reject both (XRO FY26)")
	assert.Nil(t, o.EPSDiluted)
	assert.Equal(t, 1, rep.counts[gateEPSSignMismatch])
	assert.Nil(t, o.CapitalExpenditure, "capex > 0 is a sign violation")
	assert.Equal(t, 0.0, val(t, o.DividendsPaid), "zero is allowed")
	assert.Equal(t, -3.0, val(t, o.ShareBuybacks))
	assert.Equal(t, 1, rep.counts[gateSignViolation])
	assert.ElementsMatch(t, []string{"eps_basic", "eps_diluted", "capital_expenditure"}, o.Rejected)
	assert.Equal(t, 100.0, val(t, o.Revenue))
}

func TestGateNonPositiveAssets(t *testing.T) {
	a := annual("2025-12-31", "USD")
	a.TotalAssets, a.TotalEquity, a.CashAndEquivalents = f64(-183074000), f64(-393831000), f64(5)
	a.Revenue, a.SharesOutstanding = f64(192520000), f64(226379568)
	q := PeriodRow{PeriodType: periodQuarter, PeriodEnd: date("2025-12-31"), Currency: "USD", Source: sourceYahoo,
		TotalLiabilities: f64(10), SharesOutstanding: f64(226379568)}
	ok := annual("2024-12-31", "USD")
	ok.TotalAssets = f64(1)
	out, rep := applyVendorGates([]PeriodRow{a, q, ok})
	assert.Equal(t, 1, rep.counts[gateNonPositiveAssets])
	ga := find(t, out, periodAnnual, "2025-12-31")
	assert.Nil(t, ga.TotalAssets)
	assert.Nil(t, ga.TotalEquity)
	assert.Nil(t, ga.CashAndEquivalents)
	assert.Equal(t, 192520000.0, val(t, ga.Revenue), "flow lines stand")
	assert.Equal(t, 226379568.0, val(t, ga.SharesOutstanding), "the share count stays")
	gq := find(t, out, periodQuarter, "2025-12-31")
	assert.Nil(t, gq.TotalLiabilities, "the whole period's balance sheet, snapshot included")
	assert.Contains(t, gq.Rejected, "total_liabilities")
	assert.Equal(t, 1.0, val(t, find(t, out, periodAnnual, "2024-12-31").TotalAssets))
}

func TestGateScaleBreak(t *testing.T) {
	mk := func(end string, rev float64) PeriodRow {
		r := annual(end, "AUD")
		r.Revenue, r.NetIncome, r.EPSBasic = f64(rev), f64(rev/10), f64(0.4)
		return r
	}
	rows := []PeriodRow{mk("2023-06-30", 10212000000), mk("2024-06-30", 13673000000), mk("2025-06-30", 5351000), mk("2026-06-30", 16115000000)}
	out, rep := applyVendorGates(rows)
	assert.Equal(t, 1, rep.counts[gateScaleBreak], "IAG FY25: 5.35m between 13.7bn and 16.1bn")
	fy25 := find(t, out, periodAnnual, "2025-06-30")
	assert.Nil(t, fy25.Revenue)
	assert.Nil(t, fy25.NetIncome, "the period's monetary fields, not only the broken line")
	assert.Equal(t, 0.4, val(t, fy25.EPSBasic))

	// No trigger: an end point (no neighbour on one side), a negative value,
	// a lumpy flow outside the level lines (LTR's $5,000 buyback).
	edge := []PeriodRow{mk("2024-06-30", 100e6), mk("2025-06-30", 100e6), mk("2026-06-30", 1e6)}
	_, rep = applyVendorGates(edge)
	assert.Zero(t, rep.counts[gateScaleBreak])
	neg := []PeriodRow{mk("2024-06-30", 100e6), mk("2025-06-30", -1e6), mk("2026-06-30", 100e6)}
	_, rep = applyVendorGates(neg)
	assert.Zero(t, rep.counts[gateScaleBreak], "a sign change is not a scale slip")
	bb := []PeriodRow{mk("2024-06-30", 100e6), mk("2025-06-30", 100e6), mk("2026-06-30", 100e6)}
	bb[0].ShareBuybacks, bb[1].ShareBuybacks, bb[2].ShareBuybacks = f64(-11192000), f64(-5000), f64(-9662000)
	bb[0].NetIncome, bb[1].NetIncome, bb[2].NetIncome = f64(100e6), f64(1e6), f64(120e6)
	_, rep = applyVendorGates(bb)
	assert.Zero(t, rep.counts[gateScaleBreak], "buybacks and a breakeven profit are not level lines")
}

func TestGateIdentity(t *testing.T) {
	mk := func(end string, ni, eps, shares float64) PeriodRow {
		r := annual(end, "USD")
		r.NetIncome, r.EPSBasic, r.SharesOutstanding, r.Revenue = f64(ni), f64(eps), f64(shares), f64(1e9)
		return r
	}
	// RMD: a CDI listing, k ~10 every year: nothing is an outlier.
	rmd := []PeriodRow{
		mk("2023-06-30", 897556000, 0.612, 147064349), mk("2024-06-30", 1020951000, 0.694, 146901045),
		mk("2025-06-30", 1400723000, 0.955, 146385350), mk("2026-06-30", 1523293000, 1.047, 144239563),
	}
	_, rep := applyVendorGates(rmd)
	assert.Zero(t, rep.counts[gateIdentityOutlier])
	require.NotNil(t, rep.medianK)
	assert.InDelta(t, 10.02, *rep.medianK, 0.01)
	assert.Equal(t, 4, rep.kPeriods)

	// One period off the median by more than 3x loses its monetary fields.
	bad := []PeriodRow{
		mk("2023-06-30", 832e6, 0.3392, 2441e6), mk("2024-06-30", 898e6, 0.3731, 2370e6),
		mk("2025-06-30", 3.27e6, 0.3949, 2365e6), mk("2026-06-30", 1022e6, 0.434, 2338e6),
	}
	out, rep := applyVendorGates(bad)
	assert.Equal(t, 1, rep.counts[gateIdentityOutlier])
	fy25 := find(t, out, periodAnnual, "2025-06-30")
	assert.Nil(t, fy25.NetIncome)
	assert.Nil(t, fy25.Revenue)
	assert.Equal(t, 0.3949, val(t, fy25.EPSBasic), "EPS and shares are kept")
	assert.Equal(t, 2365e6, val(t, fy25.SharesOutstanding))

	// Two periods are not enough for a median: no gate, no median_k.
	_, rep = applyVendorGates(bad[:2])
	assert.Nil(t, rep.medianK)
	assert.Zero(t, rep.counts[gateIdentityOutlier])

	// An annual row and the TTM row at the same year end are one period;
	// a TTM period takes its shares from the snapshot at that date; EPS
	// falls back to diluted.
	rows := []PeriodRow{
		mk("2024-06-30", 100, 1, 100), mk("2025-06-30", 100, 1, 100),
		{PeriodType: periodTTM, PeriodEnd: date("2025-06-30"), Currency: "USD", Source: sourceYahoo, NetIncome: f64(100), EPSBasic: f64(1)},
		{PeriodType: periodTTM, PeriodEnd: date("2025-12-31"), Currency: "USD", Source: sourceYahoo, NetIncome: f64(100), EPSDiluted: f64(1)},
		{PeriodType: periodQuarter, PeriodEnd: date("2025-12-31"), Currency: "USD", Source: sourceYahoo, SharesOutstanding: f64(100)},
	}
	ks := identityKs(rows)
	require.Len(t, ks, 3)
	for _, k := range ks {
		assert.InDelta(t, 1.0, k.k, 1e-9)
	}
}

// ---------------------------------------------------------------------------
// Fills

func TestMergeFallback(t *testing.T) {
	yahoo := []PeriodRow{
		{PeriodType: periodAnnual, PeriodEnd: date("2025-06-30"), Currency: "AUD", Source: sourceYahoo, Revenue: f64(10)},
		{PeriodType: periodTTM, PeriodEnd: date("2026-06-30"), Currency: "AUD", Source: sourceYahoo, EPSDiluted: f64(0.1)},
	}
	markit := []PeriodRow{
		{PeriodType: periodAnnual, PeriodEnd: date("2024-06-30"), Currency: "AUD", Source: sourceMarkit, Revenue: f64(8)},
		{PeriodType: periodAnnual, PeriodEnd: date("2025-06-29"), Currency: "AUD", Source: sourceMarkit, Revenue: f64(999), NetIncome: f64(3)},
		{PeriodType: periodAnnual, PeriodEnd: date("2026-06-30"), Currency: "AUD", Source: sourceMarkit, Revenue: f64(12)},
	}
	got := mergeFallback(yahoo, markit)
	require.Len(t, got, 3, "FY24 is before Yahoo's history; FY25 is filled in place; FY26 is added")
	fy25 := find(t, got, periodAnnual, "2025-06-30")
	assert.Equal(t, sourceYahoo, fy25.Source)
	assert.Equal(t, 10.0, val(t, fy25.Revenue), "Yahoo stays authoritative for its values")
	assert.Equal(t, 3.0, val(t, fy25.NetIncome), "Markit fills Yahoo's NULL (a day apart: a 52/53-week date)")
	assert.Equal(t, map[string]string{"net_income": sourceMarkit}, fy25.FieldSources)
	assert.Equal(t, sourceMarkit, find(t, got, periodAnnual, "2026-06-30").Source)
	assert.Nil(t, yahoo[0].NetIncome, "the primary rows are not mutated")

	usd := []PeriodRow{{PeriodType: periodAnnual, PeriodEnd: date("2025-06-30"), Currency: "USD", Source: sourceYahoo, EPSBasic: f64(1)}}
	got = mergeFallback(usd, markit[1:2])
	assert.Nil(t, got[0].Revenue, "no fill across currencies")

	rejected := []PeriodRow{{PeriodType: periodAnnual, PeriodEnd: date("2025-06-30"), Currency: "AUD", Source: sourceYahoo,
		EPSBasic: f64(1), Rejected: []string{"revenue", "total_assets"}}}
	got = mergeFallback(rejected, markit[1:2])
	assert.Equal(t, 999.0, val(t, got[0].Revenue), "an independent source may supply a field Yahoo's gate refused")
	assert.Equal(t, []string{"total_assets"}, got[0].Rejected, "and the field leaves the mask")

	assert.Len(t, mergeFallback(nil, markit), 3, "no Yahoo rows: the fallback is all there is")

	bhpY := fixtureRows(t, "yahoo_full_BHP.json")
	bhpM := fixtureRows(t, "markit_key_statistics_BHP.json")
	merged := mergeFallback(bhpY, bhpM)
	assert.Len(t, merged, len(bhpY), "Markit adds nothing when Yahoo is current")
	for _, r := range merged {
		assert.Empty(t, r.FieldSources)
	}
}

func TestCopyTTMAtFYE(t *testing.T) {
	a := annual("2026-06-30", "AUD")
	a.Revenue, a.NetIncome, a.Rejected = f64(639136000), f64(92552000), []string{"free_cash_flow"}
	ttm := PeriodRow{PeriodType: periodTTM, PeriodEnd: date("2026-06-30"), Currency: "AUD", Source: sourceYahoo,
		Revenue: f64(1), EPSBasic: f64(0.031), EPSDiluted: f64(0.031), FreeCashFlow: f64(47871000),
		CapitalExpenditure: f64(-134041000), TotalAssets: f64(5)}
	half := PeriodRow{PeriodType: periodTTM, PeriodEnd: date("2025-12-31"), Currency: "AUD", Source: sourceYahoo, EPSBasic: f64(-0.14)}
	rows := []PeriodRow{a, ttm, half}
	copyTTMAtFYE(rows)
	got := rows[0]
	assert.Equal(t, 639136000.0, val(t, got.Revenue), "a value the annual row has is never replaced")
	assert.Equal(t, 0.031, val(t, got.EPSBasic))
	assert.Equal(t, -134041000.0, val(t, got.CapitalExpenditure))
	assert.Nil(t, got.FreeCashFlow, "a Rejected field is never refilled from the same vendor")
	assert.Nil(t, got.TotalAssets, "only flow lines move")
	assert.Equal(t, map[string]string{
		"eps_basic": fieldSourceDerivedTTMAtFYE, "eps_diluted": fieldSourceDerivedTTMAtFYE, "capital_expenditure": fieldSourceDerivedTTMAtFYE,
	}, got.FieldSources)

	other := []PeriodRow{annual("2026-06-30", "USD"), {PeriodType: periodTTM, PeriodEnd: date("2026-06-30"), Currency: "AUD", Source: sourceYahoo, EPSBasic: f64(1)}}
	copyTTMAtFYE(other)
	assert.Nil(t, other[0].EPSBasic, "no copy across currencies")
}

func TestFillAnnualFromSnapshots(t *testing.T) {
	a := annual("2026-06-30", "USD")
	a.TotalAssets, a.Rejected = f64(1), []string{"cash_and_equivalents"}
	q := PeriodRow{PeriodType: periodQuarter, PeriodEnd: date("2026-06-30"), Currency: "USD", Source: sourceYahoo,
		TotalAssets: f64(2), TotalEquity: f64(3), CashAndEquivalents: f64(4), SharesOutstanding: f64(5)}
	h1 := PeriodRow{PeriodType: periodQuarter, PeriodEnd: date("2025-12-31"), Currency: "USD", Source: sourceYahoo, TotalDebt: f64(9)}
	rows := []PeriodRow{a, q, h1}
	fillAnnualFromSnapshots(rows)
	got := rows[0]
	assert.Equal(t, 1.0, val(t, got.TotalAssets), "never replaces")
	assert.Equal(t, 3.0, val(t, got.TotalEquity))
	assert.Equal(t, 5.0, val(t, got.SharesOutstanding))
	assert.Nil(t, got.CashAndEquivalents, "never refills a Rejected field")
	assert.Nil(t, got.TotalDebt, "only the snapshot at the year end fills the annual row")
	assert.Empty(t, got.FieldSources, "the same source: no exception to record")
}

func TestDeriveOperatingCashFlow(t *testing.T) {
	derived := annual("2026-06-30", "AUD")
	derived.FreeCashFlow, derived.CapitalExpenditure = f64(3554000000), f64(-3282000000)
	reported := annual("2025-06-30", "AUD")
	reported.OperatingCashFlow, reported.FreeCashFlow, reported.CapitalExpenditure = f64(1), f64(2), f64(-3)
	masked := annual("2024-06-30", "AUD")
	masked.FreeCashFlow, masked.CapitalExpenditure, masked.Rejected = f64(2), f64(-3), []string{"operating_cash_flow"}
	partial := annual("2023-06-30", "AUD")
	partial.FreeCashFlow = f64(2)
	rows := []PeriodRow{derived, reported, masked, partial}
	deriveOperatingCashFlow(rows)
	assert.Equal(t, 6836000000.0, val(t, rows[0].OperatingCashFlow), "FCF - capex, capex being an outflow")
	assert.Equal(t, fieldSourceDerivedFCFMinusCapex, rows[0].FieldSources["operating_cash_flow"])
	assert.Equal(t, 1.0, val(t, rows[1].OperatingCashFlow), "a reported value is never overwritten")
	assert.Empty(t, rows[1].FieldSources)
	assert.Nil(t, rows[2].OperatingCashFlow, "a Rejected OCF is not derived back")
	assert.Nil(t, rows[3].OperatingCashFlow, "both inputs are needed")
}

func TestNeedsFallback(t *testing.T) {
	now := date("2026-09-27")
	full := func(end string) PeriodRow {
		r := annual(end, "AUD")
		r.Revenue, r.NetIncome = f64(1), f64(1)
		return r
	}
	ttm := func(end string) PeriodRow { return PeriodRow{PeriodType: periodTTM, PeriodEnd: date(end)} }

	assert.False(t, needsFallback(fixtureRows(t, "yahoo_full_BHP.json"), nil, now), "BHP: annual to Jun-26, complete")
	assert.False(t, needsFallback(fixtureRows(t, "yahoo_timeseries_DRO.json"), nil, now), "DRO: annual to Dec-25, TTM to Jun-26 is the next half")

	assert.True(t, needsFallback(nil, assert.AnError, now), "Yahoo failed")
	assert.True(t, needsFallback(nil, nil, now), "Yahoo published nothing")
	assert.True(t, needsFallback([]PeriodRow{ttm("2026-06-30")}, nil, now), "no annual row")
	assert.True(t, needsFallback([]PeriodRow{full("2025-06-30"), ttm("2026-06-30")}, nil, now),
		"SKS/4DX lag: trailing to Jun-26 while annual is still Jun-25")
	assert.True(t, needsFallback([]PeriodRow{full("2025-03-31")}, nil, now), "annual older than ~15 months")
	assert.False(t, needsFallback([]PeriodRow{full("2025-12-31"), ttm("2026-06-30")}, nil, now))

	epsOnly := annual("2025-06-30", "AUD")
	epsOnly.EPSBasic = f64(1.352)
	assert.True(t, needsFallback([]PeriodRow{full("2024-06-30"), epsOnly}, nil, now), "MAQ: the latest annual is EPS-only")
	maskedLatest := annual("2026-06-30", "AUD")
	maskedLatest.EPSBasic, maskedLatest.Rejected = f64(1), []string{"revenue", "net_income"}
	assert.True(t, needsFallback([]PeriodRow{maskedLatest}, nil, now), "a refused revenue: Markit may hold the real one")
	maskedOld := full("2025-06-30")
	maskedOld.Revenue, maskedOld.Rejected = nil, []string{"revenue"}
	assert.True(t, needsFallback([]PeriodRow{maskedOld, full("2026-06-30")}, nil, now), "IAG: FY25 refused")
	assert.True(t, needsFallback(fixtureRows(t, "yahoo_full_MAQ.json"), nil, now))
}

func TestFallbackCurrencyAndRelabel(t *testing.T) {
	m := fixtureRows(t, "markit_key_statistics_XRO.json")
	assert.Equal(t, "NZD", fallbackCurrency(m))
	assert.Equal(t, "", fallbackCurrency(nil))
	rows := []PeriodRow{annual("2026-03-31", "AUD")}
	relabelCurrency(rows, "NZD")
	assert.Equal(t, "NZD", rows[0].Currency)
}

func TestNormalizeCode(t *testing.T) {
	assert.Equal(t, "BHP", normalizeCode(" bhp "))
	assert.Equal(t, "4DX", normalizeCode("4dx"))
	for _, bad := range []string{"", "BH P", "BHP.AX", "../X", "ABCDEFGHIJK"} {
		assert.Equal(t, "", normalizeCode(bad), bad)
	}
}
