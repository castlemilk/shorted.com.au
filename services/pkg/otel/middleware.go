package otel

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	otelmetric "go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

// knownRoutes is the set of registered HTTP endpoint prefixes.
// Paths not matching any known route are bucketed into "/other" to prevent
// unbounded cardinality from crawlers, 404 scanners, etc.
var knownRoutes = []string{
	"/health",
	"/ready",
	"/api/stocks/search",
	"/api/algolia/search",
	"/api/admin/sync-status",
	"/api/admin/cleanup-stuck-runs",
	"/api/debug/perf",
	"/api/docs/",
}

// normalizeRoute maps a raw URL path to a known route pattern.
// Unknown paths are bucketed into "/other" to bound metric cardinality.
func normalizeRoute(path string) string {
	for _, route := range knownRoutes {
		if path == route || strings.HasPrefix(path, route) {
			return route
		}
	}
	// Connect-RPC paths are handled by otelconnect, not this middleware,
	// but if they leak through, bucket them by service prefix.
	if strings.HasPrefix(path, "/shorts.") || strings.HasPrefix(path, "/register.") {
		return "/rpc"
	}
	return "/other"
}

// statusRecorder wraps http.ResponseWriter to capture the status code.
type statusRecorder struct {
	http.ResponseWriter
	statusCode int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.statusCode = code
	r.ResponseWriter.WriteHeader(code)
}

// HTTPMiddleware wraps an http.Handler to create spans for HTTP requests
// and record request duration metrics. This is intended for non-RPC endpoints
// such as health checks, search endpoints, and admin APIs.
func HTTPMiddleware(next http.Handler) http.Handler {
	tracer := otel.Tracer("shorted.http")
	meter := otel.Meter("shorted.http")

	durationHistogram, _ := meter.Float64Histogram(
		"http.server.duration",
		otelmetric.WithDescription("Duration of HTTP requests in milliseconds"),
		otelmetric.WithUnit("ms"),
	)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		route := normalizeRoute(r.URL.Path)
		spanName := fmt.Sprintf("HTTP %s %s", r.Method, route)

		ctx, span := tracer.Start(r.Context(), spanName,
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(
				attribute.String("http.method", r.Method),
				attribute.String("http.route", route),
			),
		)
		defer span.End()

		// Wrap the ResponseWriter to capture the status code
		rec := &statusRecorder{ResponseWriter: w, statusCode: http.StatusOK}

		// Serve the request with the span context
		next.ServeHTTP(rec, r.WithContext(ctx))

		// Record attributes and duration
		span.SetAttributes(attribute.Int("http.status_code", rec.statusCode))

		if rec.statusCode >= 400 {
			span.SetStatus(codes.Error, fmt.Sprintf("HTTP %d", rec.statusCode))
		}

		duration := float64(time.Since(start).Milliseconds())
		durationHistogram.Record(ctx, duration,
			otelmetric.WithAttributes(
				attribute.String("http.method", r.Method),
				attribute.String("http.route", route),
				attribute.Int("http.status_code", rec.statusCode),
			),
		)
	})
}
