package picks

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Fixtures.
//
// yahoo_full_<CODE>.json are the raw payloads of the production request
// (yahooTimeseriesURL's 58 types) captured live on 2026-09-28 through
// stealthhttp: BHP (USD, the full statements), CSL (direct-method OCF only,
// a Dec-24 balance snapshot Yahoo labels a quarter), IAG (FY25 slipped to
// thousands), XRO (FX-converted: fractional AUD values, and EPS that is the
// AUD-converted net income over the share count even where a point is
// labelled NZD), LTR (2022 trailing leftovers beside FY26), RMD (a CDI
// listing, k ~10, quarterly balance points), AXQ (negative total assets), MAQ
// and LOV (EPS-only FY25 rows; LOV's 52-week year) and FMG (no FY24 NetDebt:
// net cash).
//
// yahoo_timeseries_{BHP,DRO}.json and markit_key_statistics_{BHP,DRO}.json
// are the 2026-09-27 probe (docs/plans/stock-picker.md §2.7): a 39-type
// request that includes unrequested series (ignored) and empty quarterly P&L
// series. markit_key_statistics_{IAG,LOV,MAQ,XRO}.json were captured
// 2026-09-28.

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	require.NoError(t, err)
	return b
}

func date(s string) time.Time {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return t
}

func find(t *testing.T, rows []PeriodRow, periodType, end string) PeriodRow {
	t.Helper()
	for _, r := range rows {
		if r.PeriodType == periodType && r.PeriodEnd.Equal(date(end)) {
			return r
		}
	}
	t.Fatalf("no %s row for %s in %d rows", periodType, end, len(rows))
	return PeriodRow{}
}

func val(t *testing.T, v *float64) float64 {
	t.Helper()
	require.NotNil(t, v)
	return *v
}

func countType(rows []PeriodRow, periodType string) int {
	n := 0
	for _, r := range rows {
		if r.PeriodType == periodType {
			n++
		}
	}
	return n
}

// ---------------------------------------------------------------------------
// Yahoo

func TestYahooSeriesCoverEveryColumn(t *testing.T) {
	fed := map[string]map[string]bool{} // column -> period types
	for _, s := range yahooSeriesList {
		if fed[s.column] == nil {
			fed[s.column] = map[string]bool{}
		}
		fed[s.column][s.periodType] = true
	}
	for _, c := range fundamentalsColumns {
		require.Contains(t, fed, c.name, "%s is collected", c.name)
		if c.isFlow() {
			assert.Equal(t, map[string]bool{periodAnnual: true, periodTTM: true}, fed[c.name],
				"%s: annual and trailing, never quarterly (§3.1)", c.name)
		} else {
			assert.Equal(t, map[string]bool{periodAnnual: true, periodQuarter: true}, fed[c.name],
				"%s: annual and quarterly (§3.1)", c.name)
		}
	}
	assert.Equal(t, map[string]bool{periodAnnual: true, periodTTM: true}, fed[seriesOCFDirect], "the direct-method OCF, both flavours")
	assert.Len(t, yahooSeriesList, 2*(len(fundamentalsColumns)+1), "every column twice, plus the direct-method pair")
	for _, s := range yahooSeriesList {
		assert.NotContains(t, s.typ, "Valuation", "no valuation series")
		if strings.HasPrefix(s.typ, "quarterly") {
			c, ok := columnNamed(s.column)
			require.True(t, ok)
			assert.True(t, c.isBalance(), "%s: no quarterly income or cash-flow series", s.typ)
		}
	}
}

