package config

import (
	"os"
	"strconv"
)

// Config holds all configuration for the market-data-sync service
type Config struct {
	// Database
	DatabaseURL string

	// GCS
	GCSBucketName string

	// Prioritization
	PriorityStockCount int

	// Rate limits (milliseconds)
	YahooRateLimitMs        int
	AlphaVantageRateLimitMs int

	// API Keys
	AlphaVantageAPIKey string

	// Algolia
	AlgoliaAppID    string
	AlgoliaAdminKey string
	AlgoliaIndex    string
	SyncAlgolia     bool

	// Server
	Port int
}

// Load loads configuration from environment variables
func Load() *Config {
	return &Config{
		DatabaseURL:             os.Getenv("DATABASE_URL"),
		GCSBucketName:           getEnvOrDefault("GCS_BUCKET_NAME", "shorted-data"),
		PriorityStockCount:      getEnvIntOrDefault("PRIORITY_STOCK_COUNT", 100),
		YahooRateLimitMs:        getEnvIntOrDefault("YAHOO_RATE_LIMIT_MS", 2000),
		AlphaVantageRateLimitMs: getEnvIntOrDefault("ALPHA_VANTAGE_RATE_LIMIT_MS", 12000),
		AlphaVantageAPIKey:      os.Getenv("ALPHA_VANTAGE_API_KEY"),
		AlgoliaAppID:            os.Getenv("ALGOLIA_APP_ID"),
		AlgoliaAdminKey:         os.Getenv("ALGOLIA_ADMIN_KEY"),
		AlgoliaIndex:            getEnvOrDefault("ALGOLIA_INDEX", "stocks"),
		SyncAlgolia:             os.Getenv("SYNC_ALGOLIA") == "true",
		Port:                    getEnvIntOrDefault("PORT", 8080),
	}
}

// Validate checks that required configuration is set
func (c *Config) Validate() error {
	if c.DatabaseURL == "" {
		return ErrMissingDatabaseURL
	}
	return nil
}

// HasAlgolia returns true if Algolia is configured
func (c *Config) HasAlgolia() bool {
	return c.AlgoliaAppID != "" && c.AlgoliaAdminKey != ""
}

// HasAlphaVantage returns true if Alpha Vantage is configured
func (c *Config) HasAlphaVantage() bool {
	return c.AlphaVantageAPIKey != ""
}

func getEnvOrDefault(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvIntOrDefault(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if intValue, err := strconv.Atoi(value); err == nil {
			return intValue
		}
	}
	return defaultValue
}
