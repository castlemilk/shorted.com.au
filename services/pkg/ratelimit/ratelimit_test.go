package ratelimit

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
	assert.Equal(t, "ratelimit:shorted:", cfg.KeyPrefix)

	// Check tier limits
	// anonymous: 30/min, 1000/month - unauthenticated
	assert.Equal(t, 30, cfg.Tiers["anonymous"].RequestsPerMinute)
	assert.Equal(t, 1000, cfg.Tiers["anonymous"].RequestsPerMonth)

	// free: 60/min, 2000/month - authenticated without subscription
	assert.Equal(t, 60, cfg.Tiers["free"].RequestsPerMinute)
	assert.Equal(t, 2000, cfg.Tiers["free"].RequestsPerMonth)

	// pro/enterprise: unlimited/min, 10000/month - paid subscription
	assert.Equal(t, 0, cfg.Tiers["pro"].RequestsPerMinute) // 0 = unlimited
	assert.Equal(t, 10000, cfg.Tiers["pro"].RequestsPerMonth)
	assert.Equal(t, 0, cfg.Tiers["enterprise"].RequestsPerMinute)
	assert.Equal(t, 10000, cfg.Tiers["enterprise"].RequestsPerMonth)
}

func TestConfig_GetLimits(t *testing.T) {
	cfg := DefaultConfig()

	// Known tier - pro is paid tier with unlimited/min, 10000/month
	limits := cfg.GetLimits("pro")
	assert.Equal(t, 0, limits.RequestsPerMinute) // 0 = unlimited
	assert.Equal(t, 10000, limits.RequestsPerMonth)

	// Unknown tier falls back to anonymous
	limits = cfg.GetLimits("unknown")
	assert.Equal(t, 30, limits.RequestsPerMinute)
	assert.Equal(t, 1000, limits.RequestsPerMonth)
}

func TestNoopLimiter(t *testing.T) {
	limiter := NewNoopLimiter()
	defer func() { _ = limiter.Close() }()

	result, err := limiter.Check(context.Background(), "test-user", "free", false)
	require.NoError(t, err)

	assert.True(t, result.Allowed)
	assert.Equal(t, 999999, result.Limit)
	assert.Equal(t, 999999, result.Remaining)
}

func TestUpstashClient_Ping(t *testing.T) {
	// Create a mock server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify authorization header
		assert.Equal(t, "Bearer test-token", r.Header.Get("Authorization"))

		response := map[string]any{
			"result": "PONG",
		}
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer server.Close()

	client := NewUpstashClient(server.URL, "test-token", 5*time.Second)
	err := client.Ping(context.Background())
	require.NoError(t, err)
}

func TestUpstashClient_Pipeline(t *testing.T) {
	// Create a mock server
	callCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++

		// Verify it's a pipeline request
		assert.Equal(t, "/pipeline", r.URL.Path)
		assert.Equal(t, "Bearer test-token", r.Header.Get("Authorization"))

		// Return mock pipeline results
		results := []PipelineResult{
			{Result: float64(0)},   // ZREMRANGEBYSCORE
			{Result: float64(1)},   // ZADD
			{Result: float64(5)},   // ZCARD
			{Result: float64(1)},   // EXPIRE
		}
		_ = json.NewEncoder(w).Encode(results)
	}))
	defer server.Close()

	client := NewUpstashClient(server.URL, "test-token", 5*time.Second)

	commands := [][]interface{}{
		{"ZREMRANGEBYSCORE", "key", "-inf", "12345"},
		{"ZADD", "key", "12346", "member"},
		{"ZCARD", "key"},
		{"EXPIRE", "key", 120},
	}

	results, err := client.Pipeline(context.Background(), commands)
	require.NoError(t, err)
	require.Len(t, results, 4)
	assert.Equal(t, float64(5), results[2].Result)
}

