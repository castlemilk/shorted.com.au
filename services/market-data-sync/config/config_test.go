package config

import (
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestLoad(t *testing.T) {
	// Clear environment
	envVars := []string{
		"DATABASE_URL",
		"GCS_BUCKET_NAME",
		"PRIORITY_STOCK_COUNT",
		"YAHOO_RATE_LIMIT_MS",
		"ALPHA_VANTAGE_RATE_LIMIT_MS",
		"ALPHA_VANTAGE_API_KEY",
		"ALGOLIA_APP_ID",
		"ALGOLIA_ADMIN_KEY",
		"ALGOLIA_INDEX",
		"SYNC_ALGOLIA",
	}

	// Save current values
	savedVars := make(map[string]string)
	for _, v := range envVars {
		savedVars[v] = os.Getenv(v)
		os.Unsetenv(v)
	}

	// Restore after test
	defer func() {
		for k, v := range savedVars {
			if v != "" {
				os.Setenv(k, v)
			}
		}
	}()

	t.Run("defaults", func(t *testing.T) {
		cfg := Load()

		assert.Equal(t, "", cfg.DatabaseURL)
		assert.Equal(t, "shorted-data", cfg.GCSBucketName)
		assert.Equal(t, 100, cfg.PriorityStockCount)
		assert.Equal(t, 2000, cfg.YahooRateLimitMs)
		assert.Equal(t, 12000, cfg.AlphaVantageRateLimitMs)
		assert.Equal(t, "", cfg.AlphaVantageAPIKey)
		assert.Equal(t, "", cfg.AlgoliaAppID)
		assert.Equal(t, "", cfg.AlgoliaAdminKey)
		assert.Equal(t, "stocks", cfg.AlgoliaIndex)
		assert.False(t, cfg.SyncAlgolia)
	})

	t.Run("with environment variables", func(t *testing.T) {
		os.Setenv("DATABASE_URL", "postgres://test:test@localhost/test")
		os.Setenv("GCS_BUCKET_NAME", "custom-bucket")
		os.Setenv("PRIORITY_STOCK_COUNT", "50")
		os.Setenv("YAHOO_RATE_LIMIT_MS", "3000")
		os.Setenv("ALPHA_VANTAGE_API_KEY", "test-key")
		os.Setenv("ALGOLIA_APP_ID", "test-app")
		os.Setenv("ALGOLIA_ADMIN_KEY", "test-admin-key")
		os.Setenv("ALGOLIA_INDEX", "custom-index")
		os.Setenv("SYNC_ALGOLIA", "true")
		defer func() {
			for _, v := range envVars {
				os.Unsetenv(v)
			}
		}()

		cfg := Load()

		assert.Equal(t, "postgres://test:test@localhost/test", cfg.DatabaseURL)
		assert.Equal(t, "custom-bucket", cfg.GCSBucketName)
		assert.Equal(t, 50, cfg.PriorityStockCount)
		assert.Equal(t, 3000, cfg.YahooRateLimitMs)
		assert.Equal(t, "test-key", cfg.AlphaVantageAPIKey)
		assert.Equal(t, "test-app", cfg.AlgoliaAppID)
		assert.Equal(t, "test-admin-key", cfg.AlgoliaAdminKey)
		assert.Equal(t, "custom-index", cfg.AlgoliaIndex)
		assert.True(t, cfg.SyncAlgolia)
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
	os.Unsetenv(key)
	defer os.Unsetenv(key)

	// Test default value
	assert.Equal(t, "default", getEnvOrDefault(key, "default"))

	// Test with value set
	os.Setenv(key, "custom")
	assert.Equal(t, "custom", getEnvOrDefault(key, "default"))
}

func TestGetEnvIntOrDefault(t *testing.T) {
	key := "TEST_ENV_INT_12345"
	os.Unsetenv(key)
	defer os.Unsetenv(key)

	// Test default value
	assert.Equal(t, 42, getEnvIntOrDefault(key, 42))

	// Test with valid int
	os.Setenv(key, "100")
	assert.Equal(t, 100, getEnvIntOrDefault(key, 42))

	// Test with invalid int (should return default)
	os.Setenv(key, "not-a-number")
	assert.Equal(t, 42, getEnvIntOrDefault(key, 42))
}
