//go:build integration

package shorts

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// strategyBacktestReadStore builds the strategy tables the backtest readers use, from the real migrations
// 000156 (rules and recipes), 000158 (the backtest tables) and 000159 (the paper track). The trade reads join
// company names, so the company table is created when the test database does not have it.
func strategyBacktestReadStore(t *testing.T) *postgresStore {
	t.Helper()
	adminURL, err := testpostgres.Admin("SHORTS_TEST_POSTGRES_URL", "STRATEGY_ADMIN_TESTCONTAINERS")
	require.NoError(t, err, "start the strategy PostgreSQL container")
	if adminURL == "" {
		t.Skip("neither SHORTS_TEST_POSTGRES_URL nor STRATEGY_ADMIN_TESTCONTAINERS=1 is set")
	}
	pool, cleanup := isolatedTestDatabase(t, adminURL, "strategy_backtest_read")
	t.Cleanup(cleanup)
	ctx := context.Background()
	for _, file := range []string{"000156_strategy_engine.up.sql", "000158_strategy_backtests.up.sql", "000159_strategy_paper.up.sql"} {
		sql, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "migrations", file))
		require.NoError(t, err)
		_, err = pool.Exec(ctx, string(sql))
		require.NoError(t, err, file)
	}
	_, err = pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS "company-metadata" (stock_code varchar(50) PRIMARY KEY, company_name text)`)
	require.NoError(t, err)
	return &postgresStore{db: pool}
}

// seedBacktestMatrix records one live canonical version with its recipe, one variant version, and the runs
// the readers must tell apart. The ids are fixed so each assertion names the row it is about.
//
//	1  publishable: a published canonical run of the live key
//	2  superseded: a canonical publish that was published once and is no longer (published_at kept)
//	3  gate-refused: a succeeded canonical publish the publication gate did not let through
//	4  not computable: a canonical outcome with no series
//	5  verify: a rerun of a publish, never served
//	6  failed: a canonical publish that failed
//	7  variant: a published run of a variant version
//	8  variant id on a canonical key: a run a variant owns, not a canonical one
func seedBacktestMatrix(t *testing.T, s *postgresStore) (live, variant, recipe string) {
	t.Helper()
	ctx := context.Background()
	live, variant = strings.Repeat("a", 64), strings.Repeat("b", 64)
	recipe = strings.Repeat("c", 64)
	_, err := s.db.Exec(ctx, `
		INSERT INTO strategy_rule_versions (rules_hash, strategy_id, label, kind, engine_major, feature_set, canonical_json, status, live_from)
		VALUES ($1, 'zanger-breakout', 'v1', 'canonical', 1, 'fs1', '{}', 'live', '2026-11-01'),
		       ($2, 'zanger-breakout', 'variant:x', 'variant', 1, 'fs1', '{}', 'draft', NULL)`, live, variant)
	require.NoError(t, err)
	_, err = s.db.Exec(ctx, `
		INSERT INTO strategy_recipes (recipe_hash, strategy_id, recipe_id, canonical_json)
		VALUES ($1, 'zanger-breakout', 'zanger-r1', '{}')`, recipe)
	require.NoError(t, err)

	const published = `{"published_at":"2026-11-06T00:00:00Z"}`
	const computed = `{"state":"computed"}`
	runs := []struct {
		id                                 int
		kind, rules, status, summary, diag string
		published                          bool
		variantID                          string
	}{
		{1, "publish", live, "succeeded", computed, published, true, ""},
		{2, "publish", live, "succeeded", computed, published, false, ""},
		{3, "publish", live, "succeeded", computed, `{}`, false, ""},
		{4, "publish", live, "succeeded", `{"state":"not_computable","share":0.42}`, `{}`, false, ""},
		{5, "verify", live, "succeeded", computed, published, false, ""},
		{6, "publish", live, "failed", `{}`, `{}`, false, ""},
		{7, "publish", variant, "succeeded", computed, published, true, "v-1"},
		{8, "publish", live, "succeeded", computed, published, false, "v-2"},
	}
	for _, r := range runs {
		var variantArg any
		if r.variantID != "" {
			variantArg = r.variantID
		}
		_, err := s.db.Exec(ctx, `
			INSERT INTO strategy_backtest_runs (id, kind, strategy_id, rules_hash, recipe_hash, engine_version, status, published,
			  window_start, returns, benchmark_code, fundamentals, summary, diagnostics, variant_id, started_at, finished_at)
			VALUES ($1, $2, 'zanger-breakout', $3, $4, '1.1.1', $5, $6, '2019-05-01', 'total', 'XJT', 'strict', $7::jsonb, $8::jsonb, $9, now(), now())`,
			r.id, r.kind, r.rules, recipe, r.status, r.published, r.summary, r.diag, variantArg)
		require.NoError(t, err, "run %d", r.id)
	}
	// Trades: the publishable run has two, the gate-refused and variant runs have their own.
	for _, tr := range []struct {
		run        int
		seq        int
		code, exit string
	}{{1, 1, "BHP", "2024-03-01"}, {1, 2, "CBA", "2024-06-01"}, {3, 1, "WBC", "2024-07-01"}, {7, 1, "RIO", "2026-10-30"}, {8, 1, "NST", "2026-10-30"}} {
		_, err := s.db.Exec(ctx, `
			INSERT INTO strategy_backtest_trades (run_id, seq, stock_code, signal_date, entry_date, entry_price, exit_date, exit_price, exit_reason, sessions_held, gross_return_pct, net_return_pct, flags, open)
			VALUES ($1, $2, $3, '2024-01-01', '2024-01-02', 40, $4, 44, 'pivot_stop', 20, 10, 9.5, '{}', false)`,
			tr.run, tr.seq, tr.code, tr.exit)
		require.NoError(t, err)
	}
	return live, variant, recipe
}

// Which runs each reader serves: the publication gate, the canonical join and the variant exclusion all show
// up in these answers, against the real tables.
func TestBacktestReadersServeExactlyThePublishableCanonicalRuns(t *testing.T) {
	s := strategyBacktestReadStore(t)
	live, variant, recipe := seedBacktestMatrix(t, s)
	ctx := context.Background()

	for _, id := range []int64{1, 2, 4} {
		row, ok, err := s.ReadCanonicalBacktest(ctx, id)
		require.NoError(t, err)
		require.True(t, ok, "run %d is publishable and served by id", id)
		require.Equal(t, "zanger-breakout", row.StrategyID)
	}
	for _, id := range []int64{3, 5, 6, 7, 8, 999} {
		_, ok, err := s.ReadCanonicalBacktest(ctx, id)
		require.NoError(t, err)
		require.False(t, ok, "run %d must not be served by id", id)
	}

	live1, ok, err := s.ReadPublishedBacktest(ctx, "zanger-breakout", live, recipe)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, int64(1), live1.ID, "only the published canonical run is the live run")
	_, ok, err = s.ReadPublishedBacktest(ctx, "zanger-breakout", variant, recipe)
	require.NoError(t, err)
	require.False(t, ok, "a variant's published run is never the live run")

	nc, ok, err := s.ReadNotComputableBacktest(ctx, "zanger-breakout", live, recipe)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, int64(4), nc.ID, "the not-computable outcome is read as its own state")
}

// The trades of a run are served only with the run: a gate-refused run's trades and a variant's are unreachable.
func TestBacktestTradeReadsAreGatedWithTheRun(t *testing.T) {
	s := strategyBacktestReadStore(t)
	seedBacktestMatrix(t, s)
	ctx := context.Background()

	trades, err := s.ReadBacktestTrades(ctx, 1)
	require.NoError(t, err)
	require.Len(t, trades, 2)

	for _, id := range []int64{3, 7, 8} {
		got, err := s.ReadBacktestTrades(ctx, id)
		require.NoError(t, err)
		require.Empty(t, got, "run %d's trades are not served", id)
		n, err := s.CountBacktestTrades(ctx, id, BacktestTradeFilter{})
		require.NoError(t, err)
		require.Zero(t, n, "run %d's trades are not counted", id)
	}
}

// Keyset paging over a run's trades: the cursor is the seq, and the filters apply in SQL.
func TestBacktestTradePagesAreKeysetAndFiltered(t *testing.T) {
	s := strategyBacktestReadStore(t)
	seedBacktestMatrix(t, s)
	ctx := context.Background()

	first, err := s.ReadBacktestTradesPage(ctx, 1, BacktestTradeFilter{}, 0, 1)
	require.NoError(t, err)
	require.Len(t, first, 1)
	require.Equal(t, 1, first[0].Seq)

	second, err := s.ReadBacktestTradesPage(ctx, 1, BacktestTradeFilter{}, first[0].Seq, 1)
	require.NoError(t, err)
	require.Len(t, second, 1)
	require.Equal(t, 2, second[0].Seq)

	n, err := s.CountBacktestTrades(ctx, 1, BacktestTradeFilter{StockCode: "CBA"})
	require.NoError(t, err)
	require.Equal(t, 1, n)
	byStock, err := s.ReadBacktestTradesPage(ctx, 1, BacktestTradeFilter{StockCode: "CBA"}, 0, 10)
	require.NoError(t, err)
	require.Len(t, byStock, 1)
	require.Equal(t, "CBA", byStock[0].StockCode)
}

// The paper reads carry the engine that wrote each row (a track is not filtered by engine), XJT's raw close, and
// a closed trade's return columns (item 7 and item 4 on the database).
func TestPaperReadsCarryEngineBenchmarkAndReturns(t *testing.T) {
	s := strategyBacktestReadStore(t)
	live, _, recipe := seedBacktestMatrix(t, s)
	ctx := context.Background()
	_, err := s.db.Exec(ctx, `
		INSERT INTO strategy_paper_equity (rules_hash, recipe_hash, as_of, equity, cash, positions, benchmark, engine_version)
		VALUES ($1, $2, '2026-10-01', 100, 10, 2, 5200, '1.1.1'),
		       ($1, $2, '2026-10-02', 101, 10, 2, NULL, '1.2.0')`, live, recipe)
	require.NoError(t, err)
	_, err = s.db.Exec(ctx, `
		INSERT INTO strategy_paper_trades (strategy_id, engine_version, rules_hash, recipe_hash, stock_code, signal_date, entry_date, entry_price,
		  exit_date, exit_price, exit_reason, status, entry_score, sessions_held, gross_return_pct, net_return_pct)
		VALUES ('zanger-breakout', '1.2.0', $1, $2, 'RIO', '2026-10-01', '2026-10-02', 90, '2026-10-20', 95, 'pivot_stop', 'closed', 75.44, 12, 5.6, 5.1)`,
		live, recipe)
	require.NoError(t, err)

	eq, err := s.ReadPaperEquity(ctx, live, recipe)
	require.NoError(t, err)
	require.Len(t, eq, 2, "a track across an engine bump keeps every row")
	require.Equal(t, "1.1.1", eq[0].EngineVersion)
	require.Equal(t, "1.2.0", eq[1].EngineVersion)
	require.NotNil(t, eq[0].Benchmark)
	require.InDelta(t, 5200, *eq[0].Benchmark, 1e-9)
	require.Nil(t, eq[1].Benchmark, "no close on the session: the benchmark is absent, not zero")

	trades, err := s.ReadPaperTrades(ctx, live, recipe)
	require.NoError(t, err)
	require.Len(t, trades, 1)
	require.True(t, trades[0].HasNet)
	require.InDelta(t, 5.1, trades[0].NetReturnPct, 1e-9)
	require.InDelta(t, 5.6, trades[0].GrossReturnPct, 1e-9)
	require.Equal(t, 12, trades[0].SessionsHeld)
	require.InDelta(t, 75.4, trades[0].EntryScore, 0.05)
}
