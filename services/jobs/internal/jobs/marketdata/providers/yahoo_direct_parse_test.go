package providers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func day(s string) time.Time {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return t
}

// bar is one chart row; a nil price is Yahoo's null.
type bar struct {
	ts                   time.Time
	open, high, low, cls *float64
	adj                  *float64
	vol                  *int64
}

func f(v float64) *float64 { return &v }
func n(v int64) *int64     { return &v }

func chartJSON(bars ...bar) []byte {
	var doc yahooChartResponse
	doc.Chart.Result = make([]struct {
		Timestamp  []int64 `json:"timestamp"`
		Indicators struct {
			Quote []struct {
				Open   []*float64 `json:"open"`
				High   []*float64 `json:"high"`
				Low    []*float64 `json:"low"`
				Close  []*float64 `json:"close"`
				Volume []*int64   `json:"volume"`
			} `json:"quote"`
			AdjClose []struct {
				AdjClose []*float64 `json:"adjclose"`
			} `json:"adjclose"`
		} `json:"indicators"`
	}, 1)
	res := &doc.Chart.Result[0]
	res.Indicators.Quote = make([]struct {
		Open   []*float64 `json:"open"`
		High   []*float64 `json:"high"`
		Low    []*float64 `json:"low"`
		Close  []*float64 `json:"close"`
		Volume []*int64   `json:"volume"`
	}, 1)
	res.Indicators.AdjClose = make([]struct {
		AdjClose []*float64 `json:"adjclose"`
	}, 1)
	q := &res.Indicators.Quote[0]
	for _, b := range bars {
		res.Timestamp = append(res.Timestamp, b.ts.Unix())
		q.Open = append(q.Open, b.open)
		q.High = append(q.High, b.high)
		q.Low = append(q.Low, b.low)
		q.Close = append(q.Close, b.cls)
		q.Volume = append(q.Volume, b.vol)
		res.Indicators.AdjClose[0].AdjClose = append(res.Indicators.AdjClose[0].AdjClose, b.adj)
	}
	body, err := json.Marshal(doc)
	if err != nil {
		panic(err)
	}
	return body
}

// full is a complete bar for a session whose open is at ts.
func full(ts time.Time, closePrice float64) bar {
	return bar{ts: ts, open: f(closePrice - 1), high: f(closePrice + 1), low: f(closePrice - 2), cls: f(closePrice), adj: f(closePrice), vol: n(1000)}
}

func TestSessionDateIsTheSydneyDate(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		ts   time.Time
		want string
	}{
		// 10:00 AEDT on Monday 3 Nov 2025 is 23:00Z on SUNDAY 2 Nov: the UTC date
		// is the bug that filed Monday's prices under Sunday.
		{"AEDT open is the previous UTC day", time.Date(2025, 11, 2, 23, 0, 0, 0, time.UTC), "2025-11-03"},
		{"AEST open is the same UTC day", time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC), "2026-09-21"},
		{"a bar stamped at the close", time.Date(2026, 9, 25, 6, 10, 0, 0, time.UTC), "2026-09-25"},
		{"AEDT starts: first Monday of October 2026", time.Date(2026, 10, 4, 23, 0, 0, 0, time.UTC), "2026-10-05"},
	}
	for _, c := range cases {
		assert.Equal(t, c.want, SessionDate(c.ts.Unix()).Format("2006-01-02"), c.name)
		assert.Equal(t, time.UTC, SessionDate(c.ts.Unix()).Location(), c.name)
	}
}

func TestParseYahooChartDatesAEDTSessionsCorrectly(t *testing.T) {
	t.Parallel()
	// Friday 31 Oct and Monday 3 Nov 2025, both in daylight time.
	body := chartJSON(
		full(time.Date(2025, 10, 30, 23, 0, 0, 0, time.UTC), 45),
		full(time.Date(2025, 11, 2, 23, 0, 0, 0, time.UTC), 46),
	)
	recs, err := parseYahooChart(body, "BHP")
	require.NoError(t, err)
	require.Len(t, recs, 2)
	assert.Equal(t, "2025-10-31", recs[0].Date.Format("2006-01-02"))
	assert.Equal(t, time.Friday, recs[0].Date.Weekday())
	assert.Equal(t, "2025-11-03", recs[1].Date.Format("2006-01-02"))
	assert.Equal(t, time.Monday, recs[1].Date.Weekday())
}

