package otel

import (
	"context"
	"os"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	"go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
)

// InitProvider sets up the OTel SDK with OTLP exporter.
// It reads standard OTEL_* environment variables automatically.
// Returns a shutdown function to flush on exit.
//
// If OTEL_EXPORTER_OTLP_ENDPOINT is not set, it returns a no-op shutdown
// function so the service can run without OTel configured.
func InitProvider(ctx context.Context, serviceName string) (func(context.Context) error, error) {
	// Always initialize custom metrics so nil guards at call sites are not needed
	// when OTel is not fully configured. The global no-op MeterProvider handles this.
	InitCustomMetrics()

	// If no OTLP endpoint is configured, return a no-op shutdown.
	// This allows the service to run without OTel in development.
	if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") == "" {
		return func(context.Context) error { return nil }, nil
	}

	// Determine deployment environment from ENVIRONMENT env var
	environment := os.Getenv("ENVIRONMENT")
	if environment == "" {
		environment = "development"
	}

	// Build the resource with service name and deployment environment
	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(serviceName),
			attribute.String("deployment.environment", environment),
		),
	)
	if err != nil {
		return nil, err
	}

	// Set up the OTLP trace exporter.
	// The exporter reads OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS,
	// and OTEL_EXPORTER_OTLP_PROTOCOL from the environment automatically.
	traceExporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, err
	}

	// Create a TracerProvider with a BatchSpanProcessor (default batching config)
	tp := trace.NewTracerProvider(
		trace.WithBatcher(traceExporter),
		trace.WithResource(res),
	)
	otel.SetTracerProvider(tp)

	// Set up the OTLP metric exporter with a 30-second periodic reader
	metricExporter, err := otlpmetrichttp.New(ctx)
	if err != nil {
		return nil, err
	}

	mp := metric.NewMeterProvider(
		metric.WithReader(metric.NewPeriodicReader(metricExporter, metric.WithInterval(30*time.Second))),
		metric.WithResource(res),
	)
	otel.SetMeterProvider(mp)

	// Re-initialize custom metrics now that real MeterProvider is set
	InitCustomMetrics()

	// Return a shutdown function that flushes both providers
	shutdown := func(ctx context.Context) error {
		var firstErr error
		if err := tp.Shutdown(ctx); err != nil && firstErr == nil {
			firstErr = err
		}
		if err := mp.Shutdown(ctx); err != nil && firstErr == nil {
			firstErr = err
		}
		return firstErr
	}

	return shutdown, nil
}
