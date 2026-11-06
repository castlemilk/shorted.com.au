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
		State:      "computed",
		StrategyId: "crowded-short-breakout",
		Identity: &shortsv1alpha1.BacktestRunIdentity{
			RunId:         42,
			Version:       &shortsv1alpha1.StrategyVersionRef{Label: "v1", RulesHash: strings.Repeat("3f9a1c2e", 8)},
			EngineVersion: "1.0.0",
			RunDate:       "2026-11-06",
			WindowStart:   "2019-05-01",
			WindowEnd:     "2026-11-05",
			InSampleUntil: "2026-10-31",
			Returns:       "total",
			Benchmark:     "XJT",
			ReferenceName: "Same-data reference",
		},
		Windows: []*shortsv1alpha1.WindowMetrics{{
			Window: "since_may_2019", Label: "Since May 2019", From: "2019-05-01", To: "2026-11-05",
			TotalReturnPct: 210, CagrPct: 14.2, HasCagr: true, MaxDrawdownPct: -31.5, ClosedTrades: 140,
			WinRatePct: 41, HasWinRate: true, Note: "in-sample to 2026-10-31, recorded after",
		}},
		CoverageByYear:  []*shortsv1alpha1.CoverageYear{{Year: 2019, QualifyingPct: 64, HasQualifying: true, AllReportedPct: 70, HasAllReported: true}},
		Survivorship:    &shortsv1alpha1.Survivorship{Measurement: "measured", Direction: "flatters", Statement: "Prices are missing for companies that delisted."},
		Recipe:          &shortsv1alpha1.RecipeLines{Brokerage: "10 bps brokerage", Spread: "5 to 50 bps spread"},
		ReplayAgreement: "Replay agrees: 15 of 15 trades",
		Disclosures:     []string{"Hypothetical results: rules applied to historical data, not record trading. Not financial advice."},
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

// The text opens with the recipe preface, and the JSON after it carries the integrity
// fields a figure must be read with (8.7).
func TestBacktestResourceOpensWithThePrefaceAndCarriesIntegrityFields(t *testing.T) {
	src := &fakeDataSource{backtestRun: &shortsv1alpha1.GetBacktestRunResponse{Run: computedBacktestFixture()}}
	text, err := readBacktest(t, src, "shorted://strategies/crowded-short-breakout/backtest")
	require.NoError(t, err)

	assert.True(t, strings.HasPrefix(text, spec.RecipePreface), "the text opens with the recipe preface")
	assert.Equal(t, "crowded-short-breakout", src.gotBacktestRun.StrategyId)
	assert.Zero(t, src.gotBacktestRun.RunId, "the resource reads the live published run")

	var body map[string]json.RawMessage
	require.NoError(t, json.Unmarshal([]byte(strings.TrimPrefix(text, spec.RecipePreface+"\n\n")), &body))
	for _, key := range []string{
		"rules_version", "engine_version", "run_date", "window", "in_sample_until",
		"returns", "benchmark", "costs", "survivorship", "coverage_by_year",
	} {
		assert.Contains(t, body, key, "the resource carries %s", key)
	}
	assert.Equal(t, `"v1 3f9a1c2e · engine 1.0.0"`, string(body["rules_version"]), "the rules version names the label, the first eight hash characters and the engine")
	assert.Equal(t, `"2026-10-31"`, string(body["in_sample_until"]))
}

// A strategy with no published run answers its state, with no figures and no integrity
// fields, and still opens with the preface.
func TestBacktestResourceNamesAStateWithoutFigures(t *testing.T) {
	src := &fakeDataSource{backtestRun: &shortsv1alpha1.GetBacktestRunResponse{Run: &shortsv1alpha1.BacktestRun{
		State: "not_computable", StrategyId: "zanger-breakout", ComputableFrom: "2025-01-31", FiscalLabel: "FY2024",
	}}}
	text, err := readBacktest(t, src, "shorted://strategies/zanger-breakout/backtest")
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(text, spec.RecipePreface))

	var body map[string]any
	require.NoError(t, json.Unmarshal([]byte(strings.TrimPrefix(text, spec.RecipePreface+"\n\n")), &body))
	assert.Equal(t, "not_computable", body["state"])
	assert.Equal(t, "FY2024", body["fiscal_label"])
	assert.NotContains(t, body, "windows")
	assert.NotContains(t, body, "rules_version")
}

// Only a strategy id is read: a variant reference, an extra path segment or any other
// shape is refused before the data source is asked.
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

// The resource template's own listing stays small: every session pays for it. The budget is
// 2 KiB; the template adds one entry to resources/templates/list.
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

// The resource's rpc is public, so the anonymous resource read reaches it: a private rpc
// here would make the resource answer unauthenticated for every client.
func TestBacktestResourceRPCIsPublic(t *testing.T) {
	public := protovisibility.PublicMethodNames()
	for _, rpc := range backtestResourceRPCs {
		assert.True(t, public[rpc], rpc)
	}
}