func TestParseYahooChartSkipsNullBarsRatherThanStoringZero(t *testing.T) {
	t.Parallel()
	ts := time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC)
	body := chartJSON(
		full(ts, 10),
		bar{ts: ts.AddDate(0, 0, 1)}, // a session with no trade data: every field null
		bar{ts: ts.AddDate(0, 0, 2), cls: f(12)},
	)
	recs, err := parseYahooChart(body, "XYZ")
	require.NoError(t, err)
	require.Len(t, recs, 2, "the all-null session must be dropped, not stored as $0")
	assert.Equal(t, 10.0, recs[0].Close)

	thin := recs[1]
	assert.Equal(t, "2026-09-23", thin.Date.Format("2006-01-02"))
	assert.Equal(t, 12.0, thin.Close)
	assert.Equal(t, 12.0, thin.Open, "a null open falls back to the close")
	assert.Equal(t, 12.0, thin.High)
	assert.Equal(t, 12.0, thin.Low)
	assert.Equal(t, 12.0, thin.AdjustedClose, "a null adjclose falls back to the close")
	assert.Equal(t, int64(0), thin.Volume)
}

func TestParseYahooChartErrors(t *testing.T) {
	t.Parallel()
	_, err := parseYahooChart([]byte(`{"chart":{"result":null,"error":{"code":"Not Found","description":"No data found, symbol may be delisted"}}}`), "OLD")
	assert.True(t, IsNoDataError(err), "Yahoo's Not Found is an answer: %v", err)

	_, err = parseYahooChart([]byte(`{"chart":{"result":null,"error":{"code":"Internal Server Error","description":"boom"}}}`), "BHP")
	require.Error(t, err)
	assert.False(t, IsNoDataError(err), "an upstream error is not 'no data'")

	_, err = parseYahooChart([]byte(`not json`), "BHP")
	require.Error(t, err)
	assert.False(t, IsNoDataError(err))
}

// stubFetcher serves chart documents by the request window.
type stubFetcher struct {
	calls []url.Values
	serve func(q url.Values) ([]byte, error)
}

func (s *stubFetcher) FetchBytes(_ context.Context, pageURL, _ string) ([]byte, string, error) {
	u, err := url.Parse(pageURL)
	if err != nil {
		return nil, "", err
	}
	s.calls = append(s.calls, u.Query())
	body, err := s.serve(u.Query())
	return body, "application/json", err
}

func unixParam(t *testing.T, q url.Values, key string) time.Time {
	t.Helper()
	v, err := strconv.ParseInt(q.Get(key), 10, 64)
	require.NoError(t, err)
	return time.Unix(v, 0).UTC()
}

func TestFetchHistoricalDataFiltersBySessionDate(t *testing.T) {
	t.Parallel()
	stub := &stubFetcher{serve: func(url.Values) ([]byte, error) {
		// Yahoo's padding returns sessions either side of the window.
		return chartJSON(
			full(time.Date(2025, 10, 30, 23, 0, 0, 0, time.UTC), 1), // Fri 31 Oct
			full(time.Date(2025, 11, 2, 23, 0, 0, 0, time.UTC), 2),  // Mon 3 Nov
			full(time.Date(2025, 11, 3, 23, 0, 0, 0, time.UTC), 3),  // Tue 4 Nov
			full(time.Date(2025, 11, 4, 23, 0, 0, 0, time.UTC), 4),  // Wed 5 Nov
		), nil
	}}
	p := &YahooFinanceDirectProvider{fetch: stub}

	recs, err := p.FetchHistoricalData(context.Background(), "BHP", day("2025-11-01"), day("2025-11-04"))
	require.NoError(t, err)
	require.Len(t, recs, 2)
	assert.Equal(t, "2025-11-03", recs[0].Date.Format("2006-01-02"))
	assert.Equal(t, "2025-11-04", recs[1].Date.Format("2006-01-02"))

	require.Len(t, stub.calls, 1)
	q := stub.calls[0]
	assert.Equal(t, "1d", q.Get("interval"))
	// The request is padded so a daylight-time session, stamped the UTC day
	// before, is inside it.
	assert.True(t, unixParam(t, q, "period1").Before(time.Date(2025, 10, 31, 23, 0, 0, 0, time.UTC)))
	assert.True(t, unixParam(t, q, "period2").After(day("2025-11-04")))
}

func TestFetchHistoricalDataClassifiesHTTPFailures(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		status int
		noData bool
	}{
		{404, true},
		{429, false}, // Yahoo refusing us says nothing about the stock
		{500, false},
	} {
		stub := &stubFetcher{serve: func(url.Values) ([]byte, error) {
			return nil, fmt.Errorf("unexpected status: %d", tc.status) // stealthhttp's form
		}}
		p := &YahooFinanceDirectProvider{fetch: stub}
		_, err := p.FetchHistoricalData(context.Background(), "BHP", day("2026-09-21"), day("2026-09-25"))
		require.Error(t, err, "status %d", tc.status)
		assert.Equal(t, tc.noData, IsNoDataError(err), "status %d: %v", tc.status, err)
	}

	stub := &stubFetcher{serve: func(url.Values) ([]byte, error) { return nil, errors.New("connection reset") }}
	p := &YahooFinanceDirectProvider{fetch: stub}
	_, err := p.FetchHistoricalData(context.Background(), "BHP", day("2026-09-21"), day("2026-09-25"))
	require.Error(t, err)
	assert.False(t, IsNoDataError(err), "a transport failure is not 'no data'")
}