func TestYahooTimeseriesURL(t *testing.T) {
	now := time.Date(2026, 9, 27, 0, 0, 0, 0, time.UTC)
	u := yahooTimeseriesURL("bhp", now)
	assert.True(t, strings.HasPrefix(u, "https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/BHP.AX?type="))
	assert.True(t, strings.HasSuffix(u, "&period1=1262304000&period2=1822003200"), "period2 a year ahead")
	types := strings.Split(strings.TrimSuffix(strings.SplitN(strings.SplitN(u, "?type=", 2)[1], "&", 2)[0], ","), ",")
	assert.Len(t, types, 58, "ONE GET per code carries all 58 series")
	for _, want := range []string{
		"annualTotalRevenue", "trailingTotalRevenue", "annualBasicEPS", "trailingBasicEPS",
		"annualCashFlowsfromusedinOperatingActivitiesDirect", "trailingCashFlowsfromusedinOperatingActivitiesDirect",
		"annualCashDividendsPaid", "trailingRepurchaseOfCapitalStock",
		"annualTotalLiabilitiesNetMinorityInterest", "quarterlyTotalLiabilitiesNetMinorityInterest",
		"annualOrdinarySharesNumber", "quarterlyOrdinarySharesNumber", "quarterlyNetDebt",
	} {
		assert.Contains(t, types, want)
	}
	for _, not := range []string{"quarterlyTotalRevenue", "trailingOrdinarySharesNumber", "trailingTotalAssets"} {
		assert.NotContains(t, types, not)
	}
}

func TestParseYahooTimeseriesBHPFull(t *testing.T) {
	rows := fixtureRows(t, "yahoo_full_BHP.json")
	assert.Equal(t, 4, countType(rows, periodAnnual))
	assert.Equal(t, 4, countType(rows, periodQuarter))
	assert.Zero(t, countType(rows, periodHalf), "a quarterly point is never a half row")

	fy26 := find(t, rows, periodAnnual, "2026-06-30")
	assert.Equal(t, "USD", fy26.Currency, "values stay in the REPORTING currency")
	assert.Equal(t, sourceYahoo, fy26.Source)
	assert.Equal(t, 58760000000.0, val(t, fy26.Revenue))
	assert.Equal(t, 9833000000.0, val(t, fy26.NetIncome))
	assert.Equal(t, 1.936, val(t, fy26.EPSBasic))
	assert.Equal(t, 1.932, val(t, fy26.EPSDiluted))
	assert.Equal(t, 21778000000.0, val(t, fy26.OperatingCashFlow))
	assert.Equal(t, 11929000000.0, val(t, fy26.FreeCashFlow))
	assert.Equal(t, 5080163098.0, val(t, fy26.SharesOutstanding))
	assert.Equal(t, 30723000000.0, val(t, fy26.EBITDA))
	assert.Equal(t, 24522000000.0, val(t, fy26.EBIT))
	assert.Equal(t, 22414000000.0, val(t, fy26.PretaxIncome))
	assert.Equal(t, 9388000000.0, val(t, fy26.TaxProvision))
	assert.Equal(t, -1537000000.0, val(t, fy26.NetInterestIncome))
	assert.Equal(t, 65066000000.0, val(t, fy26.TotalLiabilities))
	assert.Equal(t, 18445000000.0, val(t, fy26.CashAndEquivalents))
	assert.Equal(t, 27121000000.0, val(t, fy26.TotalDebt))
	assert.Equal(t, 3496000000.0, val(t, fy26.CapitalLeaseObligations))
	assert.Equal(t, 31033000000.0, val(t, fy26.CurrentAssets))
	assert.Equal(t, 16465000000.0, val(t, fy26.CurrentLiabilities))
	assert.Nil(t, fy26.FiscalYear, "fiscal_year is derived later, never parsed")
	assert.Empty(t, fy26.Rejected)

	ttmH1 := find(t, rows, periodTTM, "2025-12-31")
	assert.Equal(t, 2.013, val(t, ttmH1.EPSDiluted))
	assert.Equal(t, 2.018, val(t, ttmH1.EPSBasic), "trailingBasicEPS is requested now")
	assert.Nil(t, ttmH1.Revenue, "Yahoo keeps TTM revenue only at the latest point")
	assert.Nil(t, ttmH1.TotalAssets, "no balance line on a TTM row")

	q := find(t, rows, periodQuarter, "2025-12-31")
	assert.Equal(t, 116012000000.0, val(t, q.TotalAssets))
	assert.Equal(t, 50407000000.0, val(t, q.TotalEquity))
	assert.Equal(t, 14555000000.0, val(t, q.NetDebt))
	assert.Equal(t, 5078211653.0, val(t, q.SharesOutstanding))
	assert.Equal(t, "USD", q.Currency)
	for _, c := range fundamentalsColumns {
		if c.isFlow() {
			assert.Nil(t, c.get(&q), "%s on a snapshot", c.name)
		}
	}

	stray := find(t, rows, periodTTM, "2020-06-30")
	assert.Equal(t, 26093000000.0, val(t, stray.GrossProfit), "parsed as reported; the stray-TTM gate drops it")
}

