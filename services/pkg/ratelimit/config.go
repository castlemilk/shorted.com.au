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
}

// DefaultConfig returns the default rate limiter configuration
//
// Rate Limit Tiers (API/programmatic access via API tokens):
//   - anonymous:  30 req/min, 1000 req/month  - Unauthenticated requests (by IP)
//   - free:       60 req/min, 2000 req/month  - Authenticated users without paid subscription
//   - pro:       120 req/min, 10000 req/month - Users with pro subscription
//   - enterprise: 300 req/min, 50000 req/month - Enterprise users
//
// Browser access (via Firebase auth from web app) has relaxed limits:
//   - anonymous:  60 req/min, 5000 req/month
//   - free:       120 req/min, 10000 req/month
//   - pro/enterprise: unlimited (no rate limiting for browser)
//
// The "pro" tier applies to any user with an active or trialing subscription.
func DefaultConfig() Config {
	return Config{
		Enabled: false, // Disabled by default for safety
		Tiers: map[string]TierLimits{
			"anonymous": {
				RequestsPerMinute: 30, RequestsPerMonth: 1000, // API limits
				BrowserRequestsPerMinute: 60, BrowserRequestsPerMonth: 5000, // Browser limits
			},
			"free": {
				RequestsPerMinute: 60, RequestsPerMonth: 2000, // API limits
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
		},
		FailOpen:   true, // Don't block requests if Redis fails
		KeyPrefix:  "ratelimit:shorted:",
		WindowSize: time.Minute,
		Timeout:    5 * time.Second,
	}
}

// GetLimits returns the limits for a given tier, falling back to anonymous if not found
func (c *Config) GetLimits(tier string) TierLimits {
	if limits, ok := c.Tiers[tier]; ok {
		return limits
	}
	return c.Tiers["anonymous"]
}
