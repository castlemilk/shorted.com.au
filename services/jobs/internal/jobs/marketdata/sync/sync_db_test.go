package sync

// The sweep against a real Postgres.
//
// The statements this package runs (the unnest upsert, the coverage view's
// concurrent refresh, the checkpoint and failure-tracker writes) are only
// proven by running them, and prod runs them through the transaction pooler in
// the simple protocol, where arrays travel as literals. So this builds a
// throwaway schema from the migrations themselves and drives RunWith end to
// end, with a fake provider standing in for Yahoo.
//
// PRICE_TEST_DATABASE_URL only, never DATABASE_URL: services/.env holds the
// production URL, and this test writes.

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/config"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/providers"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// priceMigrations shape the tables the sweep touches, in apply order. For
// 000073 only the part before newsIndexMarker is applied: the rest indexes and
// refreshes tables this schema does not have.
var priceMigrations = []string{
	"000002_stock_prices.up.sql",
	"000006_add_sync_status.up.sql",
	"000008_add_sync_checkpoint.up.sql",
	"000013_add_priority_checkpoint.up.sql",
	"000030_stock_sync_failures.up.sql",
	"000039_add_stocks_skipped.up.sql",
	"000073_stock_price_coverage_and_news_image_index.up.sql",
}

const newsIndexMarker = "-- Cover the news image backfill"

func newPriceDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("PRICE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set PRICE_TEST_DATABASE_URL (a local database, never prod) to run the price sweep against Postgres")
	}
	if strings.Contains(url, "supabase") || strings.Contains(url, "pooler") {
		t.Fatalf("PRICE_TEST_DATABASE_URL points at a hosted database; this test writes")
	}
	ctx := context.Background()

	admin, err := pgxpool.New(ctx, url)
	require.NoError(t, err)
	defer admin.Close()
	schema := fmt.Sprintf("price_sync_test_%d", time.Now().UnixNano())
	_, err = admin.Exec(ctx, `CREATE SCHEMA `+schema)
	require.NoError(t, err)

	_, thisFile, _, _ := runtime.Caller(0)
	dir := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "..", "..", "migrations")
	conn, err := admin.Acquire(ctx)
	require.NoError(t, err)
	_, err = conn.Exec(ctx, `SET search_path = `+schema)
	require.NoError(t, err)
	for _, m := range priceMigrations {
		body, err := os.ReadFile(filepath.Join(dir, m))
		require.NoError(t, err)
		sql := string(body)
		if i := strings.Index(sql, newsIndexMarker); i >= 0 {
			sql = sql[:i]
		}
		_, err = conn.Exec(ctx, sql)
		require.NoError(t, err, "apply %s", m)
	}
	conn.Release()

	cfg, err := pgxpool.ParseConfig(url)
	require.NoError(t, err)
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	// As prod: the Supabase transaction pooler needs the simple protocol.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)

	t.Cleanup(func() {
		pool.Close()
		cleanup, err := pgxpool.New(ctx, url)
		if err != nil {
			t.Logf("could not reopen to drop %s: %v", schema, err)
			return
		}
		defer cleanup.Close()
		if _, err := cleanup.Exec(ctx, `DROP SCHEMA IF EXISTS `+schema+` CASCADE`); err != nil {
			t.Errorf("schema %s left behind: %v", schema, err)
		}
	})
	return pool
}

// pricedByCode answers with one session per weekday, priced by code, except
// for the codes in empty, which have no sessions at all.
func pricedByCode(empty ...string) func(string, time.Time, time.Time) ([]providers.PriceRecord, error) {
	return func(symbol string, from, to time.Time) ([]providers.PriceRecord, error) {
		for _, e := range empty {
			if e == symbol {
				return nil, providers.NewNoDataError(symbol, "no sessions")
			}
		}
		price := map[string]float64{"BHP": 43.45, "NEW": 1.5}[symbol]
		var out []providers.PriceRecord
		for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
			if d.Weekday() == time.Saturday || d.Weekday() == time.Sunday {
				continue
			}
			out = append(out, providers.PriceRecord{
				StockCode: symbol, Date: d, Open: price, High: price + 0.5, Low: price - 0.5,
				Close: price, AdjustedClose: price, Volume: 1000,
			})
		}
		if len(out) == 0 {
			return nil, providers.NewNoDataError(symbol, "no sessions")
		}
		return out, nil
	}
}

