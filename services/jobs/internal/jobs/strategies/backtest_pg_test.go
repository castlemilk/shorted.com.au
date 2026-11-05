package strategies

// Real-Postgres tests for the backtest job: migration 000158 applied to a fresh
// database over the production table shapes, the queue's order and dedupe, the
// run-key skip, the publish flip, the verify pass's determinism check, the
// strict computable_from on stored statements, and an end-to-end run on the
// committed golden dataset that must reproduce its expected output hash.
//
//	STRATEGIES_BACKTEST_TESTCONTAINERS=1 CGO_ENABLED=0 GOWORK=off \
//	  go test -tags=testcontainers -count=1 -run Backtest ./internal/jobs/strategies/
//
// or STRATEGIES_BACKTEST_DATABASE_URL names a server. Without either the tests skip.

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"testing"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/backtest"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pgsource"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

const (
	backtestMigrationsDir = "../../../../migrations"
	backtestGoldenDir     = "../../../../pkg/strategy/backtest/testdata/golden"
	// backtestGoldenLiveFrom is the freeze date of the golden version (its in-sample ends the day before).
	backtestGoldenLiveFrom = "2023-06-02"
	backtestGoldenWindow   = "2023-01-03"
	backtestGoldenPrice4dp = "2023-06-01"
)

// backtestSourceTables are the tables the backtest readers select from, in the
// production column shapes. The fundamentals views and the ETP table are left
// out: their readers treat a missing object as absent, as on an older database.
const backtestSourceTables = `
CREATE TABLE stock_prices (stock_code varchar, date date, open numeric(12,4), high numeric(12,4),
	low numeric(12,4), close numeric(12,4), adjusted_close numeric(12,4), volume bigint,
	PRIMARY KEY (stock_code, date));
CREATE TABLE index_prices (index_code text, date date, high float8, low float8, close float8);
CREATE TABLE shorts ("DATE" timestamp, "PRODUCT" text, "PRODUCT_CODE" varchar,
	"REPORTED_SHORT_POSITIONS" float8, "TOTAL_PRODUCT_IN_ISSUE" float8,
	"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" float8);
CREATE TABLE asic_report_ingests (report_date date PRIMARY KEY, file_rows int, loaded_rows int);
CREATE TABLE dividend_history (stock_code varchar, ex_date date, dividend_type text, amount_per_share float8);
CREATE TABLE "company-metadata" (stock_code varchar PRIMARY KEY, company_name text, industry text,
	logo_gcs_url text, logo_icon_gcs_url text, key_metrics jsonb);
CREATE TABLE economic_series (id bigserial PRIMARY KEY, series_key text UNIQUE NOT NULL);
CREATE TABLE economic_observations (series_id bigint NOT NULL REFERENCES economic_series(id),
	period date NOT NULL, value float8 NOT NULL, PRIMARY KEY (series_id, period));
`

// backtestDB builds a fresh database with 000156 and 000158 applied and the
// source tables created, and returns a pool that runs simple protocol, as the
// production pool does.
func backtestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn, err := testpostgres.Admin("STRATEGIES_BACKTEST_DATABASE_URL", "STRATEGIES_BACKTEST_TESTCONTAINERS")
	require.NoError(t, err)
	if dsn == "" {
		t.Skip("set STRATEGIES_BACKTEST_TESTCONTAINERS=1 (with -tags=testcontainers) or STRATEGIES_BACKTEST_DATABASE_URL")
	}
	ctx := context.Background()
	name := fmt.Sprintf("strat_backtest_%d_%d", time.Now().UnixNano()%1e9, rand.Intn(1e6))

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
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	for _, f := range []string{"000156_strategy_engine.up.sql", "000158_strategy_backtests.up.sql"} {
		b, err := os.ReadFile(filepath.Join(backtestMigrationsDir, f))
		require.NoError(t, err)
		_, err = pool.Exec(ctx, string(b))
		require.NoError(t, err, "applying %s", f)
	}
	_, err = pool.Exec(ctx, backtestSourceTables)
	require.NoError(t, err, "creating the source tables")
	return pool
}

