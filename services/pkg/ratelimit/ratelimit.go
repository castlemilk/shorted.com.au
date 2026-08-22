package ratelimit

import (
	"context"
	"time"
)

// LimitKind names which limit a rejection came from. It is part of the
// documented 429 payload contract consumed by the web app — do not rename
// these string values.
type LimitKind string

const (
	// LimitKindNone means no app-layer limit was exceeded.
	LimitKindNone LimitKind = ""
	// LimitKindPerMinute is the in-process per-tier minute window.
	LimitKindPerMinute LimitKind = "per_minute"
	// LimitKindMonthly is the Postgres-backed monthly quota.
	LimitKindMonthly LimitKind = "monthly"
)

// Result contains the rate limit check result.
//
// Both halves are populated on every check so the response headers can state
// the full picture (a caller near their monthly quota should see it even on a
// per-minute rejection). ExceededKind says which one, if any, actually caused
// the rejection.
type Result struct {
	Allowed bool

	// ExceededKind is set only when Allowed is false.
	ExceededKind LimitKind

	// Tier is the tier the limits were resolved from ("anonymous", "free", ...).
	Tier string
	// IsBrowser records which column of the tier table applied.
	IsBrowser bool

	Limit      int           // Per-minute limit (0 = unlimited/unenforced)
	Remaining  int           // Per-minute remaining
	ResetAt    time.Time     // Per-minute window reset
	RetryAfter time.Duration // Suggested retry delay for whichever limit fired

	MonthlyLimit   int       // Monthly limit (0 = unmetered)
	MonthlyUsed    int       // Monthly usage (best known; see monthly.go on staleness)
	MonthlyResetAt time.Time // Start of next month
}

// RateLimiter defines the interface for rate limiting
type RateLimiter interface {
	// Check checks if a request should be allowed
	// isBrowser indicates if this is browser access (more relaxed limits) vs API access
	Check(ctx context.Context, identifier string, tier string, isBrowser bool) (*Result, error)

	// Close closes the rate limiter and releases resources. Implementations
	// that buffer state MUST flush it here — Close is called from the server's
	// shutdown path.
	Close() error
}

// NoopLimiter is a rate limiter that always allows requests (for testing/disabled mode)
type NoopLimiter struct{}

// NewNoopLimiter creates a rate limiter that always allows requests
func NewNoopLimiter() *NoopLimiter {
	return &NoopLimiter{}
}

// Check always returns allowed
func (l *NoopLimiter) Check(_ context.Context, _ string, tier string, isBrowser bool) (*Result, error) {
	return &Result{
		Allowed:   true,
		Tier:      tier,
		IsBrowser: isBrowser,
	}, nil
}

// Close is a no-op
func (l *NoopLimiter) Close() error {
	return nil
}
