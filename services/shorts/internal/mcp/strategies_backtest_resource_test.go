package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"connectrpc.com/connect"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/protovisibility"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// computedBacktestFixture is a published run as GetBacktestRun serves it.
func computedBacktestFixture() *shortsv1alpha1.BacktestRun {
	return &shortsv1alpha1.BacktestRun{
		State:      "published",
		StrategyId: "crowded-short-breakout",
		WindowId:   "since_2019_05",
		Identity: &shortsv1alpha1.BacktestRunIdentity{
			RunId:         42,
			Version:       &shortsv1alpha1.StrategyVersionRef{Label: "v1", RulesHash: strings.Repeat("3f9a1c2e", 8)},
			EngineVersion: "1.1.1",
			RunDate:       "2026-11-06",
			WindowStart:   "2019-05-01",
			WindowEnd:     "2026-11-05",
			InSampleUntil: "2026-10-31",
			Returns:       "total",
			Benchmark:     "XJT",
			ReferenceName: "Same-data reference: liquid crowded shorts, equal weight",
		},
		Windows: []*shortsv1alpha1.WindowMetrics{{
			Window: "since_2019_05", Label: "Since May 2019", From: "2019-05-01", To: "2026-11-05",
			TotalReturnPct: 210, HasTotalReturn: true, CagrPct: 14.2, HasCagr: true,
			BenchmarkCagrPct: 8.1, HasBenchmark: true, ReferenceCagrPct: 6.3, HasReference: true,
			MaxDrawdownPct: -31.5, Sharpe: 0.9, SharpeSe: 0.2, HasSharpe: true, ClosedTrades: 140,
			WinRatePct: 41, HasWinRate: true, Note: "in-sample to 2026-10-31, recorded after",
		}, {
			Window: "live", Label: "Live since freeze", From: "2026-10-01", To: "2026-11-05",
			TotalReturnPct: 3.1, HasTotalReturn: true, NotAnnualised: true, Note: "paper track only, recorded",
		}},
		Coverage: []*shortsv1alpha1.CoverageYear{{
			Year: 2019, Measurable: true, CoveragePct: 64, AllReportedMeasurable: true, AllReportedPct: 70,
		}},
		Survivorship: &shortsv1alpha1.Survivorship{Measurement: "measured", Direction: "flatters", Statement: "Prices are missing for companies that delisted."},
		Recipe:       &shortsv1alpha1.RecipeLines{Brokerage: "10 bps brokerage", Spread: "5 to 75 bps spread", Entry: "Buys on a breakout."},
		Sensitivity: []*shortsv1alpha1.Sensitivity{{
			Id: "costs_x2", Label: "Costs doubled", CagrPct: 9.1, HasCagr: true, ExcessVsBenchmarkPct: 1.2, HasExcess: true,
			Fragile: true, FragileChip: "Fragile to costs", Applies: true,
		}},
		ReplayAgreement:   "Replay agrees: 15 of 15 trades",
		Disclosures:       []string{"Hypothetical results from rules applied to historical data, not a record of trading. Not financial advice."},
		FundamentalsLabel: "Point-in-time fundamentals from the capture date (strict policy)",
	}
}

// readBacktest reads the resource through its handler, as a client would.
func readBacktest(t *testing.T, src *fakeDataSource, uri string) (string, error) {
	t.Helper()
	res, err := backtestHandler(src)(context.Background(), &sdk.ReadResourceRequest{Params: &sdk.ReadResourceParams{URI: uri}})
	if err != nil {
		return "", err
	}
	require.Len(t, res.Contents, 1)
	return res.Contents[0].Text, nil
}

// bodyOf is the JSON after the preface.
func bodyOf(t *testing.T, text string) map[string]json.RawMessage {
	t.Helper()
	require.True(t, strings.HasPrefix(text, spec.RecipePreface), "the text opens with the recipe preface")
	var body map[string]json.RawMessage
	require.NoError(t, json.Unmarshal([]byte(strings.TrimPrefix(text, spec.RecipePreface+"\n\n")), &body))
	return body
}

// The text opens with the recipe preface, and the JSON carries every key 8.7 names.
func TestBacktestResourceOpensWithThePrefaceAndCarriesEveryIntegrityKey(t *testing.T) {
	src := &fakeDataSource{backtestRun: &shortsv1alpha1.GetBacktestRunResponse{Run: computedBacktestFixture()}}
	text, err := readBacktest(t, src, "shorted://strategies/crowded-short-breakout/backtest")
	require.NoError(t, err)
	assert.Equal(t, "crowded-short-breakout", src.gotBacktestRun.StrategyId)
	assert.Zero(t, src.gotBacktestRun.RunId, "the resource reads the live published run")

	body := bodyOf(t, text)
	for _, key := range []string{
		"rules_version", "engine_version", "run_date", "window", "in_sample_until",
		"returns", "benchmark", "costs", "survivorship", "coverage_by_year",
		"approximate", "fundamentals_label",
	} {
		assert.Contains(t, body, key, "the resource carries %s", key)
	}
	assert.Equal(t, `"v1 3f9a1c2e · engine 1.1.1"`, string(body["rules_version"]))
	assert.Equal(t, `"2026-10-31"`, string(body["in_sample_until"]))
	assert.Equal(t, `false`, string(body["approximate"]))
}