// goldenCSV reads one committed golden file, without its header.
func goldenCSV(t *testing.T, name string) [][]string {
	t.Helper()
	f, err := os.Open(filepath.Join(backtestGoldenDir, name))
	require.NoError(t, err)
	defer f.Close()
	rows, err := csv.NewReader(f).ReadAll()
	require.NoError(t, err)
	return rows[1:]
}

// seedGolden loads the golden dataset into the source tables, and the cash rate
// as the economic series the reader joins. It returns the newest XJO session.
func seedGolden(t *testing.T, pool *pgxpool.Pool) civil.Date {
	t.Helper()
	ctx := context.Background()
	var last civil.Date
	for _, r := range goldenCSV(t, "bars.csv") {
		_, err := pool.Exec(ctx, `INSERT INTO stock_prices VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8::bigint)`,
			r[0], r[1], r[2], r[3], r[4], r[5], r[6], intText(t, r[7]))
		require.NoError(t, err)
	}
	for _, r := range goldenCSV(t, "index.csv") {
		_, err := pool.Exec(ctx, `INSERT INTO index_prices VALUES ($1, $2::date, $3::float8, $4::float8, $5::float8)`,
			r[0], r[1], r[2], r[3], r[4])
		require.NoError(t, err)
		if r[0] == "XJO" {
			d := civil.DateOf(mustParseDate(t, r[1]))
			if last.IsZero() || last.Before(d) {
				last = d
			}
		}
	}
	for _, r := range goldenCSV(t, "asic.csv") {
		_, err := pool.Exec(ctx, `INSERT INTO shorts VALUES ($1::timestamp, $2, $3, $4::float8, $5::float8, $6::float8)`,
			r[1], r[2], r[0], r[3], r[4], r[5])
		require.NoError(t, err)
	}
	for _, r := range goldenCSV(t, "ingests.csv") {
		_, err := pool.Exec(ctx, `INSERT INTO asic_report_ingests VALUES ($1::date, $2::int, $3::int)`, r[0], r[1], r[2])
		require.NoError(t, err)
	}
	for _, r := range goldenCSV(t, "dividends.csv") {
		_, err := pool.Exec(ctx, `INSERT INTO dividend_history VALUES ($1, $2::date, 'cash', $3::float8)`, r[0], r[1], r[2])
		require.NoError(t, err)
	}
	for _, r := range goldenCSV(t, "names.csv") {
		_, err := pool.Exec(ctx, `INSERT INTO "company-metadata" (stock_code, company_name) VALUES ($1, $2)`, r[0], r[1])
		require.NoError(t, err)
	}
	_, err := pool.Exec(ctx, `INSERT INTO economic_series (series_key) VALUES ('rates.cash_rate_target.aus')`)
	require.NoError(t, err)
	// The golden rates apply in the month they are dated; the reader applies an
	// observation from the month after it (monthlyForwardFill never reads a rate
	// dated on or after its own month). Seeding each observation one month earlier
	// gives the golden series exactly, so the stored rows are the golden rows.
	for _, r := range goldenCSV(t, "rates.csv") {
		d := mustParseDate(t, r[0])
		shifted := time.Date(d.Year(), d.Month()-1, 1, 0, 0, 0, 0, time.UTC).Format("2006-01-02")
		_, err := pool.Exec(ctx, `
			INSERT INTO economic_observations (series_id, period, value)
			SELECT id, $1::date, $2::float8 FROM economic_series WHERE series_key = 'rates.cash_rate_target.aus'`, shifted, r[1])
		require.NoError(t, err)
	}
	// The features phase of the last session is complete: the window end.
	_, err = pool.Exec(ctx, `
		INSERT INTO strategy_daily_runs (as_of, phase, status, engine_version)
		VALUES ($1::date, 'features', 'completed', 'test')`, last.String())
	require.NoError(t, err)
	return last
}

