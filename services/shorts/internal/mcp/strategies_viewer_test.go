package mcp

import (
	"context"
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
