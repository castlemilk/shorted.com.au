package strategies

// Real-Postgres tests for the backtest job's contract: the strict pass 1 of a
// fundamentals strategy whose derivation finds computable_from, the not-ready
// requests and the stale running rows an earlier execution left, the weekend-dated
// index hold, a verify mismatch through the run (not the pure pass), a second read
// that fails after the first copy is released, the one published run of a key, and the revalidation wait with no open snapshot. They
// share backtestDB and the golden dataset with backtest_pg_test.go.
//
//	STRATEGIES_BACKTEST_TESTCONTAINERS=1 CGO_ENABLED=0 GOWORK=off \
//	  go test -tags=testcontainers -count=1 -run Backtest ./internal/jobs/strategies/

import (
	"context"
	"errors"
	"testing"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/backtest"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pgsource"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// contractNow is the clock the contract tests enqueue under (ISO week 2026-W46).
var contractNow = time.Date(2026, 11, 13, 9, 0, 0, 0, time.UTC)

// goldenTargetUnrecorded is the golden target with its hashes, not recorded in the
// database: the version and recipe rows the daily snapshot writes are absent.
func goldenTargetUnrecorded(t *testing.T) backtestTarget {
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
	return backtestTarget{Reg: reg, RulesHash: rh, Recipe: recipe, RecipeHash: recipeHash}
}

// recordGoldenTarget writes the target's version and recipe rows, as the daily
// snapshot does, with the freeze date the golden test uses.
func recordGoldenTarget(t *testing.T, pool *pgxpool.Pool, target backtestTarget) {
	t.Helper()
	ctx := context.Background()
	rows, err := registeredVersions([]spec.Registered{target.Reg})
	require.NoError(t, err)
	require.NoError(t, upsertRecipes(ctx, pool, []spec.Recipe{target.Recipe}))
	require.NoError(t, (store{pool: pool}).upsertVersions(ctx, pool, civil.Date{Year: 2023, Month: time.June, Day: 2}, rows))
}

// canslimTarget is the CAN SLIM target: a fundamentals strategy whose window opens
// at computable_from. record writes its version and recipe rows.
func canslimTarget(t *testing.T, pool *pgxpool.Pool, record bool) backtestTarget {
	t.Helper()
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
	target := backtestTarget{Reg: reg, RulesHash: rh, Recipe: recipe, RecipeHash: recipeHash}
	if record {
		recordGoldenTarget(t, pool, target)
	}
	return target
}

// seedCanslimStatements gives two codes an annual pair of results (FY2021 and
// FY2022) and a balance point. Their 31 December 2022 results are known from March
// 2023, so the derivation finds computable_from at the March 2023 month end, which
// the golden dataset holds, and labels it FY2022.
func seedCanslimStatements(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		CREATE TABLE stock_fundamentals (stock_code varchar, period_type varchar, period_end date,
		  revenue float8, net_income float8, total_equity float8, PRIMARY KEY (stock_code, period_type, period_end))`)
	require.NoError(t, err)
	for _, code := range []string{"AAA", "BBB"} {
		for _, end := range []string{"2021-12-31", "2022-12-31"} {
			_, err := pool.Exec(ctx, `INSERT INTO stock_fundamentals VALUES ($1, 'annual', $2::date, 1000, 100, 5000)`, code, end)
			require.NoError(t, err)
		}
	}
}

// TestBacktestPassOneStoresTheDerivationAndSimulatesNothing: a fundamentals
// strategy whose derivation finds a date gets one not-computable row that carries
// it. No series, no trades, no verify, and the dry run agrees.
func TestBacktestPassOneStoresTheDerivationAndSimulatesNothing(t *testing.T) {
	pool := backtestDB(t)
	seedGolden(t, pool)
	seedCanslimStatements(t, pool)
	target := canslimTarget(t, pool, true)
	ctx := context.Background()

	dry, err := runBacktest(ctx, pool, backtestOptsFor(t, false, []backtestTarget{target}))
	require.NoError(t, err, "a by-hand dry run of a computable fundamentals strategy does not abort")
	require.Equal(t, 1, dry.Pass1)
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_runs`), "the dry run writes nothing")

	res, err := runBacktest(ctx, pool, backtestOptsFor(t, true, []backtestTarget{target}))
	require.NoError(t, err)
	require.Equal(t, 1, res.Pass1)
	require.Equal(t, 0, res.Published)
	require.Equal(t, 1, countRows(t, pool, `
		SELECT count(*) FROM strategy_backtest_runs
		 WHERE kind = 'publish' AND status = 'succeeded' AND NOT published
		   AND summary->>'state' = 'not_computable'
		   AND computable_from = '2023-03-31' AND fiscal_label = 'FY2022'`),
		"the pass-1 row carries the derived date and its fiscal label")
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_series`), "no simulation, no series")
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_trades`))
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_runs WHERE kind = 'verify'`), "nothing simulated, nothing verified")
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_requests WHERE status = 'done'`))
}