// intText turns a golden volume ("1.273764e+06") into a whole number.
func intText(t *testing.T, s string) string {
	t.Helper()
	f, err := strconv.ParseFloat(s, 64)
	require.NoError(t, err)
	return strconv.FormatInt(int64(f+0.5), 10)
}

func mustParseDate(t *testing.T, s string) time.Time {
	t.Helper()
	d, err := time.Parse("2006-01-02", s)
	require.NoError(t, err)
	return d
}

// goldenVersion is the crowded-short live version with the golden universe and
// data policy, under a label past v0, as the golden test builds it (its spec
// differs from the live spec only in the policy the golden data needs).
func goldenVersion(t *testing.T) spec.Registered {
	t.Helper()
	r, ok := spec.Live(spec.StrategyCrowdedShortBreakout)
	require.True(t, ok)
	r.Label = "v1"
	s := r.Spec
	s.Universe = spec.UniverseSpec{Instruments: "ordinary", Freshness: "bar_on_session", MinSessions: 60, LookbackDays: 400, ASICReported: true, CAGuard: true, RSPopulation: "universe"}
	s.Data = spec.DataPolicy{
		ShortSource: "latest_complete_published", PublicationLagSessions: 4, MaxReportAgeSessions: 8,
		Calendar: "xjo_and_asic_dates", DTC: "v1_20_bars_min10_traded", Absent: "fail", Fundamentals: "live_snapshot",
		Price4dpFrom: backtestGoldenPrice4dp, CAUpjumpFrom: "2023-09-01",
	}
	r.Spec = s
	return r
}

// goldenTarget is the golden version traded by the golden recipe, with the
// hashes the store keys it by.
func goldenTarget(t *testing.T, pool *pgxpool.Pool) backtestTarget {
	t.Helper()
	reg := goldenVersion(t)
	rh, err := spec.RulesHash(reg.Spec)
	require.NoError(t, err)
	var recipe spec.Recipe
	for _, r := range spec.R1Recipes() {
		if r.StrategyID == spec.StrategyCrowdedShortBreakout {
			recipe = r
		}
	}
	recipe.WindowStart = backtestGoldenWindow
	recipeHash, err := spec.RecipeHash(recipe)
	require.NoError(t, err)
	rows, err := registeredVersions([]spec.Registered{reg})
	require.NoError(t, err)
	require.NoError(t, upsertRecipes(context.Background(), pool, []spec.Recipe{recipe}))
	require.NoError(t, (store{pool: pool}).upsertVersions(context.Background(), pool, civil.Date{Year: 2023, Month: time.June, Day: 2}, rows))
	return backtestTarget{Reg: reg, RulesHash: rh, Recipe: recipe, RecipeHash: recipeHash}
}

// withPublicationWired runs f with the gate's parts switched on, then restores
// the build's setting. The publication gate is tested for its refusals elsewhere.
func withPublicationWired(t *testing.T, f func()) {
	t.Helper()
	saved := publicationWired
	publicationWired = publicationParts{Sensitivity: true, Reference: true}
	defer func() { publicationWired = saved }()
	f()
}

func backtestOptsFor(t *testing.T, write bool, targets []backtestTarget) backtestOptions {
	t.Helper()
	return backtestOptions{
		Write:   write,
		Holder:  "test",
		Now:     time.Date(2026, 11, 13, 9, 0, 0, 0, time.UTC),
		Logf:    t.Logf,
		Sleep:   func(context.Context, time.Duration) error { return nil },
		Ping:    nil,
		Targets: targets,
		Build:   "test",
	}
}

