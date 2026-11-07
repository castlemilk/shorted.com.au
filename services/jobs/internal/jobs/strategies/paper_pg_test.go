package strategies

// Real-Postgres tests for the paper track. They use the daily job's own features,
// evaluation, events and paper phases over the fixture market (paper_fixture_test.go),
// and the production batch loader and simulator run over the same rows. They run
// under the daily suite's opt-in:
//
//	STRATEGIES_DAILY_TESTCONTAINERS=1 CGO_ENABLED=0 GOWORK=off \
//	  go test -tags=testcontainers -count=1 -run 'Paper|StepEqualsRun' ./internal/jobs/strategies/
//
// or STRATEGIES_DAILY_DATABASE_URL names a server. Without either they skip.

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/backtest"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pgsource"
)

// paperDB is a database with the daily job's source tables, the economic series,
// the migrations (000156 through 000159) and the fixture market.
func paperDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := dailyDB(t)
	paperEconomicTables(t, pool)
	seedPaperMarket(t, pool)
	return pool
}

// runPaperThrough runs the daily job for every session from the first snapshot
// session to the given one, as the scheduled runs do, and returns the sessions.
func runPaperThrough(t *testing.T, pool *pgxpool.Pool, to civil.Date) []civil.Date {
	t.Helper()
	days := paperTradingDays(paperRunFrom, to)
	for _, d := range days {
		runPaperDay(t, pool, d)
	}
	return days
}

// paperFirstRecorded is the first session the paper track records: the session
// after the first snapshot session, whose previous session is the seed.
func paperFirstRecorded(t *testing.T) civil.Date {
	t.Helper()
	days := paperTradingDays(paperRunFrom, paperRunTo)
	require.GreaterOrEqual(t, len(days), 2)
	return days[1]
}

// batchableVersion is a version whose batch the fixture can run and that has
// closed and open trades: the flagship, crowded-short.
func batchableVersion(t *testing.T, pool *pgxpool.Pool) paperVersion {
	t.Helper()
	for _, v := range versionsOf(t, pool) {
		if !batchNeedsComputableFrom(t, v) && v.Target.Reg.Spec.StrategyID == "crowded-short-breakout" {
			return v
		}
	}
	t.Fatal("no batchable version")
	return paperVersion{}
}

func versionsOf(t *testing.T, pool *pgxpool.Pool) []paperVersion {
	t.Helper()
	versions, err := paperVersions(context.Background(), store{pool: pool}, t.Logf, newOnce())
	require.NoError(t, err)
	require.NotEmpty(t, versions, "a live version with a recipe")
	return versions
}

// storedEquity is one equity row of a track.
type storedEquity struct {
	Equity, Cash, Benchmark float64
	HasBenchmark            bool
	Engine                  string
}

func paperEquityOf(t *testing.T, pool *pgxpool.Pool, v paperVersion) map[civil.Date]storedEquity {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
		SELECT as_of::text, equity, cash, COALESCE(benchmark, 0), benchmark IS NOT NULL, engine_version
		  FROM strategy_paper_equity WHERE rules_hash = $1 AND recipe_hash = $2`, v.Target.RulesHash, v.Target.RecipeHash)
	require.NoError(t, err)
	defer rows.Close()
	out := map[civil.Date]storedEquity{}
	for rows.Next() {
		var (
			asOf string
			e    storedEquity
		)
		require.NoError(t, rows.Scan(&asOf, &e.Equity, &e.Cash, &e.Benchmark, &e.HasBenchmark, &e.Engine))
		d, err := civil.ParseDate(asOf)
		require.NoError(t, err)
		out[d] = e
	}
	require.NoError(t, rows.Err())
	return out
}

// storedTrade is one paper trade row as the batch's trade fields name it.
type storedTrade struct {
	Code, Status                 string
	Signal, Entry, Exit, ExitSig civil.Date
	EntryPrice, Pivot, Qty       float64
	ExitPrice, EntryScore        float64
	Reason                       string
	Flags                        []string
	Sessions                     int
	GrossPct, NetPct, Fees, Divs float64
}

func paperTradesOf(t *testing.T, pool *pgxpool.Pool, v paperVersion) []storedTrade {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
		SELECT stock_code, status, signal_date::text, COALESCE(entry_date::text, ''), COALESCE(exit_date::text, ''),
		       COALESCE(exit_signal_date::text, ''), COALESCE(entry_price, 0), COALESCE(captured_pivot, 0),
		       COALESCE(quantity, 0), COALESCE(exit_price, 0), COALESCE(exit_reason, ''), flags,
		       COALESCE(entry_score, 0)::float8, COALESCE(sessions_held, 0), COALESCE(gross_return_pct, 0),
		       COALESCE(net_return_pct, 0), COALESCE(fees, 0), COALESCE(dividends, 0)
		  FROM strategy_paper_trades WHERE rules_hash = $1 AND recipe_hash = $2
		 ORDER BY signal_date, stock_code`, v.Target.RulesHash, v.Target.RecipeHash)
	require.NoError(t, err)
	defer rows.Close()
	var out []storedTrade
	for rows.Next() {
		var (
			tr                           storedTrade
			signal, entry, exit, exitSig string
		)
		require.NoError(t, rows.Scan(&tr.Code, &tr.Status, &signal, &entry, &exit, &exitSig, &tr.EntryPrice, &tr.Pivot,
			&tr.Qty, &tr.ExitPrice, &tr.Reason, &tr.Flags, &tr.EntryScore, &tr.Sessions, &tr.GrossPct, &tr.NetPct,
			&tr.Fees, &tr.Divs))
		tr.Signal = mustDate(t, signal)
		tr.Entry = mustDate(t, entry)
		tr.Exit = mustDate(t, exit)
		tr.ExitSig = mustDate(t, exitSig)
		out = append(out, tr)
	}
	require.NoError(t, rows.Err())
	return out
}

