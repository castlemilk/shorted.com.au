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

// Config holds the rate limiter configuration.
//
// STORAGE: monthly quota accounting is backed by POSTGRES (the API's existing
// pgx pool). There is no Redis/Upstash configuration here any more, and there
// must never be again — see the failure-domain note on DefaultConfig.
type Config struct {
	// Enable/disable rate limiting
	Enabled bool `json:"enabled" yaml:"enabled" mapstructure:"enabled"`

	// Tier limits
	Tiers map[string]TierLimits `json:"tiers" yaml:"tiers" mapstructure:"tiers"`

	// Fallback behavior when the quota store is unavailable.
	//
	// The app limiter is unconditionally fail-open on its own internals; this
	// flag only governs the interceptor's behaviour if Check itself returns an
	// error (which the production limiter never does).
	FailOpen bool `json:"fail_open" yaml:"fail_open" mapstructure:"fail_open"`

	// WindowSize is the per-minute window enforced IN PROCESS (default 1m).
	WindowSize time.Duration `json:"window_size" yaml:"window_size" mapstructure:"window_size"`

	// Timeout bounds every database statement issued by the quota store.
	Timeout time.Duration `json:"timeout" yaml:"timeout" mapstructure:"timeout"`

	// AllowedOrigins is the list of hostnames allowed for browser-tier rate limits.
	// Requests with browser auth that don't match these origins (or *.vercel.app)
	// are downgraded to API-tier rate limits.
	AllowedOrigins []string `json:"allowed_origins" yaml:"allowed_origins" mapstructure:"allowed_origins"`

	// UpgradeURL is the absolute URL a rate-limited caller is pointed at. It is
	// part of the documented 429 payload contract, so it must be absolute (the
	// API is consumed cross-origin and by non-browser clients).
	UpgradeURL string `json:"upgrade_url" yaml:"upgrade_url" mapstructure:"upgrade_url"`

	// ---- Monthly quota batching (see monthly.go for the overshoot maths) ----

	// MonthlyFlushThreshold is the number of buffered increments for a single
	// identifier that triggers a flush of the WHOLE pending set. Larger = fewer
	// statements, larger worst-case overshoot.
	MonthlyFlushThreshold int `json:"monthly_flush_threshold" yaml:"monthly_flush_threshold" mapstructure:"monthly_flush_threshold"`

	// MonthlyNearLimitThreshold replaces MonthlyFlushThreshold once a caller is
	// within MonthlyNearLimitFraction of their quota. Batching hard is free
	// while a caller is at 3% of quota and expensive at 97%, so the batch size
	// collapses exactly where accuracy starts to matter.
	MonthlyNearLimitThreshold int `json:"monthly_near_limit_threshold" yaml:"monthly_near_limit_threshold" mapstructure:"monthly_near_limit_threshold"`

	// MonthlyFlushInterval is the periodic flush cadence. Pending deltas are
	// written at most this far behind (one statement for all identifiers).
	MonthlyFlushInterval time.Duration `json:"monthly_flush_interval" yaml:"monthly_flush_interval" mapstructure:"monthly_flush_interval"`

	// MonthlyTotalTTL is how long a cached remote total is trusted before an
	// ASYNC refresh is triggered. A stale/absent total never blocks a request.
	MonthlyTotalTTL time.Duration `json:"monthly_total_ttl" yaml:"monthly_total_ttl" mapstructure:"monthly_total_ttl"`

	// MonthlyIdleEviction drops in-memory counters for identifiers unseen for
	// this long (only when they have nothing pending), bounding memory.
	MonthlyIdleEviction time.Duration `json:"monthly_idle_eviction" yaml:"monthly_idle_eviction" mapstructure:"monthly_idle_eviction"`

	// MonthlyMaxIdentifiers caps the monthly state map. Beyond it, new
	// identifiers are simply not metered (fail open) rather than allowed to
	// grow memory without bound — an unbounded key space is what caused the
	// original incident.
	MonthlyMaxIdentifiers int `json:"monthly_max_identifiers" yaml:"monthly_max_identifiers" mapstructure:"monthly_max_identifiers"`

	// SkipAnonymousMonthly leaves IP-keyed (unauthenticated) callers unmetered
	// for the MONTHLY quota. Anonymous identifiers are an unbounded key space
	// and one row per IP per month is not worth writing. Anonymous per-minute
	// shaping still happens in process, and at the edge.
	SkipAnonymousMonthly bool `json:"skip_anonymous_monthly" yaml:"skip_anonymous_monthly" mapstructure:"skip_anonymous_monthly"`

	// ---- In-process per-minute limiting ----

	// MinuteMaxIdentifiers caps the per-minute window map.
	MinuteMaxIdentifiers int `json:"minute_max_identifiers" yaml:"minute_max_identifiers" mapstructure:"minute_max_identifiers"`

	// ---- Circuit breaker over the quota store ----

	// BreakerFailureThreshold is the number of consecutive store failures that
	// opens the circuit breaker (suppressing further statements).
	BreakerFailureThreshold int `json:"breaker_failure_threshold" yaml:"breaker_failure_threshold" mapstructure:"breaker_failure_threshold"`

	// BreakerCooldown is how long the circuit stays open before a probe.
	BreakerCooldown time.Duration `json:"breaker_cooldown" yaml:"breaker_cooldown" mapstructure:"breaker_cooldown"`
}