func TestBacktestQueueOrdersPublishFirstAndDedupes(t *testing.T) {
	pool := backtestDB(t)
	ctx := context.Background()
	target := goldenTarget(t, pool)
	st := backtestStore{pool: pool}

	// A variant request queued before the publish: the publish still runs first.
	_, err := pool.Exec(ctx, `
		INSERT INTO strategy_backtest_requests (kind, strategy_id, rules_hash, recipe_hash, variant_id, dedupe_key, status)
		VALUES ('variant', $1, $2, $3, 'v-1', 'variant:v-1', 'queued')`,
		target.Reg.Spec.StrategyID, target.RulesHash, target.RecipeHash)
	require.NoError(t, err)

	require.NoError(t, st.enqueue(ctx, []backtestTarget{target}, time.Date(2026, 11, 13, 9, 0, 0, 0, time.UTC)))
	require.NoError(t, st.enqueue(ctx, []backtestTarget{target}, time.Date(2026, 11, 13, 9, 0, 0, 0, time.UTC)), "a repeat enqueue is a no-op")
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_requests WHERE kind = 'publish'`),
		"a new key costs one request: the weekly one is pending, so the immediate one is not added")

	batch, err := st.claimBatch(ctx, 5)
	require.NoError(t, err)
	require.Len(t, batch, 2)
	require.Equal(t, "publish", batch[0].Kind, "publish before variant")
	require.Equal(t, "variant", batch[1].Kind)
}

func TestBacktestClaimBatchStopsAtTheBatchSize(t *testing.T) {
	pool := backtestDB(t)
	ctx := context.Background()
	target := goldenTarget(t, pool)
	st := backtestStore{pool: pool}
	require.NoError(t, st.enqueue(ctx, []backtestTarget{target}, time.Date(2026, 11, 13, 9, 0, 0, 0, time.UTC)))
	// Two more queued variants: the batch of one takes the publish, the rest stay queued.
	for _, id := range []string{"v-2", "v-3"} {
		_, err := pool.Exec(ctx, `
			INSERT INTO strategy_backtest_requests (kind, strategy_id, rules_hash, recipe_hash, variant_id, dedupe_key, status)
			VALUES ('variant', $1, $2, $3, $4, $5, 'queued')`,
			target.Reg.Spec.StrategyID, target.RulesHash, target.RecipeHash, id, "variant:"+id)
		require.NoError(t, err)
	}
	batch, err := st.claimBatch(ctx, 1)
	require.NoError(t, err)
	require.Len(t, batch, 1, "the batch is bounded by its size; the rest stay queued")
	require.Equal(t, "publish", batch[0].Kind, "the publish is claimed ahead of the variants queued before it")
	require.Equal(t, 2, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_requests WHERE status = 'queued'`))
}

