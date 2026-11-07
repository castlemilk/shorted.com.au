package shorts

import (
	"context"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"cloud.google.com/go/civil"
	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/backtest"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/stretchr/testify/require"
)

// The shared goldens (PR-18 item 2): the responses the real handlers give over the fake, in protojson exactly
// as the web's Connect client receives them, committed under the web's strategies tests. The web tests and the
// local stand-ins read the same files, so a contract change moves them here first. Run with -update to rewrite
// them; a run without it fails on any drift.
var updateGolden = flag.Bool("update", false, "rewrite the backtest golden files under web/src/@/lib/strategies/__tests__/golden")

// goldenDir is the web's golden folder, relative to this package.
const goldenDir = "../../../../../web/src/@/lib/strategies/__tests__/golden"

// goldenJSON is a message as the web receives it: protojson, re-read and written with sorted keys and fixed
// indentation, so the bytes do not depend on the protojson whitespace or the Go map order.
func goldenJSON(t *testing.T, m proto.Message) []byte {
	t.Helper()
	raw, err := protojson.Marshal(m)
	require.NoError(t, err)
	var v any
	require.NoError(t, json.Unmarshal(raw, &v))
	out, err := json.MarshalIndent(v, "", "  ")
	require.NoError(t, err)
	return append(out, '\n')
}

// compareGolden writes (with -update) or compares the file at name.
func compareGolden(t *testing.T, name string, got []byte) {
	t.Helper()
	path := filepath.Join(goldenDir, name)
	if *updateGolden {
		require.NoError(t, os.MkdirAll(goldenDir, 0o755))
		require.NoError(t, os.WriteFile(path, got, 0o644))
		return
	}
	want, err := os.ReadFile(path)
	require.NoError(t, err, "the golden %s is missing: run go test -run TestBacktestGoldens -update", name)
	require.Equal(t, string(want), string(got), "%s has drifted from the handler: run go test -run TestBacktestGoldens -update and review the diff", name)
}

