package strategies

// Real-Postgres tests for the daily job: migration 000155 applied to a fresh
// database, the source tables the readers select from, one session written, a
// dry run that writes nothing, and a re-run of the same session that writes the
// same rows. They run only with an opt-in:
//
//	STRATEGIES_DAILY_TESTCONTAINERS=1 CGO_ENABLED=0 GOWORK=off \
//	  go test -tags=testcontainers -count=1 -run DailySnapshot ./internal/jobs/strategies/
//
// or STRATEGIES_DAILY_DATABASE_URL names a server. Without either the tests skip.
// Each test builds its own database (not a schema): the migration's guards check
// public.* names, exactly as production runs them.

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

const dailyMigrationsDir = "../../../../migrations"

// dailySourceTables are the tables the daily job's readers select from, with the
// columns they read. The reader tolerant of a missing table (company-metadata,
// the fundamentals views, the ETP ownership table) are left out, as in prod's
// older databases.
const dailySourceTables = `
CREATE TABLE stock_prices (stock_code varchar, date date, open numeric, high numeric, low numeric,
	close numeric, adjusted_close numeric, volume bigint, PRIMARY KEY (stock_code, date));
CREATE TABLE index_prices (index_code text, date date, high float8, low float8, close float8);
CREATE TABLE shorts ("DATE" timestamp, "PRODUCT" text, "PRODUCT_CODE" varchar,
	"REPORTED_SHORT_POSITIONS" float8, "TOTAL_PRODUCT_IN_ISSUE" float8,
	"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" float8);
CREATE TABLE asic_report_ingests (report_date date PRIMARY KEY, file_rows int, loaded_rows int);
CREATE TABLE dividend_history (stock_code varchar, ex_date date, dividend_type text, amount_per_share float8);
CREATE TABLE sync_status (environment text, hostname text, checkpoint_stocks_total int,
	status text, started_at timestamptz NOT NULL, completed_at timestamptz);
CREATE TABLE picks_run_lease (name text PRIMARY KEY, holder text NOT NULL, expires_at timestamptz NOT NULL);
`

// dailyDB returns a pool on a fresh database with 000155 applied and the source
// tables created. The database is dropped at cleanup.
func dailyDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn, err := testpostgres.Admin("STRATEGIES_DAILY_DATABASE_URL", "STRATEGIES_DAILY_TESTCONTAINERS")
	require.NoError(t, err)
	if dsn == "" {
		t.Skip("set STRATEGIES_DAILY_TESTCONTAINERS=1 (with -tags=testcontainers) or STRATEGIES_DAILY_DATABASE_URL")
	}
	ctx := context.Background()
	name := fmt.Sprintf("strat_daily_%d_%d", time.Now().UnixNano()%1e9, rand.Intn(1e6))

	admin, err := pgxpool.New(ctx, dsn)
	require.NoError(t, err)
	_, err = admin.Exec(ctx, "CREATE DATABASE "+name)
	require.NoError(t, err)
	t.Cleanup(func() {
		admin.Close()
		cleanup, err := pgxpool.New(context.Background(), dsn)
		if err != nil {
			return
		}
		defer cleanup.Close()
		_, _ = cleanup.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
	})

	cfg, err := pgxpool.ParseConfig(dsn)
	require.NoError(t, err)
	cfg.ConnConfig.Database = name
	// Production's pool runs in simple protocol (platform.Connect): the migration
	// file is a multi-statement script, which only simple protocol accepts.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	b, err := os.ReadFile(filepath.Join(dailyMigrationsDir, "000155_strategy_engine.up.sql"))
	require.NoError(t, err)
	_, err = pool.Exec(ctx, string(b))
	require.NoError(t, err, "applying 000155")
	_, err = pool.Exec(ctx, dailySourceTables)
	require.NoError(t, err, "creating the source tables")
	return pool
}