func TestBacktestGoldenRunMatchesItsCommittedHashAndPublishes(t *testing.T) {
	pool := backtestDB(t)
	seedGolden(t, pool)
	target := goldenTarget(t, pool)

	// The loader reads the stored rows; the simulator run over them must give the
	// output hash the golden test commits.
	ctx := context.Background()
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()
	windowEnd, ok, err := pgsource.BacktestWindowEnd(ctx, tx)
	require.NoError(t, err)
	require.True(t, ok)
	in, err := pgsource.LoadBacktestInputs(ctx, tx, windowEnd)
	require.NoError(t, err)
	res, err := backtest.Run(in, target.Reg.Spec, target.Recipe)
	require.NoError(t, err)
	want := goldenExpectedOutputHash(t)
	require.Equal(t, want, res.OutputHash, "the stored rows reproduce the golden run")

	// The job publishes the same run, through the gate with its parts wired.
	withPublicationWired(t, func() {
		res, err := runBacktest(ctx, pool, backtestOptsFor(t, true, []backtestTarget{target}))
		require.NoError(t, err)
		// The weekly and the first-publish requests both name the key: each is
		// published, and the second finds the first's run key already stored.
		require.GreaterOrEqual(t, res.Published, 1)
	})
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_runs WHERE kind = 'verify' AND status = 'succeeded'`),
		"the first publish of a key runs the verify pass")
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_runs WHERE kind = 'publish' AND published`))
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_series`))
	require.Equal(t, len(res.Trades), countRows(t, pool, `SELECT count(*) FROM strategy_backtest_trades`))
}

// goldenExpectedOutputHash reads the golden run's committed output hash.
func goldenExpectedOutputHash(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(backtestGoldenDir, "expected.json"))
	require.NoError(t, err)
	var want struct {
		OutputHash string `json:"output_hash"`
	}
	require.NoError(t, json.Unmarshal(b, &want))
	require.NotEmpty(t, want.OutputHash)
	return want.OutputHash
}

func TestBacktestPublishesRefuseWithoutTheGatesPartsInThisBuild(t *testing.T) {
	pool := backtestDB(t)
	seedGolden(t, pool)
	target := goldenTarget(t, pool)
	ctx := context.Background()
	res, err := runBacktest(ctx, pool, backtestOptsFor(t, true, []backtestTarget{target}))
	require.NoError(t, err)
	require.Equal(t, 0, res.Published, "this build stores the run unpublished")
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_runs WHERE kind = 'publish' AND status = 'succeeded' AND NOT published`))
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_runs WHERE published`))
}

func TestBacktestRerunOfAnIdenticalKeyIsDetectedNotStoredTwice(t *testing.T) {
	pool := backtestDB(t)
	seedGolden(t, pool)
	target := goldenTarget(t, pool)
	ctx := context.Background()
	in := loadWindowInputs(t, pool)
	d, base, err := backtest.Disclose(in, target.Reg.Spec, target.Recipe, civil.Date{Year: 2023, Month: time.June, Day: 2}, nil,
		windowEndOf(t, pool), "test", "")
	require.NoError(t, err)
	st := backtestStore{pool: pool}
	w := runWrite{Target: target, Recipe: target.Recipe, Kind: "publish", WindowEnd: windowEndOf(t, pool), Disclosures: d, Result: base, Build: "test", Fundamentals: "strict", Verified: true}
	first, err := st.writeRun(ctx, w)
	require.NoError(t, err)
	second, err := st.writeRun(ctx, w)
	require.NoError(t, err)
	require.Equal(t, first, second, "an identical run key returns the stored run")
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_runs WHERE kind = 'publish'`))
}

// loadWindowInputs reads the golden window's rows in one snapshot.
func loadWindowInputs(t *testing.T, pool *pgxpool.Pool) *backtest.MemoryInputs {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()
	end, ok, err := pgsource.BacktestWindowEnd(ctx, tx)
	require.NoError(t, err)
	require.True(t, ok)
	in, err := pgsource.LoadBacktestInputs(ctx, tx, end)
	require.NoError(t, err)
	return in
}

func TestBacktestVerifyMismatchFailsAsADeterminismFailure(t *testing.T) {
	pool := backtestDB(t)
	seedGolden(t, pool)
	target := goldenTarget(t, pool)
	ctx := context.Background()
	in := loadWindowInputs(t, pool)
	end := windowEndOf(t, pool)
	first, _, err := backtest.Disclose(in, target.Reg.Spec, target.Recipe, civil.Date{Year: 2023, Month: time.June, Day: 2}, nil,
		end, "test", "")
	require.NoError(t, err)

	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()
	opts := backtestOptsFor(t, false, nil)

	// The same snapshot reproduces the run: the verify pass passes.
	second, err := verifyPass(ctx, tx, target, target.Recipe, civil.Date{Year: 2023, Month: time.June, Day: 2}, end, opts, first)
	require.NoError(t, err)
	require.Equal(t, first.Identity.OutputHash, second.Identity.OutputHash)

	// A first run that disagrees with its rerun is a determinism failure.
	corrupt := first
	corrupt.Identity.OutputHash = "deadbeef"
	_, err = verifyPass(ctx, tx, target, target.Recipe, civil.Date{Year: 2023, Month: time.June, Day: 2}, end, opts, corrupt)
	require.ErrorIs(t, err, errDeterminism)
}