// The body carries the figures a reader must not quote without their basis: the benchmark and reference CAGR,
// sharpe_se, not_annualised, the survivorship caveat, the sensitivity chips and the recipe entry.
func TestBacktestResourceCarriesTheFiguresTheirBasis(t *testing.T) {
	run := computedBacktestFixture()
	run.Survivorship.Caveat = "Coverage is measured on ASIC-reported names only."
	src := &fakeDataSource{backtestRun: &shortsv1alpha1.GetBacktestRunResponse{Run: run}}
	text, err := readBacktest(t, src, "shorted://strategies/crowded-short-breakout/backtest")
	require.NoError(t, err)
	assert.Contains(t, text, `"benchmark_cagr_pct":8.1`)
	assert.Contains(t, text, `"reference_cagr_pct":6.3`)
	assert.Contains(t, text, `"sharpe_se":0.2`)
	assert.Contains(t, text, `"not_annualised":true`)
	assert.Contains(t, text, `"caveat":"Coverage is measured on ASIC-reported names only."`)
	assert.Contains(t, text, `"fragile_chip":"Fragile to costs"`)
	assert.Contains(t, text, `"recipe_entry":"Buys on a breakout."`)
}

// A strategy whose run is not published says so in its state, and carries none of the figures.
func TestBacktestResourceNamesAStateWithoutFigures(t *testing.T) {
	src := &fakeDataSource{backtestRun: &shortsv1alpha1.GetBacktestRunResponse{Run: &shortsv1alpha1.BacktestRun{
		State: "not_computable", StrategyId: "zanger-breakout", ComputableFrom: "2025-01-31", FiscalLabel: "FY2024",
		StateReason: "Not computable before FY2024.",
	}}}
	text, err := readBacktest(t, src, "shorted://strategies/zanger-breakout/backtest")
	require.NoError(t, err)
	body := bodyOf(t, text)
	assert.Equal(t, `"not_computable"`, string(body["state"]))
	assert.Equal(t, `"FY2024"`, string(body["fiscal_label"]))
	assert.NotContains(t, body, "windows")
	assert.NotContains(t, body, "rules_version")
}

// An approximate run is labelled as one, in the state and in the approximate key.
func TestBacktestResourceLabelsAnApproximateRun(t *testing.T) {
	run := computedBacktestFixture()
	run.State = "approximate"
	src := &fakeDataSource{backtestRun: &shortsv1alpha1.GetBacktestRunResponse{Run: run}}
	text, err := readBacktest(t, src, "shorted://strategies/crowded-short-breakout/backtest")
	require.NoError(t, err)
	body := bodyOf(t, text)
	assert.Equal(t, `true`, string(body["approximate"]))
}

// Only a strategy id is read: a variant reference, an extra segment or any other shape never reaches the data
// source.
func TestBacktestResourceRefusesOtherURIs(t *testing.T) {
	for _, uri := range []string{
		"shorted://strategies/variant:abc123/backtest",
		"shorted://strategies/crowded-short-breakout/backtest/extra",
		"shorted://strategies//backtest",
		"shorted://strategies/Crowded-Short/backtest",
		"shorted://stocks/BHP/backtest",
	} {
		src := &fakeDataSource{backtestRun: &shortsv1alpha1.GetBacktestRunResponse{Run: computedBacktestFixture()}}
		_, err := readBacktest(t, src, uri)
		assert.Error(t, err, uri)
		assert.Nil(t, src.gotBacktestRun, "%s must not reach the data source", uri)
	}
}

// A data-source failure is the read's failure, never a body.
func TestBacktestResourcePropagatesAFailure(t *testing.T) {
	src := &fakeDataSource{err: connect.NewError(connect.CodeUnavailable, nil)}
	_, err := readBacktest(t, src, "shorted://strategies/crowded-short-breakout/backtest")
	assert.Error(t, err)
}

// The resource's rpc is public, so the anonymous read reaches it: a private rpc would make the resource answer
// unauthenticated for every client.
func TestBacktestResourceRPCIsPublic(t *testing.T) {
	public := protovisibility.PublicMethodNames()
	for _, rpc := range backtestResourceRPCs {
		assert.True(t, public[rpc], rpc)
	}
}

// The resource template's listing stays small: every session pays for it. The budget is 2 KiB.
func TestResourceTemplatesListStaysWithinBudget(t *testing.T) {
	const budget = 2 * 1024
	ctx := context.Background()
	server := anonymousServer(&fakeDataSource{}, &recordingAlerts{})

	clientTransport, serverTransport := sdk.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	require.NoError(t, err)
	defer func() { _ = serverSession.Close() }()

	client := sdk.NewClient(&sdk.Implementation{Name: "templates-probe", Version: "0.0.1"}, nil)
	session, err := client.Connect(ctx, clientTransport, nil)
	require.NoError(t, err)
	defer func() { _ = session.Close() }()

	res, err := session.ListResourceTemplates(ctx, nil)
	require.NoError(t, err)
	var found bool
	for _, tpl := range res.ResourceTemplates {
		if tpl.URITemplate == backtestTemplateURI {
			found = true
		}
	}
	assert.True(t, found, "the backtest template is listed")

	encoded, err := json.Marshal(res)
	require.NoError(t, err)
	t.Logf("resources/templates/list is %d bytes across %d templates", len(encoded), len(res.ResourceTemplates))
	assert.LessOrEqual(t, len(encoded), budget, "resources/templates/list is %d bytes, over the %d-byte budget", len(encoded), budget)
}