func TestSweepAgainstPostgres(t *testing.T) {
	pool := newPriceDB(t)
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err)
	}
	closeOn := func(code, date string) (float64, bool) {
		t.Helper()
		var c float64
		err := pool.QueryRow(ctx, `SELECT close::float8 FROM stock_prices WHERE stock_code = $1 AND date = $2::date`, code, date).Scan(&c)
		if err == pgx.ErrNoRows {
			return 0, false
		}
		require.NoError(t, err)
		return c, true
	}
	count := func(sql string, args ...any) int {
		t.Helper()
		var n int
		require.NoError(t, pool.QueryRow(ctx, sql, args...).Scan(&n))
		return n
	}

	// BHP: a week behind, carrying the two defects the old writer left, a
	// Sunday-dated row and NYSE's price on a Friday.
	exec(`INSERT INTO stock_prices (stock_code, date, open, high, low, close, adjusted_close, volume) VALUES
		('BHP', '2025-10-30', 43.45, 43.9, 43.1, 43.45, 43.45, 7562306),
		('BHP', '2025-10-31', 57.05, 57.2, 56.4, 57.05, 57.05, 2611404),
		('BHP', '2025-11-02', 43.37, 43.4, 43.0, 43.37, 43.37, 5473353),
		('BHP', '2026-09-17', 43.00, 43.5, 42.5, 43.00, 43.00, 1000),
		('CBA', '2026-09-25', 150.0, 151, 149, 150.0, 150.0, 1000),
		('HOL', '2026-09-24', 2.0, 2, 2, 2.0, 2.0, 1000),
		('OLD', '2026-01-02', 0.5, 0.5, 0.5, 0.5, 0.5, 1000)`)
	// The coverage view as a run that stopped early leaves it: behind the table.
	// Read as it stands, it would send BHP back for the 18th it already has.
	exec(`REFRESH MATERIALIZED VIEW mv_stock_price_coverage`)
	exec(`INSERT INTO stock_prices (stock_code, date, close) VALUES ('BHP', '2026-09-18', 43.0)`)

	provider := &fakeProvider{name: "yahoo", fn: pricedByCode("OLD", "HOL")}
	m := NewSyncManager(pool, nil, &config.Config{PriorityStockCount: 10}, []providers.DataProvider{provider})
	// Friday 25 September 2026, 20:00 in Sydney: the scheduled run.
	m.now = func() time.Time { return time.Date(2026, 9, 25, 10, 0, 0, 0, time.UTC) }
	codes := []string{"CBA", "NEW", "BHP", "HOL", "OLD"}

	report, err := m.RunWith(ctx, RunOptions{Codes: codes})
	require.NoError(t, err)

	// Stalest first, nothing-stored last, and nothing asked of the stock that is current.
	var asked []string
	for _, c := range provider.calls {
		asked = append(asked, c[0].Format("2006-01-02"))
	}
	assert.Equal(t, []string{"2026-01-03", "2026-09-19", "2026-09-25", "2016-09-25"}, asked,
		"OLD, then BHP from the day after its real latest (the view was refreshed first), then HOL, then NEW; CBA is current and costs nothing")

	assert.Equal(t, 5, report.Stocks)
	assert.Equal(t, 2, report.Synced)
	assert.Equal(t, 1, report.UpToDate)
	assert.Equal(t, 1, report.NoSession, "HOL: one weekday with no session is a holiday, not a strike")
	assert.Equal(t, 1, report.NoData, "OLD: nine months with no session is")
	assert.Equal(t, []string{"OLD"}, report.NoDataCodes)
	assert.Zero(t, report.Failed)

	// BHP gained exactly the week it lacked, through the batched upsert.
	assert.Equal(t, 5, count(`SELECT count(*) FROM stock_prices WHERE stock_code = 'BHP' AND date BETWEEN '2026-09-21' AND '2026-09-25'`))
	c, ok := closeOn("BHP", "2026-09-25")
	require.True(t, ok)
	assert.Equal(t, 43.45, c)
	// NEW got its ten years; a run writes no weekend dates.
	assert.Greater(t, count(`SELECT count(*) FROM stock_prices WHERE stock_code = 'NEW'`), 2500)
	assert.Zero(t, count(`SELECT count(*) FROM stock_prices WHERE stock_code = 'NEW' AND extract(isodow FROM date) > 5`))
	assert.Equal(t, 5+count(`SELECT count(*) FROM stock_prices WHERE stock_code = 'NEW'`), report.Written)

	// Failure tracking: a strike for OLD only, a reset for the synced stocks.
	// (Under the simple protocol this insert used to fail on every call.)
	assert.Equal(t, 1, count(`SELECT consecutive_failures FROM stock_sync_failures WHERE stock_code = 'OLD'`))
	assert.Zero(t, count(`SELECT count(*) FROM stock_sync_failures WHERE stock_code = 'HOL'`))
	assert.Zero(t, count(`SELECT consecutive_failures FROM stock_sync_failures WHERE stock_code = 'BHP'`))

	// The view is current after the run.
	var latest time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT latest_date FROM mv_stock_price_coverage WHERE stock_code = 'BHP'`).Scan(&latest))
	assert.Equal(t, "2026-09-25", latest.Format("2006-01-02"))
	assert.Equal(t, 1, count(`SELECT count(*) FROM sync_status WHERE status = 'completed'`))

	// A second run the same evening has nothing to ask for.
	provider.calls = nil
	report, err = m.RunWith(ctx, RunOptions{Codes: []string{"BHP", "CBA", "NEW"}})
	require.NoError(t, err)
	assert.Empty(t, provider.calls)
	assert.Equal(t, 3, report.UpToDate)

	// A dry run re-fetching from before the defects reports them and writes nothing.
	from := mustDate("2025-10-27")
	report, err = m.RunWith(ctx, RunOptions{Codes: []string{"BHP"}, From: from, DryRun: true})
	require.NoError(t, err)
	assert.Zero(t, report.Written)
	c, _ = closeOn("BHP", "2025-10-31")
	assert.Equal(t, 57.05, c, "a dry run writes nothing")
	assert.Equal(t, 1, report.StoredOnlyWeekend, "the Sunday row")
	assert.Equal(t, []StoredRow{{Code: "BHP", Date: "2025-11-02", Close: 43.37}}, report.StoredOnlyRows)
	require.NotEmpty(t, report.Changes)
	var friday *PriceChange
	for i := range report.Changes {
		if report.Changes[i].Date == "2025-10-31" {
			friday = &report.Changes[i]
		}
	}
	require.NotNil(t, friday, "the NYSE Friday is reported: %+v", report.Changes)
	assert.Equal(t, 57.05, friday.Stored)
	assert.Equal(t, 43.45, friday.Provider)
	assert.Equal(t, 2, count(`SELECT count(*) FROM sync_status`), "two live runs, and a dry run leaves no checkpoint")

	// The same run for real overwrites the Friday and keeps the Sunday row: the
	// sweep never deletes.
	report, err = m.RunWith(ctx, RunOptions{Codes: []string{"BHP"}, From: from})
	require.NoError(t, err)
	c, _ = closeOn("BHP", "2025-10-31")
	assert.Equal(t, 43.45, c)
	_, ok = closeOn("BHP", "2025-11-02")
	assert.True(t, ok, "stored-only rows are reported, never deleted")
	assert.Positive(t, report.Written)
}

func TestSweepStopsWhenTheUpstreamRefuses(t *testing.T) {
	pool := newPriceDB(t)
	ctx := context.Background()

	var codes []string
	for i := 0; i < maxConsecutiveFailures+10; i++ {
		codes = append(codes, fmt.Sprintf("C%03d", i))
	}
	provider := &fakeProvider{name: "yahoo", fn: refused}
	m := NewSyncManager(pool, nil, &config.Config{}, []providers.DataProvider{provider})
	m.now = func() time.Time { return time.Date(2026, 9, 25, 10, 0, 0, 0, time.UTC) }

	report, err := m.RunWith(ctx, RunOptions{Codes: codes})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "consecutive fetch failures")
	assert.Len(t, provider.calls, maxConsecutiveFailures, "it stops instead of spending the run being refused")
	assert.Equal(t, maxConsecutiveFailures, report.Failed)
	assert.NotEmpty(t, report.Error)

	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM stock_sync_failures WHERE consecutive_failures > 0`).Scan(&n))
	assert.Zero(t, n, "a refusal is not a strike against the stock")
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM sync_status WHERE status = 'failed'`).Scan(&n))
	assert.Equal(t, 1, n)
}

func TestFailureTrackerBlocksAfterThreeStrikes(t *testing.T) {
	pool := newPriceDB(t)
	ctx := context.Background()
	ft := NewFailureTracker(pool)

	for i := 0; i < MaxConsecutiveFailures; i++ {
		assert.False(t, ft.IsBlocked(ctx, "DEAD"), "not blocked after %d strikes", i)
		ft.RecordFailure(ctx, "DEAD", "no data")
	}
	assert.True(t, ft.IsBlocked(ctx, "DEAD"))
	assert.True(t, ft.GetBlockedSymbols(ctx)["DEAD"])

	var until time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT blocked_until FROM stock_sync_failures WHERE stock_code = 'DEAD'`).Scan(&until))
	assert.WithinDuration(t, time.Now().Add(BlockDuration), until, time.Minute)

	ft.RecordSuccess(ctx, "DEAD")
	assert.False(t, ft.IsBlocked(ctx, "DEAD"), "a success clears the block")
}