func TestBacktestDryRunWritesNothing(t *testing.T) {
	pool := backtestDB(t)
	seedGolden(t, pool)
	target := goldenTarget(t, pool)
	res, err := runBacktest(context.Background(), pool, backtestOptsFor(t, false, []backtestTarget{target}))
	require.NoError(t, err)
	require.Equal(t, 1, res.Processed)
	for _, table := range []string{"strategy_backtest_runs", "strategy_backtest_requests", "strategy_backtest_series", "strategy_backtest_trades"} {
		require.Equal(t, 0, countRows(t, pool, "SELECT count(*) FROM "+table), table)
	}
}

func TestBacktestComputableFromOnStoredStatements(t *testing.T) {
	pool := backtestDB(t)
	ctx := context.Background()
	// stock_fundamentals is not in the source tables: a database without 000132
	// reports no statements, which the derivation reads as not computable.
	empty, err := pgsource.BacktestStatements(ctx, pool, civil.Date{Year: 2025, Month: time.December, Day: 31})
	require.NoError(t, err)
	require.Empty(t, empty)

	_, err = pool.Exec(ctx, `
		CREATE TABLE stock_fundamentals (stock_code varchar, period_type varchar, period_end date,
		  revenue float8, net_income float8, total_equity float8, PRIMARY KEY (stock_code, period_type, period_end))`)
	require.NoError(t, err)
	// A 31 December 2023 result, its prior year, and a balance snapshot, for two codes.
	for _, code := range []string{"AAA", "BBB"} {
		for _, row := range []struct {
			typ, end string
			flow     bool
		}{
			{"annual", "2022-12-31", true}, {"annual", "2023-12-31", true},
			{"quarter", "2023-06-30", false},
		} {
			rev := any(nil)
			if row.flow {
				rev = 1000.0
			}
			_, err := pool.Exec(ctx, `INSERT INTO stock_fundamentals VALUES ($1, $2, $3::date, $4, $4, 1000)`, code, row.typ, row.end, rev)
			require.NoError(t, err)
		}
	}
	stmts, err := pgsource.BacktestStatements(ctx, pool, civil.Date{Year: 2025, Month: time.December, Day: 31})
	require.NoError(t, err)
	require.Len(t, stmts, 2)
	require.Equal(t, 3, len(stmts["AAA"]), "two flow rows and one balance snapshot")

	// The sessions of 2024: the derivation opens on the first month end on which the
	// 2023 result is known, and labels it by its own fiscal year.
	sessions := monthEndSessionsOf2024(t)
	got, err := backtest.DeriveComputableFrom(stmts, backtest.Needs{Growth: true}, sessions)
	require.NoError(t, err)
	require.True(t, got.Found)
	require.Equal(t, "2024-03-29", got.ComputableFrom.String())
	require.Equal(t, "FY2023", got.FiscalLabel)
}

// monthEndSessionsOf2024 is the weekdays of 2024, as sessions.
func monthEndSessionsOf2024(t *testing.T) []civil.Date {
	t.Helper()
	var out []civil.Date
	for d := (civil.Date{Year: 2024, Month: time.January, Day: 1}); d.Year == 2024; d = d.AddDays(1) {
		wd := time.Date(d.Year, d.Month, d.Day, 0, 0, 0, 0, time.UTC).Weekday()
		if wd != time.Saturday && wd != time.Sunday {
			out = append(out, d)
		}
	}
	return out
}

