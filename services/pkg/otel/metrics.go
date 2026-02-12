package otel

import (
	"go.opentelemetry.io/otel"
	otelmetric "go.opentelemetry.io/otel/metric"
)

// Custom business metrics for observability.
// These are initialized by InitCustomMetrics() and can be used throughout
// the service by importing this package and calling Add() on the counters.
var (
	// RateLimitBlocked counts requests blocked by rate limiting.
	RateLimitBlocked otelmetric.Int64Counter

	// AuthMethod counts authentication attempts by method
	// (firebase, token, internal, anonymous).
	AuthMethod otelmetric.Int64Counter

	// ScraperBlocked counts requests blocked by the User-Agent scraper check.
	ScraperBlocked otelmetric.Int64Counter
)

// InitCustomMetrics initializes the custom business metric instruments.
// It is called automatically by InitProvider but can also be called
// independently for testing or when OTel is not fully configured.
func InitCustomMetrics() {
	meter := otel.Meter("shorted.business")

	RateLimitBlocked, _ = meter.Int64Counter(
		"shorted.rate_limit.blocked",
		otelmetric.WithDescription("Number of requests blocked by rate limiting"),
	)

	AuthMethod, _ = meter.Int64Counter(
		"shorted.auth.method",
		otelmetric.WithDescription("Authentication method distribution"),
	)

	ScraperBlocked, _ = meter.Int64Counter(
		"shorted.scraper.blocked",
		otelmetric.WithDescription("Number of requests blocked by scraper/bot detection"),
	)
}
