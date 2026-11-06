package strategies

// Real-Postgres tests for the paper track: the daily job's paper phase over
// stored snapshot rows, against the batch simulator run over the same sessions.
// They run under the same opt-in as the daily tests:
//
//	STRATEGIES_DAILY_TESTCONTAINERS=1 CGO_ENABLED=0 GOWORK=off \
//	  go test -tags=testcontainers -count=1 -run Paper ./internal/jobs/strategies/
//
// or STRATEGIES_DAILY_DATABASE_URL names a server. Without either they skip.
//
// The fixture's statuses come from a test session builder: the engine reads its
// rules from full price features, which a fixture does not carry, so the builder
// sets the status of two codes on chosen sessions and leaves every other field to
// the production builder. The batch run uses the same builder over the same
// stored rows, so the two agree on everything except the state the paper track
// carries between runs, which is what these tests check.

import (
	"context"
	"testing"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/backtest"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pgsource"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/snapshot"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// statusTriggered is the engine's triggered status, which the backtest package keeps unexported.
const statusTriggered = "triggered"

// paperSessions are the trading sessions the fixture writes, oldest first. The
// first is the seed of the track that goes live on the second.
var paperSessions = []civil.Date{
	paperDay(11), paperDay(12), paperDay(13), paperDay(16),
	paperDay(17), paperDay(18), paperDay(19), paperDay(20),
}

// paperTriggers are the sessions each code is triggered on. AAA enters on the
// session after its first trigger; BBB is never triggered, so it holds nothing.
var paperTriggers = map[string][]civil.Date{
	"AAA": {paperDay(12), paperDay(16)},
}

// paperBars is one code's bar on a session: the price rises a little each day
// and every session is traded.
func paperBar(code string, s civil.Date) features.Bar {
	base := 10.0
	if code == "BBB" {
		base = 20
	}
	n := float64(s.Day)
	return features.Bar{Date: s, Open: base + n*0.05, High: base + n*0.05 + 0.2, Low: base + n*0.05 - 0.2,
		Close: base + n*0.05 + 0.1, AdjClose: base + n*0.05 + 0.1, Volume: 1e6}
}

// writePaperFixture writes the feature rows, the regime and the live versions of
// the fixture: the seed session's rows too, so the track can start on live_from.
func writePaperFixture(t *testing.T, pool *pgxpool.Pool, sessions []civil.Date) {
	t.Helper()
	ctx := context.Background()
	for _, s := range sessions {
		var rows []snapshot.Row
		for _, code := range []string{"AAA", "BBB"} {
			meta, err := snapshot.EncodeMeta(snapshot.Meta{Name: code, PricedSessions: 100})
			require.NoError(t, err)
			b := paperBar(code, s)
			rows = append(rows, snapshot.Row{
				AsOf: s, BarDate: s, FeatureSet: snapshotFeatureSet, StockCode: code,
				OrdinaryFresh60: true, IsOrdinary: true,
				Features: snapshot.Features{Bar: snapshot.Bar{O: b.Open, H: b.High, L: b.Low, C: b.Close, Adj: b.AdjClose, V: b.Volume}},
				Meta:     meta,
			})
		}
		require.NoError(t, pgsource.WriteFeatureRows(ctx, pool, rows))
		require.NoError(t, pgsource.WriteRegime(ctx, pool, s, engine.DefaultIndexCode, engine.Regime{IndexCode: engine.DefaultIndexCode}))
	}
	st := store{pool: pool}
	versions, err := registeredVersions(spec.Registry())
	require.NoError(t, err)
	require.NoError(t, st.upsertVersions(ctx, pool, paperSessions[1], versions))
	require.NoError(t, upsertRecipes(ctx, pool, spec.R1Recipes()))
}

// paperBuilder is the test session builder: the production builder, with the
// statuses the fixture names.
func paperBuilder(t *testing.T) func(rows, prev []snapshot.Row, blobs map[string]features.Fundamentals, regime engine.Regime,
	reg spec.Registered, s civil.Date, index int, seed bool, rate float64, holdings []string) (backtest.Session, error) {
	return func(rows, prev []snapshot.Row, blobs map[string]features.Fundamentals, regime engine.Regime,
		reg spec.Registered, s civil.Date, index int, seed bool, rate float64, holdings []string) (backtest.Session, error) {
		sess, err := paperSessionOf(rows, prev, blobs, regime, reg, s, index, seed, rate, holdings)
		if err != nil {
			return sess, err
		}
		for i := range sess.Codes {
			cs := &sess.Codes[i]
			for _, d := range paperTriggers[cs.Code] {
				if d == s {
					cs.Status = statusTriggered
					cs.Score = 80
					cs.Pivot = 10.5
					cs.DV20 = 1e9
				}
			}
		}
		return sess, nil
	}
}

// usePaperBuilder swaps the test builder in for one test.
func usePaperBuilder(t *testing.T, b func(rows, prev []snapshot.Row, blobs map[string]features.Fundamentals, regime engine.Regime,
	reg spec.Registered, s civil.Date, index int, seed bool, rate float64, holdings []string) (backtest.Session, error)) {
	t.Helper()
	prev := paperSessionBuilder
	paperSessionBuilder = b
	t.Cleanup(func() { paperSessionBuilder = prev })
}

func paperLogf(t *testing.T) func(string, ...any) {
	return func(format string, args ...any) { t.Logf(format, args...) }
}

// paperTarget is the live target of one strategy, from the registry the phase reads.
func paperTarget(t *testing.T, strategyID string) backtestTarget {
	t.Helper()
	targets, err := paperTargetsOf()
	require.NoError(t, err)
	for _, tg := range targets {
		if tg.Reg.Spec.StrategyID == strategyID {
			return tg
		}
	}
	t.Fatalf("no live target for %s", strategyID)
	return backtestTarget{}
}

// batchPaper runs the simulator over the stored rows of the sessions with no
// checkpoint between them: the one run a paper track must equal. It returns the
// per-session records after the seed and the closed trades.
func batchPaper(t *testing.T, pool *pgxpool.Pool, target backtestTarget, sessions []civil.Date) ([]backtest.Record, []backtest.Trade, *backtest.State) {
	t.Helper()
	ctx := context.Background()
	cfg, err := paperConfig(target)
	require.NoError(t, err)
	st := backtest.NewState(cfg)
	build := paperBuilder(t)
	read := func(d civil.Date) paperSnapshot {
		snap, ok, err := readPaperSnapshot(ctx, pool, d)
		require.NoError(t, err)
		require.True(t, ok, "rows of %s", d)
		return snap
	}
	seedDay := sessions[0]
	seedSnap := read(seedDay)
	rates, err := pgsource.CashRate(ctx, pool, seedDay)
	require.NoError(t, err)
	seed, err := build(seedSnap.Rows, nil, seedSnap.Blobs, seedSnap.Regime, target.Reg, seedDay, 0, true, backtest.CashRateFraction(rates, seedDay), nil)
	require.NoError(t, err)
	backtest.Step(st, seed)
	for i, d := range sessions[1:] {
		cur := read(d)
		prev := read(sessions[i])
		var holdings []string
		for _, h := range st.Holdings() {
			holdings = append(holdings, h.Code)
		}
		rates, err := pgsource.CashRate(ctx, pool, d)
		require.NoError(t, err)
		sess, err := build(cur.Rows, prev.Rows, cur.Blobs, cur.Regime, target.Reg, d, i+1, false, backtest.CashRateFraction(rates, d), holdings)
		require.NoError(t, err)
		backtest.Step(st, sess)
	}
	var closed []backtest.Trade
	for _, tr := range st.Finish() {
		if !tr.OpenAtEnd {
			closed = append(closed, tr)
		}
	}
	return st.Records(), closed, st
}

// paperEquityRows reads one track's equity rows, by session.
func paperEquityRows(t *testing.T, pool *pgxpool.Pool, target backtestTarget) map[civil.Date][3]float64 {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
		SELECT as_of, equity, cash, positions FROM strategy_paper_equity
		 WHERE rules_hash = $1 AND recipe_hash = $2 ORDER BY as_of`, target.RulesHash, target.RecipeHash)
	require.NoError(t, err)
	defer rows.Close()
	out := map[civil.Date][3]float64{}
	for rows.Next() {
		var (
			asOf      time.Time
			eq, cash  float64
			positions int
		)
		require.NoError(t, rows.Scan(&asOf, &eq, &cash, &positions))
		out[civil.DateOf(asOf)] = [3]float64{eq, cash, float64(positions)}
	}
	require.NoError(t, rows.Err())
	return out
}

// TestStepEqualsRun: N persisted daily steps over the
// stored rows equal one batch run over the same N sessions, for every live
// version: the equity of every session, the trades that closed, and the trades
// still open at the end.
func TestStepEqualsRun(t *testing.T) {
	pool := dailyDB(t)
	writePaperFixture(t, pool, paperSessions)
	usePaperBuilder(t, paperBuilder(t))
	ctx := context.Background()

	require.NoError(t, runPaperPhase(ctx, pool, store{pool: pool}, paperSessions[len(paperSessions)-1], true, paperLogf(t)))

	targets, err := paperTargetsOf()
	require.NoError(t, err)
	require.Len(t, targets, 5, "one live target per launch strategy")
	trades := 0
	for _, target := range targets {
		records, closed, batch := batchPaper(t, pool, target, paperSessions)
		// The batch's records are the sessions after the seed: the track's first
		// recorded session is paperSessions[1].
		got := paperEquityRows(t, pool, target)
		require.Len(t, got, len(paperSessions)-1, "one equity row per recorded session, %s", target.Reg.Spec.StrategyID)
		require.Len(t, records, len(paperSessions)-1)
		for i, rec := range records {
			day := paperSessions[i+1]
			row, ok := got[day]
			require.True(t, ok, "equity row for %s %s", target.Reg.Spec.StrategyID, day)
			require.Equal(t, rec.Equity, row[0], "equity on %s, %s", day, target.Reg.Spec.StrategyID)
			require.Equal(t, rec.Cash, row[1], "cash on %s, %s", day, target.Reg.Spec.StrategyID)
		}
		storedClosed := closedTradesOf(t, pool, target)
		require.Equal(t, len(closed), len(storedClosed), "closed trades, %s", target.Reg.Spec.StrategyID)
		for i, tr := range closed {
			require.Equal(t, tr.Code, storedClosed[i].Code)
			require.Equal(t, tr.SignalDate, storedClosed[i].Signal)
			require.Equal(t, tr.EntryDate, storedClosed[i].EntryDate)
			require.Equal(t, tr.ExitDate, storedClosed[i].ExitDate)
			require.Equal(t, tr.ExitFill, storedClosed[i].ExitPrice)
		}
		held := countRows(t, pool, `SELECT count(*) FROM strategy_paper_trades
			WHERE rules_hash = $1 AND recipe_hash = $2 AND status IN ('open','pending_exit')`, target.RulesHash, target.RecipeHash)
		require.Equal(t, len(batch.Holdings()), held, "open positions after the last session, %s", target.Reg.Spec.StrategyID)
		require.Equal(t, len(batch.Holdings()), int(got[paperSessions[len(paperSessions)-1]][2]), "positions on the last session")
		openRows := held
		trades += len(closed) + openRows
	}
	require.Greater(t, trades, 0, "the fixture produced trades under some live version")
}

type storedTrade struct {
	Code, Status string
	Signal       civil.Date
	EntryDate    civil.Date
	ExitDate     civil.Date
	ExitPrice    float64
}

// closedTradesOf reads a track's closed trades in signal order.
func closedTradesOf(t *testing.T, pool *pgxpool.Pool, target backtestTarget) []storedTrade {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
		SELECT stock_code, status, signal_date, entry_date, exit_date, exit_price FROM strategy_paper_trades
		 WHERE rules_hash = $1 AND recipe_hash = $2 AND status = 'closed'
		 ORDER BY signal_date, stock_code`, target.RulesHash, target.RecipeHash)
	require.NoError(t, err)
	defer rows.Close()
	var out []storedTrade
	for rows.Next() {
		var (
			tr               storedTrade
			sig, entry, exit time.Time
			exitPrice        float64
		)
		require.NoError(t, rows.Scan(&tr.Code, &tr.Status, &sig, &entry, &exit, &exitPrice))
		tr.Signal, tr.EntryDate, tr.ExitDate, tr.ExitPrice = civil.DateOf(sig), civil.DateOf(entry), civil.DateOf(exit), exitPrice
		out = append(out, tr)
	}
	require.NoError(t, rows.Err())
	return out
}