func TestFetchHistoricalDataEmptyWindowIsNoData(t *testing.T) {
	t.Parallel()
	// A holiday: the padded request returns the sessions either side, none in it.
	stub := &stubFetcher{serve: func(url.Values) ([]byte, error) {
		// Thursday 2 April's session (10:00 AEDT is 23:00Z on the 1st).
		return chartJSON(full(time.Date(2026, 4, 1, 23, 0, 0, 0, time.UTC), 1)), nil
	}}
	p := &YahooFinanceDirectProvider{fetch: stub}
	_, err := p.FetchHistoricalData(context.Background(), "BHP", day("2026-04-03"), day("2026-04-06"))
	assert.True(t, IsNoDataError(err), "%v", err)
}

func TestFetchHistoricalDataChunksNewestFirstAndStopsWhenEmpty(t *testing.T) {
	t.Parallel()
	const listed = "2023-06-01"
	stub := &stubFetcher{serve: func(q url.Values) ([]byte, error) {
		from := unixParam(t, q, "period1").AddDate(0, 0, 2)
		to := unixParam(t, q, "period2").AddDate(0, 0, -2)
		if to.Before(day(listed)) {
			return chartJSON(), nil // before the listing: no sessions
		}
		if from.Before(day(listed)) {
			from = day(listed)
		}
		// One bar at the start and one at the end of the chunk (AEST opens).
		return chartJSON(full(from, 1), full(to, 2)), nil
	}}
	p := &YahooFinanceDirectProvider{fetch: stub, interval: 20 * time.Millisecond}

	// Ten years, as a stock with no stored prices gets.
	start := time.Now()
	recs, err := p.FetchHistoricalData(context.Background(), "NEW", day("2016-09-25"), day("2026-09-25"))
	require.NoError(t, err)

	// The newest chunk, the one holding the listing date, then one empty chunk
	// ends it: three requests, not five.
	require.Len(t, stub.calls, 3, "chunks fetched: %d", len(stub.calls))
	assert.True(t, unixParam(t, stub.calls[0], "period2").After(day("2026-09-25")), "the newest chunk goes first")
	assert.Equal(t, "2026-09-25", recs[len(recs)-1].Date.Format("2006-01-02"))
	for i := 1; i < len(recs); i++ {
		assert.True(t, recs[i-1].Date.Before(recs[i].Date), "records are sorted and unique")
	}
	assert.GreaterOrEqual(t, time.Since(start), 2*p.GetRateLimit()-100*time.Millisecond, "chunks are paced")
}

func TestFetchHistoricalDataUnknownCodeCostsOneRequest(t *testing.T) {
	t.Parallel()
	stub := &stubFetcher{serve: func(url.Values) ([]byte, error) {
		return nil, fmt.Errorf("unexpected status: %d", 404)
	}}
	p := &YahooFinanceDirectProvider{fetch: stub}
	_, err := p.FetchHistoricalData(context.Background(), "ZZZZ", day("2016-09-25"), day("2026-09-25"))
	assert.True(t, IsNoDataError(err))
	assert.Len(t, stub.calls, 1, "ten years for a code Yahoo does not carry must not cost five requests")
}

func TestFetchHistoricalDataKeepsSuffix(t *testing.T) {
	t.Parallel()
	var got string
	stub := &stubFetcher{serve: func(url.Values) ([]byte, error) {
		return chartJSON(full(time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC), 1)), nil
	}}
	p := &YahooFinanceDirectProvider{fetch: fetcherFunc(func(ctx context.Context, u, accept string) ([]byte, string, error) {
		got = u
		return stub.FetchBytes(ctx, u, accept)
	})}
	_, err := p.FetchHistoricalData(context.Background(), "BHP", day("2026-09-21"), day("2026-09-21"))
	require.NoError(t, err)
	assert.Contains(t, got, "/v8/finance/chart/BHP.AX?")

	_, err = p.FetchHistoricalData(context.Background(), "BHP.AX", day("2026-09-21"), day("2026-09-21"))
	require.NoError(t, err)
	assert.Contains(t, got, "/v8/finance/chart/BHP.AX?", fmt.Sprintf("no double suffix: %s", got))
}

type fetcherFunc func(ctx context.Context, u, accept string) ([]byte, string, error)

func (f fetcherFunc) FetchBytes(ctx context.Context, u, accept string) ([]byte, string, error) {
	return f(ctx, u, accept)
}
