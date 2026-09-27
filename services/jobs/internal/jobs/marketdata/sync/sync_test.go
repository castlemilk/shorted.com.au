package sync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/providers"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/stocklist"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeProvider answers from fn and records every window it was asked for.
type fakeProvider struct {
	name     string
	interval time.Duration
	calls    [][2]time.Time
	fn       func(symbol string, from, to time.Time) ([]providers.PriceRecord, error)
}

func (f *fakeProvider) Name() string                { return f.name }
func (f *fakeProvider) GetRateLimit() time.Duration { return f.interval }
func (f *fakeProvider) FetchHistoricalData(_ context.Context, symbol string, from, to time.Time) ([]providers.PriceRecord, error) {
	f.calls = append(f.calls, [2]time.Time{from, to})
	return f.fn(symbol, from, to)
}

// weekdaySessions answers with one session per weekday in the window.
func weekdaySessions(symbol string, from, to time.Time) ([]providers.PriceRecord, error) {
	var out []providers.PriceRecord
	for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
		if d.Weekday() != time.Saturday && d.Weekday() != time.Sunday {
			out = append(out, providers.PriceRecord{StockCode: symbol, Date: d, Open: 1, High: 1, Low: 1, Close: 1, AdjustedClose: 1})
		}
	}
	if len(out) == 0 {
		return nil, providers.NewNoDataError(symbol, "no sessions")
	}
	return out, nil
}

func noData(symbol string, _, _ time.Time) ([]providers.PriceRecord, error) {
	return nil, providers.NewNoDataError(symbol, "nothing")
}

func refused(string, time.Time, time.Time) ([]providers.PriceRecord, error) {
	return nil, errors.New("unexpected status: 429")
}

func manager(ps ...providers.DataProvider) *SyncManager {
	return &SyncManager{providers: ps, now: time.Now, nextCall: map[string]time.Time{}}
}

func TestSyncStockWindows(t *testing.T) {
	t.Parallel()
	lastClosed := mustDate("2026-09-25") // a Friday
	dry := RunOptions{DryRun: true}

	t.Run("already holding the last closed session: no request", func(t *testing.T) {
		p := &fakeProvider{name: "yahoo", fn: weekdaySessions}
		res, err := manager(p).syncStock(context.Background(), "BHP", lastClosed, lastClosed, dry)
		require.NoError(t, err)
		assert.True(t, res.upToDate)
		assert.Empty(t, p.calls, "an up-to-date stock must cost no request")
	})

	t.Run("five weeks behind: one request for the whole gap", func(t *testing.T) {
		p := &fakeProvider{name: "yahoo", fn: weekdaySessions}
		res, err := manager(p).syncStock(context.Background(), "BHP", mustDate("2026-08-20"), lastClosed, dry)
		require.NoError(t, err)
		require.Len(t, p.calls, 1)
		assert.Equal(t, "2026-08-21", p.calls[0][0].Format("2006-01-02"))
		assert.Equal(t, "2026-09-25", p.calls[0][1].Format("2006-01-02"))
		assert.Equal(t, 26, res.fetched)
		assert.Zero(t, res.written, "a dry run writes nothing")
	})

	t.Run("one day behind asks for exactly that day", func(t *testing.T) {
		// The old sweep clamped this window to end yesterday, so a stock one day
		// behind fetched nothing new and only caught up every other day.
		p := &fakeProvider{name: "yahoo", fn: weekdaySessions}
		res, err := manager(p).syncStock(context.Background(), "BHP", mustDate("2026-09-24"), lastClosed, dry)
		require.NoError(t, err)
		require.Len(t, p.calls, 1)
		assert.Equal(t, [2]time.Time{lastClosed, lastClosed}, p.calls[0])
		assert.Equal(t, 1, res.fetched)
	})

	t.Run("nothing stored: ten years", func(t *testing.T) {
		p := &fakeProvider{name: "yahoo", fn: weekdaySessions}
		_, err := manager(p).syncStock(context.Background(), "NEW", time.Time{}, lastClosed, dry)
		require.NoError(t, err)
		require.Len(t, p.calls, 1)
		assert.Equal(t, "2016-09-25", p.calls[0][0].Format("2006-01-02"))
	})

	t.Run("-from overrides what is stored", func(t *testing.T) {
		// Up to date, but -from re-fetches anyway. The provider answers "no data"
		// so the run stops before the compare, which reads the database (the
		// Postgres test covers that).
		p := &fakeProvider{name: "yahoo", fn: noData}
		opts := RunOptions{DryRun: true, From: mustDate("2025-10-01")}
		_, err := manager(p).syncStock(context.Background(), "BHP", lastClosed, lastClosed, opts)
		assert.True(t, providers.IsNoDataError(err))
		require.Len(t, p.calls, 1)
		assert.Equal(t, "2025-10-01", p.calls[0][0].Format("2006-01-02"))
	})

	t.Run("sessions outside the window or on a weekend are dropped", func(t *testing.T) {
		p := &fakeProvider{name: "yahoo", fn: func(symbol string, from, to time.Time) ([]providers.PriceRecord, error) {
			return []providers.PriceRecord{
				{StockCode: symbol, Date: mustDate("2026-09-20"), Close: 1}, // before the window
				{StockCode: symbol, Date: mustDate("2026-09-27"), Close: 1}, // a Sunday
			}, nil
		}}
		_, err := manager(p).syncStock(context.Background(), "BHP", mustDate("2026-09-24"), lastClosed, dry)
		assert.True(t, providers.IsNoDataError(err), "%v", err)
	})
}

