package strategies

// Tests of the real flow: the daily job's runs, not the catch-up called alone. They
// pin the boundaries and the paths the mutation checks target (the catch-up on the
// already-complete path, the superseded_on stop, the prune pin, the rollback gate).

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

// execSQL runs one statement in the test database and fails the test on an error.
func execSQL(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) error {
	t.Helper()
	_, err := pool.Exec(context.Background(), sql, args...)
	return err
}

// TestPaperCatchUpRunsOnTheCompletePath: a run whose session is already complete
// still catches the paper tracks up. The session's snapshot completed on an earlier
// run that had no paper tables (so no track stepped it); a later run finds the
// session complete and must still step the tracks over it.
func TestPaperCatchUpRunsOnTheCompletePath(t *testing.T) {
	pool := paperDB(t)
	days := paperTradingDays(paperRunFrom, paperRunTo)
	for _, table := range []string{"strategy_paper_trades", "strategy_paper_equity", "strategy_paper_checkpoints"} {
		require.NoError(t, execSQL(t, pool, "DROP TABLE "+table+" CASCADE"))
	}
	// The snapshot of days[10] completes with no paper tables: no track steps it.
	runPaperThrough(t, pool, days[10])
	b, err := os.ReadFile(filepath.Join(dailyMigrationsDir, "000159_strategy_paper.up.sql"))
	require.NoError(t, err)
	require.NoError(t, execSQL(t, pool, string(b)))
	// Every track starts on this run's catch-up over the complete sessions (the
	// stepping of the complete path is what this test is about).
	res := runPaperDay(t, pool, days[10])
	require.True(t, res.AlreadyDone, "the snapshot of the session is complete")
	for _, v := range versionsOf(t, pool) {
		if batchNeedsComputableFrom(t, v) {
			continue
		}
		require.Contains(t, paperEquityOf(t, pool, v), days[10],
			"%s: the complete-path run catches the track up", v.Target.Reg.Spec.StrategyID)
	}
}

// TestPaperSupersededStopsAtTheBoundary: a superseded version's track records every
// session before superseded_on and none from it, and its stop is the superseded
// session. The superseded session's snapshot is written first, then the version is
// marked superseded (the registry's own promotion of the successor does this in
// production), then the catch-up runs. The evaluation phase re-promotes a version the
// registry still names live, so the supersession is set after the snapshot write.
func TestPaperSupersededStopsAtTheBoundary(t *testing.T) {
	pool := paperDB(t)
	ctx := context.Background()
	days := paperTradingDays(paperRunFrom, paperRunTo)
	runPaperThrough(t, pool, days[6])
	v := batchableVersion(t, pool)
	// The superseded session's snapshot is written (the daily loop's runSession: the
	// three snapshot phases, no paper step).
	res := &dailyResult{D: days[7]}
	opts := dailyOptions{Write: true, Holder: "paper-test", Now: dayAt14(days[7]), Logf: t.Logf,
		Sleep: func(context.Context, time.Duration) error { return nil }}
	held, err := runSession(ctx, pool, store{pool: pool}, days[7], false, opts, res)
	require.NoError(t, err)
	require.Nil(t, held, "the superseded session is snapshotted")
	require.NoError(t, execSQL(t, pool, `UPDATE strategy_rule_versions SET status = 'superseded', superseded_on = $2::date
		WHERE rules_hash = $1`, v.Target.RulesHash, days[7].String()))
	require.NoError(t, paperCatchUp(ctx, pool, store{pool: pool}, days[7], true, t.Logf))
	eq := paperEquityOf(t, pool, v)
	require.Contains(t, eq, days[6], "the session before superseded_on is recorded")
	require.NotContains(t, eq, days[7], "the superseded session is not recorded by its track")
	cp, found, err := store{pool: pool}.paperCheckpointOf(ctx, v.Target.RulesHash, v.Target.RecipeHash)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, days[7].String(), cp.StoppedOn.String(), "the stop is the superseded session")
}

