package ratelimit

import "time"

// TierLimits defines rate limits for a specific tier
type TierLimits struct {
	// API/programmatic access limits (stricter)
	RequestsPerMinute int `json:"requests_per_minute" yaml:"requests_per_minute" mapstructure:"requests_per_minute"`
	RequestsPerMonth  int `json:"requests_per_month" yaml:"requests_per_month" mapstructure:"requests_per_month"`

	// Browser access limits (more relaxed) - used for Firebase auth from web app
	BrowserRequestsPerMinute int `json:"browser_requests_per_minute" yaml:"browser_requests_per_minute" mapstructure:"browser_requests_per_minute"`
	BrowserRequestsPerMonth  int `json:"browser_requests_per_month" yaml:"browser_requests_per_month" mapstructure:"browser_requests_per_month"`
}

// Config holds the rate limiter configuration
type Config struct {
	// Upstash REST API configuration
	UpstashURL   string `json:"upstash_url" yaml:"upstash_url" mapstructure:"upstash_url"`
	UpstashToken string `json:"upstash_token" yaml:"upstash_token" mapstructure:"upstash_token"`

	// Enable/disable rate limiting
	Enabled bool `json:"enabled" yaml:"enabled" mapstructure:"enabled"`

	// Tier limits
	Tiers map[string]TierLimits `json:"tiers" yaml:"tiers" mapstructure:"tiers"`

	// Fallback behavior when Redis is unavailable
	FailOpen bool `json:"fail_open" yaml:"fail_open" mapstructure:"fail_open"`

	// Key prefix for Redis
	KeyPrefix string `json:"key_prefix" yaml:"key_prefix" mapstructure:"key_prefix"`

	// Window size for sliding window (default 1 minute)
	WindowSize time.Duration `json:"window_size" yaml:"window_size" mapstructure:"window_size"`

	// HTTP client timeout for Upstash requests
	Timeout time.Duration `json:"timeout" yaml:"timeout" mapstructure:"timeout"`

	// AllowedOrigins is the list of hostnames allowed for browser-tier rate limits.
	// Requests with browser auth that don't match these origins (or *.vercel.app)
	// are downgraded to API-tier rate limits.
	AllowedOrigins []string `json:"allowed_origins" yaml:"allowed_origins" mapstructure:"allowed_origins"`

	// ---- Monthly quota batching (MonthlyLimiter) ----
	//
	// Per-minute limiting is enforced at the Cloudflare edge and does NOT
	// touch Upstash. The knobs below govern the app layer's only remaining
	// Upstash traffic: batched monthly quota accounting.

	// MonthlyFlushThreshold is the number of buffered increments for a single
	// identifier that triggers an immediate flush. Larger = fewer Upstash
	// commands, larger worst-case undercount on instance death.
	MonthlyFlushThreshold int `json:"monthly_flush_threshold" yaml:"monthly_flush_threshold" mapstructure:"monthly_flush_threshold"`

	// MonthlyFlushInterval is the periodic flush cadence. Every identifier
	// with pending increments is written at most this far behind.
	MonthlyFlushInterval time.Duration `json:"monthly_flush_interval" yaml:"monthly_flush_interval" mapstructure:"monthly_flush_interval"`

	// MonthlyIdleEviction drops in-memory counters for identifiers unseen for
	// this long (only when they have nothing pending), bounding memory.
	MonthlyIdleEviction time.Duration `json:"monthly_idle_eviction" yaml:"monthly_idle_eviction" mapstructure:"monthly_idle_eviction"`

	// SkipAnonymousMonthly leaves IP-keyed (unauthenticated) callers unmetered
	// for the monthly quota. Anonymous identifiers are an unbounded key space:
	// metering them means one Upstash key per IP per month, which is exactly
	// the long tail that exhausted the shared database's command quota.
	// Anonymous abuse control is the edge per-IP minute bucket's job.
	SkipAnonymousMonthly bool `json:"skip_anonymous_monthly" yaml:"skip_anonymous_monthly" mapstructure:"skip_anonymous_monthly"`

	// BreakerFailureThreshold is the number of consecutive Upstash failures
	// that opens the circuit breaker (suppressing further calls).
	BreakerFailureThreshold int `json:"breaker_failure_threshold" yaml:"breaker_failure_threshold" mapstructure:"breaker_failure_threshold"`

	// BreakerCooldown is how long the circuit stays open before a probe.
	BreakerCooldown time.Duration `json:"breaker_cooldown" yaml:"breaker_cooldown" mapstructure:"breaker_cooldown"`
}

