package main

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"time"
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

	// The model routing. ChatProvider and ChatModel choose the primary; the
	// fallback is ChatFallbackProvider and ChatFallbackModel. Defaults keep prod
	// on Gemini with GEMINI_MODEL.
	ChatProvider         string
	ChatModel            string
	ChatMaxOutputTokens  int32
	ChatFallbackProvider string
	ChatFallbackModel    string
	// ChatFallbackImplicit is set when the fallback was not named in the env but
	// follows from a non-Gemini primary. A missing key then disables it quietly.
	ChatFallbackImplicit bool
	ChatTurnTimeout      time.Duration
	ChatFirstByteTimeout time.Duration
	// ProviderKeys holds each catalog provider's key, keyed by provider name. A
	// key is read from the environment only.
	ProviderKeys map[string]string

	ChatMaxInputChars  int
	ChatHistoryLimit   int
	MaxConversations   int
	MaxMessagesPerConv int

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

	if err := loadChatRouting(cfg); err != nil {
		return nil, err
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

// loadChatRouting reads the primary and fallback model, the timeouts and the
// provider keys. With none of the new variables set, the primary is Gemini on
// GEMINI_MODEL, with the same output limit as before.
func loadChatRouting(cfg *Config) error {
	cfg.ChatProvider = "gemini"
	if p := os.Getenv("CHAT_PROVIDER"); p != "" {
		cfg.ChatProvider = p
	}
	if _, ok := lookupProvider(cfg.ChatProvider); !ok {
		return fmt.Errorf("invalid CHAT_PROVIDER: unknown provider %q", cfg.ChatProvider)
	}
	cfg.ChatModel = ""
	if cfg.ChatProvider == "gemini" {
		cfg.ChatModel = cfg.GeminiModel
	}
	if m := os.Getenv("CHAT_MODEL"); m != "" {
		cfg.ChatModel = m
	}

	cfg.ChatMaxOutputTokens = cfg.GeminiMaxOutputTokens
	if v, err := parsePositiveIntEnv("CHAT_MAX_OUTPUT_TOKENS"); err != nil {
		return err
	} else if v > 0 {
		cfg.ChatMaxOutputTokens = int32(v)
	}

	cfg.ChatFallbackProvider = os.Getenv("CHAT_FALLBACK_PROVIDER")
	if cfg.ChatFallbackProvider == "" && cfg.ChatProvider != "gemini" {
		cfg.ChatFallbackProvider = "gemini"
		cfg.ChatFallbackImplicit = true
	}
	if cfg.ChatFallbackProvider != "" {
		if _, ok := lookupProvider(cfg.ChatFallbackProvider); !ok {
			return fmt.Errorf("invalid CHAT_FALLBACK_PROVIDER: unknown provider %q", cfg.ChatFallbackProvider)
		}
		cfg.ChatFallbackModel = ""
		if cfg.ChatFallbackProvider == "gemini" {
			cfg.ChatFallbackModel = cfg.GeminiModel
		}
		if m := os.Getenv("CHAT_FALLBACK_MODEL"); m != "" {
			cfg.ChatFallbackModel = m
		}
	}

	var err error
	if cfg.ChatTurnTimeout, err = parseDurationEnv("CHAT_TURN_TIMEOUT", defaultTurnBudget); err != nil {
		return err
	}
	if cfg.ChatFirstByteTimeout, err = parseDurationEnv("CHAT_PROVIDER_FIRST_BYTE_TIMEOUT", defaultFirstByteTimeout); err != nil {
		return err
	}

	cfg.ProviderKeys = make(map[string]string)
	for name, env := range providerKeyEnvs() {
		if key := os.Getenv(env); key != "" {
			cfg.ProviderKeys[name] = key
		}
	}
	if cfg.GeminiAPIKey != "" {
		cfg.ProviderKeys["gemini"] = cfg.GeminiAPIKey
	}
	return nil
}

// parseDurationEnv reads a positive duration, or returns def when it is unset.
func parseDurationEnv(name string, def time.Duration) (time.Duration, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return def, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("invalid %s: %w", name, err)
	}
	if d <= 0 {
		return 0, fmt.Errorf("invalid %s: must be positive", name)
	}
	return d, nil
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