func TestFetchChain(t *testing.T) {
	t.Parallel()
	from, to := mustDate("2026-09-21"), mustDate("2026-09-25")

	t.Run("no data from the primary is an answer: the fallback is not asked", func(t *testing.T) {
		// #583: on an ASX holiday the chain fell through to Alpha Vantage, which
		// answered with the US security of the same name.
		yahoo := &fakeProvider{name: "yahoo", fn: noData}
		av := &fakeProvider{name: "av", fn: weekdaySessions}
		_, err := manager(yahoo, av).fetch(context.Background(), "AMD", from, to)
		assert.True(t, providers.IsNoDataError(err))
		assert.Empty(t, av.calls)
	})

	t.Run("a refused primary falls back", func(t *testing.T) {
		yahoo := &fakeProvider{name: "yahoo", fn: refused}
		av := &fakeProvider{name: "av", fn: weekdaySessions}
		recs, err := manager(yahoo, av).fetch(context.Background(), "BHP", from, to)
		require.NoError(t, err)
		assert.Len(t, recs, 5)
		assert.Len(t, av.calls, 1)
	})

	t.Run("fallback 'no data' after a refused primary is not a no-data answer", func(t *testing.T) {
		// Otherwise a Yahoo outage plus Alpha Vantage's wrong-security refusal
		// would count a live stock towards a 30-day block.
		yahoo := &fakeProvider{name: "yahoo", fn: refused}
		av := &fakeProvider{name: "av", fn: noData}
		_, err := manager(yahoo, av).fetch(context.Background(), "BHP", from, to)
		require.Error(t, err)
		assert.False(t, providers.IsNoDataError(err), "%v", err)
		assert.Contains(t, err.Error(), "429")
	})

	t.Run("every provider refusing is a failure", func(t *testing.T) {
		yahoo := &fakeProvider{name: "yahoo", fn: refused}
		av := &fakeProvider{name: "av", fn: refused}
		_, err := manager(yahoo, av).fetch(context.Background(), "BHP", from, to)
		require.Error(t, err)
		assert.False(t, providers.IsNoDataError(err))
	})

	t.Run("no providers", func(t *testing.T) {
		_, err := manager().fetch(context.Background(), "BHP", from, to)
		require.Error(t, err)
		assert.False(t, providers.IsNoDataError(err))
	})
}

func TestPaceSpacesRequestsToOneProvider(t *testing.T) {
	t.Parallel()
	p := &fakeProvider{name: "yahoo", interval: 40 * time.Millisecond, fn: weekdaySessions}
	other := &fakeProvider{name: "av", interval: time.Hour, fn: weekdaySessions}
	m := manager(p, other)
	ctx := context.Background()

	start := time.Now()
	for i := 0; i < 3; i++ {
		require.NoError(t, m.pace(ctx, p))
	}
	assert.GreaterOrEqual(t, time.Since(start), 80*time.Millisecond, "three requests span two intervals")

	// Another provider's clock is its own.
	start = time.Now()
	require.NoError(t, m.pace(ctx, other))
	assert.Less(t, time.Since(start), 20*time.Millisecond)

	// A cancelled context stops the wait.
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	assert.ErrorIs(t, m.pace(cctx, other), context.Canceled)
}