// Batching, caching and breaker defaults.
//
// WRITE VOLUME. A flush is ONE multi-row statement covering every identifier
// with a pending delta, so statement count is driven by flush *frequency*, not
// by traffic or by the number of users. With MonthlyFlushInterval=5m an
// instance under continuous traffic issues at most 288 periodic flushes/day,
// plus one per threshold trip. Measured shape at plausible traffic
// (~1-2 req/s, a few hundred authenticated identifiers/day, 2 instances):
// ~300-600 write statements/day total, plus a handful of cold-start SELECTs.
// The pre-#455 design issued ~7 Upstash commands per request — order 10^7/day.
//
// OVERSHOOT. Each instance's cached total is refreshed by its own flush
// (the upsert RETURNs the authoritative post-increment count), so a single
// instance is exact. Across N instances an identifier can exceed quota by at
// most N x (batch size in effect), because that is the most any instance can
// hold unflushed. Far from the limit the batch is 200, so 3 instances = up to
// 600 requests of overshoot (6% of a 10,000/month quota). Within 10% of quota
// the batch collapses to 10, so the overshoot at the boundary that actually
// matters is at most N x 10 = 30 requests (0.3%). Monthly quotas are a
// fairness control, not a security boundary, and the edge per-minute ceiling
// bounds how fast any overshoot can accumulate.
const (
	defaultMonthlyFlushThreshold     = 200
	defaultMonthlyNearLimitThreshold = 10
	defaultMonthlyFlushInterval      = 5 * time.Minute
	defaultMonthlyTotalTTL           = 5 * time.Minute
	defaultMonthlyIdleEviction       = time.Hour
	defaultMonthlyMaxIdentifiers     = 50_000
	defaultMinuteMaxIdentifiers      = 100_000
	defaultBreakerFailureThreshold   = 3
	defaultBreakerCooldown           = 60 * time.Second
	defaultTimeout                   = 5 * time.Second
	defaultUpgradeURL                = "https://shorted.com.au/pricing"
)

// nearLimitNumerator/Denominator define "near the limit" as >= 90% of quota.
const (
	nearLimitNumerator   = 9
	nearLimitDenominator = 10
)