// goldenMemory rebuilds the golden dataset's inputs from the committed CSV, the
// way the golden test's own loader does, for the loader comparison.
func goldenMemory(t *testing.T) *backtest.MemoryInputs {
	t.Helper()
	m := &backtest.MemoryInputs{BarsByCode: map[string][]features.Bar{}, Divs: map[string][]features.Dividend{}, Funds: map[string]features.Fundamentals{}}
	m.Mkt.ETPs = map[string]bool{}
	m.Mkt.Names = map[string]string{}
	for _, r := range goldenCSV(t, "bars.csv") {
		m.BarsByCode[r[0]] = append(m.BarsByCode[r[0]], features.Bar{
			Date: civil.DateOf(mustParseDate(t, r[1])), Open: goldenFloat(t, r[2]), High: goldenFloat(t, r[3]), Low: goldenFloat(t, r[4]),
			Close: goldenFloat(t, r[5]), AdjClose: goldenFloat(t, r[6]), Volume: goldenFloat(t, r[7]),
		})
	}
	for _, r := range goldenCSV(t, "index.csv") {
		b := features.IndexBar{Date: civil.DateOf(mustParseDate(t, r[1])), High: goldenFloat(t, r[2]), Low: goldenFloat(t, r[3]), Close: goldenFloat(t, r[4])}
		if r[0] == "XJO" {
			m.Mkt.XJO = append(m.Mkt.XJO, b)
		} else {
			m.Mkt.XJT = append(m.Mkt.XJT, b)
		}
	}
	for _, r := range goldenCSV(t, "asic.csv") {
		pct := goldenFloat(t, r[5])
		m.Mkt.ASIC = append(m.Mkt.ASIC, features.ASICRow{
			Code: r[0], ReportDate: civil.DateOf(mustParseDate(t, r[1])), Product: r[2],
			Positions: goldenFloat(t, r[3]), Issued: goldenFloat(t, r[4]), Percent: &pct,
		})
	}
	for _, r := range goldenCSV(t, "dividends.csv") {
		m.Divs[r[0]] = append(m.Divs[r[0]], features.Dividend{ExDate: civil.DateOf(mustParseDate(t, r[1])), AmountPerShare: goldenFloat(t, r[2])})
	}
	for _, r := range goldenCSV(t, "rates.csv") {
		m.Mkt.CashRate = append(m.Mkt.CashRate, features.RatePoint{Date: civil.DateOf(mustParseDate(t, r[0])), Rate: goldenFloat(t, r[1])})
	}
	for _, r := range goldenCSV(t, "names.csv") {
		m.Mkt.Names[r[0]] = r[1]
	}
	return m
}

func goldenFloat(t *testing.T, s string) float64 {
	t.Helper()
	f, err := strconv.ParseFloat(s, 64)
	require.NoError(t, err)
	return f
}

// TestBacktestLoaderReadsTheGoldenRowsExactly holds the loader to the committed
// golden dataset field by field: a value the database returns differently from
// the CSV (a rounding, an order, a missing row) fails here, by name.
func TestBacktestLoaderReadsTheGoldenRowsExactly(t *testing.T) {
	pool := backtestDB(t)
	end := seedGolden(t, pool)
	ctx := context.Background()
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()
	got, err := pgsource.LoadBacktestInputs(ctx, tx, end)
	require.NoError(t, err)
	want := goldenMemory(t)

	require.Equal(t, len(want.BarsByCode), len(got.BarsByCode), "codes")
	for code, w := range want.BarsByCode {
		require.Equal(t, w, got.BarsByCode[code], "bars of %s", code)
	}
	require.Equal(t, want.Mkt.XJO, got.Mkt.XJO, "XJO")
	require.Equal(t, want.Mkt.XJT, got.Mkt.XJT, "XJT")
	require.Equal(t, want.Mkt.ASIC, got.Mkt.ASIC, "ASIC rows")
	for _, x := range want.Mkt.XJO {
		require.Equal(t, rateAt(want.Mkt.CashRate, x.Date), rateAt(got.Mkt.CashRate, x.Date), "cash rate on %s", x.Date)
	}
	require.Equal(t, want.Mkt.Names, got.Mkt.Names, "names")
	for code, w := range want.Divs {
		require.Equal(t, sortedDividends(w), sortedDividends(got.Divs[code]), "dividends of %s", code)
	}
}