func TestStalestFirst(t *testing.T) {
	t.Parallel()
	stocks := []stocklist.Stock{
		{Code: "TOP1", IsPriority: true},
		{Code: "TOP2", IsPriority: true},
		{Code: "NEW"},
		{Code: "OLD"},
		{Code: "MID"},
		{Code: "CUR"},
	}
	latest := map[string]time.Time{
		"TOP1": mustDate("2026-09-24"),
		"TOP2": mustDate("2026-09-24"),
		"OLD":  mustDate("2026-08-20"),
		"MID":  mustDate("2026-09-01"),
		"CUR":  mustDate("2026-09-24"),
	}
	var got []string
	for _, s := range stalestFirst(stocks, latest) {
		got = append(got, s.Code)
	}
	// Stalest first; ties keep the priority order; nothing stored goes last.
	assert.Equal(t, []string{"OLD", "MID", "TOP1", "TOP2", "CUR", "NEW"}, got)
	assert.Equal(t, "TOP1", stocks[0].Code, "the input is not reordered")
}

func TestRecentlyPriced(t *testing.T) {
	t.Parallel()
	lastClosed := mustDate("2026-09-25")
	latest := map[string]time.Time{
		"BHP":  mustDate("2026-09-25"),
		"VAS":  mustDate("2026-08-21"), // five weeks behind: the outage it must survive
		"EDGE": mustDate("2026-06-27"), // 90 days before the newest
		"GONE": mustDate("2026-06-26"), // 91: delisted, as far as the sweep knows
	}
	assert.Equal(t, []string{"BHP", "EDGE", "VAS"}, recentlyPriced(latest, lastClosed))

	// The window runs from the newest stored session, not from today: after a
	// long outage every code is equally behind, and none of them ages out.
	assert.Equal(t, []string{"BHP", "EDGE", "VAS"}, recentlyPriced(latest, mustDate("2027-03-01")))

	// A stray future-dated row cannot drag the window past every real code.
	latest["BAD"] = mustDate("2031-01-01")
	assert.Equal(t, []string{"BAD", "BHP", "EDGE", "VAS"}, recentlyPriced(latest, lastClosed))

	assert.Empty(t, recentlyPriced(nil, lastClosed))
}

func TestSessionsIn(t *testing.T) {
	t.Parallel()
	recs := []providers.PriceRecord{
		{Date: mustDate("2026-09-23"), Close: 2},
		{Date: time.Date(2026, 9, 22, 0, 0, 0, 0, time.UTC), Close: 1},
		{Date: mustDate("2026-09-23"), Close: 3}, // a later duplicate wins
		{Date: mustDate("2026-09-26"), Close: 9}, // Saturday
		{Date: mustDate("2026-09-28"), Close: 9}, // after the window
	}
	got := sessionsIn("BHP", recs, mustDate("2026-09-21"), mustDate("2026-09-25"))
	require.Len(t, got, 2)
	assert.Equal(t, "2026-09-22", got[0].Date.Format("2006-01-02"))
	assert.Equal(t, "2026-09-23", got[1].Date.Format("2006-01-02"))
	assert.Equal(t, 3.0, got[1].Close)
}

func TestComparePrices(t *testing.T) {
	t.Parallel()
	c := func(v float64) storedSession { return storedSession{close: &v} }
	fetched := []providers.PriceRecord{
		{Date: mustDate("2025-10-27"), Close: 43.54},  // stored holds Tuesday's 43.34: shifted
		{Date: mustDate("2025-10-28"), Close: 43.34},  // equal
		{Date: mustDate("2025-10-29"), Close: 0.2349}, // equal once stored to two decimals
		{Date: mustDate("2025-10-31"), Close: 43.45},  // stored holds NYSE BHP, 57.05
		{Date: mustDate("2025-11-03"), Close: 43.37},  // missing
		{Date: mustDate("2025-11-04"), Close: 42.54},  // stored close is NULL
	}
	stored := map[time.Time]storedSession{
		mustDate("2025-10-27"): c(43.34),
		mustDate("2025-10-28"): c(43.34),
		mustDate("2025-10-29"): c(0.23),
		mustDate("2025-10-31"): c(57.05),
		mustDate("2025-11-02"): c(43.37), // Sunday: Monday's session a day early
		mustDate("2025-11-04"): {},
	}
	d := comparePrices("BHP", fetched, stored)
	assert.Equal(t, 1, d.new)
	require.Len(t, d.changes, 3)
	byDate := map[string]PriceChange{}
	for _, ch := range d.changes {
		byDate[ch.Date] = ch
	}
	assert.InDelta(t, 57.05/43.45, byDate["2025-10-31"].Ratio, 1e-9)
	assert.Equal(t, 43.34, byDate["2025-10-27"].Stored)
	assert.Equal(t, ratioNoPrice, byDate["2025-11-04"].Ratio, "a NULL or $0 stored close is flagged first")
	require.Len(t, d.storedOnly, 1)
	assert.Equal(t, StoredRow{Code: "BHP", Date: "2025-11-02", Close: 43.37}, d.storedOnly[0])

	var r RunReport
	r.addDiff(d)
	assert.Equal(t, 1, r.New)
	assert.Equal(t, 3, r.Changed)
	assert.Equal(t, 1, r.ChangedTwofold, "only the NULL close is off by 2x or more")
	assert.Equal(t, 1, r.StoredOnly)
	assert.Equal(t, 1, r.StoredOnlyWeekend)
	assert.Equal(t, map[string]int{"BHP": 1}, r.StoredOnlyByCode)
	assert.Equal(t, ratioNoPrice, r.Changes[0].Ratio, "largest ratio first")

	// The report is stored as JSON, which has no infinity.
	_, err := json.Marshal(r)
	require.NoError(t, err)
}

