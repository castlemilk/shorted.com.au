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

// The fixtures are the raw payloads the 2026-09-27 source probe captured
// (docs/plans/stock-picker.md §2.7): Yahoo fundamentals-timeseries for BHP.AX
// (reports in USD, June year end) and DRO.AX (AUD, December year end, no
// operating cash flow series), and Markit key statistics for both. The Yahoo
// payloads were requested with a WIDER type list than production (39 types,
// including the empty quarterly series), which also proves unrequested series
// are ignored.

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

func TestParseYahooTimeseriesBHP(t *testing.T) {
	rows, err := parseYahooTimeseries(readFixture(t, "yahoo_timeseries_BHP.json"))
	require.NoError(t, err)

	// Four fiscal years of annual rows; TTM EPS at every half-year end (six
	// points), with revenue / profit / cash flow only on the latest.
	assert.Equal(t, 4, countType(rows, periodAnnual))
	assert.Equal(t, 6, countType(rows, periodTTM))

	fy26 := find(t, rows, periodAnnual, "2026-06-30")
	assert.Equal(t, "USD", fy26.Currency, "values stay in the REPORTING currency")
	assert.Equal(t, sourceYahoo, fy26.Source)
	assert.Equal(t, 58760000000.0, val(t, fy26.Revenue))
	assert.Equal(t, 9833000000.0, val(t, fy26.NetIncome))
	assert.Equal(t, 1.932, val(t, fy26.EPSDiluted))
	assert.Equal(t, 1.936, val(t, fy26.EPSBasic))
	assert.Equal(t, 21778000000.0, val(t, fy26.OperatingCashFlow))
	assert.Equal(t, 11929000000.0, val(t, fy26.FreeCashFlow))
	assert.Equal(t, 5080163098.0, val(t, fy26.SharesOutstanding))
	assert.Nil(t, fy26.FiscalYear, "fiscal_year is derived later, never parsed")

	fy25 := find(t, rows, periodAnnual, "2025-06-30")
	assert.Equal(t, 51262000000.0, val(t, fy25.Revenue))
	assert.Equal(t, 1.774, val(t, fy25.EPSDiluted))

	ttmH1 := find(t, rows, periodTTM, "2025-12-31")
	assert.Equal(t, 2.013, val(t, ttmH1.EPSDiluted))
	assert.Nil(t, ttmH1.Revenue, "Yahoo keeps TTM revenue only at the latest point")
	assert.Nil(t, ttmH1.EPSBasic, "trailingBasicEPS is not requested, so never stored")

	ttmLatest := find(t, rows, periodTTM, "2026-06-30")
	assert.Equal(t, 58760000000.0, val(t, ttmLatest.Revenue))
	assert.Equal(t, 9833000000.0, val(t, ttmLatest.NetIncome))
	assert.Equal(t, 21778000000.0, val(t, ttmLatest.OperatingCashFlow))
	assert.Equal(t, 11929000000.0, val(t, ttmLatest.FreeCashFlow))
	assert.Nil(t, ttmLatest.SharesOutstanding)
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
			{"meta":{"type":["annualEBITDA"]},"annualEBITDA":[{"asOfDate":"2025-06-30","periodType":"12M","currencyCode":"AUD","reportedValue":{"raw":5}}]},
			{"meta":{"type":["quarterlyTotalRevenue"]}}
		],"error":null}}`
		rows, err := parseYahooTimeseries([]byte(body))
		require.NoError(t, err)
		require.Len(t, rows, 1)
		assert.Equal(t, 100.0, val(t, rows[0].Revenue))
	})

	t.Run("a point whose periodType does not match its series is refused", func(t *testing.T) {
		body := `{"timeseries":{"result":[
			{"meta":{"type":["annualTotalRevenue"]},"annualTotalRevenue":[{"asOfDate":"2025-12-31","periodType":"3M","currencyCode":"AUD","reportedValue":{"raw":100}}]}
		]}}`
		rows, err := parseYahooTimeseries([]byte(body))
		require.NoError(t, err)
		assert.Empty(t, rows, "a half-year figure must never be filed as a full year")
	})

	t.Run("a row whose series disagree on currency is dropped", func(t *testing.T) {
		body := `{"timeseries":{"result":[
			{"meta":{"type":["annualTotalRevenue"]},"annualTotalRevenue":[{"asOfDate":"2025-06-30","periodType":"12M","currencyCode":"USD","reportedValue":{"raw":100}}]},
			{"meta":{"type":["annualDilutedEPS"]},"annualDilutedEPS":[{"asOfDate":"2025-06-30","periodType":"12M","currencyCode":"AUD","reportedValue":{"raw":1.5}}]},
			{"meta":{"type":["annualNetIncomeCommonStockholders"]},"annualNetIncomeCommonStockholders":[{"asOfDate":"2024-06-30","periodType":"12M","currencyCode":"USD","reportedValue":{"raw":7}}]}
		]}}`
		rows, err := parseYahooTimeseries([]byte(body))
		require.NoError(t, err)
		require.Len(t, rows, 1)
		assert.Equal(t, date("2024-06-30"), rows[0].PeriodEnd)
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

func TestYahooTimeseriesURL(t *testing.T) {
	now := time.Date(2026, 9, 27, 0, 0, 0, 0, time.UTC)
	u := yahooTimeseriesURL("bhp", now)
	want := "https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/BHP.AX" +
		"?type=annualTotalRevenue,annualNetIncomeCommonStockholders,annualDilutedEPS,annualBasicEPS," +
		"annualOperatingCashFlow,annualFreeCashFlow,annualOrdinarySharesNumber," +
		"trailingTotalRevenue,trailingNetIncomeCommonStockholders,trailingDilutedEPS," +
		"trailingOperatingCashFlow,trailingFreeCashFlow" +
		"&period1=1262304000&period2=1822003200"
	assert.Equal(t, want, u, "the plan's (§2.7) type list, in order, period2 a year ahead")
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

	stub := &stubBytes{body: readFixture(t, "yahoo_timeseries_BHP.json")}
	y = &yahooTimeseries{fetch: stub, pace: noPace, now: now}
	rows, err = y.Fundamentals(context.Background(), "BHP")
	require.NoError(t, err)
	assert.Len(t, rows, 10)
	require.Len(t, stub.urls, 1)
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
