package ratelimit

import (
	"context"
	"time"
)

// Result contains the rate limit check result.
//
// The per-minute fields (Limit/Remaining/ResetAt) are retained for the
// interface and for limiters that own a minute window, but the production
// limiter (MonthlyLimiter) leaves them zero: per-minute limiting is enforced
// at the Cloudflare edge worker, not here. The interceptor omits the
// X-RateLimit-Limit/Remaining/Reset headers when Limit == 0 so the response
// contract never advertises a window the app layer is not enforcing.
type Result struct {
	Allowed        bool
	Limit          int           // Per-minute limit (0 = not enforced by the app layer)
	Remaining      int           // Per-minute remaining
	ResetAt        time.Time     // Per-minute reset
	RetryAfter     time.Duration // Suggested retry delay
	MonthlyLimit   int           // Monthly limit (0 = unmetered)
	MonthlyUsed    int           // Monthly usage
	MonthlyResetAt time.Time     // Monthly reset (start of next month)
}

// RateLimiter defines the interface for rate limiting
type RateLimiter interface {
	// Check checks if a request should be allowed
	// isBrowser indicates if this is browser access (more relaxed limits) vs API access
	Check(ctx context.Context, identifier string, tier string, isBrowser bool) (*Result, error)

	// Close closes the rate limiter and releases resources
	Close() error
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
