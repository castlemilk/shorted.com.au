//go:build integration

package shorts

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/backtest"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// The public readers, against the real Postgres store (not the fake): a gate-refused run, a variant's run and
// a foreign run are not found by any reader, so TestPublicReadersNeverReturnVariants can fail on store
// behaviour. Opt in with SHORTS_TEST_POSTGRES_URL, or STRATEGY_ADMIN_TESTCONTAINERS=1 with the testcontainers tag.
func TestPublicReadersNeverReturnVariantsAgainstThePostgresStore(t *testing.T) {
	adminURL, err := testpostgres.Admin("SHORTS_TEST_POSTGRES_URL", "STRATEGY_ADMIN_TESTCONTAINERS")
	require.NoError(t, err, "start the strategy PostgreSQL container")
	if adminURL == "" {
		t.Skip("neither SHORTS_TEST_POSTGRES_URL nor STRATEGY_ADMIN_TESTCONTAINERS=1 is set")
	}
	ctx := context.Background()
	cfg, err := pgx.ParseConfig(adminURL)
	require.NoError(t, err)

	admin, err := pgxpool.NewWithConfig(ctx, mustConfig(t, adminURL))
	require.NoError(t, err)
	t.Cleanup(admin.Close)
	name := fmt.Sprintf("bt_public_%d", time.Now().UnixNano())
	_, err = admin.Exec(ctx, fmt.Sprintf(`CREATE DATABASE "%s"`, name))
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), fmt.Sprintf(`DROP DATABASE IF EXISTS "%s" WITH (FORCE)`, name))
	})

	dbCfg := cfg.Copy()
	dbCfg.Database = name
	pool, err := pgxpool.NewWithConfig(ctx, mustPoolConfig(t, dbCfg))
	require.NoError(t, err)
	defer pool.Close()
	for _, file := range []string{"000156_strategy_engine.up.sql", "000158_strategy_backtests.up.sql", "000159_strategy_paper.up.sql"} {
		sql, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "migrations", file))
		require.NoError(t, err)
		_, err = pool.Exec(ctx, string(sql))
		require.NoError(t, err, file)
	}
	_, err = pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS "company-metadata" (stock_code varchar(50) PRIMARY KEY, company_name text)`)
	require.NoError(t, err)

	// The registry's live crowded-short version and recipe, so the live reads resolve to them.
	id := spec.StrategyCrowdedShortBreakout
	rules, recipe := liveKeysOf(t, id)
	variant := strings.Repeat("e", 64)
	_, err = pool.Exec(ctx, `
		INSERT INTO strategy_rule_versions (rules_hash, strategy_id, label, kind, engine_major, feature_set, canonical_json, status, live_from)
		VALUES ($1, $2, 'v1', 'canonical', 1, 'fs1', '{}', 'live', '2026-11-01'),
		       ($3, $2, 'variant:x', 'variant', 1, 'fs1', '{}', 'draft', NULL)`, rules, id, variant)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO strategy_recipes (recipe_hash, strategy_id, recipe_id, canonical_json) VALUES ($1, $2, 'csb-r1', '{}')`, recipe, id)
	require.NoError(t, err)

	// Run 101: the publishable run. 102: gate-refused (succeeded, never published). 103: a variant's run.
	published, series, trades := fixtureRun(t, id, 101, backtest.MeasurementMeasured)
	gated, _, gatedTrades := fixtureRun(t, id, 102, backtest.MeasurementMeasured)
	variantRun, _, variantTrades := fixtureRun(t, id, 103, backtest.MeasurementMeasured)
	insertRun(t, pool, published, `{"published_at":"2026-11-06T00:00:00Z"}`, true, "")
	insertRun(t, pool, gated, `{}`, false, "")
	variantRun.RulesHash = variant // the variant's own version: the live key's published slot is not its
	insertRun(t, pool, variantRun, `{"published_at":"2026-11-06T00:00:00Z"}`, true, "v-1")
	_, err = pool.Exec(ctx, `INSERT INTO strategy_backtest_series (run_id, points) VALUES (101, $1::jsonb)`, string(series))
	require.NoError(t, err)
	for _, run := range []struct {
		id int64
		tr []shortsstore.BacktestTradeRow
	}{{101, trades}, {102, gatedTrades}, {103, variantTrades}} {
		for _, tr := range run.tr {
			_, err := pool.Exec(ctx, `
				INSERT INTO strategy_backtest_trades (run_id, seq, stock_code, signal_date, entry_date, entry_price, exit_date, exit_price, exit_reason, sessions_held, gross_return_pct, net_return_pct, flags, open)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, '{}', $13)`,
				run.id, tr.Seq, tr.StockCode, tr.SignalDate, tr.EntryDate, tr.EntryPrice, nullable(tr.ExitDate), tr.ExitPrice, tr.ExitReason, tr.SessionsHeld, tr.GrossReturnPct, tr.NetReturnPct, tr.Open)
			require.NoError(t, err)
		}
	}

	st, err := shortsstore.NewStore(shortsstore.Config{
		StorageBackend:   shortsstore.PostgresStore,
		PostgresAddress:  fmt.Sprintf("%s:%d", cfg.Host, cfg.Port),
		PostgresUsername: cfg.User,
		PostgresPassword: cfg.Password,
		PostgresDatabase: name,
	})
	require.NoError(t, err)
	reader, ok := st.(shortsstore.StrategyBacktestStore)
	require.True(t, ok, "the Postgres store is the backtest reader")
	srv := newTestServer(t, newBacktestStoresMock(t))
	srv.strategyBacktests = reader

	// The publishable run is served, and only it.
	run, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: id}))
	require.NoError(t, err)
	assert.Equal(t, "published", run.Msg.Run.State)
	assert.Equal(t, int64(101), run.Msg.Run.Identity.RunId)
	for _, runID := range []int64{102, 103, 999} {
		_, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: id, RunId: runID}))
		assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err), "run %d is not served by id", runID)
		_, err = srv.ListBacktestTrades(resolvedPremiumContext(), connect.NewRequest(&shortsv1alpha1.ListBacktestTradesRequest{RunId: runID}))
		assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err), "run %d's trades are not served", runID)
	}
	byID, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: id, RunId: 101}))
	require.NoError(t, err)
	assert.Equal(t, "published", byID.Msg.Run.State)

	// The evidence lists the live canonical version only.
	ev, err := srv.ListStrategyEvidence(anonymousContext(), connect.NewRequest(&shortsv1alpha1.ListStrategyEvidenceRequest{}))
	require.NoError(t, err)
	for _, e := range ev.Msg.Strategies {
		if e.Version != nil {
			assert.Equal(t, "canonical", e.Version.Kind, e.StrategyId)
		}
		if e.StrategyId == id {
			assert.Equal(t, "published", e.State)
			assert.Equal(t, int64(101), e.RunId)
		}
	}
}

