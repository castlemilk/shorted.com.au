package viewerctx

import (
	"context"
	"testing"
)

func TestMCPUserRoundTripsOnlyANonBlankID(t *testing.T) {
	if _, ok := MCPUser(context.Background()); ok {
		t.Fatal("empty context carries a viewer")
	}
	if _, ok := MCPUser(WithMCPUser(context.Background(), "   ")); ok {
		t.Fatal("blank uid was set")
	}
	ctx := WithMCPUser(context.Background(), " uid-9 ")
	if uid, ok := MCPUser(ctx); !ok || uid != "uid-9" {
		t.Fatalf("got %q (set=%v), want uid-9", uid, ok)
	}
}
