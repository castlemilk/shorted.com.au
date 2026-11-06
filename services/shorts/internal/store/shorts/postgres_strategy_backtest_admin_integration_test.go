//go:build integration

package shorts

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// strategyAdminTestStore builds the strategy tables the admin status and queue read,
// from the real migrations 000156 and 000158.
func strategyAdminTestStore(t *testing.T) *postgresStore {
	t.Helper()
	adminURL, err := testpostgres.Admin("SHORTS_TEST_POSTGRES_URL", "STRATEGY_ADMIN_TESTCONTAINERS")
	require.NoError(t, err, "start the strategy admin PostgreSQL container")
	if adminURL == "" {
		t.Skip("neither SHORTS_TEST_POSTGRES_URL nor STRATEGY_ADMIN_TESTCONTAINERS=1 is set")
	}
	pool, cleanup := isolatedTestDatabase(t, adminURL, "strategy_admin")
	t.Cleanup(cleanup)
	ctx := context.Background()
	for _, file := range []string{"000156_strategy_engine.up.sql", "000158_strategy_backtests.up.sql"} {
		sql, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "migrations", file))
		require.NoError(t, err)
		_, err = pool.Exec(ctx, string(sql))
		require.NoError(t, err, file)
	}
	return &postgresStore{db: pool}
}

// seedStrategyAdmin records one live canonical version with its recipe, one variant
// version, and one canonical and one variant backtest run of the live version.
func seedStrategyAdmin(t *testing.T, s *postgresStore) (live, variant, recipe string) {
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
	_, err = s.db.Exec(ctx, `
		INSERT INTO strategy_backtest_runs (kind, strategy_id, rules_hash, recipe_hash, engine_version, status, published,
		  window_start, window_end, returns, benchmark_code, fundamentals, build_revision, goarch, summary, diagnostics, started_at, finished_at)
		VALUES ('publish', 'zanger-breakout', $1, $3, '1.1.0', 'succeeded', true, '2019-05-01', '2026-11-05', 'total', 'XJT', 'strict',
		  'test', 'arm64', '{"state":"computed","diff":{"state":"changed","rewritten_count":3,"price_rows_rewritten":["AAA","BBB","CCC"]}}', '{"published_at":"2026-11-06T00:00:00Z"}', now(), now()),
		       ('publish', 'zanger-breakout', $2, $3, '1.1.0', 'succeeded', false, '2019-05-01', '2026-11-05', 'total', 'XJT', 'strict',
		  'test', 'arm64', '{"state":"computed"}', '{}', now(), now())`, live, variant, recipe)
	require.NoError(t, err)
	return live, variant, recipe
}

// The admin queue refuses a variant hash and queues a live canonical version once,
// then names the request it already holds.
func TestStrategyBacktestQueueRefusesVariantsAndDedupes(t *testing.T) {
	s := strategyAdminTestStore(t)
	live, variant, recipe := seedStrategyAdmin(t, s)
	ctx := context.Background()

	_, err := s.QueueStrategyBacktest(ctx, QueueStrategyBacktestRequest{RulesHash: variant, RecipeHash: recipe, Actor: "oauth:uid"})
	require.True(t, errors.Is(err, ErrBacktestRefused), "a variant hash is refused: %v", err)
	require.NotContains(t, err.Error(), "variant:x", "a refusal never echoes a variant's name")

	first, err := s.QueueStrategyBacktest(ctx, QueueStrategyBacktestRequest{StrategyID: "zanger-breakout", Version: "v1", RulesHash: live, RecipeHash: recipe, Actor: "oauth:uid"})
	require.NoError(t, err)
	require.Equal(t, "queued", first.Status)
	require.Equal(t, "v1", first.Label)

	again, err := s.QueueStrategyBacktest(ctx, QueueStrategyBacktestRequest{RulesHash: live, RecipeHash: recipe})
	require.NoError(t, err)
	require.Equal(t, "already_queued", again.Status)
	require.Equal(t, first.RequestID, again.RequestID)

	// The request carries the canonical key the job matches on.
	var requestedBy string
	require.NoError(t, s.db.QueryRow(ctx, `SELECT requested_by FROM strategy_backtest_requests WHERE id = $1`, first.RequestID).Scan(&requestedBy))
	require.Equal(t, "oauth:uid", requestedBy)
}

// The status carries the queue and the canonical runs, and no variant run.
func TestStrategyStatusCarriesCanonicalRunsAndTheQueueOnly(t *testing.T) {
	s := strategyAdminTestStore(t)
	_, _, recipe := seedStrategyAdmin(t, s)
	live := strings.Repeat("a", 64)
	ctx := context.Background()
	_, err := s.QueueStrategyBacktest(ctx, QueueStrategyBacktestRequest{StrategyID: "zanger-breakout", Version: "v1", RulesHash: live, RecipeHash: recipe})
	require.NoError(t, err)

	st, err := s.StrategyDailyStatus(ctx, 3)
	require.NoError(t, err)
	require.True(t, st.Migrated)
	require.Len(t, st.BacktestRuns, 1, "the variant run is not reported")
	run := st.BacktestRuns[0]
	require.Equal(t, "v1", run.Label)
	require.Equal(t, "computed", run.State)
	require.True(t, run.Published)
	require.Equal(t, "changed", run.DiffState)
	require.Equal(t, int64(3), run.RewrittenCodes)
	require.Len(t, st.BacktestQueue, 1)
	require.Equal(t, "publish", st.BacktestQueue[0].Kind)
	require.Equal(t, int64(1), st.BacktestQueue[0].Count)
}

// TestStrategyStatusCompletionCountsOnlyTheSnapshotPhases: a session is complete when
// its features, evaluation and events phases completed. A session with a completed
// paper row and no events is not complete, and a paper row never makes one complete.
func TestStrategyStatusCompletionCountsOnlyTheSnapshotPhases(t *testing.T) {
	s := strategyAdminTestStore(t)
	ctx := context.Background()
	_, err := s.db.Exec(ctx, `
		INSERT INTO strategy_daily_runs (as_of, phase, status, engine_version) VALUES
		  ('2026-11-10', 'features', 'completed', '1'),
		  ('2026-11-10', 'evaluation', 'completed', '1'),
		  ('2026-11-10', 'events', 'completed', '1'),
		  ('2026-11-11', 'features', 'completed', '1'),
		  ('2026-11-11', 'evaluation', 'completed', '1'),
		  ('2026-11-11', 'paper', 'completed', '1')`)
	require.NoError(t, err)

	st, err := s.StrategyDailyStatus(ctx, 3)
	require.NoError(t, err)
	require.Equal(t, "2026-11-10", st.LastCompleted, "the paper row does not complete 2026-11-11")

	_, err = s.db.Exec(ctx, `INSERT INTO strategy_daily_runs (as_of, phase, status, engine_version)
		VALUES ('2026-11-11', 'events', 'completed', '1')`)
	require.NoError(t, err)
	st, err = s.StrategyDailyStatus(ctx, 3)
	require.NoError(t, err)
	require.Equal(t, "2026-11-11", st.LastCompleted, "the three snapshot phases complete the session, with or without paper")
}
