package strategies

// Real-Postgres tests for the daily job: migration 000156 applied to a fresh
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

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
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

// dailyDB returns a pool on a fresh database with 000156 applied and the source
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

	b, err := os.ReadFile(filepath.Join(dailyMigrationsDir, "000156_strategy_engine.up.sql"))
	require.NoError(t, err)
	_, err = pool.Exec(ctx, string(b))
	require.NoError(t, err, "applying 000156")
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
	require.Equal(t, 5, countRows(t, pool, `SELECT count(*) FROM jsonb_object_keys(
		(SELECT counts->'eligible' FROM strategy_daily_runs WHERE as_of = '2026-11-12' AND phase = 'evaluation'))`),
		"one eligible count per version, keyed by strategy and label")

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

// diffSetup writes the 2026-11-12 session, then returns what diffSession needs to
// diff 2026-11-13 against it: the live Zanger version with AAA read as a setup
// (its stored 2026-11-12 status is watch, so the diff is watch -> setup), and
// nothing for BBB, so BBB is no event. The 2026-11-13 session is never written.
func diffSetup(t *testing.T, pool *pgxpool.Pool) (spec.Registered, map[string]versionEval) {
	t.Helper()
	ctx := context.Background()
	seedDailySession(t, pool)
	_, err := runDaily(ctx, pool, dailyOpts(true, t))
	require.NoError(t, err)
	live, ok := spec.Live(spec.StrategyZangerBreakout)
	require.True(t, ok)
	h, err := spec.RulesHash(live.Spec)
	require.NoError(t, err)
	pivot := 41.64
	evals := map[string]versionEval{h: {RulesHash: h, Picks: map[string]pickState{
		"AAA": {Status: "setup", Score: 60, Close: 41.2, Pivot: &pivot, Regime: "neutral"},
	}}}
	return live, evals
}

// TestDailySnapshotWatchToSetupEventsWhileRowsExist is the positive control for the
// guard below: with the previous session's feature rows stored, the diff of a
// setup against that session's watch is one event, so the guard test's zero is not
// the diff finding nothing to say.
func TestDailySnapshotWatchToSetupEventsWhileRowsExist(t *testing.T) {
	pool := dailyDB(t)
	live, evals := diffSetup(t, pool)
	ctx := context.Background()
	prev := civil.Date{Year: 2026, Month: time.November, Day: 12}
	cur := civil.Date{Year: 2026, Month: time.November, Day: 13}
	require.Equal(t, 2, countRows(t, pool, "SELECT count(*) FROM strategy_features_daily WHERE as_of = '2026-11-12'"))

	events, err := diffSession(ctx, pool, cur, []civil.Date{prev}, []spec.Registered{live}, evals, map[string]bool{}, t.Logf)
	require.NoError(t, err)
	require.Len(t, events, 1, "one watch -> setup event for AAA; BBB, absent on the session, is no event")
	require.Equal(t, "AAA", events[0].Code)
	require.Equal(t, "watch", events[0].From)
	require.Equal(t, "setup", events[0].To)
	require.Equal(t, prev, events[0].PrevAsOf)
}

