package otel

import (
	"context"
	"os"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	"go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
)

// histogramViews returns Views that set explicit bucket boundaries for
// duration histograms, keeping cardinality predictable.
func histogramViews() []metric.View {
	// RPC duration buckets (milliseconds): focused on API latency ranges
	// 10 buckets → 10 time series per unique label combination
	rpcBuckets := []float64{5, 10, 25, 50, 100, 250, 500, 1000, 2500, 10000}

	// HTTP duration buckets (milliseconds): similar to RPC
	httpBuckets := []float64{5, 10, 25, 50, 100, 250, 500, 1000, 2500, 10000}

	// Sync duration buckets (seconds): jobs run for seconds to hours
	syncBuckets := []float64{1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600}

	// Request/response size buckets (bytes)
	sizeBuckets := []float64{128, 512, 1024, 4096, 16384, 65536, 262144, 1048576}

	return []metric.View{
		// otelconnect RPC duration
		metric.NewView(
			metric.Instrument{Name: "rpc.server.duration"},
			metric.Stream{Aggregation: metric.AggregationExplicitBucketHistogram{
				Boundaries: rpcBuckets,
			}},
		),
		// otelconnect RPC request size
		metric.NewView(
			metric.Instrument{Name: "rpc.server.request.size"},
			metric.Stream{Aggregation: metric.AggregationExplicitBucketHistogram{
				Boundaries: sizeBuckets,
			}},
		),
		// otelconnect RPC response size
		metric.NewView(
			metric.Instrument{Name: "rpc.server.response.size"},
			metric.Stream{Aggregation: metric.AggregationExplicitBucketHistogram{
				Boundaries: sizeBuckets,
			}},
		),
		// Custom HTTP middleware duration
		metric.NewView(
			metric.Instrument{Name: "http.server.duration"},
			metric.Stream{Aggregation: metric.AggregationExplicitBucketHistogram{
				Boundaries: httpBuckets,
			}},
		),
		// Sync job duration
		metric.NewView(
			metric.Instrument{Name: "shorted.sync.duration"},
			metric.Stream{Aggregation: metric.AggregationExplicitBucketHistogram{
				Boundaries: syncBuckets,
			}},
		),
		// Stealth HTTP fetch duration (seconds): web scraping latency
		metric.NewView(
			metric.Instrument{Name: "shorted.stealth.fetch_duration"},
			metric.Stream{Aggregation: metric.AggregationExplicitBucketHistogram{
				Boundaries: []float64{0.1, 0.25, 0.5, 1, 2, 5, 10, 30},
			}},
		),
		// Logo discovery duration (seconds)
		metric.NewView(
			metric.Instrument{Name: "shorted.logo.discovery_duration"},
			metric.Stream{Aggregation: metric.AggregationExplicitBucketHistogram{
				Boundaries: syncBuckets,
			}},
		),
		// Monthly quota consumption (percent of quota). The buckets are dense
		// where a decision gets made — 90/95/99 is where a caller is about to
		// be blocked and where an upsell or a support call comes from — and
		// sparse below that. >100 exists because the limiter overshoots by
		// design across instances (see monthly.go).
		metric.NewView(
			metric.Instrument{Name: "shorted.rate_limit.quota_consumed_ratio"},
			metric.Stream{Aggregation: metric.AggregationExplicitBucketHistogram{
				Boundaries: []float64{1, 5, 10, 25, 50, 75, 90, 95, 99, 100, 110},
			}},
		),
		// Quota store statement duration (seconds). Off the request path, so
		// the interesting range is "healthy" vs "about to hit the 5s timeout".
		metric.NewView(
			metric.Instrument{Name: "shorted.rate_limit.store_duration"},
			metric.Stream{Aggregation: metric.AggregationExplicitBucketHistogram{
				Boundaries: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5},
			}},
		),
		// Identifiers per flush. One statement covers the whole batch, so this
		// is the batch width, not a statement count.
		metric.NewView(
			metric.Instrument{Name: "shorted.rate_limit.flush_rows"},
			metric.Stream{Aggregation: metric.AggregationExplicitBucketHistogram{
				Boundaries: []float64{1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000},
			}},
		),
	}
}

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

	// Read optional service version from environment (e.g., git SHA)
	serviceVersion := os.Getenv("SERVICE_VERSION")

	// Build the resource with service name, version, and deployment environment
	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(serviceName),
			semconv.ServiceVersion(serviceVersion),
			attribute.String("deployment.environment", environment),
		),
		resource.WithHost(),
	)
	if err != nil {
		return nil, err
	}

	// Enable W3C TraceContext + Baggage propagation for distributed tracing.
	// Without this, trace context is not propagated across service boundaries.
	otel.SetTextMapPropagator(
		propagation.NewCompositeTextMapPropagator(
			propagation.TraceContext{},
			propagation.Baggage{},
		),
	)

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

	// Build MeterProvider options: reader + resource + histogram views for cardinality control
	mpOpts := []metric.Option{
		metric.WithReader(metric.NewPeriodicReader(metricExporter, metric.WithInterval(30*time.Second))),
		metric.WithResource(res),
	}
	for _, v := range histogramViews() {
		mpOpts = append(mpOpts, metric.WithView(v))
	}

	mp := metric.NewMeterProvider(mpOpts...)
	otel.SetMeterProvider(mp)

	// Re-initialize custom metrics now that real MeterProvider is set
	InitCustomMetrics()

	// Return a shutdown function that flushes both providers
	shutdown := func(ctx context.Context) error {
		// Flush traces first (typically more time-sensitive)
		tpErr := tp.Shutdown(ctx)
		mpErr := mp.Shutdown(ctx)
		if tpErr != nil {
			return tpErr
		}
		return mpErr
	}

	return shutdown, nil
}