func TestParseYahooTimeseriesDirectMethodOCF(t *testing.T) {
	csl := fixtureRows(t, "yahoo_full_CSL.json")
	fy25 := find(t, csl, periodAnnual, "2025-06-30")
	assert.Equal(t, 3561000000.0, val(t, fy25.OperatingCashFlow), "CSL has no OperatingCashFlow series: the direct-method one")
	ttm := find(t, csl, periodTTM, "2026-06-30")
	assert.Equal(t, 3512000000.0, val(t, ttm.OperatingCashFlow))

	body := `{"timeseries":{"result":[
		{"meta":{"type":["annualOperatingCashFlow"]},"annualOperatingCashFlow":[{"asOfDate":"2025-06-30","periodType":"12M","currencyCode":"AUD","reportedValue":{"raw":100}}]},
		{"meta":{"type":["annualCashFlowsfromusedinOperatingActivitiesDirect"]},"annualCashFlowsfromusedinOperatingActivitiesDirect":[
			{"asOfDate":"2025-06-30","periodType":"12M","currencyCode":"AUD","reportedValue":{"raw":90}},
			{"asOfDate":"2024-06-30","periodType":"12M","currencyCode":"AUD","reportedValue":{"raw":80}}]}
	]}}`
	rows, err := parseYahooTimeseries([]byte(body))
	require.NoError(t, err)
	assert.Equal(t, 100.0, val(t, find(t, rows, periodAnnual, "2025-06-30").OperatingCashFlow), "the reported series wins")
	assert.Equal(t, 80.0, val(t, find(t, rows, periodAnnual, "2024-06-30").OperatingCashFlow), "else the direct method")
}

func TestParseYahooTimeseriesDRO(t *testing.T) {
	rows, err := parseYahooTimeseries(readFixture(t, "yahoo_timeseries_DRO.json"))
	require.NoError(t, err)
	assert.Equal(t, 4, countType(rows, periodAnnual))
	assert.Equal(t, 6, countType(rows, periodTTM))

	fy25 := find(t, rows, periodAnnual, "2025-12-31")
	assert.Equal(t, "AUD", fy25.Currency)
	assert.Equal(t, 216547000.0, val(t, fy25.Revenue))
	assert.Equal(t, 3521000.0, val(t, fy25.NetIncome))
	assert.Equal(t, 0.0038, val(t, fy25.EPSDiluted))
	assert.Nil(t, fy25.OperatingCashFlow, "DRO has no annualOperatingCashFlow: NULL, never 0")
	assert.Equal(t, -14882000.0, val(t, fy25.FreeCashFlow))

	fy24 := find(t, rows, periodAnnual, "2024-12-31")
	assert.Equal(t, -1320000.0, val(t, fy24.NetIncome), "a loss is stored as reported")

	ttm := find(t, rows, periodTTM, "2026-06-30")
	assert.Equal(t, 269990000.0, val(t, ttm.Revenue))
	assert.Equal(t, -30833000.0, val(t, ttm.NetIncome))
	assert.Equal(t, -0.0334, val(t, ttm.EPSDiluted))
	assert.Nil(t, ttm.OperatingCashFlow)
}