// TestBacktestUnrecordedVersionWaitsAndAnAbandonedRequestFailsOnce: a version the
// daily snapshot has not recorded leaves its request queued (not failed). A row an
// earlier execution left running is failed under the lease, not queued again, so a
// request that kills its execution cannot repeat on every lease expiry; the day's
// immediate request is the one retry.
func TestBacktestUnrecordedVersionWaitsAndAnAbandonedRequestFailsOnce(t *testing.T) {
	pool := backtestDB(t)
	seedGolden(t, pool)
	ctx := context.Background()
	target := goldenTargetUnrecorded(t)
	st := backtestStore{pool: pool}
	require.NoError(t, st.enqueue(ctx, []backtestTarget{target}, contractNow))
	// An earlier execution claimed the request and died.
	_, err := pool.Exec(ctx, `UPDATE strategy_backtest_requests SET status = 'running', started_at = now()`)
	require.NoError(t, err)

	res, err := runBacktest(ctx, pool, backtestOptsFor(t, true, []backtestTarget{target}))
	require.NoError(t, err, "an abandoned request is not a run failure: the job exits 0")
	require.Equal(t, 0, res.Failed)
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_requests WHERE status = 'running'`))
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_requests WHERE status = 'failed' AND error = 'the execution that claimed it did not finish'`),
		"the abandoned request is failed, not queued again")
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_runs`))

	// The day's immediate request is queued by the next execution, and waits for the
	// unrecorded version without failing.
	res, err = runBacktest(ctx, pool, backtestOptsFor(t, true, []backtestTarget{target}))
	require.NoError(t, err)
	require.Equal(t, 1, res.NotReady)
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_requests WHERE status = 'queued'`),
		"the request waits in the queue, with no run and not failed")

	// The daily snapshot records the version; the next execution runs the request.
	recordGoldenTarget(t, pool, target)
	res, err = runBacktest(ctx, pool, backtestOptsFor(t, true, []backtestTarget{target}))
	require.NoError(t, err)
	require.Equal(t, 0, res.NotReady)
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_requests WHERE status = 'done'`))
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_runs WHERE kind = 'publish' AND status = 'succeeded'`))
}

// TestBacktestWeekendDatedIndexRowHoldsTheBatchUntilItIsGone: while an XJO or XJT
// row sits on a weekend the batch is held (queued, nothing written), and it runs
// once the row is gone.
func TestBacktestWeekendDatedIndexRowHoldsTheBatchUntilItIsGone(t *testing.T) {
	pool := backtestDB(t)
	seedGolden(t, pool)
	ctx := context.Background()
	target := goldenTarget(t, pool)
	st := backtestStore{pool: pool}
	require.NoError(t, st.enqueue(ctx, []backtestTarget{target}, contractNow))
	// 4 March 2023 is a Saturday: an index bar dated on it is an un-re-dated bar.
	_, err := pool.Exec(ctx, `INSERT INTO index_prices (index_code, date, high, low, close) VALUES ('XJO', '2023-03-04', 1, 1, 1)`)
	require.NoError(t, err)

	res, err := runBacktest(ctx, pool, backtestOptsFor(t, true, []backtestTarget{target}))
	require.NoError(t, err)
	require.True(t, res.Held)
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_runs`), "no run over index history not yet re-dated")
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_requests WHERE status = 'queued'`))

	_, err = pool.Exec(ctx, `DELETE FROM index_prices WHERE date = '2023-03-04'`)
	require.NoError(t, err)
	res, err = runBacktest(ctx, pool, backtestOptsFor(t, true, []backtestTarget{target}))
	require.NoError(t, err)
	require.False(t, res.Held)
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_runs WHERE kind = 'publish' AND status = 'succeeded'`))
}

// TestBacktestVerifySecondReadFailureStopsTheBatchWithoutAHistory: the verify pass
// releases the first copy before its second read, so a failed second read leaves
// the batch no history. The batch stops with an error (exit 1), the request is
// failed, and nothing is left running.
func TestBacktestVerifySecondReadFailureStopsTheBatchWithoutAHistory(t *testing.T) {
	pool := backtestDB(t)
	seedGolden(t, pool)
	target := goldenTarget(t, pool)
	ctx := context.Background()
	opts := backtestOptsFor(t, true, []backtestTarget{target})
	opts.Load = func(context.Context, pgsource.DB, civil.Date) (*backtest.MemoryInputs, error) {
		return nil, errors.New("the second read was refused")
	}

	res, err := runBacktest(ctx, pool, opts)
	require.Error(t, err)
	require.ErrorContains(t, err, "second read was refused")
	require.Equal(t, 1, res.Failed)
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_requests WHERE status = 'running'`))
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_requests WHERE status = 'failed'`))
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_runs WHERE kind = 'publish' AND status = 'succeeded'`))
}