// liveKeysOf is a strategy's live rules and recipe hashes.
func liveKeysOf(t *testing.T, id string) (string, string) {
	t.Helper()
	reg, ok := spec.Live(id)
	require.True(t, ok)
	require.NotNil(t, reg.Recipe)
	rules, err := spec.RulesHash(reg.Spec)
	require.NoError(t, err)
	recipe, err := spec.RecipeHash(*reg.Recipe)
	require.NoError(t, err)
	return rules, recipe
}

// insertRun writes one run row of the fixture with its published state and diagnostics.
func insertRun(t *testing.T, pool *pgxpool.Pool, row shortsstore.BacktestRunRow, diagnostics string, published bool, variantID string) {
	t.Helper()
	var variant any
	if variantID != "" {
		variant = variantID
	}
	_, err := pool.Exec(context.Background(), `
		INSERT INTO strategy_backtest_runs (id, run_key, kind, strategy_id, rules_hash, recipe_hash, engine_version, status, published,
		  window_start, window_end, returns, benchmark_code, fundamentals, prices_through, in_sample_until, summary, diagnostics, variant_id, started_at, finished_at)
		VALUES ($1, $2, 'publish', $3, $4, $5, $6, 'succeeded', $7, '2019-05-01', '2026-11-05', 'total', 'XJT', 'strict', '2026-11-05', $8, $9::jsonb, $10::jsonb, $11, now(), now())`,
		row.ID, row.RunKey, row.StrategyID, row.RulesHash, row.RecipeHash, engine.Version, published, row.InSampleUntil, string(row.Summary), diagnostics, variant)
	require.NoError(t, err)
}

// nullable is an empty string as SQL NULL.
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// mustConfig and mustPoolConfig parse a connection string for a pool.
func mustConfig(t *testing.T, url string) *pgxpool.Config {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(url)
	require.NoError(t, err)
	return cfg
}

func mustPoolConfig(t *testing.T, cfg *pgx.ConnConfig) *pgxpool.Config {
	t.Helper()
	pc, err := pgxpool.ParseConfig(fmt.Sprintf("postgres://%s:%s@%s:%d/%s", cfg.User, cfg.Password, cfg.Host, cfg.Port, cfg.Database))
	require.NoError(t, err)
	return pc
}