func TestParseYahooTimeseriesDefensive(t *testing.T) {
	t.Run("null points and unrequested series are skipped", func(t *testing.T) {
		body := `{"timeseries":{"result":[
			{"meta":{"type":["annualTotalRevenue"]},"annualTotalRevenue":[null,{"asOfDate":"2025-06-30","periodType":"12M","currencyCode":"AUD","reportedValue":{"raw":100}}]},
			{"meta":{"type":["annualNetIncome"]},"annualNetIncome":[{"asOfDate":"2025-06-30","periodType":"12M","currencyCode":"AUD","reportedValue":{"raw":5}}]},
			{"meta":{"type":["quarterlyTotalRevenue"]},"quarterlyTotalRevenue":[{"asOfDate":"2025-03-31","periodType":"3M","currencyCode":"AUD","reportedValue":{"raw":5}}]}
		],"error":null}}`
		rows, err := parseYahooTimeseries([]byte(body))
		require.NoError(t, err)
		require.Len(t, rows, 1)
		assert.Equal(t, 100.0, val(t, rows[0].Revenue))
		assert.Nil(t, rows[0].NetIncome, "annualNetIncome is not NetIncomeCommonStockholders")
	})

	t.Run("a point whose periodType does not match its series is refused", func(t *testing.T) {
		body := `{"timeseries":{"result":[
			{"meta":{"type":["annualTotalRevenue"]},"annualTotalRevenue":[{"asOfDate":"2025-12-31","periodType":"3M","currencyCode":"AUD","reportedValue":{"raw":100}}]},
			{"meta":{"type":["quarterlyTotalAssets"]},"quarterlyTotalAssets":[{"asOfDate":"2025-12-31","periodType":"12M","currencyCode":"AUD","reportedValue":{"raw":100}}]}
		]}}`
		rows, err := parseYahooTimeseries([]byte(body))
		require.NoError(t, err)
		assert.Empty(t, rows, "a half-year figure must never be filed as a full year, nor a year as a snapshot")
	})

	t.Run("a monetary point in another currency nulls THAT field, never the row", func(t *testing.T) {
		body := `{"timeseries":{"result":[
			{"meta":{"type":["annualTotalRevenue"]},"annualTotalRevenue":[{"asOfDate":"2025-06-30","periodType":"12M","currencyCode":"USD","reportedValue":{"raw":100}}]},
			{"meta":{"type":["annualNetIncomeCommonStockholders"]},"annualNetIncomeCommonStockholders":[{"asOfDate":"2025-06-30","periodType":"12M","currencyCode":"USD","reportedValue":{"raw":10}}]},
			{"meta":{"type":["annualTotalAssets"]},"annualTotalAssets":[{"asOfDate":"2025-06-30","periodType":"12M","currencyCode":"AUD","reportedValue":{"raw":900}}]},
			{"meta":{"type":["annualDilutedEPS"]},"annualDilutedEPS":[{"asOfDate":"2025-06-30","periodType":"12M","currencyCode":"NZD","reportedValue":{"raw":1.5}}]},
			{"meta":{"type":["annualOrdinarySharesNumber"]},"annualOrdinarySharesNumber":[{"asOfDate":"2025-06-30","periodType":"12M","currencyCode":"AUD","reportedValue":{"raw":7}}]}
		]}}`
		rows, err := parseYahooTimeseries([]byte(body))
		require.NoError(t, err)
		require.Len(t, rows, 1)
		r := rows[0]
		assert.Equal(t, "USD", r.Currency, "the monetary majority")
		assert.Equal(t, 100.0, val(t, r.Revenue))
		assert.Nil(t, r.TotalAssets)
		assert.Equal(t, []string{"total_assets"}, r.Rejected, "named so the stored value is nulled too")
		assert.Equal(t, 1.5, val(t, r.EPSDiluted), "EPS ignores currencyCode (§3.4)")
		assert.Equal(t, 7.0, val(t, r.SharesOutstanding), "so does the share count")
	})

	t.Run("a currency tie goes to the revenue line", func(t *testing.T) {
		body := `{"timeseries":{"result":[
			{"meta":{"type":["annualTotalRevenue"]},"annualTotalRevenue":[{"asOfDate":"2025-06-30","periodType":"12M","currencyCode":"USD","reportedValue":{"raw":100}}]},
			{"meta":{"type":["annualTotalAssets"]},"annualTotalAssets":[{"asOfDate":"2025-06-30","periodType":"12M","currencyCode":"AUD","reportedValue":{"raw":900}}]}
		]}}`
		rows, err := parseYahooTimeseries([]byte(body))
		require.NoError(t, err)
		require.Len(t, rows, 1)
		assert.Equal(t, "USD", rows[0].Currency)
		assert.Equal(t, []string{"total_assets"}, rows[0].Rejected)
	})

	t.Run("a row with no monetary point takes its EPS currency", func(t *testing.T) {
		body := `{"timeseries":{"result":[
			{"meta":{"type":["trailingDilutedEPS"]},"trailingDilutedEPS":[{"asOfDate":"2025-12-31","periodType":"TTM","currencyCode":"USD","reportedValue":{"raw":2.0}}]}
		]}}`
		rows, err := parseYahooTimeseries([]byte(body))
		require.NoError(t, err)
		require.Len(t, rows, 1)
		assert.Equal(t, "USD", rows[0].Currency)
		assert.Empty(t, rows[0].Rejected)
	})

	t.Run("an out-of-range literal is refused without failing the document", func(t *testing.T) {
		body := `{"timeseries":{"result":[
			{"meta":{"type":["annualTotalRevenue"]},"annualTotalRevenue":[{"asOfDate":"2025-06-30","periodType":"12M","currencyCode":"AUD","reportedValue":{"raw":1e400}}]},
			{"meta":{"type":["annualNetIncomeCommonStockholders"]},"annualNetIncomeCommonStockholders":[{"asOfDate":"2025-06-30","periodType":"12M","currencyCode":"AUD","reportedValue":{"raw":7}}]}
		]}}`
		rows, err := parseYahooTimeseries([]byte(body))
		require.NoError(t, err)
		require.Len(t, rows, 1)
		assert.Nil(t, rows[0].Revenue)
		assert.Equal(t, 7.0, val(t, rows[0].NetIncome))
	})

	t.Run("a top-level error is an error, not an empty answer", func(t *testing.T) {
		_, err := parseYahooTimeseries([]byte(`{"timeseries":{"result":[],"error":{"code":"Bad Request","description":"x"}}}`))
		require.Error(t, err)
		_, err = parseYahooTimeseries([]byte(`<html>`))
		require.Error(t, err)
	})
}