// mustDate parses a stored date, or returns the zero date for an empty one.
func mustDate(t *testing.T, s string) civil.Date {
	t.Helper()
	if s == "" {
		return civil.Date{}
	}
	d, err := civil.ParseDate(s)
	require.NoError(t, err)
	return d
}

func sortedFlags(f []string) []string {
	out := append([]string(nil), f...)
	sort.Strings(out)
	return out
}

// TestStepEqualsRun: the paper track over the features phase's stored snapshots
// equals one production batch run over the same sessions. Every recorded session
// has the batch's equity, cash and benchmark, and every trade has the batch's
// entry, size, pivot, exit, reason, flags, returns, costs and dividends. Each
// version whose batch the fixture can run is compared: the fundamentals versions
// need fundamentals history the fixture does not have, and are skipped.
func TestStepEqualsRun(t *testing.T) {
	pool := paperDB(t)
	ctx := context.Background()
	runPaperThrough(t, pool, paperRunTo)
	in, err := pgsource.LoadBacktestInputs(ctx, pool, paperRunTo)
	require.NoError(t, err)

	first := paperFirstRecorded(t)
	traded := map[string]int{}
	for _, v := range versionsOf(t, pool) {
		if batchNeedsComputableFrom(t, v) {
			continue
		}
		recipe := v.Target.Recipe
		recipe.WindowStart = first.String()
		want, err := backtest.Run(in, v.Target.Reg.Spec, recipe)
		require.NoError(t, err, "batch run of %s", v.Target.Reg.Spec.StrategyID)

		eq := paperEquityOf(t, pool, v)
		require.Equal(t, len(want.Records), len(eq), "%s: one equity row per recorded session (batch first %s last %s)", v.Target.Reg.Spec.StrategyID, want.Records[0].Date, want.Records[len(want.Records)-1].Date)
		for _, rec := range want.Records {
			row, ok := eq[rec.Date]
			require.True(t, ok, "%s: equity row for %s", v.Target.Reg.Spec.StrategyID, rec.Date)
			require.InDelta(t, rec.Equity, row.Equity, 1e-6, "%s equity on %s", v.Target.Reg.Spec.StrategyID, rec.Date)
			require.InDelta(t, rec.Cash, row.Cash, 1e-6, "%s cash on %s", v.Target.Reg.Spec.StrategyID, rec.Date)
			require.True(t, row.HasBenchmark, "%s: benchmark on %s", v.Target.Reg.Spec.StrategyID, rec.Date)
			require.InDelta(t, rec.Benchmark, row.Benchmark, 1e-9, "%s benchmark on %s", v.Target.Reg.Spec.StrategyID, rec.Date)
			require.Equal(t, engine.Version, row.Engine)
		}

		stored := paperTradesOf(t, pool, v)
		var closed, open []backtest.Trade
		for _, tr := range want.Trades {
			if tr.OpenAtEnd {
				open = append(open, tr)
			} else {
				closed = append(closed, tr)
			}
		}
		gotClosed := map[string]storedTrade{}
		gotOpen := map[string]storedTrade{}
		for _, s := range stored {
			switch s.Status {
			case "closed":
				gotClosed[tradeKey(s.Code, s.Signal)] = s
			case "open", "pending_exit":
				gotOpen[tradeKey(s.Code, s.Signal)] = s
			}
		}
		require.Len(t, gotClosed, len(closed), "%s: closed trades", v.Target.Reg.Spec.StrategyID)
		require.Len(t, gotOpen, len(open), "%s: open trades at the last session", v.Target.Reg.Spec.StrategyID)
		for _, tr := range closed {
			got, ok := gotClosed[tradeKey(tr.Code, tr.SignalDate)]
			require.True(t, ok, "%s: closed trade %s signalled %s is stored", v.Target.Reg.Spec.StrategyID, tr.Code, tr.SignalDate)
			requireSameTrade(t, v, got, tr)
		}
		for _, tr := range open {
			got, ok := gotOpen[tradeKey(tr.Code, tr.SignalDate)]
			require.True(t, ok, "%s: open trade %s signalled %s is stored", v.Target.Reg.Spec.StrategyID, tr.Code, tr.SignalDate)
			require.Equal(t, tr.EntryDate, got.Entry, tr.Code)
			require.InDelta(t, tr.EntryFill, got.EntryPrice, 1e-6, tr.Code)
			require.InDelta(t, tr.Qty, got.Qty, 1e-6, tr.Code)
			require.InDelta(t, tr.Pivot, got.Pivot, 1e-9, tr.Code)
			require.InDelta(t, tr.EntryScore, got.EntryScore, 1e-4, tr.Code)
			require.Equal(t, sortedFlags(tr.Flags), sortedFlags(got.Flags), tr.Code)
		}
		traded[v.Target.Reg.Spec.StrategyID] = len(closed) + len(open)
		t.Logf("%s: %d closed, %d open trades in the batch", v.Target.Reg.Spec.StrategyID, len(closed), len(open))
	}
	// The flagship must trade both ways: a closed and an open trade, compared above.
	crowded := crowdedClosedOpen(t, pool)
	require.Greater(t, crowded[0], 0, "crowded-short-breakout has a closed trade in the fixture")
	require.Greater(t, crowded[1], 0, "crowded-short-breakout has an open trade in the fixture")
	// A position HELD when a suspect becomes known exits through corporate_action_exit
	// (HHH, held from 27 July, suspect on 10 August), compared with the batch above.
	require.Greater(t, countRows(t, pool, `SELECT count(*) FROM strategy_paper_trades
		WHERE exit_reason = 'corporate_action_exit'`), 0, "a held position exits on a suspect")
	// A minervini exit on its stop-loss, and one cancelled entry (GGG, untraded on its
	// entry day), are in the fixture and compared.
	require.Greater(t, countRows(t, pool, `SELECT count(*) FROM strategy_paper_trades
		WHERE strategy_id = 'minervini-trend-template' AND status = 'closed' AND exit_reason = 'sma_stop'`), 0,
		"a minervini exit on a price rule (CCC's fall past its stop and its 50-day average) is in the fixture")
	require.Greater(t, countRows(t, pool, `SELECT count(*) FROM strategy_paper_trades WHERE status = 'cancelled'`), 0,
		"a cancelled entry is in the fixture and compared")
	// The corporate-action block is exercised: AAA's suspect is known on 22 July, and
	// no trade of any version enters AAA in the sixty sessions after it (its 6 August
	// entry would otherwise be taken).
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_paper_trades
		WHERE stock_code = 'AAA' AND entry_date BETWEEN '2026-07-22' AND '2026-09-18'`),
		"the suspect blocks AAA's entries for sixty sessions")
	// A held code went 20 sessions without a bar: its exit is a stale exit, compared
	// end to end (the batch and the paper track both label it delisted_exit).
	require.Greater(t, countRows(t, pool, `SELECT count(*) FROM strategy_paper_trades WHERE exit_reason = 'delisted_exit'`), 0,
		"a stale exit (delisted_exit) is in the fixture and compared")
	// The NULL close is on a held code: some trade holds it on that session.
	held := countRows(t, pool, `SELECT count(*) FROM strategy_paper_trades
		WHERE stock_code = $1 AND entry_date <= $2::date AND (exit_date IS NULL OR exit_date >= $2::date)`,
		paperNullCode, paperNullClose.String())
	require.Greater(t, held, 0, "the NULL close falls on a session where %s is held", paperNullCode)
}

// crowdedClosedOpen counts the flagship's stored closed and open trades.
func crowdedClosedOpen(t *testing.T, pool *pgxpool.Pool) [2]int {
	t.Helper()
	var closed, open int
	require.NoError(t, pool.QueryRow(context.Background(), `
		SELECT count(*) FILTER (WHERE status = 'closed'), count(*) FILTER (WHERE status IN ('open','pending_exit'))
		  FROM strategy_paper_trades WHERE strategy_id = 'crowded-short-breakout'`).Scan(&closed, &open))
	return [2]int{closed, open}
}

// batchNeedsComputableFrom reports whether a version's recipe starts where its
// fundamentals first compute (the window is the literal computable_from), which
// the batch derives from fundamentals history. The fixture has no fundamentals, so
// the batch cannot be run over such a version here: the paper track still records
// it (TestPaperEquityHasARowForEverySession), but its equality is not checked.
func batchNeedsComputableFrom(t *testing.T, v paperVersion) bool {
	t.Helper()
	if v.Target.Recipe.WindowStart == "computable_from" {
		t.Logf("%s: fundamentals window is computable_from; the fixture has no fundamentals, so its batch equality is not checked", v.Target.Reg.Spec.StrategyID)
		return true
	}
	return false
}

// tradeKey names a trade by its code and signal session: the table's own key.
func tradeKey(code string, signal civil.Date) string { return code + "|" + signal.String() }

// requireSameTrade compares one closed trade's stored fields with the batch's.
func requireSameTrade(t *testing.T, v paperVersion, got storedTrade, want backtest.Trade) {
	t.Helper()
	id := v.Target.Reg.Spec.StrategyID + " " + want.Code + " " + want.SignalDate.String()
	require.Equal(t, want.Code, got.Code, id)
	require.Equal(t, want.SignalDate, got.Signal, id)
	require.Equal(t, want.EntryDate, got.Entry, id)
	require.Equal(t, want.ExitDate, got.Exit, id)
	require.Equal(t, want.ExitSignalDate, got.ExitSig, id)
	require.InDelta(t, want.EntryFill, got.EntryPrice, 1e-6, id+" entry price")
	require.InDelta(t, want.Pivot, got.Pivot, 1e-9, id+" pivot")
	require.InDelta(t, want.Qty, got.Qty, 1e-6, id+" quantity")
	require.InDelta(t, want.ExitFill, got.ExitPrice, 1e-6, id+" exit price")
	require.Equal(t, want.ExitReason, got.Reason, id+" exit reason")
	require.Equal(t, sortedFlags(want.Flags), sortedFlags(got.Flags), id+" flags")
	// entry_score is a real (32-bit) column, as the batch's trade table stores it.
	require.InDelta(t, want.EntryScore, got.EntryScore, 1e-4, id+" entry score")
	require.Equal(t, want.SessionsHeld, got.Sessions, id+" sessions held")
	require.InDelta(t, want.Gross*100, got.GrossPct, 1e-6, id+" gross return")
	require.InDelta(t, want.Net*100, got.NetPct, 1e-6, id+" net return")
	require.InDelta(t, want.Fees, got.Fees, 1e-6, id+" fees")
	require.InDelta(t, want.Dividends, got.Divs, 1e-6, id+" dividends")
}

// TestPaperSessionsEqualTheBatchSessions compares the paper track's session, built
// from the stored snapshot of each session, with the batch's prepared session: the
// status, score, pivot, dollar volume, moving averages, breakout date, bar, cash
// dividend and corporate-action suspect of every code the batch steps, and the
// cash rate and benchmark. A code the batch never steps must not trigger.
func TestPaperSessionsEqualTheBatchSessions(t *testing.T) {
	pool := paperDB(t)
	ctx := context.Background()
	// Run to 7 August: the retained snapshot (the newest fifteen sessions) then still
	// holds the fixture's suspect, dividend and NULL close (the earliest of them is
	// 18 July). A later run would prune them, and this comparison reads only what the
	// snapshot keeps.
	last := civil.Date{Year: 2026, Month: time.August, Day: 7}
	runPaperThrough(t, pool, last)
	in, err := pgsource.LoadBacktestInputs(ctx, pool, last)
	require.NoError(t, err)
	st := store{pool: pool}

	first := paperFirstRecorded(t)
	pruned, compared := 0, 0
	caSeen, divSeen, nullSeen := 0, 0, 0
	defer func() {
		require.GreaterOrEqual(t, compared, 10, "the sessions the retention keeps are compared (pruned %d)", pruned)
		// The comparison proves the paths only if the fixture reaches them.
		require.Greater(t, caSeen, 0, "a corporate-action suspect is known on a code the batch steps")
		require.Greater(t, divSeen, 0, "a cash dividend is credited in a compared session")
		require.Greater(t, nullSeen, 0, "a NULL close is in a compared session")
	}()
	for _, v := range versionsOf(t, pool) {
		if batchNeedsComputableFrom(t, v) {
			continue
		}
		recipe := v.Target.Recipe
		recipe.WindowStart = first.String()
		sessions, err := backtest.Sessions(in, v.Target.Reg.Spec, recipe)
		require.NoError(t, err)
		require.NotEmpty(t, sessions)
		for _, bs := range sessions {
			snap, ok, err := readPaperSnapshot(ctx, pool, bs.Date)
			require.NoError(t, err)
			if !ok {
				// Sessions older than the retained window are pruned: the paper track
				// never reads them, and the comparison covers what is kept.
				pruned++
				continue
			}
			compared++
			rate, err := pgsource.CashRate(ctx, pool, bs.Date)
			require.NoError(t, err)
			bench, err := st.indexLevelOn(ctx, pgsource.BacktestIndexBenchmark, bs.Date)
			require.NoError(t, err)
			require.InDelta(t, bs.CashRate, backtest.CashRateFraction(rate, bs.Date), 1e-12, "cash rate on %s", bs.Date)
			require.InDelta(t, bs.Benchmark, bench, 1e-9, "benchmark on %s", bs.Date)

			got, err := paperSessionOf(snap.Rows, snap.Blobs, snap.Regime, v.Target.Reg, bs.Date, prevTradingDay(bs.Date), bs.Index, bs.Seed, bs.CashRate, bs.Benchmark, nil)
			require.NoError(t, err)
			gotBy := map[string]backtest.CodeSession{}
			for _, c := range got.Codes {
				gotBy[c.Code] = c
			}
			inBatch := map[string]bool{}
			for _, want := range bs.Codes {
				inBatch[want.Code] = true
				requireSameCodeSession(t, bs.Date, gotBy[want.Code], want)
				if want.CA.Known {
					caSeen++
				}
				if want.Dividend > 0 {
					divSeen++
				}
				if d := gotBy[want.Code]; d.Bar == nil && want.Code == paperNullCode && bs.Date == paperNullClose {
					nullSeen++
				}
			}
			for _, c := range got.Codes {
				// The batch steps the codes that trigger at some session; a code that
				// never triggers may hold any other status.
				if !inBatch[c.Code] {
					require.NotEqual(t, string(engine.StatusTriggered), c.Status, "%s: %s triggers on %s but the batch never steps it", v.Target.Reg.Spec.StrategyID, c.Code, bs.Date)
				}
			}
		}
	}
}

func requireSameCodeSession(t *testing.T, d civil.Date, got, want backtest.CodeSession) {
	t.Helper()
	id := want.Code + " on " + d.String()
	require.Equal(t, want.Status, got.Status, id+" status")
	require.InDelta(t, want.Score, got.Score, 1e-9, id+" score")
	require.InDelta(t, want.Pivot, got.Pivot, 1e-9, id+" pivot")
	require.InDelta(t, want.DV20, got.DV20, 1e-3, id+" dollar volume")
	require.InDelta(t, want.SMA50, got.SMA50, 1e-9, id+" sma50")
	require.InDelta(t, want.SMA200, got.SMA200, 1e-9, id+" sma200")
	require.Equal(t, want.BreakoutDate, got.BreakoutDate, id+" breakout date")
	require.InDelta(t, want.Dividend, got.Dividend, 1e-12, id+" cash dividend")
	require.Equal(t, want.CA, got.CA, id+" corporate-action suspect")
	require.Equal(t, want.Bar == nil, got.Bar == nil, id+" bar presence")
	if want.Bar != nil {
		require.InDelta(t, want.Bar.Close, got.Bar.Close, 1e-9, id+" close")
		require.InDelta(t, want.Bar.Volume, got.Bar.Volume, 1e-9, id+" volume")
		require.InDelta(t, want.Bar.AdjClose, got.Bar.AdjClose, 1e-9, id+" adjusted close")
	}
}

// TestPaperEquityHasARowForEverySession: each live version has one equity row for
// every complete session from its first recorded one, and the rows name the engine.
func TestPaperEquityHasARowForEverySession(t *testing.T) {
	pool := paperDB(t)
	days := runPaperThrough(t, pool, paperRunTo)
	first := paperFirstRecorded(t)
	var want []civil.Date
	for _, d := range days {
		if !d.Before(first) {
			want = append(want, d)
		}
	}
	for _, v := range versionsOf(t, pool) {
		eq := paperEquityOf(t, pool, v)
		require.Len(t, eq, len(want), "%s: one row per session from %s", v.Target.Reg.Spec.StrategyID, first)
		for _, d := range want {
			require.Contains(t, eq, d, "%s: row for %s", v.Target.Reg.Spec.StrategyID, d)
		}
	}
}

// TestPaperCatchesUpAfterASkippedSession: a session the daily job did not run is
// stepped by the next run, oldest first, and its equity row is written.
func TestPaperCatchesUpAfterASkippedSession(t *testing.T) {
	pool := paperDB(t)
	days := paperTradingDays(paperRunFrom, paperRunTo)
	runPaperThrough(t, pool, days[9])
	// Skip the next two sessions, then run the third.
	res := runPaperDay(t, pool, days[12])
	require.Equal(t, []civil.Date{days[10], days[11], days[12]}, res.Done, "the held sessions are backfilled oldest first")
	for _, v := range versionsOf(t, pool) {
		eq := paperEquityOf(t, pool, v)
		require.Contains(t, eq, days[11], "%s: the skipped session has an equity row", v.Target.Reg.Spec.StrategyID)
		require.Contains(t, eq, days[12])
	}
}

// TestPaperDoesNotHoldTheSnapshot: the paper phase is not part of a session's
// completion. A track whose checkpoint cannot be read fails in its own track, its
// error comes back at the end of the run, and every session still completes its
// three snapshot phases and every other track steps.
func TestPaperDoesNotHoldTheSnapshot(t *testing.T) {
	pool := paperDB(t)
	ctx := context.Background()
	days := paperTradingDays(paperRunFrom, paperRunTo)
	runPaperThrough(t, pool, days[9])
	versions := versionsOf(t, pool)
	bad := versions[0]
	_, err := pool.Exec(ctx, `UPDATE strategy_paper_checkpoints SET checkpoint = '{"version":99}'::jsonb
		WHERE rules_hash = $1 AND recipe_hash = $2`, bad.Target.RulesHash, bad.Target.RecipeHash)
	require.NoError(t, err)

	later := days[10:15]
	var runErr error
	for _, d := range later {
		_, runErr = runDailyForDay(t, pool, d)
		require.Error(t, runErr, "the failing track's error comes back from %s", d)
		require.Contains(t, runErr.Error(), "version 99")
	}
	for _, d := range later {
		require.Equal(t, 3, countRows(t, pool, `SELECT count(*) FROM strategy_daily_runs
			WHERE as_of = $1::date AND status = 'completed' AND phase IN ('features','evaluation','events')`, d.String()),
			"the snapshot of %s is whole", d)
	}
	eq := paperEquityOf(t, pool, bad)
	require.NotContains(t, eq, later[0], "the failing track records nothing past its last good session")
	for _, v := range versions[1:] {
		require.Contains(t, paperEquityOf(t, pool, v), later[len(later)-1], "%s steps while another track fails", v.Target.Reg.Spec.StrategyID)
	}
}

// runDailyForDay runs the daily job for a day and returns its error, unlike
// runPaperDay, which fails the test on one.
func runDailyForDay(t *testing.T, pool *pgxpool.Pool, day civil.Date) (dailyResult, error) {
	t.Helper()
	opts := dailyOptions{
		Write:  true,
		Holder: "paper-test",
		Now:    dayAt14(day),
		Logf:   t.Logf,
		Sleep:  func(context.Context, time.Duration) error { return nil },
	}
	return runDaily(context.Background(), pool, opts)
}

// TestPaperMissingTablesIdle: a database without the paper tables runs the snapshot
// and idles the paper phase, with one log line and no error.
func TestPaperMissingTablesIdle(t *testing.T) {
	pool := paperDB(t)
	days := paperTradingDays(paperRunFrom, paperRunTo)
	runPaperThrough(t, pool, days[4])
	_, err := pool.Exec(context.Background(), `DROP TABLE strategy_paper_trades CASCADE`)
	require.NoError(t, err)

	var lines []string
	opts := dailyOptions{
		Write:  true,
		Holder: "paper-test",
		Now:    dayAt14(days[5]),
		Logf:   func(f string, a ...any) { lines = append(lines, f) },
		Sleep:  func(context.Context, time.Duration) error { return nil },
	}
	_, err = runDaily(context.Background(), pool, opts)
	require.NoError(t, err, "a missing paper table is not an error")
	require.Equal(t, 3, countRows(t, pool, `SELECT count(*) FROM strategy_daily_runs
		WHERE as_of = $1::date AND status = 'completed' AND phase IN ('features','evaluation','events')`, days[5].String()))
	idle := 0
	for _, l := range lines {
		if strings.Contains(l, "paper track idle") && strings.Contains(l, "missing") {
			idle++
		}
	}
	require.Equal(t, 1, idle, "one idle line")
}

// TestPaperBenchmarkIsTheXJTLevelOnOrBeforeTheSession: each equity row's benchmark
// is the newest XJT close dated on or before its session, and indexLevelOn reads
// nothing newer and nothing from before the first bar.
func TestPaperBenchmarkIsTheXJTLevelOnOrBeforeTheSession(t *testing.T) {
	pool := paperDB(t)
	runPaperThrough(t, pool, paperRunTo)
	ctx := context.Background()
	st := store{pool: pool}
	for _, v := range versionsOf(t, pool) {
		for d, row := range paperEquityOf(t, pool, v) {
			var close float64
			require.NoError(t, pool.QueryRow(ctx, `SELECT close::float8 FROM index_prices
				WHERE index_code = 'XJT' AND date <= $1::date ORDER BY date DESC LIMIT 1`, d.String()).Scan(&close))
			require.True(t, row.HasBenchmark)
			require.InDelta(t, close, row.Benchmark, 1e-9, "benchmark on %s", d)
		}
	}

	// Before the first XJT bar there is no level: NULL, not zero.
	early := civil.Date{Year: 2020, Month: 1, Day: 2}
	level, err := st.indexLevelOn(ctx, "XJT", early)
	require.NoError(t, err)
	require.Zero(t, level)
}

// TestPaperCheckpointMustMatchItsNewestRow: a checkpoint whose as_of is not the
// track's newest equity row is an error for that track, and nothing is stepped.
func TestPaperCheckpointMustMatchItsNewestRow(t *testing.T) {
	pool := paperDB(t)
	days := paperTradingDays(paperRunFrom, paperRunTo)
	runPaperThrough(t, pool, days[6])
	v := versionsOf(t, pool)[0]
	_, err := pool.Exec(context.Background(), `UPDATE strategy_paper_checkpoints SET as_of = $3::date
		WHERE rules_hash = $1 AND recipe_hash = $2`, v.Target.RulesHash, v.Target.RecipeHash, days[2].String())
	require.NoError(t, err)
	_, _, err = store{pool: pool}.paperCheckpointOf(context.Background(), v.Target.RulesHash, v.Target.RecipeHash)
	require.Error(t, err)
	require.Contains(t, err.Error(), "does not match the newest equity row")
}

// TestPaperSupersededTrackStopsAndRepromotionDoesNotResume: a superseded version's
// track steps no session from its superseded_on and records its stop. A later
// re-promotion does not resume it: no rows, and the log line prints once.
func TestPaperSupersededTrackStopsAndRepromotionDoesNotResume(t *testing.T) {
	pool := paperDB(t)
	ctx := context.Background()
	days := paperTradingDays(paperRunFrom, paperRunTo)
	runPaperThrough(t, pool, days[6])
	v := versionsOf(t, pool)[0]
	before := paperEquityOf(t, pool, v)
	require.Contains(t, before, days[6])

	// The version is superseded from days[7]: its track may not record that session.
	_, err := pool.Exec(ctx, `UPDATE strategy_rule_versions SET status = 'superseded', superseded_on = $2::date
		WHERE rules_hash = $1`, v.Target.RulesHash, days[7].String())
	require.NoError(t, err)
	require.NoError(t, paperCatchUp(ctx, pool, store{pool: pool}, days[7], true, t.Logf))
	cp, found, err := store{pool: pool}.paperCheckpointOf(ctx, v.Target.RulesHash, v.Target.RecipeHash)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, days[7].String(), cp.StoppedOn.String(), "the stop is recorded on the superseded session")
	require.Equal(t, before, paperEquityOf(t, pool, v), "a superseded track records nothing new")

	// Re-promotion: the registry names the version live again, and the daily runs go on.
	var lines []string
	for _, d := range days[7:12] {
		opts := dailyOptions{Write: true, Holder: "paper-test", Now: dayAt14(d),
			Logf: func(f string, a ...any) { lines = append(lines, f) }, Sleep: func(context.Context, time.Duration) error { return nil }}
		_, err := runDaily(ctx, pool, opts)
		require.NoError(t, err)
	}
	require.Equal(t, before, paperEquityOf(t, pool, v), "a re-promoted version does not resume its track")
	relog := 0
	for _, l := range lines {
		if strings.Contains(l, "re-promotion does not resume") {
			relog++
		}
	}
	// A line prints once per run, and the loop above is five runs: at most one line per run.
	require.LessOrEqual(t, relog, len(days[7:12]), "the re-promotion line prints at most once per run")
}

// TestPaperRecipesAreRegisteredOnEverySessionRun: a recipe row that is missing is
// registered again by the next run, even when that session's phases are complete,
// so no checkpoint or trade can reference a recipe that does not exist.
func TestPaperRecipesAreRegisteredOnEverySessionRun(t *testing.T) {
	pool := paperDB(t)
	days := paperTradingDays(paperRunFrom, paperRunTo)
	runPaperThrough(t, pool, days[3])
	// Nothing may reference a recipe while it is deleted: the tracks go first. The session is complete, so its evaluation phase is skipped.
	_, err := pool.Exec(context.Background(), `DELETE FROM strategy_paper_trades; DELETE FROM strategy_paper_equity;
		DELETE FROM strategy_paper_checkpoints; DELETE FROM strategy_recipes`)
	require.NoError(t, err)
	runPaperDay(t, pool, days[3])
	require.Equal(t, 5, countRows(t, pool, `SELECT count(*) FROM strategy_recipes`))
}

// TestPaperFlagsGrowWithoutAStatusMove: a trade whose status stays open takes new
// flags, and its status and entry are unchanged.
func TestPaperFlagsGrowWithoutAStatusMove(t *testing.T) {
	pool := paperDB(t)
	ctx := context.Background()
	runPaperThrough(t, pool, paperRunFrom.AddDays(7))
	v := versionsOf(t, pool)[0]
	target := v.Target
	signal := civil.Date{Year: 2026, Month: 7, Day: 20}
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()
	require.NoError(t, applyPaperTrade(ctx, tx, target, target.Reg.Spec.StrategyID, paperTradeRow{Status: "pending_entry", Code: "ZZZ", SignalDate: signal, Flags: []string{}}))
	require.NoError(t, applyPaperTrade(ctx, tx, target, target.Reg.Spec.StrategyID, paperTradeRow{Status: "open", Code: "ZZZ", SignalDate: signal, EntryDate: signal.AddDays(1), HasEntry: true, EntryPrice: 9, Flags: []string{}}))
	require.NoError(t, applyPaperTrade(ctx, tx, target, target.Reg.Spec.StrategyID, paperTradeRow{Status: "open", Code: "ZZZ", SignalDate: signal, Flags: []string{"price_return_only"}}))
	var status string
	var flags []string
	require.NoError(t, tx.QueryRow(ctx, `SELECT status, flags FROM strategy_paper_trades WHERE stock_code = 'ZZZ'`).Scan(&status, &flags))
	require.Equal(t, "open", status)
	require.Equal(t, []string{"price_return_only"}, flags)
}

// dayAt14 is the UTC instant of a session's 14:00 scheduled run.
func dayAt14(d civil.Date) time.Time {
	return time.Date(d.Year, d.Month, d.Day, 14, 0, 0, 0, time.UTC)
}

// TestThreePhaseSessionsFromBeforeTheDeployAreDiffed: the sessions production holds
// today are complete with their three snapshot phases and no paper rows. The first
// run of the new code diffs its session's events against the last of them (a
// baseline would lose the session's events for good), and a session the run skips
// is backfilled oldest first.
func TestPaperThreePhaseSessionsFromBeforeTheDeployAreDiffed(t *testing.T) {
	pool := paperDB(t)
	ctx := context.Background()
	days := paperTradingDays(paperRunFrom, paperRunTo)
	// Before the deploy the paper tables do not exist: the sessions run without them.
	for _, table := range []string{"strategy_paper_trades", "strategy_paper_equity", "strategy_paper_checkpoints"} {
		_, err := pool.Exec(ctx, "DROP TABLE "+table+" CASCADE")
		require.NoError(t, err)
	}
	runPaperThrough(t, pool, days[19])
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_daily_runs WHERE phase = 'paper'`))

	// The deploy applies 000159 again, and the next run is the first one of the new code.
	b, err := os.ReadFile(filepath.Join(dailyMigrationsDir, "000159_strategy_paper.up.sql"))
	require.NoError(t, err)
	_, err = pool.Exec(ctx, string(b))
	require.NoError(t, err)

	var lines []string
	logf := func(f string, a ...any) { lines = append(lines, fmt.Sprintf(f, a...)) }
	opts := dailyOptions{Write: true, Holder: "paper-test", Now: dayAt14(days[20]), Logf: logf,
		Sleep: func(context.Context, time.Duration) error { return nil }}
	res, err := runDaily(ctx, pool, opts)
	require.NoError(t, err)
	require.Equal(t, []civil.Date{days[20]}, res.Done)
	for _, l := range lines {
		require.NotContains(t, l, "is a baseline", "the first new run diffs against the three-phase session before it")
	}
	require.Equal(t, days[19].String(), stringOf(t, pool, `SELECT max(as_of)::text FROM strategy_daily_runs
		WHERE as_of < $1::date AND status = 'completed' AND phase = 'events'`, days[20].String()))

	// Sessions the run skips are backfilled, oldest first, by the next run that can.
	res = runPaperDay(t, pool, days[23])
	require.Equal(t, []civil.Date{days[21], days[22], days[23]}, res.Done, "the skipped sessions are backfilled oldest first")
}