// TestDailySnapshotNoFeatureRowsOnThePreviousSessionMakesNoEvents: a previous
// session with a stored regime but no feature rows (a pruned or edited session)
// is no baseline for a diff. Every current pick would read as none -> its status,
// so diffSession writes no events instead. The same diff with the rows stored is
// the positive control above, so removing the guard makes this test fail.
func TestDailySnapshotNoFeatureRowsOnThePreviousSessionMakesNoEvents(t *testing.T) {
	pool := dailyDB(t)
	live, evals := diffSetup(t, pool)
	ctx := context.Background()
	prev := civil.Date{Year: 2026, Month: time.November, Day: 12}
	cur := civil.Date{Year: 2026, Month: time.November, Day: 13}

	_, err := pool.Exec(ctx, `DELETE FROM strategy_features_daily WHERE as_of = '2026-11-12'`)
	require.NoError(t, err)
	require.Equal(t, 1, countRows(t, pool, "SELECT count(*) FROM strategy_regime_daily WHERE as_of = '2026-11-12' AND index_code = 'XJO'"),
		"the previous session keeps its regime, so only the missing feature rows stop the diff")

	events, err := diffSession(ctx, pool, cur, []civil.Date{prev}, []spec.Registered{live}, evals, map[string]bool{}, t.Logf)
	require.NoError(t, err)
	require.Empty(t, events, "AAA's setup would read as none -> setup against an empty previous session")
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

// stringOf reads one text value.
func stringOf(t *testing.T, pool *pgxpool.Pool, query string, args ...any) string {
	t.Helper()
	var v string
	require.NoError(t, pool.QueryRow(context.Background(), query, args...).Scan(&v))
	return v
}

// datesText is the dates as YYYY-MM-DD, for comparing the sessions a run did.
func datesText(ds []civil.Date) []string {
	out := make([]string, 0, len(ds))
	for _, d := range ds {
		out = append(out, d.String())
	}
	return out
}

// seedFriday adds Friday 13 November's bars, index bar and completed sweep.
func seedFriday(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO stock_prices (stock_code, date, open, high, low, close, adjusted_close, volume)
		VALUES ('AAA', '2026-11-13', 30, 30.5, 29.5, 30, 30, 1000000), ('BBB', '2026-11-13', 30, 30.5, 29.5, 30, 30, 1000000)`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO index_prices (index_code, date, high, low, close) VALUES ('XJO', '2026-11-13', 5100, 5080, 5090)`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO sync_status (environment, hostname, checkpoint_stocks_total, status, started_at, completed_at)
		VALUES (NULL, NULL, 1800, 'completed', '2026-11-13 06:00:00+00', '2026-11-13 06:30:00+00')`)
	require.NoError(t, err)
}

// A code with too little history stores no price features. The next session
// reads its row back in the diff, so the row must decode, and the code stays out
// of the universe with its reason.
func TestDailySnapshotShortHistoryCodeSurvivesTheNextSession(t *testing.T) {
	pool := dailyDB(t)
	seedDailySession(t, pool)
	ctx := context.Background()
	// NEW has about thirty priced sessions, under the sixty the ordinary universe needs.
	_, err := pool.Exec(ctx, `
		INSERT INTO stock_prices (stock_code, date, open, high, low, close, adjusted_close, volume)
		SELECT 'NEW', d::date, 3, 3.5, 2.5, 3, 3, 1000000
		  FROM generate_series('2026-10-01'::date, '2026-11-12'::date, interval '1 day') AS g(d)
		 WHERE extract(isodow FROM d) < 6`)
	require.NoError(t, err)

	wed := dailyOpts(true, t)
	wed.Now = time.Date(2026, 11, 11, 14, 0, 0, 0, time.UTC)
	res, err := runDaily(ctx, pool, wed)
	require.NoError(t, err)
	require.Equal(t, "2026-11-11", res.D.String())
	require.Len(t, res.Done, 1)

	res, err = runDaily(ctx, pool, dailyOpts(true, t))
	require.NoError(t, err)
	require.Nil(t, res.Held)
	require.Equal(t, []string{"2026-11-12"}, datesText(res.Done), "the diff reads Wednesday's rows back, NEW included")
	require.Equal(t, 0, countRows(t, pool, "SELECT count(*) FROM strategy_daily_runs WHERE status = 'failed'"))
	require.Equal(t, "short_history", stringOf(t, pool,
		"SELECT ineligible_reason FROM strategy_features_daily WHERE as_of = '2026-11-12' AND stock_code = 'NEW'"))
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_features_daily
		WHERE as_of = '2026-11-12' AND stock_code = 'NEW' AND jsonb_typeof(features->'fs1') = 'null'`))
}