type stubBytes struct {
	body []byte
	err  error
	urls []string
}

func (s *stubBytes) FetchBytes(_ context.Context, u, accept string) ([]byte, string, error) {
	s.urls = append(s.urls, u)
	return s.body, "application/json", s.err
}

func TestYahooFetcherStatusHandling(t *testing.T) {
	now := func() time.Time { return time.Date(2026, 9, 27, 0, 0, 0, 0, time.UTC) }
	noPace := &pacer{interval: 0, now: time.Now, sleep: sleepCtx}

	y := &yahooTimeseries{fetch: &stubBytes{err: errors.New("unexpected status: 404")}, pace: noPace, now: now}
	rows, err := y.Fundamentals(context.Background(), "ZZZ")
	require.NoError(t, err, "404 means Yahoo does not carry the code: answered")
	assert.Empty(t, rows)

	y = &yahooTimeseries{fetch: &stubBytes{err: errors.New("unexpected status: 429")}, pace: noPace, now: now}
	_, err = y.Fundamentals(context.Background(), "BHP")
	require.Error(t, err, "a 429 is not 'no data'")

	stub := &stubBytes{body: readFixture(t, "yahoo_full_BHP.json")}
	y = &yahooTimeseries{fetch: stub, pace: noPace, now: now}
	rows, err = y.Fundamentals(context.Background(), "BHP")
	require.NoError(t, err)
	assert.Len(t, rows, 4+7+4, "annual, ttm and quarter rows")
	require.Len(t, stub.urls, 1, "ONE GET per code")
	assert.True(t, strings.Contains(stub.urls[0], "/BHP.AX?"))
}

