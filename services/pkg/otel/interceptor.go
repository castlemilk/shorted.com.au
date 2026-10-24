package otel

import (
	"connectrpc.com/connect"
	"connectrpc.com/otelconnect"
)

// OTelInterceptor returns a Connect interceptor that creates spans for each
// RPC call and records standard OTel RPC metrics (duration, request/response
// size) following the OTel semconv spec.
//
// It should be placed as the FIRST interceptor in the chain so that the span
// captures the full request lifecycle including auth, rate limiting, etc.
func OTelInterceptor() connect.Interceptor {
	// otelconnect v0.12 omits server peer attributes by default (they are opt-in
	// via WithServerPeerAttributes), so the old WithoutServerPeerAttributes was removed.
	interceptor, _ := otelconnect.NewInterceptor(
		otelconnect.WithTrustRemote(),
	)
	return interceptor
}