// goldenCrowdedShort is Crowded-Short published the way production reads: the run's own record stops at the end
// of October, the paper track starts the session after live_from, the track is written by two engine versions,
// the run and the track agree on the post-freeze trades, and the in-sample record has dozens of closed trades
// across the exit reasons.
func goldenCrowdedShort(t *testing.T) *backtestStoreFake {
	t.Helper()
	fake := newBacktestFake()
	id := spec.StrategyCrowdedShortBreakout
	fake.publish(t, id, 101)
	truncateSeries(t, fake, 101, civil.Date{Year: 2026, Month: time.October, Day: 30})

	// The track starts the session after live_from. Its first half is written by engine 1.1.0, the rest by the
	// running engine: one track, two engine segments.
	dates := weekdays(civil.Date{Year: 2026, Month: time.September, Day: 1}, civil.Date{Year: 2026, Month: time.November, Day: 5})
	paper := paperFrom(dates, backtestFixtureLiveFrom.AddDays(1), func(m int) float64 { return 5000 * (1 + 0.0002*float64(m)) }, "1.1.0")
	for k := len(paper) / 2; k < len(paper); k++ {
		paper[k].EngineVersion = engine.Version
	}
	fake.paperEq = paper

	reasons := []string{"pivot_stop", "time_stop", "stop_loss", "sma_stop", "status_exit", "delisted_exit", "corporate_action_exit"}
	codes := []string{"BHP", "CBA", "WBC", "NAB", "ANZ", "RIO", "FMG", "WES", "CSL", "TLS", "WOW", "QBE"}

	// The in-sample record: forty-two closed trades that entered and exited before live_from.
	var inSample []shortsstore.BacktestTradeRow
	for k := 0; k < 42; k++ {
		entry := civil.Date{Year: 2019, Month: time.June, Day: 3}.AddDays(45 * k)
		exit := entry.AddDays(5 + k%20)
		net := float64((k*37)%61-25) / 3
		inSample = append(inSample, shortsstore.BacktestTradeRow{
			Seq: 10 + k, StockCode: codes[k%len(codes)], SignalDate: entry.AddDays(-2).String(), EntryDate: entry.String(),
			EntryPrice: 20 + float64(k), EntryScore: 55 + float64(k%40), ExitSignalDate: exit.AddDays(-1).String(), ExitDate: exit.String(),
			ExitPrice: 20 + float64(k) + net/10, ExitReason: reasons[k%len(reasons)], SessionsHeld: 5 + k%20,
			GrossReturnPct: net + 0.2, NetReturnPct: net, Flags: []string{},
		})
	}
	fake.trades[101] = append(fake.trades[101], inSample...)

	// The post-freeze record: sixteen trades the track also took (run and track agree), and one open on both.
	days := weekdays(civil.Date{Year: 2026, Month: time.October, Day: 2}, civil.Date{Year: 2026, Month: time.October, Day: 30})
	var track []shortsstore.PaperTradeRow
	var runPost []shortsstore.BacktestTradeRow
	for k := 0; k < 12; k++ {
		entry := days[k]
		exit := days[k+3+k%5]
		net := float64((k*13)%17) - 5
		code := codes[(k+3)%len(codes)]
		track = append(track, shortsstore.PaperTradeRow{
			StockCode: code, SignalDate: entry.AddDays(-1).String(), EntryDate: entry.String(), EntryPrice: 40 + float64(k),
			ExitDate: exit.String(), ExitPrice: 40 + float64(k) + net/10, ExitReason: reasons[k%3], Status: "closed",
			EntryScore: 60 + float64(k), SessionsHeld: 3 + k%5, GrossReturnPct: net + 0.2, NetReturnPct: net, HasNet: true,
		})
		runPost = append(runPost, shortsstore.BacktestTradeRow{
			Seq: 100 + k, StockCode: code, SignalDate: entry.AddDays(-1).String(), EntryDate: entry.String(), EntryPrice: 40 + float64(k),
			ExitDate: exit.String(), ExitPrice: 40 + float64(k) + net/10, ExitReason: reasons[k%3], SessionsHeld: 3 + k%5,
			GrossReturnPct: net + 0.2, NetReturnPct: net, EntryScore: 60 + float64(k), Flags: []string{},
		})
	}
	open := days[13]
	track = append(track, shortsstore.PaperTradeRow{
		StockCode: "MQG", SignalDate: open.AddDays(-1).String(), EntryDate: open.String(), EntryPrice: 180, Status: "open", EntryScore: 72,
	})
	runPost = append(runPost, shortsstore.BacktestTradeRow{
		Seq: 120, StockCode: "MQG", SignalDate: open.AddDays(-1).String(), EntryDate: open.String(), EntryPrice: 180,
		ExitReason: "open_at_end", Open: true, EntryScore: 72, Flags: []string{},
	})
	// The fixture's own open RIO trade (entered 21 October) is on the track too, so the record agrees.
	track = append(track, shortsstore.PaperTradeRow{
		StockCode: "RIO", SignalDate: "2026-10-20", EntryDate: "2026-10-21", EntryPrice: 90, Status: "open", EntryScore: 75,
	})
	fake.paperTrades = track
	fake.trades[101] = append(fake.trades[101], runPost...)
	return fake
}

// goldenMinervini is Minervini published on the ASIC-reported universe: survivorship partial, the all-reported
// coverage from 2025, and the not-measurable years before it.
func goldenMinervini(t *testing.T) *backtestStoreFake {
	t.Helper()
	fake := newBacktestFake()
	fake.publishWith(t, spec.StrategyMinerviniTrend, 201, backtest.MeasurementASICOnly)
	fake.paperRules = "" // no track for this strategy in the golden
	return fake
}