func TestPacerSpacesRequests(t *testing.T) {
	clock := time.Date(2026, 9, 27, 0, 0, 0, 0, time.UTC)
	var slept []time.Duration
	p := &pacer{
		interval: 4 * time.Second,
		now:      func() time.Time { return clock },
		sleep: func(_ context.Context, d time.Duration) error {
			slept = append(slept, d)
			clock = clock.Add(d)
			return nil
		},
	}
	require.NoError(t, p.wait(context.Background()))
	assert.Empty(t, slept, "the first request goes immediately")
	clock = clock.Add(time.Second)
	require.NoError(t, p.wait(context.Background()))
	assert.Equal(t, []time.Duration{3 * time.Second}, slept, "tops the gap up to the interval")
	clock = clock.Add(10 * time.Second)
	require.NoError(t, p.wait(context.Background()))
	assert.Len(t, slept, 1, "no wait once the interval has already passed")

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	real := newPacer(time.Hour)
	require.NoError(t, real.wait(context.Background()))
	require.ErrorIs(t, real.wait(ctx), context.Canceled, "the wait is ctx-aware")
}

// ---------------------------------------------------------------------------
// Markit

func TestParseMarkitKeyStatisticsBHP(t *testing.T) {
	rows, err := parseMarkitKeyStatistics(readFixture(t, "markit_key_statistics_BHP.json"))
	require.NoError(t, err)
	require.Len(t, rows, 4)
	// Excel serials: 46203 = 2026-06-30, 45838 = 2025-06-30, 45473 =
	// 2024-06-30, 45107 = 2023-06-30.
	for _, end := range []string{"2023-06-30", "2024-06-30", "2025-06-30", "2026-06-30"} {
		r := find(t, rows, periodAnnual, end)
		assert.Equal(t, "USD", r.Currency)
		assert.Equal(t, sourceMarkit, r.Source)
		assert.Nil(t, r.EPSDiluted, "Markit's EPS is TTM in the trading currency: never stored")
		assert.Nil(t, r.SharesOutstanding, "numOfShares is current, not as at the period end")
	}
	fy26 := find(t, rows, periodAnnual, "2026-06-30")
	assert.Equal(t, 58760000000.0, val(t, fy26.Revenue), "identical to Yahoo's FY26")
	assert.Equal(t, 9833000000.0, val(t, fy26.NetIncome))
}

func TestParseMarkitKeyStatisticsDRO(t *testing.T) {
	rows, err := parseMarkitKeyStatistics(readFixture(t, "markit_key_statistics_DRO.json"))
	require.NoError(t, err)
	require.Len(t, rows, 4)
	fy25 := find(t, rows, periodAnnual, "2025-12-31") // 46022
	assert.Equal(t, "AUD", fy25.Currency)
	assert.Equal(t, 216547000.0, val(t, fy25.Revenue))
	assert.Equal(t, 3521000.0, val(t, fy25.NetIncome))
	find(t, rows, periodAnnual, "2022-12-31") // 44926
}

