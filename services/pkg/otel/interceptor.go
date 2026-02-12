package otel

import (
	"context"
	"time"

	"connectrpc.com/connect"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	otelmetric "go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

// OTelInterceptor returns a Connect unary interceptor that creates spans for
// each RPC call and records request duration and count metrics.
//
// It should be placed as the FIRST interceptor in the chain so that the span
// captures the full request lifecycle including auth, rate limiting, etc.
func OTelInterceptor() connect.UnaryInterceptorFunc {
	tracer := otel.Tracer("shorted.api")
	meter := otel.Meter("shorted.api")

	// Create instruments for RPC metrics
	durationHistogram, _ := meter.Float64Histogram(
		"rpc.server.duration",
		otelmetric.WithDescription("Duration of RPC calls in milliseconds"),
		otelmetric.WithUnit("ms"),
	)

	requestCounter, _ := meter.Int64Counter(
		"rpc.server.requests",
		otelmetric.WithDescription("Total number of RPC requests"),
	)

	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			procedure := req.Spec().Procedure
			start := time.Now()

			// Start a new span for this RPC call
			ctx, span := tracer.Start(ctx, procedure,
				trace.WithSpanKind(trace.SpanKindServer),
				trace.WithAttributes(
					attribute.String("rpc.system", "connect"),
					attribute.String("rpc.method", procedure),
				),
			)
			defer span.End()

			// Increment the request counter
			requestCounter.Add(ctx, 1,
				otelmetric.WithAttributes(
					attribute.String("rpc.method", procedure),
				),
			)

			// Call the next handler
			resp, err := next(ctx, req)

			// Record duration
			duration := float64(time.Since(start).Milliseconds())

			if err != nil {
				// Extract Connect error code if available
				code := connect.CodeOf(err)
				span.SetAttributes(attribute.String("rpc.connect.status_code", code.String()))
				span.SetStatus(codes.Error, err.Error())
				span.RecordError(err)

				durationHistogram.Record(ctx, duration,
					otelmetric.WithAttributes(
						attribute.String("rpc.method", procedure),
						attribute.String("rpc.connect.status_code", code.String()),
					),
				)
			} else {
				span.SetAttributes(attribute.String("rpc.connect.status_code", "ok"))

				durationHistogram.Record(ctx, duration,
					otelmetric.WithAttributes(
						attribute.String("rpc.method", procedure),
						attribute.String("rpc.connect.status_code", "ok"),
					),
				)
			}

			return resp, err
		}
	}
}