// TestPaperEquityHasARowForEverySession and the catch-up, rerun, append-only and
// re-sync tests below all run on the same fixture.

func TestPaperCatchesUpAfterATwoSessionGap(t *testing.T) {
	pool := dailyDB(t)
	writePaperFixture(t, pool, paperSessions)
	usePaperBuilder(t, paperBuilder(t))
	ctx := context.Background()
	st := store{pool: pool}

	// A run reaches 13 November, then nothing runs for 16 and 17 November; the
	// next run is for 17 November and must step both missed sessions.
	require.NoError(t, runPaperPhase(ctx, pool, st, paperDay(13), true, paperLogf(t)))
	target := paperTarget(t, spec.StrategyZangerBreakout)
	require.Len(t, paperEquityRows(t, pool, target), 2, "12 and 13 November are recorded")

	require.NoError(t, runPaperPhase(ctx, pool, st, paperDay(17), true, paperLogf(t)))
	got := paperEquityRows(t, pool, target)
	require.Len(t, got, 4, "every session from 12 to 17 November has an equity row")
	for _, d := range []civil.Date{paperDay(16), paperDay(17)} {
		require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_daily_runs
			WHERE as_of = $1::date AND phase = 'paper' AND status = 'completed'`, d.String()),
			"the caught-up session %s has its paper phase", d)
	}

	records, _, _ := batchPaper(t, pool, target, paperSessions[:5]) // 11 to 17 November, the seed first
	for i, rec := range records {
		row := got[paperSessions[i+1]]
		require.Equal(t, rec.Equity, row[0], "equity on %s after the gap", paperSessions[i+1])
	}
}

func TestPaperRerunIsIdempotent(t *testing.T) {
	pool := dailyDB(t)
	writePaperFixture(t, pool, paperSessions)
	usePaperBuilder(t, paperBuilder(t))
	ctx := context.Background()
	st := store{pool: pool}
	last := paperSessions[len(paperSessions)-1]

	require.NoError(t, runPaperPhase(ctx, pool, st, last, true, paperLogf(t)))
	target := paperTarget(t, spec.StrategyZangerBreakout)
	before := paperEquityRows(t, pool, target)
	var checkpointBefore string
	require.NoError(t, pool.QueryRow(ctx, `SELECT checkpoint::text FROM strategy_paper_checkpoints
		WHERE rules_hash = $1 AND recipe_hash = $2`, target.RulesHash, target.RecipeHash).Scan(&checkpointBefore))
	tradesBefore := countRows(t, pool, `SELECT count(*) FROM strategy_paper_trades`)

	require.NoError(t, runPaperPhase(ctx, pool, st, last, true, paperLogf(t)))
	require.Equal(t, before, paperEquityRows(t, pool, target), "a rerun writes no equity row and changes none")
	var checkpointAfter string
	require.NoError(t, pool.QueryRow(ctx, `SELECT checkpoint::text FROM strategy_paper_checkpoints
		WHERE rules_hash = $1 AND recipe_hash = $2`, target.RulesHash, target.RecipeHash).Scan(&checkpointAfter))
	require.Equal(t, checkpointBefore, checkpointAfter, "the checkpoint is where the last session left it")
	require.Equal(t, tradesBefore, countRows(t, pool, `SELECT count(*) FROM strategy_paper_trades`))
}

func TestPaperRecordsAreAppendOnly(t *testing.T) {
	pool := dailyDB(t)
	writePaperFixture(t, pool, paperSessions)
	usePaperBuilder(t, paperBuilder(t))
	ctx := context.Background()
	st := store{pool: pool}
	require.NoError(t, runPaperPhase(ctx, pool, st, paperSessions[len(paperSessions)-1], true, paperLogf(t)))
	target := paperTarget(t, spec.StrategyZangerBreakout)

	// A second equity row for a recorded session is refused by its key.
	out := &paperStep{Equity: backtest.Record{Equity: 1, Cash: 1}, Session: paperSessions[2], Raw: []byte(`{}`)}
	require.Error(t, st.writePaperStep(ctx, target, spec.StrategyZangerBreakout, out), "a second write for a recorded session")
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_paper_equity WHERE as_of = $1::date
		AND rules_hash = $2 AND recipe_hash = $3`, paperSessions[2].String(), target.RulesHash, target.RecipeHash))

	// A trade that is recorded past pending_entry never moves back to it: the
	// first live version with an open or closed trade is the one to try.
	var code, status string
	var signal time.Time
	for _, tg := range mustTargets(t) {
		err := pool.QueryRow(ctx, `SELECT stock_code, status, signal_date FROM strategy_paper_trades
			WHERE rules_hash = $1 AND recipe_hash = $2 AND status <> 'pending_entry' LIMIT 1`,
			tg.RulesHash, tg.RecipeHash).Scan(&code, &status, &signal)
		if err == nil {
			target = tg
			break
		}
	}
	require.NotEmpty(t, status, "the fixture recorded a trade past its entry")
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()
	back := paperTradeRow{Status: "pending_entry", Code: code, SignalDate: civil.DateOf(signal)}
	require.Error(t, applyPaperTrade(ctx, tx, target, target.Reg.Spec.StrategyID, back), "%s -> pending_entry must be refused", status)
}