// A session held before the last scheduled run is backfilled, oldest first, by
// the next run that can. A hold at 16:40 pages, even when the held session is
// an earlier one.
func TestDailySnapshotHeldBackfillRunsOldestFirstAndPagesAtTheDeadline(t *testing.T) {
	pool := dailyDB(t)
	seedDailySession(t, pool)
	ctx := context.Background()

	wed := dailyOpts(true, t)
	wed.Now = time.Date(2026, 11, 11, 14, 0, 0, 0, time.UTC)
	res, err := runDaily(ctx, pool, wed)
	require.NoError(t, err)
	require.Equal(t, []string{"2026-11-11"}, datesText(res.Done))

	_, err = pool.Exec(ctx, "DELETE FROM index_prices WHERE date = '2026-11-12'")
	require.NoError(t, err)
	res, err = runDaily(ctx, pool, dailyOpts(true, t))
	require.NoError(t, err)
	require.NotNil(t, res.Held, "Thursday's index bar is missing")
	require.False(t, res.PastDeadline, "a hold before 16:40 UTC exits 0")

	atDeadline := dailyOpts(true, t)
	atDeadline.Now = time.Date(2026, 11, 12, 16, 40, 0, 0, time.UTC)
	res, err = runDaily(ctx, pool, atDeadline)
	require.NoError(t, err)
	require.NotNil(t, res.Held)
	require.True(t, res.PastDeadline, "a hold at 16:40 UTC exits 10")

	// Thursday's index bar lands, then Friday's data: Friday's run backfills Thursday first.
	_, err = pool.Exec(ctx, `INSERT INTO index_prices (index_code, date, high, low, close) VALUES ('XJO', '2026-11-12', 5160, 5140, 5150)`)
	require.NoError(t, err)
	seedFriday(t, pool)
	friday := dailyOpts(true, t)
	friday.Now = time.Date(2026, 11, 13, 14, 0, 0, 0, time.UTC)
	res, err = runDaily(ctx, pool, friday)
	require.NoError(t, err)
	require.Nil(t, res.Held)
	require.Equal(t, []string{"2026-11-12", "2026-11-13"}, datesText(res.Done), "oldest first")
	require.Equal(t, "true", stringOf(t, pool, "SELECT counts->>'late' FROM strategy_daily_runs WHERE as_of = '2026-11-12' AND phase = 'features'"),
		"a backfilled session records late")
	require.Equal(t, "false", stringOf(t, pool, "SELECT counts->>'late' FROM strategy_daily_runs WHERE as_of = '2026-11-13' AND phase = 'features'"))
	require.Equal(t, 3, countRows(t, pool, "SELECT count(*) FROM strategy_daily_runs WHERE as_of = '2026-11-12' AND status = 'completed'"))
	require.Equal(t, 3, countRows(t, pool, "SELECT count(*) FROM strategy_daily_runs WHERE as_of = '2026-11-13' AND status = 'completed'"))
}

// A promotion keeps the superseded version's live_from and sets its
// superseded_on, and a later run that registers the same versions changes nothing.
func TestDailySnapshotPromotionKeepsTheSupersededDates(t *testing.T) {
	pool := dailyDB(t)
	ctx := context.Background()
	st := store{pool: pool}
	live, ok := spec.Live(spec.StrategyZangerBreakout)
	require.True(t, ok)

	first, err := registeredVersions([]spec.Registered{live})
	require.NoError(t, err)
	require.NoError(t, st.upsertVersions(ctx, pool, civil.Date{Year: 2026, Month: time.November, Day: 12}, first))

	v0 := live
	v0.Live = false
	v1 := live
	v1.Label = "v1"
	v1.Spec.Universe.MinSessions = 61
	second, err := registeredVersions([]spec.Registered{v0, v1})
	require.NoError(t, err)
	promoted := civil.Date{Year: 2026, Month: time.November, Day: 16}
	require.NoError(t, st.upsertVersions(ctx, pool, promoted, second))
	require.NoError(t, st.upsertVersions(ctx, pool, promoted, second), "a rerun is a no-op")

	dates := func(label string) (status, liveFrom, supersededOn string) {
		t.Helper()
		require.NoError(t, pool.QueryRow(ctx, `SELECT status, coalesce(live_from::text, ''), coalesce(superseded_on::text, '')
			FROM strategy_rule_versions WHERE strategy_id = $1 AND label = $2`, live.Spec.StrategyID, label).Scan(&status, &liveFrom, &supersededOn))
		return status, liveFrom, supersededOn
	}
	status, liveFrom, supersededOn := dates("v0")
	require.Equal(t, []string{"superseded", "2026-11-12", "2026-11-16"}, []string{status, liveFrom, supersededOn}, "v0 keeps its live_from")
	status, liveFrom, supersededOn = dates("v1")
	require.Equal(t, []string{"live", "2026-11-16", ""}, []string{status, liveFrom, supersededOn})
}

