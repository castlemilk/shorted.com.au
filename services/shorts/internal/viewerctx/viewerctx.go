// Package viewerctx carries a verified signed-in viewer into an in-process
// call. The MCP server verifies its own bearer tokens and then calls the
// shorts service directly, so the strategy reads need a way to learn who
// the MCP caller is without trusting anything an HTTP client sends.
//
// Only Go code in this process can set the value. A Connect request builds
// its context from the HTTP request, never from another request's context,
// so no HTTP caller can supply it.
//
// This is a leaf package: the MCP server and the shorts service both import
// it, and it imports nothing from either.
package viewerctx

import (
	"context"
	"strings"
)

type mcpUserKey struct{}

// WithMCPUser returns ctx carrying uid as the verified MCP viewer. An empty
// uid returns ctx unchanged, so an anonymous MCP caller carries no viewer.
func WithMCPUser(ctx context.Context, uid string) context.Context {
	uid = strings.TrimSpace(uid)
	if uid == "" {
		return ctx
	}
	return context.WithValue(ctx, mcpUserKey{}, uid)
}

// MCPUser returns the verified MCP viewer carried by ctx, if any.
func MCPUser(ctx context.Context) (string, bool) {
	uid, ok := ctx.Value(mcpUserKey{}).(string)
	return uid, ok && uid != ""
}
