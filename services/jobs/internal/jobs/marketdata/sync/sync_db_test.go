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
	"000001_initial_schema.up.sql",
	"000002_stock_prices.up.sql",
	"000006_add_sync_status.up.sql",
	"000008_add_sync_checkpoint.up.sql",
	"000013_add_priority_checkpoint.up.sql",
	"000030_stock_sync_failures.up.sql",
	"000039_add_stocks_skipped.up.sql",
	"000073_stock_price_coverage_and_news_image_index.up.sql",
	"000131_widen_stock_price_precision.up.sql",
}

const newsIndexMarker = "-- Cover the news image backfill"

func newPriceDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	return newPriceDBWith(t, priceMigrations)
}

// migrationsDir is services/migrations.
func migrationsDir() string {
	_, thisFile, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "..", "..", "migrations")
}

func newPriceDBWith(t *testing.T, migrations []string) *pgxpool.Pool {
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

	dir := migrationsDir()
	conn, err := admin.Acquire(ctx)
	require.NoError(t, err)
	_, err = conn.Exec(ctx, `SET search_path = `+schema)
	require.NoError(t, err)
	for _, m := range migrations {
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
	// Where the time went: one request per stock that needed one.
	assert.Equal(t, ProviderStats{Requests: 4, Answered: 2, NoData: 2, Seconds: report.Providers["yahoo"].Seconds}, report.Providers["yahoo"])
	require.NotEmpty(t, report.Slowest)
	assert.Zero(t, report.Attempt)
	assert.False(t, report.InProgress)

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

// TestScheduledSweepCarriesCodesBeyondTheListing drives the scheduled path, the
// one no -codes run exercises: the listing, then what it does not carry.
func TestScheduledSweepCarriesCodesBeyondTheListing(t *testing.T) {
	pool := newPriceDB(t)
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err)
	}

	// The ASX company listing: BHP only. ETFs are not companies.
	listing := filepath.Join(t.TempDir(), "latest.csv")
	require.NoError(t, os.WriteFile(listing, []byte("ASX code,Company name,GICs industry group\nBHP,BHP GROUP LIMITED,Materials\n"), 0o600))
	t.Setenv("LOCAL_ASX_CSV", listing)

	exec(`INSERT INTO shorts ("DATE", "PRODUCT", "PRODUCT_CODE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS") VALUES
		('2026-09-21', 'BHP GROUP LIMITED ORDINARY', 'BHP', 0.5),
		('2026-09-21', 'VANECK GOLD MINERS ETF', 'GDX', 0.1),
		('2026-09-21', 'BETASHARES NASDAQ 100 ETF', 'NDQ', 0.1),
		('2026-06-23', 'VANECK MSCI WORLD QUALITY ETF', 'QUAL', 0.1),
		('2026-06-22', 'GONE LIMITED ORDINARY', 'GONE', 1.2)`)
	exec(`INSERT INTO stock_prices (stock_code, date, close) VALUES
		('BHP', '2026-09-24', 43.0),
		('GDX', '2026-08-20', 117.96),
		('VAS', '2026-08-21', 112.54),
		('GONE', '2026-06-01', 0.1),
		('DEAD', '2026-06-25', 0.2)`)

	provider := &fakeProvider{name: "yahoo", fn: weekdaySessions}
	// One priority stock, BHP: the top shorted list carries any code it finds,
	// listed or not, and at 10 it would carry GDX and NDQ here.
	m := NewSyncManager(pool, nil, &config.Config{PriorityStockCount: 1}, []providers.DataProvider{provider})
	m.now = func() time.Time { return time.Date(2026, 9, 25, 10, 0, 0, 0, time.UTC) }

	report, err := m.RunWith(ctx, RunOptions{DryRun: true})
	require.NoError(t, err)

	// GDX and NDQ from the last 90 days of reports (QUAL's 23 June is day 90),
	// VAS from its prices; GONE was last reported and priced too long ago,
	// DEAD last priced 91 days before the newest session.
	assert.Equal(t, 5, report.Stocks)
	assert.Equal(t, 4, report.BeyondListing)
	var asked []string
	for _, c := range provider.calls {
		asked = append(asked, c[0].Format("2006-01-02"))
	}
	assert.Equal(t, []string{"2026-08-21", "2026-08-22", "2026-09-25", "2016-09-25", "2016-09-25"}, asked,
		"GDX, VAS, BHP, then NDQ and QUAL, which hold no prices yet, last")
	assert.Equal(t, 5, report.Synced)
	assert.Zero(t, report.Written, "a dry run")
}

