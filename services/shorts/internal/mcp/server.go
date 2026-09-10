// Package mcp serves the Shorted data set over the Model Context Protocol.
//
// Tools call ShortsServer's Connect handlers IN-PROCESS. That is the whole
// reason this lives inside the API binary — no HTTP hop, no WAF, no second
// copy of the query logic. It also means the Connect interceptor chain (auth,
// user-agent, rate limiting) does NOT run for these calls, so every RPC a tool
// touches must be VISIBILITY_PUBLIC. TestToolsOnlyCallPublicMethods enforces
// that; do not add a tool without checking it.
package mcp

import (
	"context"
	"net/http"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	// ServerName is the MCP server identity. It is also published in the
	// server card at /.well-known/mcp/server-card.json — changing it breaks
	// existing client configurations.
	ServerName    = "shorted-au-market-data"
	ServerTitle   = "Shorted — Australian market and public-interest data"
	ServerVersion = "1.0.0"
)

// NewServer builds the MCP server. src may be nil, which yields a server with
// no tools — useful for protocol-level tests.
func NewServer(src DataSource) *sdk.Server {
	server := sdk.NewServer(&sdk.Implementation{
		Name:    ServerName,
		Title:   ServerTitle,
		Version: ServerVersion,
	}, nil)

	// Resources and prompts are static: they carry the interpretation context
	// and the composed entry points, neither of which needs a data source.
	// Registering them unconditionally means a protocol-level test server and
	// the real one advertise the same non-tool surface.
	registerResources(server)
	registerPrompts(server)

	if src != nil {
		registerAll(server, src)
	}

	return server
}

// Handler returns the HTTP handler to mount at /mcp.
//
// Stateless is not a tuning knob here, it is load-bearing twice over:
//
//   - The SDK only serves protocol 2026-07-28 over streamable HTTP when the
//     transport is stateless (StreamableServerTransport.SupportsProtocolVersion).
//     A stateful handler silently omits 2026-07-28 from server/discover and
//     every client falls back to the legacy initialize path.
//   - The API runs as multiple Cloud Run instances behind a load balancer with
//     no session affinity, so a session pinned to one instance's memory would
//     be unreachable on the next request anyway.
//
// The tools are read-only and take every parameter they need per call, so
// there is no per-session state to lose.
func Handler(src DataSource) http.Handler {
	return HandlerWithLifetime(src, StreamLifetime)
}

// HandlerWithLifetime is Handler with an explicit stream ceiling. Production
// uses Handler; this exists so a test can drive the real handler over a real
// socket without waiting out the real ceiling.
func HandlerWithLifetime(src DataSource, lifetime time.Duration) http.Handler {
	server := NewServer(src)
	return boundStreamLifetime(lifetime, sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server {
		return server
	}, &sdk.StreamableHTTPOptions{Stateless: true}))
}

// StreamLifetime bounds how long ONE /mcp request may stay open.
//
// It exists because MCP requests are not all request/response calls. A
// subscriptions/listen POST (SEP-2575) has no synchronous result: the handler
// blocks and the SSE stream stays open until the client goes away. On Cloud
// Run "until the client goes away" means until the platform's 300s request
// timeout kills it — measured on prod 2026-09-10, all 53 API POST 5xx in 24h
// were /mcp, and every single one ran for 299.98s. Cloudflare relabels that
// 524, so a normal, healthy client looked like a failing origin every five
// minutes, and each dead stream held a request slot until the platform noticed.
//
// Ending the stream ourselves turns that into an ordinary completed response:
// the SDK's hangResponse returns as soon as the request context is done, the
// SSE body ends after a 200, and the client reconnects exactly as it already
// does today. The only thing that changes is who ends the connection, and
// therefore what it is recorded as.
//
// The margin below the platform timeout is deliberate: it must be large enough
// that a request cannot lose the race and still be killed at 300s.
// terraform/modules/shorts-api/main.tf pins that 300s, and
// TestStreamLifetimeIsBelowCloudRunTimeout keeps the two numbers honest.
const StreamLifetime = 240 * time.Second

// boundStreamLifetime caps a request's context, so a held-open stream ends on
// our terms rather than the platform's. Cancelling the request context is the
// SDK's own shutdown path for a hung response, not an abort: for a stateless
// subscriptions/listen the SDK already propagates that cancellation into the
// handler (shouldPropagateCancellation), and every other MCP request completes
// in milliseconds and never reaches the deadline at all.
func boundStreamLifetime(lifetime time.Duration, next http.Handler) http.Handler {
	if lifetime <= 0 {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), lifetime)
		defer cancel()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
