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
	SyncDuration         otelmetric.Float64Histogram
	SyncRecordsProcessed otelmetric.Int64Counter
	SyncStatus           otelmetric.Int64Counter
	SyncLastSuccess      otelmetric.Int64Gauge

	// Logo discovery metrics
	LogoDiscoveryTotal    otelmetric.Int64Counter
	LogoDiscoveryDuration otelmetric.Float64Histogram

	// AI request cost-attribution metrics. Keep attributes bounded at call sites:
	// feature, model, phase, status, token_type, and tool_name are acceptable;
	// user IDs, IPs, prompts, conversation IDs, and stock codes are not.
	AIRequestsTotal    otelmetric.Int64Counter
	AITokensTotal      otelmetric.Int64Counter
	AIInputCharsTotal  otelmetric.Int64Counter
	AIToolCallsTotal   otelmetric.Int64Counter
	AIToolResultBytes  otelmetric.Int64Counter
	ChatStorageWrites  otelmetric.Int64Counter
	ChatMessagesPruned otelmetric.Int64Counter
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

	LogoDiscoveryTotal, _ = meter.Int64Counter(
		"shorted.logo.discovery_total",
		otelmetric.WithDescription("Total logo discovery attempts by source and result"),
	)

	LogoDiscoveryDuration, _ = meter.Float64Histogram(
		"shorted.logo.discovery_duration",
		otelmetric.WithDescription("Duration of logo discovery in seconds"),
		otelmetric.WithUnit("s"),
	)

	AIRequestsTotal, _ = meter.Int64Counter(
		"shorted.ai.requests_total",
		otelmetric.WithDescription("Total AI model requests by feature, model, phase, and status"),
	)

	AITokensTotal, _ = meter.Int64Counter(
		"shorted.ai.tokens_total",
		otelmetric.WithDescription("Total AI tokens by feature, model, phase, status, and token type"),
	)

	AIInputCharsTotal, _ = meter.Int64Counter(
		"shorted.ai.input_chars_total",
		otelmetric.WithDescription("Total AI input characters by feature, model, phase, and status"),
	)

	AIToolCallsTotal, _ = meter.Int64Counter(
		"shorted.ai.tool_calls_total",
		otelmetric.WithDescription("Total AI tool calls by feature, tool, and status"),
	)

	AIToolResultBytes, _ = meter.Int64Counter(
		"shorted.ai.tool_result_bytes_total",
		otelmetric.WithDescription("Total bytes returned from AI tool calls by feature, tool, and status"),
		otelmetric.WithUnit("By"),
	)

	ChatStorageWrites, _ = meter.Int64Counter(
		"shorted.chat.storage_writes_total",
		otelmetric.WithDescription("Total chat persistence writes by role"),
	)

	ChatMessagesPruned, _ = meter.Int64Counter(
		"shorted.chat.messages_pruned_total",
		otelmetric.WithDescription("Total old chat messages pruned by retention guardrails"),
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