func TestSlidingWindowLimiter_Check(t *testing.T) {
	pipelineCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/pipeline" {
			pipelineCount++
			// Return different counts based on request number to simulate rate limiting
			count := float64(pipelineCount)
			// New pipeline structure: minute (4 commands) + month (3 commands)
			results := []PipelineResult{
				{Result: float64(0)}, // ZREMRANGEBYSCORE (minute)
				{Result: float64(1)}, // ZADD (minute)
				{Result: count},      // ZCARD (minute) - increases with each request
				{Result: float64(1)}, // EXPIRE (minute)
				{Result: float64(1)}, // ZADD (month)
				{Result: count},      // ZCARD (month)
				{Result: float64(1)}, // EXPIRE (month)
			}
			_ = json.NewEncoder(w).Encode(results)
			return
		}

		// Handle PING
		_ = json.NewEncoder(w).Encode(map[string]any{"result": "PONG"})
	}))
	defer server.Close()

	cfg := DefaultConfig()
	cfg.UpstashURL = server.URL
	cfg.UpstashToken = "test-token"
	cfg.Enabled = true
	cfg.Tiers["anonymous"] = TierLimits{RequestsPerMinute: 5, RequestsPerMonth: 1000}

	limiter, err := NewSlidingWindowLimiter(cfg)
	require.NoError(t, err)
	defer func() { _ = limiter.Close() }()

	ctx := context.Background()

	// First 5 requests should be allowed (count 1-5, limit is 5/min)
	for i := range 5 {
		result, err := limiter.Check(ctx, "ip:127.0.0.1", "anonymous", false) // API access
		require.NoError(t, err)
		assert.True(t, result.Allowed, "request %d should be allowed", i+1)
	}

	// 6th request should be rate limited (count 6 > limit 5/min)
	result, err := limiter.Check(ctx, "ip:127.0.0.1", "anonymous", false)
	require.NoError(t, err)
	assert.False(t, result.Allowed)
	assert.Equal(t, 5, result.Limit)
	assert.Equal(t, 0, result.Remaining)
}

func TestSlidingWindowLimiter_DifferentTiers(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/pipeline" {
			// Return count of 50 for minute, 500 for month
			results := []PipelineResult{
				{Result: float64(0)},  // ZREMRANGEBYSCORE (minute)
				{Result: float64(1)},  // ZADD (minute)
				{Result: float64(50)}, // ZCARD (minute)
				{Result: float64(1)},  // EXPIRE (minute)
				{Result: float64(1)},  // ZADD (month)
				{Result: float64(500)}, // ZCARD (month)
				{Result: float64(1)},  // EXPIRE (month)
			}
			_ = json.NewEncoder(w).Encode(results)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"result": "PONG"})
	}))
	defer server.Close()

	cfg := DefaultConfig()
	cfg.UpstashURL = server.URL
	cfg.UpstashToken = "test-token"
	cfg.Enabled = true

	limiter, err := NewSlidingWindowLimiter(cfg)
	require.NoError(t, err)
	defer func() { _ = limiter.Close() }()

	ctx := context.Background()

	// Anonymous API access (30/min, 1000/month) should be limited at 50 requests/min
	result, err := limiter.Check(ctx, "ip:127.0.0.1", "anonymous", false)
	require.NoError(t, err)
	assert.False(t, result.Allowed)
	assert.Equal(t, 30, result.Limit)
	assert.Equal(t, 1000, result.MonthlyLimit)

	// Free API access (60/min, 2000/month) should be allowed at 50/min, 500/month
	result, err = limiter.Check(ctx, "user:123", "free", false)
	require.NoError(t, err)
	assert.True(t, result.Allowed)
	assert.Equal(t, 60, result.Limit)
	assert.Equal(t, 10, result.Remaining)
	assert.Equal(t, 2000, result.MonthlyLimit)
	assert.Equal(t, 500, result.MonthlyUsed)

	// Pro API access (unlimited/min, 10000/month) should be allowed - paid tier
	result, err = limiter.Check(ctx, "user:456", "pro", false)
	require.NoError(t, err)
	assert.True(t, result.Allowed)
	assert.Equal(t, 0, result.Limit) // 0 = unlimited per minute
	assert.Equal(t, 10000, result.MonthlyLimit)
	assert.Equal(t, 500, result.MonthlyUsed)
}
