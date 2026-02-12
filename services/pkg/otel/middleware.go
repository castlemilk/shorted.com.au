package otel

import (
	"fmt"
	"net/http"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	otelmetric "go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

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
		spanName := fmt.Sprintf("HTTP %s %s", r.Method, r.URL.Path)

		ctx, span := tracer.Start(r.Context(), spanName,
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(
				attribute.String("http.method", r.Method),
				attribute.String("http.route", r.URL.Path),
				attribute.String("http.url", r.URL.String()),
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
				attribute.String("http.route", r.URL.Path),
				attribute.Int("http.status_code", rec.statusCode),
			),
		)
	})
}