// seedDailySession seeds two codes and the index with weekday bars from 2026-06-01
// to the session, a completed price sweep that started after the session's
// 05:30 UTC, and nothing else. The session is 2026-11-12, a Thursday.
func seedDailySession(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO stock_prices (stock_code, date, open, high, low, close, adjusted_close, volume)
		SELECT c, d::date, 10 + n*0.05, 10.5 + n*0.05, 9.5 + n*0.05, 10 + n*0.05, 10 + n*0.05, 1000000
		  FROM (VALUES ('AAA'), ('BBB')) codes(c)
		  CROSS JOIN generate_series('2026-06-01'::date, '2026-11-12'::date, interval '1 day') WITH ORDINALITY AS g(d, n)
		 WHERE extract(isodow FROM d) < 6`)
	require.NoError(t, err, "seed stock prices")
	_, err = pool.Exec(ctx, `
		INSERT INTO index_prices (index_code, date, high, low, close)
		SELECT 'XJO', d::date, 5010 + n*3, 4990 + n*3, 5000 + n*3
		  FROM generate_series('2026-06-01'::date, '2026-11-12'::date, interval '1 day') WITH ORDINALITY AS g(d, n)
		 WHERE extract(isodow FROM d) < 6`)
	require.NoError(t, err, "seed index prices")
	_, err = pool.Exec(ctx, `
		INSERT INTO sync_status (environment, hostname, checkpoint_stocks_total, status, started_at, completed_at)
		VALUES (NULL, NULL, 1800, 'completed', '2026-11-12 06:00:00+00', '2026-11-12 06:30:00+00')`)
	require.NoError(t, err, "seed the price sweep")
}

func dailyNow() time.Time { return time.Date(2026, 11, 12, 14, 0, 0, 0, time.UTC) }

func dailyOpts(write bool, t *testing.T) dailyOptions {
	return dailyOptions{
		Write:  write,
		Holder: "daily-test",
		Now:    dailyNow(),
		Logf:   t.Logf,
		Sleep:  func(context.Context, time.Duration) error { return nil },
		Ping:   nil,
	}
}

func countRows(t *testing.T, pool *pgxpool.Pool, query string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(context.Background(), query, args...).Scan(&n))
	return n
}

// TestDailySnapshotDryRunWritesNothing reads, computes and logs a session, and
// leaves every table empty.
func TestDailySnapshotDryRunWritesNothing(t *testing.T) {
	pool := dailyDB(t)
	seedDailySession(t, pool)

	res, err := runDaily(context.Background(), pool, dailyOpts(false, t))
	require.NoError(t, err)
	require.Equal(t, "2026-11-12", res.D.String())
	require.Len(t, res.Done, 1, "the dry run still walks the session")

	for _, table := range []string{"strategy_features_daily", "strategy_daily_runs", "strategy_rule_versions",
		"strategy_recipes", "strategy_regime_daily", "strategy_fundamentals_blobs", "strategy_signal_events", "picks_run_lease"} {
		require.Equal(t, 0, countRows(t, pool, "SELECT count(*) FROM "+table), "%s must stay empty in a dry run", table)
	}
}

// TestDailySnapshotWritesAndRerunsIdentically writes one session, then deletes its
// run log and runs it again: the feature rows and the versions are identical, and
// the phases are complete after both runs.
func TestDailySnapshotWritesAndRerunsIdentically(t *testing.T) {
	pool := dailyDB(t)
	seedDailySession(t, pool)
	ctx := context.Background()

	res, err := runDaily(ctx, pool, dailyOpts(true, t))
	require.NoError(t, err)
	require.Len(t, res.Done, 1)
	require.Nil(t, res.Held)

	require.Equal(t, 2, countRows(t, pool, "SELECT count(*) FROM strategy_features_daily WHERE as_of = '2026-11-12'"),
		"one feature row per code on the session")
	require.Equal(t, 1, countRows(t, pool, "SELECT count(*) FROM strategy_regime_daily WHERE as_of = '2026-11-12' AND index_code = 'XJO'"))
	require.Equal(t, 5, countRows(t, pool, "SELECT count(*) FROM strategy_rule_versions WHERE status = 'live' AND kind = 'canonical'"),
		"one live version per launch strategy")
	require.Equal(t, 5, countRows(t, pool, "SELECT count(*) FROM strategy_recipes"), "the five R1 recipes")
	require.Equal(t, 3, countRows(t, pool, "SELECT count(*) FROM strategy_daily_runs WHERE as_of = '2026-11-12' AND status = 'completed'"),
		"features, evaluation and events complete")
	require.Equal(t, 0, countRows(t, pool, "SELECT count(*) FROM picks_run_lease"), "the lease is released on exit")

	first := featureSnapshot(t, pool)

	// Delete the run log so the same session runs again over its own rows.
	_, err = pool.Exec(ctx, "DELETE FROM strategy_daily_runs WHERE as_of = '2026-11-12'")
	require.NoError(t, err)
	res, err = runDaily(ctx, pool, dailyOpts(true, t))
	require.NoError(t, err)
	require.Len(t, res.Done, 1)

	require.Equal(t, first, featureSnapshot(t, pool), "the same session gives the same rows")
	require.Equal(t, 2, countRows(t, pool, "SELECT count(*) FROM strategy_features_daily WHERE as_of = '2026-11-12'"),
		"a re-run replaces its rows, it does not add to them")
}

// TestDailySnapshotAlreadyCompletedIsAQuietExit: once every phase of the session
// completed, a later run finds nothing to do.
func TestDailySnapshotAlreadyCompletedIsAQuietExit(t *testing.T) {
	pool := dailyDB(t)
	seedDailySession(t, pool)
	ctx := context.Background()
	_, err := runDaily(ctx, pool, dailyOpts(true, t))
	require.NoError(t, err)

	res, err := runDaily(ctx, pool, dailyOpts(true, t))
	require.NoError(t, err)
	require.True(t, res.AlreadyDone, "a completed session is skipped after one query")
	require.Empty(t, res.Done)
}

// TestDailySnapshotHoldsAndDoesNotWriteAPartialSession: a session whose XJO bar
// is missing is held, writes only its held row, and is not counted as complete.
func TestDailySnapshotHoldsAndDoesNotWriteAPartialSession(t *testing.T) {
	pool := dailyDB(t)
	seedDailySession(t, pool)
	ctx := context.Background()
	_, err := pool.Exec(ctx, "DELETE FROM index_prices WHERE date = '2026-11-12'")
	require.NoError(t, err)

	res, err := runDaily(ctx, pool, dailyOpts(true, t))
	require.NoError(t, err)
	require.NotNil(t, res.Held)
	require.Equal(t, "xjo_bar_missing", res.Held.Reason)
	require.Empty(t, res.Done)
	require.Equal(t, 0, countRows(t, pool, "SELECT count(*) FROM strategy_features_daily"), "a held session writes no feature row")
	require.Equal(t, 1, countRows(t, pool, "SELECT count(*) FROM strategy_daily_runs WHERE as_of = '2026-11-12' AND status = 'held'"))
	require.Equal(t, 0, countRows(t, pool, "SELECT count(*) FROM strategy_daily_runs WHERE as_of = '2026-11-12' AND status = 'completed'"))
}

// featureSnapshot is the session's stored rows as text, for the identity check.
func featureSnapshot(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var s string
	require.NoError(t, pool.QueryRow(context.Background(), `
		SELECT coalesce(string_agg(concat_ws('|', stock_code, bar_date, ordinary_fresh_60, coalesce(ineligible_reason, ''),
		       is_ordinary, in_asic_report, coalesce(short_status, ''), features::text, meta::text), E'\n' ORDER BY stock_code), '')
		  FROM strategy_features_daily WHERE as_of = '2026-11-12'`).Scan(&s))
	return s
}

// TestDailySnapshotDiffsAgainstTheStoredPreviousSession runs a second session
// after a first. The second reads the first back from the stored rows, the blobs
// and the regime, evaluates it, and completes all three phases.
func TestDailySnapshotDiffsAgainstTheStoredPreviousSession(t *testing.T) {
	pool := dailyDB(t)
	seedDailySession(t, pool)
	ctx := context.Background()
	_, err := runDaily(ctx, pool, dailyOpts(true, t))
	require.NoError(t, err)

	// Friday 13 November: one more session of bars, and its own completed sweep.
	_, err = pool.Exec(ctx, `
		INSERT INTO stock_prices (stock_code, date, open, high, low, close, adjusted_close, volume)
		VALUES ('AAA', '2026-11-13', 30, 30.5, 29.5, 30, 30, 1000000), ('BBB', '2026-11-13', 30, 30.5, 29.5, 30, 30, 1000000)`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO index_prices (index_code, date, high, low, close) VALUES ('XJO', '2026-11-13', 5100, 5080, 5090)`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO sync_status (environment, hostname, checkpoint_stocks_total, status, started_at, completed_at)
		VALUES (NULL, NULL, 1800, 'completed', '2026-11-13 06:00:00+00', '2026-11-13 06:30:00+00')`)
	require.NoError(t, err)

	opts := dailyOpts(true, t)
	opts.Now = time.Date(2026, 11, 13, 14, 0, 0, 0, time.UTC)
	res, err := runDaily(ctx, pool, opts)
	require.NoError(t, err)
	require.Equal(t, "2026-11-13", res.D.String())
	require.Len(t, res.Done, 1)
	require.Equal(t, 3, countRows(t, pool, "SELECT count(*) FROM strategy_daily_runs WHERE as_of = '2026-11-13' AND status = 'completed'"))
	require.Equal(t, 0, countRows(t, pool, "SELECT count(*) FROM strategy_daily_runs WHERE status = 'failed'"))
}

// TestDailySnapshotSweepIgnoresASICAndSingleStockRows: the readiness sweep is the
// price sweep alone. A later ASIC sync row, and a market-data single-stock run,
// leave it as it was, so the session stays ready.
func TestDailySnapshotSweepIgnoresASICAndSingleStockRows(t *testing.T) {
	pool := dailyDB(t)
	seedDailySession(t, pool)
	ctx := context.Background()
	s := civil.Date{Year: 2026, Month: time.November, Day: 12}

	_, err := pool.Exec(ctx, `
		INSERT INTO sync_status (environment, hostname, checkpoint_stocks_total, status, started_at, completed_at)
		VALUES ('production', 'asic-exec-1', 1800, 'completed', '2026-11-12 09:00:00+00', '2026-11-12 09:30:00+00'),
		       (NULL, NULL, 1, 'running', '2026-11-12 10:00:00+00', NULL)`)
	require.NoError(t, err)

	facts, err := readinessDB(ctx, pool, s)
	require.NoError(t, err)
	require.NotNil(t, facts.Sweep)
	require.Equal(t, "completed", facts.Sweep.Status, "the newest price sweep is the completed one, not the single-stock run")
	require.True(t, facts.Sweep.StartedAt.Equal(time.Date(2026, 11, 12, 6, 0, 0, 0, time.UTC)))
	ready, reason := evaluateReadiness(s, facts)
	require.True(t, ready, "the session is ready: %s", reason)
}
