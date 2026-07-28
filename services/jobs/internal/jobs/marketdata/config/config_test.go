package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestLoad(t *testing.T) {
	// Every var Load() reads. t.Setenv (not manual save/Unsetenv/restore, as the
	// standalone test did) makes the restore automatic and fails loudly if the
	// test is ever marked parallel.
	envVars := []string{
		"DATABASE_URL",
		"DB_MAX_CONNS",
		"DB_MIN_CONNS",
		"GCS_BUCKET_NAME",
		"PRIORITY_STOCK_COUNT",
		"YAHOO_RATE_LIMIT_MS",
		"ALPHA_VANTAGE_RATE_LIMIT_MS",
		"ALPHA_VANTAGE_API_KEY",
		"ALGOLIA_APP_ID",
		"ALGOLIA_ADMIN_KEY",
		"ALGOLIA_INDEX",
		"SYNC_ALGOLIA",
		"PORT",
	}

	t.Run("defaults", func(t *testing.T) {
		for _, v := range envVars {
			t.Setenv(v, "")
		}

		cfg := Load()

		assert.Equal(t, "", cfg.DatabaseURL)
		assert.Equal(t, 3, cfg.DBMaxConns)
		assert.Equal(t, 0, cfg.DBMinConns)
		assert.Equal(t, "shorted-data", cfg.GCSBucketName)
		assert.Equal(t, 100, cfg.PriorityStockCount)
		assert.Equal(t, 2000, cfg.YahooRateLimitMs)
		assert.Equal(t, 12000, cfg.AlphaVantageRateLimitMs)
		assert.Equal(t, "", cfg.AlphaVantageAPIKey)
		assert.Equal(t, "", cfg.AlgoliaAppID)
		assert.Equal(t, "", cfg.AlgoliaAdminKey)
		assert.Equal(t, "stocks", cfg.AlgoliaIndex)
		assert.False(t, cfg.SyncAlgolia)
		assert.Equal(t, 8080, cfg.Port)
	})

	t.Run("with environment variables", func(t *testing.T) {
		for _, v := range envVars {
			t.Setenv(v, "")
		}
		t.Setenv("DATABASE_URL", "postgres://test:test@localhost/test")
		t.Setenv("DB_MAX_CONNS", "4")
		t.Setenv("DB_MIN_CONNS", "1")
		t.Setenv("GCS_BUCKET_NAME", "custom-bucket")
		t.Setenv("PRIORITY_STOCK_COUNT", "50")
		t.Setenv("YAHOO_RATE_LIMIT_MS", "3000")
		t.Setenv("ALPHA_VANTAGE_API_KEY", "test-key")
		t.Setenv("ALGOLIA_APP_ID", "test-app")
		t.Setenv("ALGOLIA_ADMIN_KEY", "test-admin-key")
		t.Setenv("ALGOLIA_INDEX", "custom-index")
		t.Setenv("SYNC_ALGOLIA", "true")
		t.Setenv("PORT", "9090")

		cfg := Load()

		assert.Equal(t, "postgres://test:test@localhost/test", cfg.DatabaseURL)
		assert.Equal(t, 4, cfg.DBMaxConns)
		assert.Equal(t, 1, cfg.DBMinConns)
		assert.Equal(t, "custom-bucket", cfg.GCSBucketName)
		assert.Equal(t, 50, cfg.PriorityStockCount)
		assert.Equal(t, 3000, cfg.YahooRateLimitMs)
		assert.Equal(t, "test-key", cfg.AlphaVantageAPIKey)
		assert.Equal(t, "test-app", cfg.AlgoliaAppID)
		assert.Equal(t, "test-admin-key", cfg.AlgoliaAdminKey)
		assert.Equal(t, "custom-index", cfg.AlgoliaIndex)
		assert.True(t, cfg.SyncAlgolia)
		assert.Equal(t, 9090, cfg.Port)
	})
}

func TestConfig_Validate(t *testing.T) {
	t.Run("missing database URL", func(t *testing.T) {
		cfg := &Config{}
		err := cfg.Validate()
		assert.ErrorIs(t, err, ErrMissingDatabaseURL)
	})

	t.Run("valid config", func(t *testing.T) {
		cfg := &Config{DatabaseURL: "postgres://localhost/test"}
		err := cfg.Validate()
		assert.NoError(t, err)
	})
}

func TestConfig_HasAlgolia(t *testing.T) {
	tests := []struct {
		name     string
		appID    string
		adminKey string
		want     bool
	}{
		{"both set", "app", "key", true},
		{"only appID", "app", "", false},
		{"only adminKey", "", "key", false},
		{"neither", "", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := &Config{AlgoliaAppID: tt.appID, AlgoliaAdminKey: tt.adminKey}
			assert.Equal(t, tt.want, cfg.HasAlgolia())
		})
	}
}

func TestConfig_HasAlphaVantage(t *testing.T) {
	tests := []struct {
		name   string
		apiKey string
		want   bool
	}{
		{"with key", "test-key", true},
		{"without key", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := &Config{AlphaVantageAPIKey: tt.apiKey}
			assert.Equal(t, tt.want, cfg.HasAlphaVantage())
		})
	}
}

func TestGetEnvOrDefault(t *testing.T) {
	key := "TEST_ENV_VAR_12345"
	t.Setenv(key, "")

	// Test default value
	assert.Equal(t, "default", getEnvOrDefault(key, "default"))

	// Test with value set
	t.Setenv(key, "custom")
	assert.Equal(t, "custom", getEnvOrDefault(key, "default"))
}

func TestGetEnvIntOrDefault(t *testing.T) {
	key := "TEST_ENV_INT_12345"
	t.Setenv(key, "")

	// Test default value
	assert.Equal(t, 42, getEnvIntOrDefault(key, 42))

	// Test with valid int
	t.Setenv(key, "100")
	assert.Equal(t, 100, getEnvIntOrDefault(key, 42))

	// Test with invalid int (should return default)
	t.Setenv(key, "not-a-number")
	assert.Equal(t, 42, getEnvIntOrDefault(key, 42))
}