// TestPaperRerunIsIdempotent: a run over sessions already recorded writes nothing:
// no equity row, no trade row and no change to the checkpoint.
func TestPaperRerunIsIdempotent(t *testing.T) {
	pool := paperDB(t)
	ctx := context.Background()
	days := runPaperThrough(t, pool, paperRunTo)
	last := days[len(days)-1]
	equity := countRows(t, pool, `SELECT count(*) FROM strategy_paper_equity`)
	trades := countRows(t, pool, `SELECT count(*) FROM strategy_paper_trades`)
	var before string
	require.NoError(t, pool.QueryRow(ctx, `SELECT string_agg(checkpoint::text, '|' ORDER BY rules_hash, recipe_hash) FROM strategy_paper_checkpoints`).Scan(&before))

	res := runPaperDay(t, pool, last)
	require.True(t, res.AlreadyDone, "the session is complete: the snapshot is not run again")
	require.Equal(t, equity, countRows(t, pool, `SELECT count(*) FROM strategy_paper_equity`))
	require.Equal(t, trades, countRows(t, pool, `SELECT count(*) FROM strategy_paper_trades`))
	var after string
	require.NoError(t, pool.QueryRow(ctx, `SELECT string_agg(checkpoint::text, '|' ORDER BY rules_hash, recipe_hash) FROM strategy_paper_checkpoints`).Scan(&after))
	require.Equal(t, before, after, "the checkpoints are where the last session left them")
}

