package mcp

import (
	"context"
	"strings"
	"testing"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/viewerctx"
	sdkauth "github.com/modelcontextprotocol/go-sdk/auth"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// viewerRecord is the in-process viewer a strategy read was called with.
type viewerRecord struct {
	uid string
	set bool
}

// recordViewer reads the viewer the strategy read received from its context.
func recordViewer(ctx context.Context) viewerRecord {
	uid, ok := viewerctx.MCPUser(ctx)
	return viewerRecord{uid: uid, set: ok}
}

// The strategy tools hand the verified token's user to the in-process reads,
// and nothing else: an anonymous call carries no viewer.
func TestMCPViewerContextFollowsTheVerifiedToken(t *testing.T) {
	signedIn := &sdk.CallToolRequest{Extra: &sdk.RequestExtra{
		TokenInfo: &sdkauth.TokenInfo{UserID: " uid-1 "},
	}}
	uid, ok := viewerctx.MCPUser(mcpViewerContext(context.Background(), signedIn))
	if !ok || uid != "uid-1" {
		t.Fatalf("verified token: got viewer %q (set=%v), want uid-1", uid, ok)
	}

	for name, req := range map[string]*sdk.CallToolRequest{
		"no token":    {},
		"nil request": nil,
		"blank user":  {Extra: &sdk.RequestExtra{TokenInfo: &sdkauth.TokenInfo{UserID: "  "}}},
	} {
		if uid, ok := viewerctx.MCPUser(mcpViewerContext(context.Background(), req)); ok {
			t.Errorf("%s: carried viewer %q, want none", name, uid)
		}
	}
}

// Each strategy tool calls its read with the verified viewer from the request
// it was given, so the depth the connector is owed reaches the read.
func TestStrategyToolsHandOverTheVerifiedViewer(t *testing.T) {
	signedIn := &sdk.CallToolRequest{Extra: &sdk.RequestExtra{
		TokenInfo: &sdkauth.TokenInfo{UserID: "uid-1"},
	}}
	cases := []struct {
		name string
		req  *sdk.CallToolRequest
		want viewerRecord
	}{
		{"verified token", signedIn, viewerRecord{uid: "uid-1", set: true}},
		{"no token", &sdk.CallToolRequest{}, viewerRecord{}},
		{"nil request", nil, viewerRecord{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src := &fakeDataSource{
				strategyPicks: &shortsv1alpha1.GetStrategyPicksResponse{},
				strategies:    &shortsv1alpha1.ListStrategiesResponse{},
			}

			if _, _, err := getStrategyPicksHandler(src)(context.Background(), tc.req, GetStrategyPicksInput{StrategyID: "zanger-breakout"}); err != nil {
				t.Fatalf("get_strategy_picks: %v", err)
			}
			if src.gotStrategyPicksViewer != tc.want {
				t.Errorf("get_strategy_picks read carried viewer %+v, want %+v", src.gotStrategyPicksViewer, tc.want)
			}

			if _, _, err := listStrategiesHandler(src)(context.Background(), tc.req, ListStrategiesInput{}); err != nil {
				t.Fatalf("list_strategies: %v", err)
			}
			if src.gotStrategiesViewer != tc.want {
				t.Errorf("list_strategies read carried viewer %+v, want %+v", src.gotStrategiesViewer, tc.want)
			}
		})
	}
}

// A clamped answer (no sign-in) is worded as what it is: the public top rows.
// "No picks" under the clamp would be false, since matching stocks exist below
// the depth, and a sorted list is the top of the rank order, not of the metric.
func TestGetStrategyPicksTextSaysWhatTheClampHides(t *testing.T) {
	ranked := &shortsv1alpha1.StrategyPick{StockCode: "AAA", Status: "triggered", Rank: 1}
	clamped := &shortsv1alpha1.ViewerDepth{Access: "anonymous", Clamped: true, Limit: 10}

	run := func(t *testing.T, resp *shortsv1alpha1.GetStrategyPicksResponse, in GetStrategyPicksInput) string {
		t.Helper()
		src := &fakeDataSource{strategyPicks: resp, strategies: &shortsv1alpha1.ListStrategiesResponse{}}
		res, _, err := getStrategyPicksHandler(src)(context.Background(), nil, in)
		if err != nil {
			t.Fatalf("get_strategy_picks: %v", err)
		}
		text, ok := res.Content[0].(*sdk.TextContent)
		if !ok {
			t.Fatalf("content is %T, want text", res.Content[0])
		}
		return text.Text
	}

	t.Run("filter with matches only below the depth", func(t *testing.T) {
		text := run(t, &shortsv1alpha1.GetStrategyPicksResponse{TotalCount: 25, Viewer: clamped},
			GetStrategyPicksInput{StrategyID: "minervini-trend-template", Status: "setup"})
		if strings.Contains(text, "No picks") {
			t.Errorf("clamped empty filter says no picks: %q", text)
		}
		if !strings.Contains(text, "none of the public top 10") || !strings.Contains(text, "25 stocks with that status") {
			t.Errorf("clamped empty filter does not say what the clamp hides: %q", text)
		}
	})

	t.Run("sorted within the public top rows", func(t *testing.T) {
		text := run(t, &shortsv1alpha1.GetStrategyPicksResponse{
			Picks: []*shortsv1alpha1.StrategyPick{ranked}, TotalCount: 212, Viewer: clamped,
		}, GetStrategyPicksInput{StrategyID: "quality-compounders", SortBy: "roe"})
		if !strings.Contains(text, "Without sign-in only the top 10 of the ranking are served") {
			t.Errorf("clamped sorted answer does not state its scope: %q", text)
		}
	})

	t.Run("unclamped empty filter keeps its wording", func(t *testing.T) {
		text := run(t, &shortsv1alpha1.GetStrategyPicksResponse{},
			GetStrategyPicksInput{StrategyID: "minervini-trend-template", Status: "setup"})
		if !strings.Contains(text, "No picks for") {
			t.Errorf("unclamped empty filter lost its wording: %q", text)
		}
	})
}

// The description states the depth an anonymous caller and a connector get. The
// public depth is set in Terraform (strategy_public_signals_limit); a
// scripts/tests check holds this clause to that number.
func TestGetStrategyPicksDescriptionStatesTheDepth(t *testing.T) {
	const clause = "Default 10 picks. Without sign-in, the top 10 only; connected with OAuth, up to 25. Ids and rules: list_strategies."
	if !strings.Contains(getStrategyPicksDescription, clause) {
		t.Errorf("description lost its depth clause or its spacing:\n%s", getStrategyPicksDescription)
	}
}