func TestPruneAgainstPostgres(t *testing.T) {
	pool := newPriceDB(t)
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err)
	}
	count := func(sql string) int {
		t.Helper()
		var n int
		require.NoError(t, pool.QueryRow(ctx, sql).Scan(&n))
		return n
	}

	// BHP's stored December: the daylight-time defect's Sunday rows and a row
	// on Christmas Day (Friday's session filed a day early), around real
	// sessions. ASM holds a weekday session the provider no longer has: kept.
	exec(`INSERT INTO stock_prices (stock_code, date, close) VALUES
		('BHP', '2025-12-19', 40.1), ('BHP', '2025-12-21', 40.5), ('BHP', '2025-12-22', 40.5),
		('BHP', '2025-12-24', 40.9), ('BHP', '2025-12-25', 41.2), ('BHP', '2025-12-28', 41.0),
		('BHP', '2025-12-29', 41.0), ('BHP', '2026-01-02', 41.3), ('BHP', '2026-01-04', 41.4),
		('CBA', '2025-12-27', 150.0), ('CBA', '2026-01-01', 151.0), ('CBA', '2026-01-05', 151.5),
		('ASM', '2025-12-23', 1.02), ('BTC-USD', '2025-12-27', 9.0)`)

	closed := []string{"2025-12-25", "2025-12-26", "2026-01-01"}
	provider := &fakeProvider{name: "yahoo", fn: sessionsExcept(closed...)}
	m := NewSyncManager(pool, nil, &config.Config{}, []providers.DataProvider{provider})
	m.now = func() time.Time { return time.Date(2026, 1, 9, 10, 0, 0, 0, time.UTC) }

	report, err := m.Prune(ctx, PruneOptions{DryRun: true})
	require.NoError(t, err)
	assert.Equal(t, "prune", report.Mode)
	assert.Equal(t, closed, report.Holidays)
	assert.Equal(t, 4, report.WeekendRows, "BHP's three Sundays and CBA's Saturday")
	assert.Equal(t, map[string]int{"2025": 3, "2026": 1}, report.WeekendRowsByYear)
	assert.Equal(t, 2, report.HolidayRows)
	assert.Equal(t, map[string]int{"2025-12-25": 1, "2026-01-01": 1}, report.HolidayRowsByDate)
	assert.Zero(t, report.Deleted)
	assert.Equal(t, 14, count(`SELECT count(*) FROM stock_prices`), "a dry run deletes nothing")

	report, err = m.Prune(ctx, PruneOptions{})
	require.NoError(t, err)
	assert.Equal(t, 6, report.Deleted)
	assert.Equal(t, 8, count(`SELECT count(*) FROM stock_prices`))
	assert.Equal(t, 1, count(`SELECT count(*) FROM stock_prices WHERE EXTRACT(ISODOW FROM date) IN (6, 7)`),
		"only the non-ASX symbol's Saturday is left: the ASX calendar is not its to judge")
	assert.Zero(t, count(`SELECT count(*) FROM stock_prices WHERE date IN ('2025-12-25', '2026-01-01')`))
	assert.Equal(t, 1, count(`SELECT count(*) FROM stock_prices WHERE stock_code = 'ASM'`),
		"a weekday session the provider lacks is history, not a defect")

	// A calendar missing a month of sessions in its middle deletes nothing. (A
	// gap before its first session is never judged, so it cannot delete.)
	exec(`INSERT INTO stock_prices (stock_code, date, close) VALUES ('BHP', '2025-11-09', 39.0)`)
	var gap []string
	for d := mustDate("2025-11-17"); d.Before(mustDate("2025-12-13")); d = d.AddDate(0, 0, 1) {
		gap = append(gap, d.Format("2006-01-02"))
	}
	m.providers = []providers.DataProvider{&fakeProvider{name: "yahoo", fn: sessionsExcept(append(gap, closed...)...)}}
	report, err = m.Prune(ctx, PruneOptions{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "nothing deleted")
	assert.NotEmpty(t, report.Error)
	assert.Equal(t, 1, count(`SELECT count(*) FROM stock_prices WHERE date = '2025-11-09'`))
}