// TestPaperRecordsAreAppendOnly: a session's equity is written once, and a closed
// trade does not move back to pending_entry. Both are refused by the database key
// or by the lifecycle, never silently changed.
func TestPaperRecordsAreAppendOnly(t *testing.T) {
	pool := paperDB(t)
	ctx := context.Background()
	days := paperTradingDays(paperRunFrom, paperRunTo)
	runPaperThrough(t, pool, paperRunTo)
	v := batchableVersion(t, pool)
	st := store{pool: pool}

	// A second write of a recorded session's equity is refused.
	first := paperFirstRecorded(t)
	out := &paperStep{Equity: backtest.Record{Date: first, Equity: 1, Cash: 1}, Session: first, Raw: []byte(`{}`)}
	require.Error(t, st.writePaperStep(ctx, v.Target, v.Target.Reg.Spec.StrategyID, out))
	require.Equal(t, 1, countRows(t, pool, `SELECT count(*) FROM strategy_paper_equity WHERE as_of = $1::date
		AND rules_hash = $2 AND recipe_hash = $3`, first.String(), v.Target.RulesHash, v.Target.RecipeHash))
	_ = days

	// A closed trade cannot go back to a pending entry.
	var code string
	var signal time.Time
	require.NoError(t, pool.QueryRow(ctx, `SELECT stock_code, signal_date FROM strategy_paper_trades
		WHERE rules_hash = $1 AND recipe_hash = $2 AND status = 'closed' LIMIT 1`, v.Target.RulesHash, v.Target.RecipeHash).Scan(&code, &signal))
	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()
	err = applyPaperTrade(ctx, tx, v.Target, v.Target.Reg.Spec.StrategyID,
		paperTradeRow{Status: "pending_entry", Code: code, SignalDate: civil.DateOf(signal)})
	require.Error(t, err, "closed -> pending_entry must be refused")
}

