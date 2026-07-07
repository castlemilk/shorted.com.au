package main

import (
	"fmt"
	"os"
	"strconv"
)

// Config holds the service configuration.
type Config struct {
	Port                  int
	Environment           string
	DatabaseURL           string
	ShortsAPIURL          string
	InternalServiceSecret string
	GeminiAPIKey          string
	GeminiModel           string
	GeminiMaxOutputTokens int32
	ChatMaxInputChars     int
	ChatHistoryLimit      int
	MaxConversations      int
	MaxMessagesPerConv    int
}

// LoadConfig loads configuration from environment variables.
func LoadConfig() (*Config, error) {
	cfg := &Config{
		Port:                  8080,
		Environment:           "development",
		GeminiModel:           "gemini-2.5-flash",
		GeminiMaxOutputTokens: 1024,
		ChatMaxInputChars:     2000,
		ChatHistoryLimit:      20,
		MaxConversations:      100,
		MaxMessagesPerConv:    100,
	}

	if port := os.Getenv("PORT"); port != "" {
		p, err := strconv.Atoi(port)
		if err != nil {
			return nil, fmt.Errorf("invalid PORT: %w", err)
		}
		cfg.Port = p
	}

	if environment := os.Getenv("ENVIRONMENT"); environment != "" {
		cfg.Environment = environment
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
	cfg.InternalServiceSecret = os.Getenv("INTERNAL_SERVICE_SECRET")

	if model := os.Getenv("GEMINI_MODEL"); model != "" {
		cfg.GeminiModel = model
	}

	if v, err := parsePositiveIntEnv("GEMINI_MAX_OUTPUT_TOKENS"); err != nil {
		return nil, err
	} else if v > 0 {
		cfg.GeminiMaxOutputTokens = int32(v)
	}

	if v, err := parsePositiveIntEnv("CHAT_MAX_INPUT_CHARS"); err != nil {
		return nil, err
	} else if v > 0 {
		cfg.ChatMaxInputChars = v
	}

	if v, err := parsePositiveIntEnv("CHAT_HISTORY_LIMIT"); err != nil {
		return nil, err
	} else if v > 0 {
		cfg.ChatHistoryLimit = v
	}

	if v, err := parsePositiveIntEnv("CHAT_MAX_MESSAGES_PER_CONVERSATION"); err != nil {
		return nil, err
	} else if v > 0 {
		cfg.MaxMessagesPerConv = v
	}

	return cfg, nil
}

func parsePositiveIntEnv(name string) (int, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return 0, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("invalid %s: %w", name, err)
	}
	if v <= 0 {
		return 0, fmt.Errorf("invalid %s: must be positive", name)
	}
	return v, nil
}
