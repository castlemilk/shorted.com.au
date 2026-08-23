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
	// Rate limiter metrics.
	//
	// CARDINALITY RULE (load-bearing, same rule as the AI metrics below):
	// attributes on these instruments must be drawn from small closed sets —
	// tier, access, decision, kind, operation, state, reason, result. The
	// rate limiter's natural key is the *identifier* (an IP or a user id), and
	// that is an unbounded key space: using it as an attribute would create one
	// time series per unique client and turn the observability bill into the
	// next incident. Per-identifier detail belongs in logs, redacted.
	//
	// RateLimitBlocked counts requests blocked by rate limiting. It is a
	// trailing indicator — it only fires once a caller is ALREADY blocked, so
	// the instruments beneath it exist to see pressure building.
	RateLimitBlocked otelmetric.Int64Counter

	// RateLimitChecks counts every app-layer rate limit decision, allowed or
	// not. This is the denominator RateLimitBlocked was missing.
	RateLimitChecks otelmetric.Int64Counter

	// RateLimitQuotaConsumed is the distribution of "percent of monthly quota
	// consumed" at decision time, bucketed. Bucketed rather than per-identifier
	// so "how many callers are above 90% of quota" is answerable without a
	// series per caller.
	RateLimitQuotaConsumed otelmetric.Float64Histogram

	// RateLimitBreakerTransitions counts quota-store circuit breaker state
	// changes (open / half_open / closed). A sick quota database otherwise
	// fails open in silence — the exact shape of the August 2026 incident.
	RateLimitBreakerTransitions otelmetric.Int64Counter

	// Flush health. A flush that never succeeds means monthly quota is not
	// being enforced, and nothing else in the system will say so.
	RateLimitFlushTotal    otelmetric.Int64Counter
	RateLimitFlushRows     otelmetric.Int64Histogram
	RateLimitRetained      otelmetric.Int64Gauge
	RateLimitDeltasDropped otelmetric.Int64Counter

	// Quota store (Postgres) latency and errors. Errors are classed, never
	// carried as raw messages (raw driver text is unbounded).
	RateLimitStoreDuration otelmetric.Float64Histogram
	RateLimitStoreErrors   otelmetric.Int64Counter

	// Per-minute limiter pressure. The identifier map is capped and the cap
	// silently disables limiting for NEW identifiers, so it must be visible.
	RateLimitMinuteIdentifiers  otelmetric.Int64Gauge
	RateLimitMonthlyIdentifiers otelmetric.Int64Gauge
	RateLimitMinuteEvictions    otelmetric.Int64Counter
	RateLimitMinuteCapReached   otelmetric.Int64Counter

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

	RateLimitChecks, _ = meter.Int64Counter(
		"shorted.rate_limit.checks_total",
		otelmetric.WithDescription("App-layer rate limit decisions by tier, access, decision and limit kind"),
	)

	RateLimitQuotaConsumed, _ = meter.Float64Histogram(
		"shorted.rate_limit.quota_consumed_ratio",
		otelmetric.WithDescription("Percent of monthly quota consumed at decision time, by tier and access"),
		otelmetric.WithUnit("%"),
	)

	RateLimitBreakerTransitions, _ = meter.Int64Counter(
		"shorted.rate_limit.breaker_transitions_total",
		otelmetric.WithDescription("Quota-store circuit breaker state transitions (open/half_open/closed)"),
	)

	RateLimitFlushTotal, _ = meter.Int64Counter(
		"shorted.rate_limit.flush_total",
		otelmetric.WithDescription("Monthly quota flush attempts by result"),
	)

	RateLimitFlushRows, _ = meter.Int64Histogram(
		"shorted.rate_limit.flush_rows",
		otelmetric.WithDescription("Identifiers written per monthly quota flush"),
	)

	RateLimitRetained, _ = meter.Int64Gauge(
		"shorted.rate_limit.retained_deltas",
		otelmetric.WithDescription("Unflushed quota increments held in memory, by buffer (pending/orphan)"),
	)

	RateLimitDeltasDropped, _ = meter.Int64Counter(
		"shorted.rate_limit.deltas_dropped_total",
		otelmetric.WithDescription("Quota increments discarded because a retention cap was hit, by reason"),
	)

	RateLimitStoreDuration, _ = meter.Float64Histogram(
		"shorted.rate_limit.store_duration",
		otelmetric.WithDescription("api_usage_monthly statement duration in seconds, by operation and status"),
		otelmetric.WithUnit("s"),
	)

	RateLimitStoreErrors, _ = meter.Int64Counter(
		"shorted.rate_limit.store_errors_total",
		otelmetric.WithDescription("api_usage_monthly statement errors by operation and error class"),
	)

	RateLimitMinuteIdentifiers, _ = meter.Int64Gauge(
		"shorted.rate_limit.minute_identifiers",
		otelmetric.WithDescription("Identifiers currently tracked by the in-process per-minute limiter"),
	)

	RateLimitMonthlyIdentifiers, _ = meter.Int64Gauge(
		"shorted.rate_limit.monthly_identifiers",
		otelmetric.WithDescription("Identifiers currently tracked for monthly quota accounting"),
	)

	RateLimitMinuteEvictions, _ = meter.Int64Counter(
		"shorted.rate_limit.minute_evictions_total",
		otelmetric.WithDescription("Per-minute limiter map evictions by reason (expired/least_recently_seen)"),
	)

	RateLimitMinuteCapReached, _ = meter.Int64Counter(
		"shorted.rate_limit.minute_cap_reached_total",
		otelmetric.WithDescription("Requests that went UNMETERED because the per-minute identifier map was full"),
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