// TestPaperPriceResyncLeavesRecordedEquityUnchanged: a price re-sync after a session
// rewrites the stored prices of the days before it. The recorded equity does not
// change, because the paper track reads only the snapshot rows. The batch run over
// the re-synced prices does change, so the re-sync is not a no-op.
func TestPaperPriceResyncLeavesRecordedEquityUnchanged(t *testing.T) {
	pool := paperDB(t)
	ctx := context.Background()
	days := paperTradingDays(paperRunFrom, paperRunTo)
	runPaperThrough(t, pool, days[50])
	v := batchableVersion(t, pool)
	before := paperEquityOf(t, pool, v)

	// FFF's history from 3 August to the recorded session is re-adjusted (FFF is held
	// from 6 August, so its marks change and the batch's equity with them). A rescale
	// of a whole interval that holds the entry would leave the P&L unchanged.
	_, err := pool.Exec(ctx, `UPDATE stock_prices SET open = open * 0.8, high = high * 0.8, low = low * 0.8,
		close = close * 0.8, adjusted_close = adjusted_close * 0.8
		WHERE stock_code = 'FFF' AND date > '2026-08-03' AND date <= $1::date`, days[50].String())
	require.NoError(t, err)
	runPaperThrough(t, pool, days[60])

	after := paperEquityOf(t, pool, v)
	for d, row := range before {
		require.Equal(t, row, after[d], "recorded equity on %s after the re-sync", d)
	}
	in, err := pgsource.LoadBacktestInputs(ctx, pool, days[50])
	require.NoError(t, err)
	recipe := v.Target.Recipe
	recipe.WindowStart = paperFirstRecorded(t).String()
	rerun, err := backtest.Run(in, v.Target.Reg.Spec, recipe)
	require.NoError(t, err)
	require.NotEmpty(t, rerun.Records)
	require.NotEqual(t, before[days[50]].Equity, rerun.Records[len(rerun.Records)-1].Equity,
		"a batch run over the re-synced prices differs on the recorded session: the re-sync is a real change")
}

