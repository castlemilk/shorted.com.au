package main

import (
	"fmt"
	"net/url"
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

	// Send limits, enforced against chat_usage_events before the model is
	// called. The web app's Redis buckets use the same names and defaults; they
	// are a first line that fails open, so this service is the authority.
	ChatSendsPerMinute       int
	ChatSendsPerDay          int
	ChatSendsPerMonth        int
	ChatGlobalSendsPerMinute int
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

		ChatSendsPerMinute:       4,
		ChatSendsPerDay:          40,
		ChatSendsPerMonth:        600,
		ChatGlobalSendsPerMinute: 60,
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
			cfg.DatabaseURL = postgresURL(user, pass, addr, db)
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

	if v, err := parsePositiveIntEnv("CHAT_SENDS_PER_MINUTE"); err != nil {
		return nil, err
	} else if v > 0 {
		cfg.ChatSendsPerMinute = v
	}

	if v, err := parsePositiveIntEnv("CHAT_SENDS_PER_DAY"); err != nil {
		return nil, err
	} else if v > 0 {
		cfg.ChatSendsPerDay = v
	}

	if v, err := parsePositiveIntEnv("CHAT_SENDS_PER_MONTH"); err != nil {
		return nil, err
	} else if v > 0 {
		cfg.ChatSendsPerMonth = v
	}

	if v, err := parsePositiveIntEnv("CHAT_GLOBAL_SENDS_PER_MINUTE"); err != nil {
		return nil, err
	} else if v > 0 {
		cfg.ChatGlobalSendsPerMinute = v
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

// postgresURL builds the chat-service database URL with net/url, so a password
// containing '@', '/', ':' or '%' is escaped. pgx ends the userinfo at the first
// '@', so a plain format string would split such a password. TLS is required.
func postgresURL(user, pass, addr, db string) string {
	u := url.URL{
		Scheme:   "postgres",
		User:     url.UserPassword(user, pass),
		Host:     addr,
		Path:     "/" + db,
		RawQuery: "sslmode=require",
	}
	return u.String()
}