// DefaultConfig returns the default rate limiter configuration.
//
// ARCHITECTURE (post August-2026 incident, post PR #455, post Postgres move):
//
//	abuse ceiling (tier-blind) -> Cloudflare edge worker (services/edge-worker)
//	per-tier per-minute        -> this package, IN MEMORY, per instance
//	monthly quotas             -> this package, POSTGRES, batched + fail-open
//
// The incident was a shared-dependency failure: a 7-command-per-request
// Upstash pipeline exhausted the command cap of the database that also backs
// the page cache, and Upstash then rejected writes while still serving reads —
// one quota, two outages. Rate limiting must therefore never depend on
// Upstash again, at any volume. Postgres has no per-command cap to exhaust,
// and the limiter does no I/O on the request path regardless.
//
// The per-minute numbers below are enforced PER INSTANCE and in memory, so
// with N Cloud Run instances the effective ceiling is up to N x the limit.
// That is deliberate: the alternative (a shared counter) reintroduces exactly
// the coupling that caused the incident, and approximate tier shaping is
// strictly better than the zero per-tier enforcement the edge can provide —
// the edge cannot resolve a caller's subscription tier without a lookup.
//
// Rate Limit Tiers (API/programmatic access via API tokens). The per-minute
// column is the documented tier entitlement; the per-month column keeps the
// values PR #455 tightened to discourage scraping (anonymous 500, free 1000) —
// this change is about WHERE quotas are stored, not about loosening them.
//   - anonymous:  30 req/min,   500 req/month
//   - free:       60 req/min,  1000 req/month
//   - pro:       120 req/min, 10000 req/month
//   - enterprise: 300 req/min, 50000 req/month
//
// Browser access (via Firebase auth from the web app) has relaxed limits:
//   - anonymous:  60 req/min,  5000 req/month
//   - free:      120 req/min, 10000 req/month
//   - pro/premium/enterprise: unlimited (0 = unlimited)
func DefaultConfig() Config {
	return Config{
		Enabled: false, // Disabled by default for safety
		Tiers: map[string]TierLimits{
			"anonymous": {
				RequestsPerMinute: 30, RequestsPerMonth: 500, // API limits
				BrowserRequestsPerMinute: 60, BrowserRequestsPerMonth: 5000, // Browser limits
			},
			"free": {
				RequestsPerMinute: 60, RequestsPerMonth: 1000, // API limits
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
		FailOpen:   true,
		WindowSize: time.Minute,
		Timeout:    defaultTimeout,
		UpgradeURL: defaultUpgradeURL,

		MonthlyFlushThreshold:     defaultMonthlyFlushThreshold,
		MonthlyNearLimitThreshold: defaultMonthlyNearLimitThreshold,
		MonthlyFlushInterval:      defaultMonthlyFlushInterval,
		MonthlyTotalTTL:           defaultMonthlyTotalTTL,
		MonthlyIdleEviction:       defaultMonthlyIdleEviction,
		MonthlyMaxIdentifiers:     defaultMonthlyMaxIdentifiers,
		MinuteMaxIdentifiers:      defaultMinuteMaxIdentifiers,
		SkipAnonymousMonthly:      true,
		BreakerFailureThreshold:   defaultBreakerFailureThreshold,
		BreakerCooldown:           defaultBreakerCooldown,
		AllowedOrigins: []string{
			"shorted.com.au",
			"www.shorted.com.au",
			"localhost",
			"127.0.0.1",
		},
	}
}

// withDefaults fills in zero-valued knobs so a hand-built Config (or one
// deserialized from partial YAML) still behaves sanely.
func withDefaults(cfg Config) Config {
	if cfg.MonthlyFlushThreshold <= 0 {
		cfg.MonthlyFlushThreshold = defaultMonthlyFlushThreshold
	}
	if cfg.MonthlyNearLimitThreshold <= 0 {
		cfg.MonthlyNearLimitThreshold = defaultMonthlyNearLimitThreshold
	}
	if cfg.MonthlyFlushInterval <= 0 {
		cfg.MonthlyFlushInterval = defaultMonthlyFlushInterval
	}
	if cfg.MonthlyTotalTTL <= 0 {
		cfg.MonthlyTotalTTL = defaultMonthlyTotalTTL
	}
	if cfg.MonthlyIdleEviction <= 0 {
		cfg.MonthlyIdleEviction = defaultMonthlyIdleEviction
	}
	if cfg.MonthlyMaxIdentifiers <= 0 {
		cfg.MonthlyMaxIdentifiers = defaultMonthlyMaxIdentifiers
	}
	if cfg.MinuteMaxIdentifiers <= 0 {
		cfg.MinuteMaxIdentifiers = defaultMinuteMaxIdentifiers
	}
	if cfg.BreakerFailureThreshold <= 0 {
		cfg.BreakerFailureThreshold = defaultBreakerFailureThreshold
	}
	if cfg.BreakerCooldown <= 0 {
		cfg.BreakerCooldown = defaultBreakerCooldown
	}
	if cfg.WindowSize <= 0 {
		cfg.WindowSize = time.Minute
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = defaultTimeout
	}
	if cfg.UpgradeURL == "" {
		cfg.UpgradeURL = defaultUpgradeURL
	}
	return cfg
}

// GetLimits returns the limits for a given tier, falling back to anonymous if not found
func (c *Config) GetLimits(tier string) TierLimits {
	if limits, ok := c.Tiers[tier]; ok {
		return limits
	}
	return c.Tiers["anonymous"]
}