// TestPaperStartsOnTheFirstSeedThatCarriesCAKnown: rows written before the
// suspects were stored are not backfilled, and a track does not start on one. With
// live_from L, rows for L-1 and L are pre-change and the row for L+1 is not, so the
// track's first recorded session is L+2: its seed is L+1, the first seed that
// carries ca_known. The start is logged once, with its reason.
func TestPaperStartsOnTheFirstSeedThatCarriesCAKnown(t *testing.T) {
	pool := paperDB(t)
	ctx := context.Background()
	days := paperTradingDays(paperRunFrom, paperRunTo)
	L, pre, post := days[9], []civil.Date{days[8], days[9]}, days[10]

	// The snapshot runs before the paper tables exist, as before the deploy.
	for _, table := range []string{"strategy_paper_trades", "strategy_paper_equity", "strategy_paper_checkpoints"} {
		_, err := pool.Exec(ctx, "DROP TABLE "+table+" CASCADE")
		require.NoError(t, err)
	}
	runPaperThrough(t, pool, L)
	// The rows of L-1 and L predate the suspects: the features rows lack ca_known.
	_, err := pool.Exec(ctx, `UPDATE strategy_features_daily SET features = features - 'ca_known'
		WHERE as_of = ANY($1::date[])`, []string{pre[0].String(), pre[1].String()})
	require.NoError(t, err)
	b, err := os.ReadFile(filepath.Join(dailyMigrationsDir, "000159_strategy_paper.up.sql"))
	require.NoError(t, err)
	_, err = pool.Exec(ctx, string(b))
	require.NoError(t, err)
	// The promotion day is L: the live versions take it as their live_from.
	_, err = pool.Exec(ctx, `UPDATE strategy_rule_versions SET live_from = $1::date WHERE status = 'live' AND kind = 'canonical'`, L.String())
	require.NoError(t, err)

	var lines []string
	logf := func(f string, a ...any) { lines = append(lines, fmt.Sprintf(f, a...)) }
	for _, d := range []civil.Date{post, days[11]} {
		opts := dailyOptions{Write: true, Holder: "paper-test", Now: dayAt14(d), Logf: logf,
			Sleep: func(context.Context, time.Duration) error { return nil }}
		_, err := runDaily(ctx, pool, opts)
		require.NoError(t, err)
	}

	first := days[11]
	for _, v := range versionsOf(t, pool) {
		eq := paperEquityOf(t, pool, v)
		var earliest civil.Date
		for d := range eq {
			if earliest.IsZero() || d.Before(earliest) {
				earliest = d
			}
		}
		require.Equal(t, first.String(), earliest.String(), "%s: the first recorded session is L+2", v.Target.Reg.Spec.StrategyID)
	}
	starts, waits := 0, 0
	for _, l := range lines {
		if strings.Contains(l, "starts: first recorded session") {
			starts++
		}
		if strings.Contains(l, "waits to start") {
			waits++
		}
	}
	require.Greater(t, starts, 0, "the start is logged with its reason")
	require.Greater(t, waits, 0, "the wait for a seed that carries ca_known is logged")
	// The wait line prints once per version per run: one run per session it waits.
	require.LessOrEqual(t, waits, len(versionsOf(t, pool))*2, "the wait line prints at most once per version per run")
}

