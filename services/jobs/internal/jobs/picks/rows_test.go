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
			Revenue: f64(math.NaN())}, // nothing survives: dropped
		{PeriodType: "half", PeriodEnd: date("2024-12-31"), Currency: "AUD", Source: sourceYahoo, Revenue: f64(1)},
		{PeriodType: periodTTM, PeriodEnd: date("2024-12-31"), Currency: "", Source: sourceYahoo, Revenue: f64(1)},
		{PeriodType: periodTTM, PeriodEnd: time.Time{}, Currency: "AUD", Source: sourceYahoo, Revenue: f64(1)},
		{PeriodType: periodTTM, PeriodEnd: date("2025-12-31"), Currency: "USD", Source: sourceYahoo, EPSDiluted: f64(0)},
	}
	out, rejected := sanitizeRows(rows)
	assert.Equal(t, 3, rejected, "Inf revenue, NaN EPS, NaN revenue")
	require.Len(t, out, 2)
	assert.Nil(t, out[0].Revenue)
	assert.Nil(t, out[0].EPSDiluted)
	assert.Equal(t, 5.0, *out[0].NetIncome)
	assert.Equal(t, 0.0, *out[1].EPSDiluted, "zero is a value (a break-even EPS), not a missing one")
	assert.True(t, math.IsInf(*rows[0].Revenue, 1), "the input slice is not mutated")
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
	bhp, err := parseYahooTimeseries(readFixture(t, "yahoo_timeseries_BHP.json"))
	require.NoError(t, err)
	assignFiscalYears(bhp)
	assert.Equal(t, int16(2026), *find(t, bhp, periodAnnual, "2026-06-30").FiscalYear)
	assert.Equal(t, int16(2026), *find(t, bhp, periodTTM, "2025-12-31").FiscalYear, "H1 FY26")
	assert.Equal(t, int16(2024), *find(t, bhp, periodTTM, "2023-12-31").FiscalYear, "H1 FY24")
	assert.Equal(t, date("2025-12-31"), find(t, bhp, periodTTM, "2025-12-31").PeriodEnd, "period_end untouched")

	dro, err := parseYahooTimeseries(readFixture(t, "yahoo_timeseries_DRO.json"))
	require.NoError(t, err)
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

func TestNeedsFallback(t *testing.T) {
	now := date("2026-09-27")
	annual := func(end string) PeriodRow { return PeriodRow{PeriodType: periodAnnual, PeriodEnd: date(end)} }
	ttm := func(end string) PeriodRow { return PeriodRow{PeriodType: periodTTM, PeriodEnd: date(end)} }

	bhp, _ := parseYahooTimeseries(readFixture(t, "yahoo_timeseries_BHP.json"))
	dro, _ := parseYahooTimeseries(readFixture(t, "yahoo_timeseries_DRO.json"))
	assert.False(t, needsFallback(bhp, nil, now), "BHP: annual to Jun-26, current")
	assert.False(t, needsFallback(dro, nil, now), "DRO: annual to Dec-25, TTM to Jun-26 is the next half, current")

	assert.True(t, needsFallback(nil, assert.AnError, now), "Yahoo failed")
	assert.True(t, needsFallback(nil, nil, now), "Yahoo published nothing")
	assert.True(t, needsFallback([]PeriodRow{ttm("2026-06-30")}, nil, now), "no annual row")
	assert.True(t, needsFallback([]PeriodRow{annual("2025-06-30"), ttm("2026-06-30")}, nil, now),
		"SKS/4DX lag: trailing to Jun-26 while annual is still Jun-25")
	assert.True(t, needsFallback([]PeriodRow{annual("2025-03-31")}, nil, now), "annual older than ~15 months")
	assert.False(t, needsFallback([]PeriodRow{annual("2025-12-31"), ttm("2026-06-30")}, nil, now))
}

func TestMergeFallback(t *testing.T) {
	yahoo := []PeriodRow{
		{PeriodType: periodAnnual, PeriodEnd: date("2025-06-30"), Source: sourceYahoo, Revenue: f64(10)},
		{PeriodType: periodTTM, PeriodEnd: date("2026-06-30"), Source: sourceYahoo, EPSDiluted: f64(0.1)},
	}
	markit := []PeriodRow{
		{PeriodType: periodAnnual, PeriodEnd: date("2024-06-30"), Source: sourceMarkit, Revenue: f64(8)},
		{PeriodType: periodAnnual, PeriodEnd: date("2025-06-30"), Source: sourceMarkit, Revenue: f64(999)},
		{PeriodType: periodAnnual, PeriodEnd: date("2026-06-30"), Source: sourceMarkit, Revenue: f64(12)},
	}
	got := mergeFallback(yahoo, markit)
	require.Len(t, got, 3, "only the year Yahoo has not caught up with is added")
	assert.Equal(t, sourceYahoo, find(t, got, periodAnnual, "2025-06-30").Source, "Yahoo stays authoritative for its periods")
	assert.Equal(t, 10.0, *find(t, got, periodAnnual, "2025-06-30").Revenue)
	assert.Equal(t, sourceMarkit, find(t, got, periodAnnual, "2026-06-30").Source)

	assert.Len(t, mergeFallback(nil, markit), 3, "no Yahoo rows: the fallback is all there is")

	bhpY, _ := parseYahooTimeseries(readFixture(t, "yahoo_timeseries_BHP.json"))
	bhpM, _ := parseMarkitKeyStatistics(readFixture(t, "markit_key_statistics_BHP.json"))
	assert.Len(t, mergeFallback(bhpY, bhpM), len(bhpY), "Markit adds nothing when Yahoo is current")
}

func TestNormalizeCode(t *testing.T) {
	assert.Equal(t, "BHP", normalizeCode(" bhp "))
	assert.Equal(t, "4DX", normalizeCode("4dx"))
	for _, bad := range []string{"", "BH P", "BHP.AX", "../X", "ABCDEFGHIJK"} {
		assert.Equal(t, "", normalizeCode(bad), bad)
	}
}