// TestPaperGuardsSkipACheckpointlessSupersededVersion: a superseded version that
// never started its track pins nothing. Its live_from guard would be read by no
// track, and would hold pruning for good.
func TestPaperGuardsSkipACheckpointlessSupersededVersion(t *testing.T) {
	pool := paperDB(t)
	ctx := context.Background()
	days := paperTradingDays(paperRunFrom, paperRunTo)
	runPaperThrough(t, pool, days[6])
	v := batchableVersion(t, pool)
	// Supersede the version and remove its track: it has no checkpoint, as a version
	// that was superseded before its track started has none.
	require.NoError(t, execSQL(t, pool, `UPDATE strategy_rule_versions SET status = 'superseded', superseded_on = $2::date
		WHERE rules_hash = $1`, v.Target.RulesHash, days[7].String()))
	require.NoError(t, execSQL(t, pool, `DELETE FROM strategy_paper_checkpoints WHERE rules_hash = $1`, v.Target.RulesHash))
	require.NoError(t, execSQL(t, pool, `DELETE FROM strategy_paper_equity WHERE rules_hash = $1`, v.Target.RulesHash))

	guards, err := paperGuards(ctx, store{pool: pool}, t.Logf)
	require.NoError(t, err)
	for _, g := range guards {
		require.True(t, g.After(days[1]), "no guard is held back by the checkpointless version (got %s)", g)
	}
	// The live versions' guards remain, so the test is not vacuous.
	require.NotEmpty(t, guards)
}

// TestPaperGuardsReturnsTheTracksGuards: paperGuards answers each live track's
// guard. A mutant that returns nil fails here, against Postgres.
func TestPaperGuardsReturnsTheTracksGuards(t *testing.T) {
	pool := paperDB(t)
	days := paperTradingDays(paperRunFrom, paperRunTo)
	runPaperThrough(t, pool, days[12])
	guards, err := paperGuards(context.Background(), store{pool: pool}, t.Logf)
	require.NoError(t, err)
	require.NotEmpty(t, guards, "the live tracks hold their guards")
	for _, g := range guards {
		require.False(t, g.IsZero())
		require.False(t, g.After(days[12]), "a guard is at or before the newest recorded session")
	}
}