// Signal events are inserted with the evidence the job builds for them: an entry
// with a pass, a fail and an unknown rule, a status change, and an exit. The same
// key inserted again adds no row.
func TestDailySnapshotWritesAnEventWithItsEvidence(t *testing.T) {
	pool := dailyDB(t)
	ctx := context.Background()
	st := store{pool: pool}
	versions, err := registeredVersions(spec.Registry())
	require.NoError(t, err)
	d := civil.Date{Year: 2026, Month: time.November, Day: 12}
	require.NoError(t, st.upsertVersions(ctx, pool, d, versions))

	live, ok := spec.Live(spec.StrategyZangerBreakout)
	require.True(t, ok)
	h, err := spec.RulesHash(live.Spec)
	require.NoError(t, err)
	pivot := 41.64
	score := 80.0
	entry := transition{Code: "AAA", From: "setup", To: "triggered", Score: score, Rules: pickState{
		Status: "triggered", Score: score, Close: 41.2, Pivot: &pivot,
		ShortReport: ptrDate(2026, time.October, 28), ShortAvailable: ptrDate(2026, time.November, 3), Regime: "neutral",
		Rules: []engine.RuleResult{
			{RuleID: "growth", Status: engine.RulePass, Value: 9.5, HasValue: true},
			{RuleID: "breakout", Status: engine.RuleFail, Proximity: 0.82, HasProximity: true},
			{RuleID: "liquidity", Status: engine.RuleUnknown, Reason: engine.ReasonNoPriceHistory},
		},
	}}
	change := transition{Code: "BBB", From: "watch", To: "setup", Score: score, Rules: pickState{
		Status: "setup", Score: score, Close: 7.5,
		Rules: []engine.RuleResult{
			{RuleID: "growth", Status: engine.RuleFail, Value: -3, HasValue: true},
			{RuleID: "breakout", Status: engine.RulePass, Value: 1.5, HasValue: true},
		},
	}}
	exit := transition{Code: "CCC", From: "triggered", To: noneStatus}

	var events []eventRow
	for _, tr := range []transition{entry, change, exit} {
		evidence, err := evidenceJSON(tr)
		require.NoError(t, err)
		ev := eventRow{
			RulesHash: h, EngineVersion: engine.Version, StrategyID: live.Spec.StrategyID, Code: tr.Code,
			AsOf: d, PrevAsOf: civil.Date{Year: 2026, Month: time.November, Day: 11},
			From: tr.From, To: tr.To, Score: scoreOrNil(tr), Evidence: evidence,
		}
		events = append(events, ev)
	}
	require.NoError(t, writeEvents(ctx, pool, st, d, []string{h}, events, "{}"))
	require.NoError(t, writeEvents(ctx, pool, st, d, []string{h}, events, "{}"))

	require.Equal(t, 3, countRows(t, pool, "SELECT count(*) FROM strategy_signal_events WHERE stock_code IN ('AAA','BBB','CCC') AND as_of = '2026-11-12'"))
	stored := func(code string) string {
		return stringOf(t, pool, "SELECT evidence::text FROM strategy_signal_events WHERE stock_code = '"+code+"' AND as_of = '2026-11-12'")
	}
	require.JSONEq(t, `{"r":"PFU","v":[9.5,null,null],"p":[null,0.82,null],"close":41.2,"pivot":41.64,
		"short_report":"2026-10-28","short_available":"2026-11-03","regime":"neutral"}`, stored("AAA"))
	require.JSONEq(t, `{"r":"FP","v":[-3,1.5],"p":[null,null],"close":7.5,"pivot":null,
		"short_report":null,"short_available":null,"regime":null}`, stored("BBB"))
	require.JSONEq(t, `{"r":"","v":[],"p":[],"close":null,"pivot":null,
		"short_report":null,"short_available":null,"regime":null}`, stored("CCC"))
}