// goldenZanger is Zanger not computable: the measured label and the universe share.
func goldenZanger(t *testing.T, fake *backtestStoreFake) {
	t.Helper()
	rules, recipe := liveKeys(t, spec.StrategyZangerBreakout)
	fake.notComputable[spec.StrategyZangerBreakout] = shortsstore.BacktestRunRow{
		ID: 301, StrategyID: spec.StrategyZangerBreakout, RulesHash: rules, RecipeHash: recipe,
		ComputableFrom: "2025-08-31", FiscalLabel: "FY2024", Summary: []byte(`{"state":"not_computable","share":0.42}`),
	}
}

// TestBacktestGoldens regenerates the shared goldens from the real handlers and compares them with the files.
func TestBacktestGoldens(t *testing.T) {
	ctx := context.Background()
	crowd := goldenCrowdedShort(t)
	srv := backtestServer(t, crowd)

	crowdRun, err := srv.GetBacktestRun(ctx, connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
	require.NoError(t, err)
	// The golden must look like production: a real trade count across the exit reasons, so the summary, the win
	// rate and the exits by reason mean something.
	require.GreaterOrEqual(t, crowdRun.Msg.Run.TradeSummary.Closed, int32(30), "the in-sample record has dozens of closed trades")
	require.GreaterOrEqual(t, len(crowdRun.Msg.Run.TradeSummary.ExitsByReason), 4, "trades exit for several reasons")
	require.Len(t, crowdRun.Msg.Run.Sensitivity, 5, "all five sensitivity runs")
	compareGolden(t, "backtest_run_crowded_short.json", goldenJSON(t, crowdRun.Msg))

	mini := goldenMinervini(t)
	miniSrv := backtestServer(t, mini)
	miniRun, err := miniSrv.GetBacktestRun(ctx, connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyMinerviniTrend}))
	require.NoError(t, err)
	compareGolden(t, "backtest_run_minervini.json", goldenJSON(t, miniRun.Msg))

	zanger := newBacktestFake()
	goldenZanger(t, zanger)
	zangerSrv := backtestServer(t, zanger)
	zangerRun, err := zangerSrv.GetBacktestRun(ctx, connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyZangerBreakout}))
	require.NoError(t, err)
	compareGolden(t, "backtest_run_zanger_not_computable.json", goldenJSON(t, zangerRun.Msg))

	// The evidence of all five strategies: Crowded-Short published (with its track), Minervini published, Zanger
	// not computable, and the two without a run.
	all := goldenCrowdedShort(t)
	mini2 := goldenMinervini(t)
	all.published[spec.StrategyMinerviniTrend] = mini2.published[spec.StrategyMinerviniTrend]
	all.runs[201] = mini2.runs[201]
	all.series[201] = mini2.series[201]
	all.trades[201] = mini2.trades[201]
	goldenZanger(t, all)
	evSrv := backtestServer(t, all)
	ev, err := evSrv.ListStrategyEvidence(ctx, connect.NewRequest(&shortsv1alpha1.ListStrategyEvidenceRequest{}))
	require.NoError(t, err)
	require.Len(t, ev.Msg.Strategies, 5, "the evidence covers all five strategies")
	compareGolden(t, "strategy_evidence_all.json", goldenJSON(t, ev.Msg))
}

// The goldens are valid JSON in the web's folder, and every file the test writes is listed here.
func TestBacktestGoldensAreValidJSON(t *testing.T) {
	names := []string{
		"backtest_run_crowded_short.json",
		"backtest_run_minervini.json",
		"backtest_run_zanger_not_computable.json",
		"strategy_evidence_all.json",
	}
	for _, name := range names {
		raw, err := os.ReadFile(filepath.Join(goldenDir, name))
		require.NoError(t, err, name)
		var v any
		require.NoError(t, json.Unmarshal(raw, &v), name)
		require.True(t, strings.HasSuffix(string(raw), "\n"), name)
	}
}
