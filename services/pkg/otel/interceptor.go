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
	interceptor, _ := otelconnect.NewInterceptor(
		otelconnect.WithoutServerPeerAttributes(),
		otelconnect.WithTrustRemote(),
	)
	return interceptor
}