func TestReportListsAreCapped(t *testing.T) {
	t.Parallel()
	var r RunReport
	for i := 0; i < reportListCap+50; i++ {
		v := float64(i + 1)
		d := comparePrices(fmt.Sprintf("C%03d", i),
			[]providers.PriceRecord{{Date: mustDate("2026-09-21"), Close: 2 * v}},
			map[time.Time]storedSession{
				mustDate("2026-09-21"): {close: &v},
				mustDate("2026-09-19"): {close: &v},
			})
		r.addDiff(d)
		r.FailedCodes = appendCapped(r.FailedCodes, "X")
	}
	assert.Equal(t, reportListCap+50, r.Changed, "counts stay exact")
	assert.Len(t, r.Changes, reportListCap)
	assert.Len(t, r.StoredOnlyRows, reportListCap)
	assert.Equal(t, reportListCap+50, r.StoredOnly)
	assert.Len(t, r.StoredOnlyByCode, reportListCap+50)
	assert.Len(t, r.FailedCodes, reportListCap)
}

func TestPublishNeedsAnExecution(t *testing.T) {
	t.Setenv("CLOUD_RUN_EXECUTION", "")
	r := &RunReport{}
	r.publish(context.Background(), nil, "bucket") // no client: a no-op, not a panic
	assert.Empty(t, r.Execution)
}

// TestPriceSyncWorkflowReadsTheReport pins the contract with
// .github/workflows/price-sync.yml, which is the only way CI sees a run's
// outcome (it cannot read Cloud Logging).
func TestPriceSyncWorkflowReadsTheReport(t *testing.T) {
	t.Parallel()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "..", ".github", "workflows", "price-sync.yml"))
	require.NoError(t, err)
	wf := string(b)
	for _, want := range []string{
		`gs://$BUCKET/` + ReportObjectPrefix + `$EXECUTION.json`,
		"JOB: shorted-price-sync",
		`args="market-data@sync"`,
		`--args="^@^$args"`,
		"@-dry-run", "@-from@", "@-codes@",
		// Started detached, so a run that outlasts the wait keeps its name and
		// can be reported later without starting another.
		"--async", "report_only", "--task-timeout", "executions describe",
	} {
		assert.Contains(t, wf, want)
	}
	// Every field the summary reads is one the report writes.
	for _, field := range []string{"execution", "dry_run", "from", "codes", "last_session", "duration", "error",
		"stocks", "beyond_listing", "synced", "up_to_date", "no_session", "no_data", "failed", "blocked",
		"sessions_fetched", "sessions_written", "sessions_new", "sessions_changed", "sessions_changed_twofold",
		"stored_only", "stored_only_weekend", "stored_only_by_code", "changes", "stored_only_rows",
		"failed_codes", "no_data_codes"} {
		assert.Contains(t, wf, "."+field, "the workflow reads .%s", field)
	}
	report, err := json.Marshal(RunReport{
		Execution: "x", From: "2025-10-01", Codes: []string{"BHP"}, Error: "e",
		Changes: []PriceChange{{}}, StoredOnlyRows: []StoredRow{{}}, StoredOnlyByCode: map[string]int{"BHP": 1},
		FailedCodes: []string{"A"}, NoDataCodes: []string{"B"},
		New: 1, Changed: 1, ChangedTwofold: 1, StoredOnly: 1, StoredOnlyWeekend: 1,
	})
	require.NoError(t, err)
	var keys map[string]any
	require.NoError(t, json.Unmarshal(report, &keys))
	for _, field := range []string{"execution", "stocks", "beyond_listing", "sessions_new", "stored_only_weekend", "changes", "no_data_codes"} {
		assert.Contains(t, keys, field)
	}
}
