package ratelimit

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDefaultConfig(t *testing.T) {
	cfg := DefaultConfig()

	assert.False(t, cfg.Enabled)
	assert.True(t, cfg.FailOpen)
	assert.Equal(t, time.Minute, cfg.WindowSize)
	assert.Equal(t, "https://shorted.com.au/pricing", cfg.UpgradeURL)

	// Per-minute numbers are the documented tier entitlements, now enforced
	// in process (the edge cannot resolve a caller's tier).
	assert.Equal(t, 30, cfg.Tiers["anonymous"].RequestsPerMinute)
	assert.Equal(t, 500, cfg.Tiers["anonymous"].RequestsPerMonth)
	assert.Equal(t, 60, cfg.Tiers["free"].RequestsPerMinute)
	assert.Equal(t, 1000, cfg.Tiers["free"].RequestsPerMonth)
	assert.Equal(t, 120, cfg.Tiers["pro"].RequestsPerMinute)
	assert.Equal(t, 10000, cfg.Tiers["pro"].RequestsPerMonth)
	assert.Equal(t, 300, cfg.Tiers["enterprise"].RequestsPerMinute)
	assert.Equal(t, 50000, cfg.Tiers["enterprise"].RequestsPerMonth)

	// Browser columns.
	assert.Equal(t, 60, cfg.Tiers["anonymous"].BrowserRequestsPerMinute)
	assert.Equal(t, 120, cfg.Tiers["free"].BrowserRequestsPerMinute)
	assert.Equal(t, 0, cfg.Tiers["premium"].BrowserRequestsPerMinute, "paid browser access is unlimited")
	assert.Equal(t, 0, cfg.Tiers["premium"].BrowserRequestsPerMonth, "paid browser access is unlimited")
}

// The whole point of this change is that quota accounting has no Redis
// dependency. A config field is how one would come back.
func TestConfigHasNoRedisSurface(t *testing.T) {
	cfg := DefaultConfig()
	assert.NotContains(t, structFieldNames(cfg), "UpstashURL")
	assert.NotContains(t, structFieldNames(cfg), "UpstashToken")
	assert.NotContains(t, structFieldNames(cfg), "KeyPrefix")
}

func TestConfig_GetLimits(t *testing.T) {
	cfg := DefaultConfig()

	limits := cfg.GetLimits("pro")
	assert.Equal(t, 120, limits.RequestsPerMinute)
	assert.Equal(t, 10000, limits.RequestsPerMonth)

	// Unknown tier falls back to anonymous
	limits = cfg.GetLimits("unknown")
	assert.Equal(t, 30, limits.RequestsPerMinute)
	assert.Equal(t, 500, limits.RequestsPerMonth)
}

func TestWithDefaults_FillsZeroKnobs(t *testing.T) {
	cfg := withDefaults(Config{})

	assert.Equal(t, defaultMonthlyFlushThreshold, cfg.MonthlyFlushThreshold)
	assert.Equal(t, defaultMonthlyNearLimitThreshold, cfg.MonthlyNearLimitThreshold)
	assert.Equal(t, defaultMonthlyFlushInterval, cfg.MonthlyFlushInterval)
	assert.Equal(t, defaultMonthlyTotalTTL, cfg.MonthlyTotalTTL)
	assert.Equal(t, defaultMinuteMaxIdentifiers, cfg.MinuteMaxIdentifiers)
	assert.Equal(t, defaultUpgradeURL, cfg.UpgradeURL)
	assert.Equal(t, time.Minute, cfg.WindowSize)
}

func TestNoopLimiter(t *testing.T) {
	limiter := NewNoopLimiter()
	defer func() { _ = limiter.Close() }()

	result, err := limiter.Check(context.Background(), "test-user", "free", false)
	require.NoError(t, err)

	assert.True(t, result.Allowed)
	assert.Equal(t, LimitKindNone, result.ExceededKind)
}