// rateAt is the cash rate a session reads: the newest point dated on or before it.
func rateAt(points []features.RatePoint, t civil.Date) float64 {
	rate := 0.0
	for _, p := range points {
		if !p.Date.After(t) {
			rate = p.Rate
		}
	}
	return rate
}

// windowEndOf is the window end a backtest reads to, from the stored features phase.
func windowEndOf(t *testing.T, pool *pgxpool.Pool) civil.Date {
	t.Helper()
	end, ok, err := pgsource.BacktestWindowEnd(context.Background(), pool)
	require.NoError(t, err)
	require.True(t, ok)
	return end
}

// sortedDividends orders a code's dividends by ex-date, the order the reader returns.
func sortedDividends(ds []features.Dividend) []features.Dividend {
	out := append([]features.Dividend(nil), ds...)
	sort.Slice(out, func(i, j int) bool { return out[i].ExDate.Before(out[j].ExDate) })
	return out
}

func TestBacktestBudgetStopRequeuesTheRestOfTheBatch(t *testing.T) {
	pool := backtestDB(t)
	seedGolden(t, pool)
	target := goldenTarget(t, pool)
	ctx := context.Background()
	st := backtestStore{pool: pool}
	require.NoError(t, st.enqueue(ctx, []backtestTarget{target}, time.Date(2026, 11, 13, 9, 0, 0, 0, time.UTC)))

	opts := backtestOptsFor(t, true, []backtestTarget{target})
	opts.Budget = time.Nanosecond
	res, err := runBacktest(ctx, pool, opts)
	require.NoError(t, err)
	require.Equal(t, 0, res.Processed, "a spent budget starts no request")
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_runs`))
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_requests WHERE status = 'running'`),
		"the requests the budget stopped are queued again, not left running")
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_requests WHERE status = 'queued'`))
}

func TestBacktestNotComputableStoresTheOutcomeWithoutASimulation(t *testing.T) {
	pool := backtestDB(t)
	seedGolden(t, pool)
	ctx := context.Background()

	// A fundamentals strategy whose window opens at computable_from. The golden
	// dataset holds no statements, so the derivation finds nothing computable.
	reg, ok := spec.Live(spec.StrategyCANSLIM)
	require.True(t, ok)
	reg.Label = "v1"
	var recipe spec.Recipe
	for _, r := range spec.R1Recipes() {
		if r.StrategyID == spec.StrategyCANSLIM {
			recipe = r
		}
	}
	require.Equal(t, spec.WindowComputableFrom, recipe.WindowStart)
	rh, err := spec.RulesHash(reg.Spec)
	require.NoError(t, err)
	recipeHash, err := spec.RecipeHash(recipe)
	require.NoError(t, err)
	rows, err := registeredVersions([]spec.Registered{reg})
	require.NoError(t, err)
	require.NoError(t, upsertRecipes(ctx, pool, []spec.Recipe{recipe}))
	require.NoError(t, (store{pool: pool}).upsertVersions(ctx, pool, civil.Date{Year: 2023, Month: time.June, Day: 2}, rows))
	target := backtestTarget{Reg: reg, RulesHash: rh, Recipe: recipe, RecipeHash: recipeHash}

	res, err := runBacktest(ctx, pool, backtestOptsFor(t, true, []backtestTarget{target}))
	require.NoError(t, err)
	require.GreaterOrEqual(t, res.NotComputable, 1)
	require.Equal(t, 0, res.Published)
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_runs WHERE summary->>'state' = 'not_computable' AND status = 'succeeded' AND NOT published`),
		"the weekly and the immediate request store one outcome")
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_series`), "no simulation, no series")
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_trades`))
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_runs WHERE computable_from IS NULL AND fiscal_label IS NULL`),
		"a run that is not computable carries no date and no label")
}
