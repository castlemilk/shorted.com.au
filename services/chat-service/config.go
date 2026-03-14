package main

import (
	"fmt"
	"os"
	"strconv"
)

// Config holds the service configuration.
type Config struct {
	Port             int
	DatabaseURL      string
	ShortsAPIURL     string
	GeminiAPIKey     string
	GeminiModel      string
	MaxConversations int
	MaxMessagesPerConv int
}

// LoadConfig loads configuration from environment variables.
func LoadConfig() (*Config, error) {
	cfg := &Config{
		Port:               8080,
		GeminiModel:        "gemini-2.5-flash",
		MaxConversations:   100,
		MaxMessagesPerConv: 200,
	}

	if port := os.Getenv("PORT"); port != "" {
		p, err := strconv.Atoi(port)
		if err != nil {
			return nil, fmt.Errorf("invalid PORT: %w", err)
		}
		cfg.Port = p
	}

	cfg.DatabaseURL = os.Getenv("DATABASE_URL")
	if cfg.DatabaseURL == "" {
		// Build from components (matching other services)
		addr := os.Getenv("APP_STORE_POSTGRES_ADDRESS")
		db := os.Getenv("APP_STORE_POSTGRES_DATABASE")
		user := os.Getenv("APP_STORE_POSTGRES_USERNAME")
		pass := os.Getenv("APP_STORE_POSTGRES_PASSWORD")
		if addr != "" && db != "" && user != "" && pass != "" {
			cfg.DatabaseURL = fmt.Sprintf("postgres://%s:%s@%s/%s?sslmode=require", user, pass, addr, db)
		}
	}

	cfg.ShortsAPIURL = os.Getenv("SHORTS_API_URL")
	if cfg.ShortsAPIURL == "" {
		cfg.ShortsAPIURL = "http://localhost:9091"
	}

	cfg.GeminiAPIKey = os.Getenv("GEMINI_API_KEY")

	if model := os.Getenv("GEMINI_MODEL"); model != "" {
		cfg.GeminiModel = model
	}

	return cfg, nil
}