func mustTargets(t *testing.T) []backtestTarget {
	t.Helper()
	targets, err := paperTargetsOf()
	require.NoError(t, err)
	return targets
}

func TestPaperPriceResyncLeavesRecordedEquityUnchanged(t *testing.T) {
	pool := dailyDB(t)
	seedDailySession(t, pool)
	writePaperFixture(t, pool, paperSessions)
	usePaperBuilder(t, paperBuilder(t))
	ctx := context.Background()
	st := store{pool: pool}
	require.NoError(t, runPaperPhase(ctx, pool, st, paperDay(16), true, paperLogf(t)))
	target := paperTarget(t, spec.StrategyZangerBreakout)
	before := paperEquityRows(t, pool, target)

	// A price re-sync rewrites every stored close, including the recorded sessions'.
	_, err := pool.Exec(ctx, `UPDATE stock_prices SET close = close * 3, adjusted_close = adjusted_close * 3, open = open * 3`)
	require.NoError(t, err)
	require.NoError(t, runPaperPhase(ctx, pool, st, paperSessions[len(paperSessions)-1], true, paperLogf(t)))

	after := paperEquityRows(t, pool, target)
	for d, row := range before {
		require.Equal(t, row, after[d], "recorded equity on %s after the re-sync", d)
	}
	require.Len(t, after, len(paperSessions)-1, "the later sessions are recorded on their stored rows")
}

