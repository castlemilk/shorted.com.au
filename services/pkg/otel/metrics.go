package otel

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
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

	// Sync job metrics
	SyncDuration          otelmetric.Float64Histogram
	SyncRecordsProcessed  otelmetric.Int64Counter
	SyncStatus            otelmetric.Int64Counter
	SyncLastSuccess       otelmetric.Int64Gauge
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

	SyncDuration, _ = meter.Float64Histogram(
		"shorted.sync.duration",
		otelmetric.WithDescription("Duration of sync job runs in seconds"),
		otelmetric.WithUnit("s"),
	)

	SyncRecordsProcessed, _ = meter.Int64Counter(
		"shorted.sync.records_processed",
		otelmetric.WithDescription("Number of records processed during sync"),
	)

	SyncStatus, _ = meter.Int64Counter(
		"shorted.sync.status",
		otelmetric.WithDescription("Sync job completion status"),
	)

	SyncLastSuccess, _ = meter.Int64Gauge(
		"shorted.sync.last_success",
		otelmetric.WithDescription("Unix timestamp of last successful sync"),
	)
}

// RegisterDBPoolMetrics registers observable gauge callbacks that read
// from pgxpool.Pool.Stat() to expose connection pool utilization.
func RegisterDBPoolMetrics(pool *pgxpool.Pool) {
	meter := otel.Meter("shorted.db")

	activeConns, _ := meter.Int64ObservableGauge(
		"db.pool.active_connections",
		otelmetric.WithDescription("Number of active (in-use) connections"),
	)
	idleConns, _ := meter.Int64ObservableGauge(
		"db.pool.idle_connections",
		otelmetric.WithDescription("Number of idle connections"),
	)
	totalConns, _ := meter.Int64ObservableGauge(
		"db.pool.total_connections",
		otelmetric.WithDescription("Total number of connections in the pool"),
	)
	maxConns, _ := meter.Int64ObservableGauge(
		"db.pool.max_connections",
		otelmetric.WithDescription("Maximum pool size"),
	)

	_, _ = meter.RegisterCallback(
		func(_ context.Context, o otelmetric.Observer) error {
			stat := pool.Stat()
			o.ObserveInt64(activeConns, int64(stat.AcquiredConns()))
			o.ObserveInt64(idleConns, int64(stat.IdleConns()))
			o.ObserveInt64(totalConns, int64(stat.TotalConns()))
			o.ObserveInt64(maxConns, int64(stat.MaxConns()))
			return nil
		},
		activeConns, idleConns, totalConns, maxConns,
	)
}