// TestBacktestVerifyInputMismatchFailsTheRequestAndExitsTen runs the verify pass
// through runBacktest: a second read that differs fails the publish as a
// determinism failure, with a failed run and a failed request on the record.
func TestBacktestVerifyInputMismatchFailsTheRequestAndExitsTen(t *testing.T) {
	pool := backtestDB(t)
	seedGolden(t, pool)
	ctx := context.Background()
	target := goldenTarget(t, pool)
	opts := backtestOptsFor(t, true, []backtestTarget{target})
	// The verify pass's second read is the seam. This copy has one bar changed.
	opts.Load = func(ctx context.Context, db pgsource.DB, to civil.Date) (*backtest.MemoryInputs, error) {
		in, err := pgsource.LoadBacktestInputs(ctx, db, to)
		if err != nil {
			return nil, err
		}
		for _, bars := range in.BarsByCode {
			if len(bars) > 0 {
				bars[len(bars)-1].Close *= 1.01
				break
			}
		}
		return in, nil
	}

	res, err := runBacktest(ctx, pool, opts)
	require.ErrorIs(t, err, errDeterminism)
	require.Equal(t, 1, res.Determinism)
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_runs WHERE status = 'failed'`), "the failed publish is on the record")
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_requests WHERE status = 'failed'`))
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_runs WHERE status = 'succeeded' AND kind = 'publish'`),
		"no run of a mismatched publish is stored as succeeded")
}

// TestBacktestOnlyOneRunOfAKeyIsPublished: publishing a second run of a key flips
// the first off, so the one-published index holds.
func TestBacktestOnlyOneRunOfAKeyIsPublished(t *testing.T) {
	pool := backtestDB(t)
	seedGolden(t, pool)
	target := goldenTarget(t, pool)
	ctx := context.Background()
	st := backtestStore{pool: pool}
	end := windowEndOf(t, pool)
	for _, key := range []string{"run-a", "run-b"} {
		var d backtest.Disclosures
		d.Identity.RunKey = key
		d.Identity.InputHash = "in-" + key
		d.Identity.OutputHash = "out-" + key
		_, err := st.writeRun(ctx, runWrite{
			Target: target, Recipe: target.Recipe, Kind: "publish", WindowEnd: end,
			Disclosures: d, Publish: true, Build: "test", Fundamentals: "strict", Verified: true,
		})
		require.NoError(t, err)
	}
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_runs WHERE published`))
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_backtest_runs WHERE published AND run_key = 'run-b'`),
		"the later run is the published one")
}

// TestBacktestRevalidatesAfterSixteenMinutesWithNoOpenSnapshot: a batch that
// publishes waits sixteen minutes and then pings the strategy-backtests tag, and
// the read transaction is closed before the wait (no connection is held).
func TestBacktestRevalidatesAfterSixteenMinutesWithNoOpenSnapshot(t *testing.T) {
	pool := backtestDB(t)
	seedGolden(t, pool)
	target := goldenTarget(t, pool)
	ctx := context.Background()
	opts := backtestOptsFor(t, true, []backtestTarget{target})
	var slept []time.Duration
	var acquiredDuringWait int32 = -1
	opts.Sleep = func(_ context.Context, d time.Duration) error {
		slept = append(slept, d)
		acquiredDuringWait = pool.Stat().AcquiredConns()
		return nil
	}
	var pings []platform.RevalidateRequest
	opts.Ping = func(r platform.RevalidateRequest) { pings = append(pings, r) }

	res, err := runBacktest(ctx, pool, opts)
	require.NoError(t, err)
	require.Equal(t, 1, res.Published)
	require.Equal(t, []time.Duration{16 * time.Minute}, slept)
	require.Len(t, pings, 1)
	require.Equal(t, "strategy-backtests", pings[0].Tag)
	require.Equal(t, int32(0), acquiredDuringWait, "the read transaction is closed before the wait")
}

// TestBacktestVerifyRecordSatisfiesOnlyTheRunItReproduced: an older verify of a
// different input does not satisfy the gate for a run with another input.
func TestBacktestVerifyRecordSatisfiesOnlyTheRunItReproduced(t *testing.T) {
	pool := backtestDB(t)
	seedGolden(t, pool)
	target := goldenTarget(t, pool)
	ctx := context.Background()
	st := backtestStore{pool: pool}
	var d backtest.Disclosures
	d.Identity.RunKey = "verify-old"
	d.Identity.InputHash = "input-old"
	d.Identity.OutputHash = "output-old"
	_, err := st.writeRun(ctx, runWrite{
		Target: target, Recipe: target.Recipe, Kind: "verify", WindowEnd: windowEndOf(t, pool),
		Disclosures: d, Build: "test", Fundamentals: "strict", Verified: true,
	})
	require.NoError(t, err)

	ok, err := st.verifiedRun(ctx, target, "input-new", "output-old")
	require.NoError(t, err)
	require.False(t, ok, "a verify of another input does not verify this run")
	ok, err = st.verifiedRun(ctx, target, "input-old", "output-new")
	require.NoError(t, err)
	require.False(t, ok, "a verify of another output does not verify this run")
	ok, err = st.verifiedRun(ctx, target, "input-old", "output-old")
	require.NoError(t, err)
	require.True(t, ok)
}