func TestPaperTrackStartsAtLiveFromWhenItsSeedIsThere(t *testing.T) {
	pool := dailyDB(t)
	// No rows for 11 November: the track's first seed is missing, so it starts on
	// the first session whose previous session has rows.
	writePaperFixture(t, pool, paperSessions[1:])
	usePaperBuilder(t, paperBuilder(t))
	ctx := context.Background()
	require.NoError(t, runPaperPhase(ctx, pool, store{pool: pool}, paperDay(13), true, paperLogf(t)))
	target := paperTarget(t, spec.StrategyZangerBreakout)
	got := paperEquityRows(t, pool, target)
	require.Len(t, got, 1, "the track starts on 13 November, the first session after its seed")
	_, ok := got[paperDay(13)]
	require.True(t, ok)
}

func TestPaperPhaseIdlesWithoutALiveVersion(t *testing.T) {
	pool := dailyDB(t)
	writePaperFixture(t, pool, paperSessions)
	prev := paperTargetsOf
	paperTargetsOf = func() ([]backtestTarget, error) { return nil, nil }
	t.Cleanup(func() { paperTargetsOf = prev })
	ctx := context.Background()
	require.NoError(t, runPaperPhase(ctx, pool, store{pool: pool}, paperDay(13), true, paperLogf(t)))
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_paper_equity`))
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_paper_trades`))
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_daily_runs
		WHERE as_of = '2026-11-13' AND phase = 'paper' AND status = 'completed'`), "an idle phase completes")
}

func TestPaperRecordedSessionsFeedTheGuard(t *testing.T) {
	pool := dailyDB(t)
	writePaperFixture(t, pool, paperSessions)
	usePaperBuilder(t, paperBuilder(t))
	ctx := context.Background()
	st := store{pool: pool}
	require.NoError(t, runPaperPhase(ctx, pool, st, paperDay(17), true, paperLogf(t)))

	recorded, err := st.paperRecordedAsOf(ctx)
	require.NoError(t, err)
	target := paperTarget(t, spec.StrategyZangerBreakout)
	require.Equal(t, paperDay(17), recorded[target.RulesHash], "the guard is the newest recorded session")
}

// TestPaperGuardReadsNothingWithoutThePaperTables: a database that has not
// applied 000159 has no recorded session and no checkpoint, so the prune guard
// keeps the seed of each version and a track starts from live_from. The reads
// never fail on the missing tables.
func TestPaperGuardReadsNothingWithoutThePaperTables(t *testing.T) {
	pool := dailyDB(t)
	ctx := context.Background()
	st := store{pool: pool}
	_, err := pool.Exec(ctx, `DROP TABLE strategy_paper_checkpoints; DROP TABLE strategy_paper_equity; DROP TABLE strategy_paper_trades`)
	require.NoError(t, err)

	recorded, err := st.paperRecordedAsOf(ctx)
	require.NoError(t, err)
	require.Empty(t, recorded)
	_, found, err := st.paperCheckpoint(ctx, "x", "y")
	require.NoError(t, err)
	require.False(t, found)
}