// The window's rows do not answer for a code whose newest qualifying short
// position is older than two years, so its sf0 reads the whole history.
func TestDailySnapshotReadsAShortPositionOlderThanTheWindow(t *testing.T) {
	pool := dailyDB(t)
	seedDailySession(t, pool)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO shorts ("DATE", "PRODUCT", "PRODUCT_CODE", "REPORTED_SHORT_POSITIONS", "TOTAL_PRODUCT_IN_ISSUE",
			"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS")
		VALUES ('2024-03-01', 'ALPHA MINING LIMITED ORDINARY FULLY PAID', 'AAA', 1000000, 100000000, 6)`)
	require.NoError(t, err)

	wed := dailyOpts(true, t)
	wed.Now = time.Date(2026, 11, 11, 14, 0, 0, 0, time.UTC)
	res, err := runDaily(ctx, pool, wed)
	require.NoError(t, err)
	require.Len(t, res.Done, 1)
	require.Equal(t, "reported", stringOf(t, pool, "SELECT features->'sf0'->>'status' FROM strategy_features_daily WHERE as_of = '2026-11-11' AND stock_code = 'AAA'"))
	require.Equal(t, "6", stringOf(t, pool, "SELECT features->'sf0'->>'pct' FROM strategy_features_daily WHERE as_of = '2026-11-11' AND stock_code = 'AAA'"))
}

// A features phase the run log records as completed is read back, not computed
// again: changed inputs leave its rows as they were, while the phases that were
// not complete run on the stored rows.
func TestDailySnapshotSkipsACompletedFeaturesPhase(t *testing.T) {
	pool := dailyDB(t)
	seedDailySession(t, pool)
	ctx := context.Background()
	_, err := runDaily(ctx, pool, dailyOpts(true, t))
	require.NoError(t, err)
	first := featureSnapshot(t, pool)

	_, err = pool.Exec(ctx, "UPDATE stock_prices SET open = 999, high = 999, low = 999, close = 999, adjusted_close = 999 WHERE stock_code = 'AAA' AND date = '2026-11-12'")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, "DELETE FROM strategy_daily_runs WHERE as_of = '2026-11-12' AND phase <> 'features'")
	require.NoError(t, err)

	res, err := runDaily(ctx, pool, dailyOpts(true, t))
	require.NoError(t, err)
	require.Equal(t, []string{"2026-11-12"}, datesText(res.Done))
	require.Equal(t, first, featureSnapshot(t, pool), "a completed features phase is read back, not recomputed")
	require.Equal(t, 3, countRows(t, pool, "SELECT count(*) FROM strategy_daily_runs WHERE as_of = '2026-11-12' AND status = 'completed'"))
}

// TestDailySnapshotPruneDeletesWhatTheRetentionRulesNoLongerNeed seeds sixteen
// completed sessions with feature rows, the blobs they point at and two events,
// then runs the prune the job runs after a write. The oldest session's rows go,
// and the blob only it referenced goes with them; a blob a kept row still
// references stays; the session at the cut-off stays; an event older than three
// years goes and a recent one stays.
func TestDailySnapshotPruneDeletesWhatTheRetentionRulesNoLongerNeed(t *testing.T) {
	pool := dailyDB(t)
	ctx := context.Background()
	newest := civil.Date{Year: 2026, Month: time.November, Day: 12}
	day := func(i int) string { return newest.AddDays(-i).String() }
	const rulesHash = "0000000000000000000000000000000000000000000000000000000000000001"

	for _, h := range []string{"orphan", "shared"} {
		_, err := pool.Exec(ctx, `INSERT INTO strategy_fundamentals_blobs (hash, body, first_seen) VALUES ($1, '{}', '2026-01-01')`, h)
		require.NoError(t, err)
	}
	for i := 0; i <= keepSessions; i++ {
		for _, p := range phaseNames {
			_, err := pool.Exec(ctx, `INSERT INTO strategy_daily_runs (as_of, phase, status, engine_version)
				VALUES ($1::date, $2, 'completed', 'test')`, day(i), p)
			require.NoError(t, err)
		}
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO strategy_features_daily (as_of, feature_set, stock_code, ordinary_fresh_60, is_ordinary, in_asic_report, features, fundamentals_hash)
		VALUES ($1::date, 'fs1', 'AAA', true, true, true, '{}', 'orphan'),
		       ($1::date, 'fs1', 'BBB', true, true, true, '{}', 'shared'),
		       ($2::date, 'fs1', 'DDD', true, true, true, '{}', NULL),
		       ($3::date, 'fs1', 'CCC', true, true, true, '{}', 'shared')`, day(keepSessions), day(keepSessions-1), day(0))
	require.NoError(t, err, "seed feature rows")
	_, err = pool.Exec(ctx, `
		INSERT INTO strategy_rule_versions (rules_hash, strategy_id, label, kind, engine_major, feature_set, canonical_json)
		VALUES ($1, 'zanger-breakout', 'v0', 'canonical', 1, 'fs1', '{}')`, rulesHash)
	require.NoError(t, err, "seed the rules version")
	_, err = pool.Exec(ctx, `
		INSERT INTO strategy_signal_events (rules_hash, engine_version, strategy_id, stock_code, as_of, from_status, to_status)
		VALUES ($1, 'test', 'zanger-breakout', 'AAA', '2022-01-03', 'none', 'watch'),
		       ($1, 'test', 'zanger-breakout', 'AAA', $2::date, 'watch', 'setup')`, rulesHash, day(0))
	require.NoError(t, err, "seed the signal events")

	require.NoError(t, pruneAfter(ctx, pool, store{pool: pool}, newest, t.Logf))

	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_features_daily WHERE as_of = $1::date`, day(keepSessions)),
		"the oldest session's feature rows are pruned")
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_features_daily WHERE as_of = $1::date`, day(keepSessions-1)),
		"the session at the cut-off is kept")
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_features_daily WHERE as_of = $1::date`, day(0)))
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_fundamentals_blobs WHERE hash = 'orphan'`),
		"a blob only a pruned row referenced is pruned with it")
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_fundamentals_blobs WHERE hash = 'shared'`),
		"a blob a kept row still references is kept")
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_signal_events WHERE as_of < current_date - interval '3 years'`),
		"an event older than three years is pruned")
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_signal_events WHERE as_of = $1::date`, day(0)))
}

// TestDailySnapshotKeepsHoldsThroughCompletion holds a session twice (no price sweep
// yet), then completes it. The completed features row keeps the two holds and the
// reason of the last one, which its own completed write would otherwise overwrite.
func TestDailySnapshotKeepsHoldsThroughCompletion(t *testing.T) {
	pool := dailyDB(t)
	seedDailySession(t, pool)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `DELETE FROM sync_status`)
	require.NoError(t, err, "hold the session: no price sweep")

	for i := 0; i < 2; i++ {
		res, err := runDaily(ctx, pool, dailyOpts(true, t))
		require.NoError(t, err)
		require.NotNil(t, res.Held)
	}
	require.Equal(t, "2", stringOf(t, pool, `SELECT counts->>'holds' FROM strategy_daily_runs WHERE as_of = '2026-11-12' AND phase = 'features' AND status = 'held'`))

	_, err = pool.Exec(ctx, `
		INSERT INTO sync_status (environment, hostname, checkpoint_stocks_total, status, started_at, completed_at)
		VALUES (NULL, NULL, 1800, 'completed', '2026-11-12 06:00:00+00', '2026-11-12 06:30:00+00')`)
	require.NoError(t, err, "the price sweep completes")
	res, err := runDaily(ctx, pool, dailyOpts(true, t))
	require.NoError(t, err)
	require.Nil(t, res.Held)

	require.Equal(t, "completed", stringOf(t, pool, `SELECT status FROM strategy_daily_runs WHERE as_of = '2026-11-12' AND phase = 'features'`))
	require.Equal(t, "2", stringOf(t, pool, `SELECT counts->>'holds' FROM strategy_daily_runs WHERE as_of = '2026-11-12' AND phase = 'features'`))
	require.Equal(t, "no_price_sweep", stringOf(t, pool, `SELECT counts->>'last_hold_reason' FROM strategy_daily_runs WHERE as_of = '2026-11-12' AND phase = 'features'`))
}
