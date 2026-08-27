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
	"net/http"

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
	server := NewServer(src)
	return sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server {
		return server
	}, &sdk.StreamableHTTPOptions{Stateless: true})
}