func TestParseMarkitSentinelsAndGuards(t *testing.T) {
	body := `{"data":{"priceEarningsRatio":-99999.99,"incomeStatement":[
		{"revenue":-32768,"netIncome":1200000,"period":"2026A","fPeriodEndDate":46203,"curCode":"AUD"},
		{"revenue":5000000,"netIncome":-99999.99,"period":"2025A","fPeriodEndDate":45838,"curCode":"AUD"},
		{"revenue":-32768,"netIncome":-32768,"period":"2024A","fPeriodEndDate":45473,"curCode":"AUD"},
		{"revenue":9000000,"netIncome":100,"period":"2027E","fPeriodEndDate":46568,"curCode":"AUD"},
		{"revenue":9000000,"netIncome":100,"period":"2023A","fPeriodEndDate":-32768,"curCode":"AUD"},
		{"revenue":9000000,"netIncome":100,"period":"2022A","fPeriodEndDate":44742,"curCode":""},
		{"revenue":-2420000,"netIncome":-100,"period":"2021A","fPeriodEndDate":44377,"curCode":"aud"}
	]}}`
	rows, err := parseMarkitKeyStatistics([]byte(body))
	require.NoError(t, err)
	require.Len(t, rows, 3, "2024A (all sentinels), 2027E (forecast), bad serial and no-currency rows are dropped")

	fy26 := find(t, rows, periodAnnual, "2026-06-30")
	assert.Nil(t, fy26.Revenue, "-32768 is missing, not a value")
	assert.Equal(t, 1200000.0, val(t, fy26.NetIncome))

	fy25 := find(t, rows, periodAnnual, "2025-06-30")
	assert.Nil(t, fy25.NetIncome, "-99999.99 is not meaningful, not a value")

	fy21 := find(t, rows, periodAnnual, "2021-06-30")
	assert.Equal(t, -2420000.0, val(t, fy21.Revenue), "odd values (CXO's negative revenue) are stored as reported")
	assert.Equal(t, "AUD", fy21.Currency)

	rows, err = parseMarkitKeyStatistics([]byte(`{"data":null}`))
	require.NoError(t, err)
	assert.Empty(t, rows)
}

func TestExcelSerialDate(t *testing.T) {
	n := func(s string) *json.Number { v := json.Number(s); return &v }
	for serial, want := range map[string]string{"46203": "2026-06-30", "46022": "2025-12-31", "45107": "2023-06-30", "46203.75": "2026-06-30"} {
		got, ok := excelSerialDate(n(serial))
		require.True(t, ok, serial)
		assert.Equal(t, want, got.Format("2006-01-02"), serial)
	}
	for _, bad := range []string{"-32768", "0", "99999", "x"} {
		_, ok := excelSerialDate(n(bad))
		assert.False(t, ok, bad)
	}
	_, ok := excelSerialDate(nil)
	assert.False(t, ok)
}

func TestMarkitFetcherHTTP(t *testing.T) {
	var gotReferer, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotReferer, gotPath = r.Header.Get("Referer"), r.URL.Path
		switch {
		case strings.Contains(r.URL.Path, "/ZZZ/"):
			http.NotFound(w, r)
		case strings.Contains(r.URL.Path, "/ERR/"):
			w.WriteHeader(http.StatusBadGateway)
		case strings.Contains(r.URL.Path, "/ZZZQ/"):
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"code":400,"message":"Bad Request: Symbol not found"}}`))
		case strings.Contains(r.URL.Path, "/BADQ/"):
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"code":400,"message":"Bad Request"}}`))
		default:
			_, _ = w.Write(readFixture(t, "markit_key_statistics_DRO.json"))
		}
	}))
	defer srv.Close()
	m := &markitKeyStatistics{client: srv.Client(), baseURL: srv.URL + "/companies/", pace: &pacer{now: time.Now, sleep: sleepCtx}}

	rows, err := m.Fundamentals(context.Background(), "dro")
	require.NoError(t, err)
	assert.Len(t, rows, 4)
	assert.Equal(t, "/companies/DRO/key-statistics", gotPath)
	assert.Equal(t, "https://www.asx.com.au/", gotReferer)

	rows, err = m.Fundamentals(context.Background(), "ZZZ")
	require.NoError(t, err, "404: Markit does not cover the code, answered")
	assert.Empty(t, rows)

	_, err = m.Fundamentals(context.Background(), "ERR")
	require.Error(t, err, "a 502 is a failure, not an empty answer")

	rows, err = m.Fundamentals(context.Background(), "ZZZQ")
	require.NoError(t, err, "Markit's 400 'Symbol not found' is how it says it does not cover a code")
	assert.Empty(t, rows)

	_, err = m.Fundamentals(context.Background(), "BADQ")
	require.Error(t, err, "any other 400 is still a failure")
}