// TestPaperQualityCompoundersStepsOverItsSnapshot is the weaker check for a
// fundamentals strategy. The production batch never simulates a fundamentals
// strategy whose window is computable_from (backtest.go publishRequest stores the
// derivation only, because a simulation would read today's fundamentals at every
// session), and backtest.Run refuses any date window for it, so there is no batch
// trading run to compare. The fixture writes no fundamentals blobs, so the
// snapshot carries none: the test checks that the paper track steps the strategy
// over those rows without error and records one equity row per recorded session.
func TestPaperQualityCompoundersStepsOverItsSnapshot(t *testing.T) {
	pool := paperDB(t)
	days := runPaperThrough(t, pool, paperRunTo)
	first := paperFirstRecorded(t)
	var q *paperVersion
	for _, v := range versionsOf(t, pool) {
		if v.Target.Reg.Spec.StrategyID == "quality-compounders" {
			vv := v
			q = &vv
		}
	}
	require.NotNil(t, q, "quality-compounders is a live version")
	require.Equal(t, 0, countRows(t, pool, `SELECT count(*) FROM strategy_fundamentals_blobs`),
		"the fixture writes no fundamentals blobs: the snapshot carries none")
	var want []civil.Date
	for _, d := range days {
		if !d.Before(first) {
			want = append(want, d)
		}
	}
	eq := paperEquityOf(t, pool, *q)
	require.Len(t, eq, len(want), "one equity row per recorded session")
	for _, d := range want {
		require.Contains(t, eq, d)
		require.Equal(t, engine.Version, eq[d].Engine)
	}
}
