package mcp

import (
	"context"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/viewerctx"
	sdkauth "github.com/modelcontextprotocol/go-sdk/auth"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

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