// Batching + circuit-breaker defaults.
//
// Volume: at 25/30s a caller doing 10,000 requests/month costs at most
// 400 flushes x 2 commands = 800 Upstash commands, versus 70,000 under the
// old per-request 7-command pipeline — an ~87x reduction. With anonymous
// traffic unmetered, total monthly command volume is bounded by the number of
// *authenticated* users, not by request count.
//
// Accuracy: worst-case undercount per identifier per instance death is
// MonthlyFlushThreshold-1 = 24 requests (0.24% of the 10,000/month paid API
// quota, 1.2% of the 2,000/month free quota). Monthly quotas are a fairness
// control rather than a security boundary, so that is an acceptable trade.
const (
	defaultMonthlyFlushThreshold   = 25
	defaultMonthlyFlushInterval    = 30 * time.Second
	defaultMonthlyIdleEviction     = time.Hour
	defaultBreakerFailureThreshold = 3
	defaultBreakerCooldown         = 60 * time.Second
)

// DefaultConfig returns the default rate limiter configuration
//
// ARCHITECTURE (post August-2026 Upstash incident):
//
//	per-minute limiting -> Cloudflare edge worker (services/edge-worker)
//	monthly quotas      -> this package (MonthlyLimiter, batched Upstash writes)
//
// The RequestsPerMinute / BrowserRequestsPerMinute fields below are retained
// as the DOCUMENTED tier contract (they still describe what a tier is entitled
// to, and the API docs quote them), but MonthlyLimiter does not enforce them —
// the edge does. Only the *PerMonth fields are enforced here.
//
// Rate Limit Tiers (API/programmatic access via API tokens):
//   - anonymous:  10 req/min,  500 req/month  - Unauthenticated requests (by IP)
//   - free:       30 req/min, 1000 req/month  - Authenticated users without paid subscription
//   - pro:       120 req/min, 10000 req/month - Users with pro subscription
//   - enterprise: 300 req/min, 50000 req/month - Enterprise users
//
// Browser access (via Firebase auth from web app) has relaxed limits:
//   - anonymous:  60 req/min, 5000 req/month
//   - free:       120 req/min, 10000 req/month
//   - pro/enterprise: unlimited (no rate limiting for browser)
//
// The "premium" tier applies to consumer premium subscribers ($4/mo).
// The "pro" tier applies to legacy pro subscribers (treated same as premium).
func DefaultConfig() Config {
	return Config{
		Enabled: false, // Disabled by default for safety
		Tiers: map[string]TierLimits{
			"anonymous": {
				RequestsPerMinute: 10, RequestsPerMonth: 500, // API limits (tightened to discourage scraping)
				BrowserRequestsPerMinute: 60, BrowserRequestsPerMonth: 5000, // Browser limits
			},
			"free": {
				RequestsPerMinute: 30, RequestsPerMonth: 1000, // API limits (tightened from 60/2000)
				BrowserRequestsPerMinute: 120, BrowserRequestsPerMonth: 10000, // Browser limits
			},
			"pro": {
				RequestsPerMinute: 120, RequestsPerMonth: 10000, // API limits (2 req/sec)
				BrowserRequestsPerMinute: 0, BrowserRequestsPerMonth: 0, // Browser: no limits (0 = unlimited)
			},
			"enterprise": {
				RequestsPerMinute: 300, RequestsPerMonth: 50000, // API limits (5 req/sec)
				BrowserRequestsPerMinute: 0, BrowserRequestsPerMonth: 0, // Browser: no limits
			},
			"premium": {
				RequestsPerMinute: 120, RequestsPerMonth: 10000, // API limits (same as pro)
				BrowserRequestsPerMinute: 0, BrowserRequestsPerMonth: 0, // Browser: no limits
			},
		},
		FailOpen:   true, // Don't block requests if Redis fails
		KeyPrefix:  "ratelimit:shorted:",
		WindowSize: time.Minute,
		Timeout:    5 * time.Second,

		MonthlyFlushThreshold:   defaultMonthlyFlushThreshold,
		MonthlyFlushInterval:    defaultMonthlyFlushInterval,
		MonthlyIdleEviction:     defaultMonthlyIdleEviction,
		SkipAnonymousMonthly:    true,
		BreakerFailureThreshold: defaultBreakerFailureThreshold,
		BreakerCooldown:         defaultBreakerCooldown,
		AllowedOrigins: []string{
			"shorted.com.au",
			"www.shorted.com.au",
			"localhost",
			"127.0.0.1",
		},
	}
}

// GetLimits returns the limits for a given tier, falling back to anonymous if not found
func (c *Config) GetLimits(tier string) TierLimits {
	if limits, ok := c.Tiers[tier]; ok {
		return limits
	}
	return c.Tiers["anonymous"]
}
