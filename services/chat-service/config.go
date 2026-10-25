package main

import (
	"fmt"
	"log"
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
	// ChatTurnTimeout and ChatFirstByteTimeout are the env values. Zero means unset,
	// and the router picks the mode's default (see turnBudgetWithFallback).
	ChatTurnTimeout      time.Duration
	ChatFirstByteTimeout time.Duration
	// ProviderKeys holds each catalog provider's key, keyed by provider name. A
	// key is read from the environment only.
	ProviderKeys map[string]string

	// The chat-model flag. It is on only when FlaggrAPIKey and FlaggrServiceID
	// are both set. The rest tunes it; none of them can stop startup.
	FlaggrAPIKey      string
	FlaggrServiceID   string
	FlaggrEnvironment string
	FlaggrAPIURL      string
	// ChatModelFlagTimeout is how long a turn waits for its answer. The lookup
	// behind it runs for ChatModelFlagLookupTimeout, so an answer that arrives
	// after the turn has moved on is still cached for the next turn.
	// ChatModelFlagTTL is how long an answer is used as fresh, and
	// ChatModelFlagMaxStale is the longest an answer is served once it is past its TTL.
	ChatModelFlagTimeout       time.Duration
	ChatModelFlagLookupTimeout time.Duration
	ChatModelFlagTTL           time.Duration
	ChatModelFlagMaxStale      time.Duration

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
	loadChatModelFlagConfig(cfg)

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
//
// The turn budget and the first-byte bound depend on whether a fallback exists,
// which the router decides, so an unset timeout stays zero here and the router
// resolves it.
func loadChatRouting(cfg *Config) error {
	cfg.ChatProvider = "gemini"
	if p := os.Getenv("CHAT_PROVIDER"); p != "" {
		cfg.ChatProvider = p
	}
	primarySpec, ok := lookupProvider(cfg.ChatProvider)
	if !ok {
		return fmt.Errorf("invalid CHAT_PROVIDER: unknown provider %q", cfg.ChatProvider)
	}
	cfg.ChatModel = ""
	if cfg.ChatProvider == "gemini" {
		cfg.ChatModel = cfg.GeminiModel
	}
	if m := os.Getenv("CHAT_MODEL"); m != "" {
		cfg.ChatModel = m
	}
	if err := validateRoute(cfg.Environment, primarySpec, cfg.ChatModel, "CHAT_PROVIDER", "CHAT_MODEL"); err != nil {
		return err
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
		fallbackSpec, ok := lookupProvider(cfg.ChatFallbackProvider)
		if !ok {
			return fmt.Errorf("invalid CHAT_FALLBACK_PROVIDER: unknown provider %q", cfg.ChatFallbackProvider)
		}
		cfg.ChatFallbackModel = ""
		if cfg.ChatFallbackProvider == "gemini" {
			cfg.ChatFallbackModel = cfg.GeminiModel
		}
		if m := os.Getenv("CHAT_FALLBACK_MODEL"); m != "" {
			cfg.ChatFallbackModel = m
		}
		if err := validateRoute(cfg.Environment, fallbackSpec, cfg.ChatFallbackModel, "CHAT_FALLBACK_PROVIDER", "CHAT_FALLBACK_MODEL"); err != nil {
			return err
		}
	}

	var err error
	if cfg.ChatTurnTimeout, err = parseDurationEnv("CHAT_TURN_TIMEOUT", 0); err != nil {
		return err
	}
	if cfg.ChatFirstByteTimeout, err = parseDurationEnv("CHAT_PROVIDER_FIRST_BYTE_TIMEOUT", 0); err != nil {
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

// loadChatModelFlagConfig reads the Flaggr settings. A bad duration here falls
// back to its default with a warning: the flag is an experiment, and it must
// never be the reason the service fails to start.
func loadChatModelFlagConfig(cfg *Config) {
	cfg.FlaggrAPIKey = os.Getenv("FLAGGR_API_KEY")
	cfg.FlaggrServiceID = os.Getenv("FLAGGR_SERVICE_ID")
	cfg.FlaggrAPIURL = os.Getenv("FLAGGR_API_URL")
	cfg.FlaggrEnvironment = "development"
	if cfg.Environment == "production" {
		cfg.FlaggrEnvironment = "production"
	}
	if env := os.Getenv("FLAGGR_ENVIRONMENT"); env != "" {
		cfg.FlaggrEnvironment = env
	}
	cfg.ChatModelFlagTimeout = durationEnvOrWarn("CHAT_MODEL_FLAG_TIMEOUT", defaultChatModelFlagTimeout)
	cfg.ChatModelFlagLookupTimeout = durationEnvOrWarn("CHAT_MODEL_FLAG_LOOKUP_TIMEOUT", defaultChatModelFlagLookupTimeout)
	cfg.ChatModelFlagTTL = durationEnvOrWarn("CHAT_MODEL_FLAG_TTL", defaultChatModelFlagTTL)
	cfg.ChatModelFlagMaxStale = durationEnvOrWarn("CHAT_MODEL_FLAG_MAX_STALE", defaultChatModelFlagMaxStale)
}

// durationEnvOrWarn is parseDurationEnv that never fails: a bad value is logged
// and replaced by the default.
func durationEnvOrWarn(name string, def time.Duration) time.Duration {
	d, err := parseDurationEnv(name, def)
	if err != nil {
		log.Printf("WARNING: %v; using %s", err, def)
		return def
	}
	return d
}

// validateRoute checks one route at config load. A route with no model is refused:
// OpenRouter has no default model, so an empty one would 400 every turn and fall
// back silently. In production it also refuses DeepSeek's direct API unless the
// PRC privacy flag is set, a provider with no verified tool choice, and a model the
// catalog does not list or marks test-only. Elsewhere those are allowed, so tests
// and smoke runs can use them.
func validateRoute(environment string, spec ProviderSpec, model, providerVar, modelVar string) error {
	production := environment == "production"
	if model == "" {
		if spec.DefaultModel == "" {
			return fmt.Errorf("%s=%s: no model is set and the catalog has no default model for %s; set %s", providerVar, spec.Name, spec.Name, modelVar)
		}
		model = spec.DefaultModel
	}
	if !production {
		return nil
	}
	if spec.Name == "deepseek" && os.Getenv(chatAllowPRCHostedProviderEnv) != "true" {
		return fmt.Errorf("%s=deepseek is refused in production: DeepSeek's first-party API is hosted in the PRC, and the privacy review the plan requires (docs/plans/chat-llm-providers.md §11.2) is not done. Route through OpenRouter pinned to US or EU hosts, or set %s=true once that review is complete", providerVar, chatAllowPRCHostedProviderEnv)
	}
	if spec.TestOnly {
		return fmt.Errorf("%s=%s is test-only: no tool-choice behaviour is verified for it, so production may not route to it", providerVar, spec.Name)
	}
	m, known := lookupModel(spec.Name, model)
	if !known {
		return fmt.Errorf("%s=%s/%s is not in the chat provider catalog (providerCatalog in provider_catalog.go), and production routes only catalogued models; add it there after verifying its tool choice and price", providerVar, spec.Name, model)
	}
	if !m.Activatable {
		return fmt.Errorf("%s=%s/%s is test-only (not activatable) until its gate passes, so production may not route to it", providerVar, spec.Name, model)
	}
	return nil
}

// chatAllowPRCHostedProviderEnv opens the direct DeepSeek API to production
// routing. Set it only after the PRC privacy review in the plan is complete.
const chatAllowPRCHostedProviderEnv = "CHAT_ALLOW_PRC_HOSTED_PROVIDER"

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
