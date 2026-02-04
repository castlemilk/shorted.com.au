package ratelimit

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
)

// Result contains the rate limit check result
type Result struct {
	Allowed         bool
	Limit           int           // Per-minute limit
	Remaining       int           // Per-minute remaining
	ResetAt         time.Time     // Per-minute reset
	RetryAfter      time.Duration // Suggested retry delay
	MonthlyLimit    int           // Monthly limit
	MonthlyUsed     int           // Monthly usage
	MonthlyResetAt  time.Time     // Monthly reset (start of next month)
}

// RateLimiter defines the interface for rate limiting
type RateLimiter interface {
	// Check checks if a request should be allowed
	// isBrowser indicates if this is browser access (more relaxed limits) vs API access
	Check(ctx context.Context, identifier string, tier string, isBrowser bool) (*Result, error)

	// Close closes the rate limiter and releases resources
	Close() error
}

// SlidingWindowLimiter implements rate limiting using a sliding window algorithm
type SlidingWindowLimiter struct {
	client *UpstashClient
	config Config
}

// NewSlidingWindowLimiter creates a new sliding window rate limiter
func NewSlidingWindowLimiter(cfg Config) (*SlidingWindowLimiter, error) {
	if cfg.UpstashURL == "" || cfg.UpstashToken == "" {
		return nil, fmt.Errorf("upstash URL and token are required")
	}

	client := NewUpstashClient(cfg.UpstashURL, cfg.UpstashToken, cfg.Timeout)

	// Test connection
	ctx, cancel := context.WithTimeout(context.Background(), cfg.Timeout)
	defer cancel()

	if err := client.Ping(ctx); err != nil {
		return nil, fmt.Errorf("failed to connect to Upstash: %w", err)
	}

	log.Infof("Connected to Upstash Redis at %s", cfg.UpstashURL)

	return &SlidingWindowLimiter{
		client: client,
		config: cfg,
	}, nil
}

// Check checks if a request should be allowed using a sliding window algorithm
// It checks both per-minute and per-month limits.
// isBrowser indicates browser access (relaxed limits) vs API access (strict limits).
func (l *SlidingWindowLimiter) Check(ctx context.Context, identifier string, tier string, isBrowser bool) (*Result, error) {
	limits := l.config.GetLimits(tier)

	// Use browser limits if browser access, otherwise API limits
	var minuteLimit, monthLimit int
	if isBrowser {
		minuteLimit = limits.BrowserRequestsPerMinute
		monthLimit = limits.BrowserRequestsPerMonth
	} else {
		minuteLimit = limits.RequestsPerMinute
		monthLimit = limits.RequestsPerMonth
	}

	// If both limits are 0, no rate limiting applies (unlimited)
	if minuteLimit == 0 && monthLimit == 0 {
		return &Result{
			Allowed:        true,
			Limit:          0,
			Remaining:      0,
			MonthlyLimit:   0,
			MonthlyUsed:    0,
		}, nil
	}

	now := time.Now()
	minuteWindowStart := now.Add(-l.config.WindowSize)

	// Calculate month window (start of current month)
	monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	nextMonth := monthStart.AddDate(0, 1, 0)
	monthWindowSeconds := int(nextMonth.Sub(monthStart).Seconds())

	minuteKey := fmt.Sprintf("%sminute:%s", l.config.KeyPrefix, identifier)
	monthKey := fmt.Sprintf("%smonth:%s:%s", l.config.KeyPrefix, now.Format("2006-01"), identifier)

	// Build commands for both minute and month windows
	commands := [][]interface{}{
		// Minute window
		{"ZREMRANGEBYSCORE", minuteKey, "-inf", strconv.FormatInt(minuteWindowStart.UnixMilli(), 10)},
		{"ZADD", minuteKey, strconv.FormatInt(now.UnixMilli(), 10), strconv.FormatInt(now.UnixNano(), 10)},
		{"ZCARD", minuteKey},
		{"EXPIRE", minuteKey, int(l.config.WindowSize.Seconds() * 2)},
		// Month window
		{"ZADD", monthKey, strconv.FormatInt(now.UnixMilli(), 10), strconv.FormatInt(now.UnixNano(), 10)},
		{"ZCARD", monthKey},
		{"EXPIRE", monthKey, monthWindowSeconds + 86400}, // Expire 1 day after month ends
	}

	results, err := l.client.Pipeline(ctx, commands)
	if err != nil {
		return nil, fmt.Errorf("redis pipeline error: %w", err)
	}

	if len(results) < 6 {
		return nil, fmt.Errorf("unexpected pipeline result length: %d", len(results))
	}

	// Parse minute count (index 2)
	minuteCount := parseCount(results[2].Result)
	// Parse month count (index 5)
	monthCount := parseCount(results[5].Result)

	minuteRemaining := minuteLimit - minuteCount
	if minuteRemaining < 0 {
		minuteRemaining = 0
	}

	// Check limits
	// minuteLimit == 0 means unlimited per minute (only monthly limit applies)
	minuteAllowed := minuteLimit == 0 || minuteCount <= minuteLimit
	monthAllowed := monthLimit == 0 || monthCount <= monthLimit

	result := &Result{
		Allowed:        minuteAllowed && monthAllowed,
		Limit:          minuteLimit,
		Remaining:      minuteRemaining,
		ResetAt:        now.Add(l.config.WindowSize),
		RetryAfter:     l.config.WindowSize,
		MonthlyLimit:   monthLimit,
		MonthlyUsed:    monthCount,
		MonthlyResetAt: nextMonth,
	}

	// If monthly limit exceeded, set retry to start of next month
	if !monthAllowed {
		result.RetryAfter = nextMonth.Sub(now)
	}

	return result, nil
}

// parseCount extracts an integer count from a Redis result
func parseCount(v interface{}) int {
	switch val := v.(type) {
	case float64:
		return int(val)
	case int:
		return val
	case int64:
		return int(val)
	default:
		return 0
	}
}

// Close closes the rate limiter
func (l *SlidingWindowLimiter) Close() error {
	// HTTP client doesn't need explicit closing
	return nil
}

// NoopLimiter is a rate limiter that always allows requests (for testing/disabled mode)
type NoopLimiter struct{}

// NewNoopLimiter creates a rate limiter that always allows requests
func NewNoopLimiter() *NoopLimiter {
	return &NoopLimiter{}
}

// Check always returns allowed
func (l *NoopLimiter) Check(ctx context.Context, identifier string, tier string, isBrowser bool) (*Result, error) {
	return &Result{
		Allowed:   true,
		Limit:     999999,
		Remaining: 999999,
		ResetAt:   time.Now().Add(time.Hour),
	}, nil
}

// Close is a no-op
func (l *NoopLimiter) Close() error {
	return nil
}
