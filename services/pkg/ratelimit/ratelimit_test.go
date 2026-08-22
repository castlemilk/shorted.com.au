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
	// anonymous: 10/min, 500/month - unauthenticated (tightened for anti-scraping)
	assert.Equal(t, 10, cfg.Tiers["anonymous"].RequestsPerMinute)
	assert.Equal(t, 500, cfg.Tiers["anonymous"].RequestsPerMonth)

	// free: 30/min, 1000/month - authenticated without subscription (tightened)
	assert.Equal(t, 30, cfg.Tiers["free"].RequestsPerMinute)
	assert.Equal(t, 1000, cfg.Tiers["free"].RequestsPerMonth)

	// pro: 120/min, 10000/month - paid subscription
	assert.Equal(t, 120, cfg.Tiers["pro"].RequestsPerMinute)
	assert.Equal(t, 10000, cfg.Tiers["pro"].RequestsPerMonth)
	// enterprise: 300/min, 50000/month - enterprise subscription
	assert.Equal(t, 300, cfg.Tiers["enterprise"].RequestsPerMinute)
	assert.Equal(t, 50000, cfg.Tiers["enterprise"].RequestsPerMonth)
}

func TestConfig_GetLimits(t *testing.T) {
	cfg := DefaultConfig()

	// Known tier - pro is paid tier with 120/min, 10000/month
	limits := cfg.GetLimits("pro")
	assert.Equal(t, 120, limits.RequestsPerMinute)
	assert.Equal(t, 10000, limits.RequestsPerMonth)

	// Unknown tier falls back to anonymous
	limits = cfg.GetLimits("unknown")
	assert.Equal(t, 10, limits.RequestsPerMinute)
	assert.Equal(t, 500, limits.RequestsPerMonth)
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
			{Result: float64(0)}, // ZREMRANGEBYSCORE
			{Result: float64(1)}, // ZADD
			{Result: float64(5)}, // ZCARD
			{Result: float64(1)}, // EXPIRE
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