// A Cloud Run retry can start while the previous attempt's whole-table
// statement is still running on the server (behind the transaction pooler the
// server does not notice the client has gone). On 2026-09-29 the live prune's
// retry timed out counting weekend rows. A prune that finds another prune's
// transaction open refuses and deletes nothing; once that transaction ends,
// the next prune runs.
func TestPruneRefusesWhileAnotherIsRunning(t *testing.T) {
	pool := newPriceDB(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `INSERT INTO stock_prices (stock_code, date, close) VALUES
		('BHP', '2025-12-19', 40.1), ('BHP', '2025-12-21', 40.5), ('BHP', '2025-12-22', 40.5)`)
	require.NoError(t, err)

	provider := &fakeProvider{name: "yahoo", fn: sessionsExcept()}
	m := NewSyncManager(pool, nil, &config.Config{}, []providers.DataProvider{provider})
	m.now = func() time.Time { return time.Date(2026, 1, 9, 10, 0, 0, 0, time.UTC) }

	// The previous attempt: a transaction holding the prune's lock.
	held, err := pool.Begin(ctx)
	require.NoError(t, err)
	_, err = held.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, pruneLockKey)
	require.NoError(t, err)

	report, err := m.Prune(ctx, PruneOptions{})
	require.ErrorIs(t, err, ErrPruneRunning)
	assert.Contains(t, report.Error, "nothing deleted")
	assert.Zero(t, report.Deleted)
	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM stock_prices`).Scan(&n))
	assert.Equal(t, 3, n, "a refused prune deletes nothing")

	require.NoError(t, held.Rollback(ctx))
	report, err = m.Prune(ctx, PruneOptions{})
	require.NoError(t, err)
	assert.Equal(t, 1, report.Deleted, "the Sunday row, once the other prune has ended")
	assert.Equal(t, map[string]int{"2025": 1}, report.WeekendRowsByYear, "a live run counts what it deleted")
}

// TestPruneOutlastsTheRoleTimeout: every statement the prune runs against the
// table scans all of it, and on prod a scan outlasts the role's default
// timeout. The first live prune (2026-09-29) timed out counting weekend rows
// before it deleted anything. Here a 1ms default stands in for prod's two
// minutes, against a table big enough that a scan takes longer.
func TestPruneOutlastsTheRoleTimeout(t *testing.T) {
	pool := newPriceDB(t)
	ctx := context.Background()
	count := func(sql string) int {
		t.Helper()
		var n int
		require.NoError(t, pool.QueryRow(ctx, sql).Scan(&n))
		return n
	}
	_, err := pool.Exec(ctx, `INSERT INTO stock_prices (stock_code, date, close)
		SELECT 'S' || lpad(c::text, 4, '0'), d::date, 1.0
		FROM generate_series(1, 300) c, generate_series('2023-01-02'::date, '2025-12-31'::date, '1 day') d`)
	require.NoError(t, err)
	weekend := count(`SELECT count(*) FROM stock_prices WHERE EXTRACT(ISODOW FROM date) IN (6, 7)`)
	holiday := count(`SELECT count(*) FROM stock_prices WHERE date IN ('2025-12-25', '2025-12-26')`)

	cfg := pool.Config().Copy()
	cfg.ConnConfig.RuntimeParams["statement_timeout"] = "1"
	tight, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(tight.Close)
	_, err = tight.Exec(ctx, `SELECT count(*) FROM stock_prices WHERE EXTRACT(ISODOW FROM date) IN (6, 7)`)
	require.ErrorContains(t, err, "statement timeout", "the table must be big enough for one scan to outlast the default")

	provider := &fakeProvider{name: "yahoo", fn: sessionsExcept("2025-12-25", "2025-12-26")}
	m := NewSyncManager(tight, nil, &config.Config{}, []providers.DataProvider{provider})
	m.now = func() time.Time { return time.Date(2026, 1, 9, 10, 0, 0, 0, time.UTC) }

	report, err := m.Prune(ctx, PruneOptions{DryRun: true})
	require.NoError(t, err)
	assert.Equal(t, weekend, report.WeekendRows)
	assert.Equal(t, holiday, report.HolidayRows)

	report, err = m.Prune(ctx, PruneOptions{})
	require.NoError(t, err)
	assert.Equal(t, weekend+holiday, report.Deleted)
	assert.Zero(t, count(`SELECT count(*) FROM stock_prices WHERE EXTRACT(ISODOW FROM date) IN (6, 7)`))
}

// TestPricePrecisionMigration applies 000131 to a table still at two decimals,
// with the views that read it, as prod has them.
func TestPricePrecisionMigration(t *testing.T) {
	pool := newPriceDBWith(t, priceMigrations[:len(priceMigrations)-1])
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err)
	}
	closeOf := func(code string) float64 {
		t.Helper()
		var c float64
		require.NoError(t, pool.QueryRow(ctx, `SELECT close::float8 FROM stock_prices WHERE stock_code = $1`, code).Scan(&c))
		return c
	}
	scale := func() int {
		t.Helper()
		var s int
		require.NoError(t, pool.QueryRow(ctx, `SELECT numeric_scale FROM information_schema.columns
			WHERE table_schema = current_schema() AND table_name = 'stock_prices' AND column_name = 'close'`).Scan(&s))
		return s
	}
	views := func() []string {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT c.relname || ':' || c.relkind::text || ':' || c.relispopulated::text
			FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = current_schema() AND c.relkind IN ('v', 'm') ORDER BY 1`)
		require.NoError(t, err)
		var out []string
		for rows.Next() {
			var v string
			require.NoError(t, rows.Scan(&v))
			out = append(out, v)
		}
		require.NoError(t, rows.Err())
		return out
	}
	apply := func(file string) {
		t.Helper()
		body, err := os.ReadFile(filepath.Join(migrationsDir(), file))
		require.NoError(t, err)
		exec(string(body))
	}

	exec(`INSERT INTO stock_prices (stock_code, date, close) VALUES ('ENL', '2026-08-20', 0.0042), ('BHP', '2026-08-20', 43.45)`)
	exec(`REFRESH MATERIALIZED VIEW mv_stock_price_coverage`)
	assert.Zero(t, closeOf("ENL"), "two decimals store ENL's $0.0042 as $0")
	m := NewSyncManager(pool, nil, &config.Config{}, nil)
	assert.InDelta(t, closeTolerance(2), m.storedCloseTolerance(ctx), 1e-12)
	before := views()
	for _, v := range []string{"latest_stock_prices:v:true", "stock_price_changes:v:true", "mv_stock_price_coverage:m:true"} {
		require.Contains(t, before, v, "the views that read the table, as prod has them")
	}

	apply("000131_widen_stock_price_precision.up.sql")
	assert.Equal(t, 4, scale())
	assert.Equal(t, before, views(), "every view that read the table is back, populated as it was")
	assert.InDelta(t, closeTolerance(4), m.storedCloseTolerance(ctx), 1e-12)
	var covered int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM mv_stock_price_coverage`).Scan(&covered))
	assert.Equal(t, 2, covered, "the coverage view was rebuilt with its data")

	require.NoError(t, m.upsertRecords(ctx, "ENL", []providers.PriceRecord{{Date: mustDate("2026-08-20"), Close: 0.0042, AdjustedClose: 0.0042}}))
	assert.InDelta(t, 0.0042, closeOf("ENL"), 1e-9)
	require.NoError(t, m.upsertRecords(ctx, "BHP", []providers.PriceRecord{{Date: mustDate("2026-08-20"), Close: 43.45000076293945}}))
	assert.Equal(t, 43.45, closeOf("BHP"), "the provider's float noise is rounded away")

	apply("000131_widen_stock_price_precision.up.sql") // a replay does nothing
	assert.Equal(t, 4, scale())
	assert.Equal(t, before, views())

	apply("000131_widen_stock_price_precision.down.sql")
	assert.Equal(t, 2, scale())
	assert.Equal(t, before, views())
	assert.Zero(t, closeOf("ENL"), "the down migration rounds to the cent again")
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

// A sweep with a run budget stops between stocks once the budget is spent,
// reports what it did as a stopped run, and leaves the rest to the next
// attempt, which takes the stocks it never reached first. It never waits for
// the platform to kill it: on 2026-09-27 the catch-up's first attempt was
// terminated at the six-hour task timeout, which is what raised the "Cloud
// Run Job logged ERROR / timeout" alert.
func TestSweepStopsOnItsBudget(t *testing.T) {
	pool := newPriceDB(t)
	ctx := context.Background()

	var codes []string
	for i := 0; i < 40; i++ {
		codes = append(codes, fmt.Sprintf("B%03d", i))
	}
	const perStock = 20 * time.Millisecond
	provider := &fakeProvider{name: "yahoo", fn: func(symbol string, from, to time.Time) ([]providers.PriceRecord, error) {
		time.Sleep(perStock)
		return weekdaySessions(symbol, from, to)
	}}
	m := NewSyncManager(pool, nil, &config.Config{}, []providers.DataProvider{provider})
	m.now = func() time.Time { return time.Date(2026, 9, 25, 10, 0, 0, 0, time.UTC) }

	budget := 8 * perStock
	report, err := m.RunWith(ctx, RunOptions{Codes: codes, Budget: budget})
	require.ErrorIs(t, err, ErrBudgetSpent)
	assert.Contains(t, err.Error(), "the next attempt resumes from the stalest stock")
	assert.NotEmpty(t, report.Error, "a stopped run says so in its report")
	assert.Greater(t, report.Synced, 0, "the budget is spent on stocks, not before the first")
	assert.Less(t, report.Synced, len(codes), "the budget stopped the run with stocks left")
	assert.Len(t, provider.calls, report.Synced, "it stops between stocks, not mid-request")

	var stored int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(DISTINCT stock_code) FROM stock_prices`).Scan(&stored))
	assert.Equal(t, report.Synced, stored, "what the run did is stored before it stops")
	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM sync_status WHERE status = 'failed'`).Scan(&n))
	assert.Equal(t, 1, n, "a budget stop is a stopped run in the checkpoint, like a refused upstream")

	// The next attempt takes the stocks the first never reached, then the ones
	// it synced, all of which are now current and cost no request.
	provider.calls = nil
	report, err = m.RunWith(ctx, RunOptions{Codes: codes})
	require.NoError(t, err)
	assert.Equal(t, len(codes)-stored, report.Synced)
	assert.Equal(t, stored, report.UpToDate)
	assert.Len(t, provider.calls, len(codes)-stored)

	// No budget: the whole list, however long it takes.
	provider.calls = nil
	report, err = NewSyncManager(pool, nil, &config.Config{}, []providers.DataProvider{provider}).RunWith(ctx, RunOptions{Codes: codes, From: mustDate("2026-09-21")})
	require.NoError(t, err)
	assert.Equal(t, len(codes), report.Synced)
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