// TestPaperFailsASessionWithoutCAKnown: a session written before ca_known is not
// stepped by a track, on any session it steps, not only its seed. The track fails
// with a clear error and the other tracks step. This is the rollback gate: an older
// image must not write sessions into the append-only record.
//
// The snapshot runs through days[5] with the paper tables absent, so no track has
// started. days[6] is then written as an older image would write it (without
// ca_known), and the daily run for days[7] runs the catch-up over it: every track
// starts on its live_from, owes days[6] as its first step, and must refuse it.
func TestPaperFailsASessionWithoutCAKnown(t *testing.T) {
	pool := paperDB(t)
	days := paperTradingDays(paperRunFrom, paperRunTo)
	// The paper tables are absent while the snapshot is written, so no track starts.
	for _, table := range []string{"strategy_paper_trades", "strategy_paper_equity", "strategy_paper_checkpoints"} {
		require.NoError(t, execSQL(t, pool, "DROP TABLE "+table+" CASCADE"))
	}
	runPaperThrough(t, pool, days[5])

	bad := days[6]
	// The session is written as an older image writes it: the snapshot for it is
	// complete, and its feature rows have no ca_known. The paper tables are still
	// absent, so no track steps it.
	runPaperDayWithoutPaper(t, pool, bad)
	// The migration is applied after the staged session, as the deploy applies it
	// before the first run that can step a track.
	b, err := os.ReadFile(filepath.Join(dailyMigrationsDir, "000159_strategy_paper.up.sql"))
	require.NoError(t, err)
	require.NoError(t, execSQL(t, pool, string(b)))
	require.NoError(t, execSQL(t, pool, `UPDATE strategy_features_daily SET features = features - 'ca_known'
		WHERE as_of = $1::date`, bad.String()))
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_features_daily
		WHERE as_of = $1::date AND features ? 'ca_known'`, bad.String()), "the staged session has no ca_known")

	_, err = runDailyWithLog(t, pool, days[7], func(string, ...any) {})
	require.Error(t, err, "the track refuses the session it owes that has no ca_known")
	require.Contains(t, err.Error(), "predates ca_known")

	stepped := 0
	for _, v := range versionsOf(t, pool) {
		if batchNeedsComputableFrom(t, v) {
			continue
		}
		stepped++
		_, has := paperEquityOf(t, pool, v)[bad]
		require.False(t, has, "%s stepped a session without ca_known", v.Target.Reg.Spec.StrategyID)
	}
	require.Greater(t, stepped, 0)
	for _, d := range []civil.Date{bad, days[7]} {
		require.Equal(t, 3, countRows(t, pool, `SELECT count(*) FROM strategy_daily_runs
			WHERE as_of = $1::date AND status = 'completed' AND phase IN ('features','evaluation','events')`, d.String()),
			"the snapshot of %s completed", d)
	}
}

// runPaperDayWithoutPaper writes one session's snapshot with the paper tables absent:
// the daily run's snapshot phases, then no paper step (the tables do not exist).
func runPaperDayWithoutPaper(t *testing.T, pool *pgxpool.Pool, day civil.Date) {
	t.Helper()
	runPaperDay(t, pool, day)
}

// runDailyWithLog runs the daily job for a day with a log sink, returning its error.
func runDailyWithLog(t *testing.T, pool *pgxpool.Pool, day civil.Date, logf func(string, ...any)) (dailyResult, error) {
	t.Helper()
	opts := dailyOptions{Write: true, Holder: "paper-test", Now: dayAt14(day), Logf: logf,
		Sleep: func(context.Context, time.Duration) error { return nil }}
	return runDaily(context.Background(), pool, opts)
}

// TestPaperWaitReadsNoSnapshot: a track that waits for a seed carrying ca_known
// decodes no full snapshot while it waits. The snapshot is written with no paper
// tables, and with ca_known absent from every row (as a pre-change deploy's rows
// are): no track has started, so each later run only checks the seed, one query per
// session, and reads no feature rows.
func TestPaperWaitReadsNoSnapshot(t *testing.T) {
	pool := paperDB(t)
	days := paperTradingDays(paperRunFrom, paperRunTo)
	for _, table := range []string{"strategy_paper_trades", "strategy_paper_equity", "strategy_paper_checkpoints"} {
		require.NoError(t, execSQL(t, pool, "DROP TABLE "+table+" CASCADE"))
	}
	runPaperThrough(t, pool, days[5])
	require.NoError(t, execSQL(t, pool, `UPDATE strategy_features_daily SET features = features - 'ca_known'`))
	b, err := os.ReadFile(filepath.Join(dailyMigrationsDir, "000159_strategy_paper.up.sql"))
	require.NoError(t, err)
	require.NoError(t, execSQL(t, pool, string(b)))

	reads := 0
	paperSnapshotReadHook = func() { reads++ }
	t.Cleanup(func() { paperSnapshotReadHook = nil })
	// Each session is written as a pre-change image writes it: its rows lose ca_known
	// right after the run, so every seed the track could start on is a pre-change row.
	for _, d := range days[6:10] {
		runPaperDay(t, pool, d)
		require.NoError(t, execSQL(t, pool, `UPDATE strategy_features_daily SET features = features - 'ca_known'
			WHERE as_of = $1::date`, d.String()))
	}
	require.Equal(t, 0, reads, "a wait for a seed that carries ca_known reads no full snapshot")
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_paper_equity`), "no track started")
}
