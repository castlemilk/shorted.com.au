package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestLoadConfigDefaultsCostGuardrails(t *testing.T) {
	t.Setenv("PORT", "")
	t.Setenv("ENVIRONMENT", "")
	t.Setenv("INTERNAL_SERVICE_SECRET", "")
	t.Setenv("GEMINI_MAX_OUTPUT_TOKENS", "")
	t.Setenv("CHAT_MAX_INPUT_CHARS", "")
	t.Setenv("CHAT_HISTORY_LIMIT", "")
	t.Setenv("CHAT_MAX_MESSAGES_PER_CONVERSATION", "")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}

	if cfg.GeminiMaxOutputTokens != 1024 {
		t.Fatalf("GeminiMaxOutputTokens = %d, want 1024", cfg.GeminiMaxOutputTokens)
	}
	if cfg.Environment != "development" {
		t.Fatalf("Environment = %q, want development", cfg.Environment)
	}
	if cfg.ChatMaxInputChars != 2000 {
		t.Fatalf("ChatMaxInputChars = %d, want 2000", cfg.ChatMaxInputChars)
	}
	if cfg.ChatHistoryLimit != 20 {
		t.Fatalf("ChatHistoryLimit = %d, want 20", cfg.ChatHistoryLimit)
	}
	if cfg.MaxMessagesPerConv != 100 {
		t.Fatalf("MaxMessagesPerConv = %d, want 100", cfg.MaxMessagesPerConv)
	}
}

func TestLoadConfigParsesCostGuardrails(t *testing.T) {
	t.Setenv("ENVIRONMENT", "production")
	t.Setenv("INTERNAL_SERVICE_SECRET", "secret")
	t.Setenv("GEMINI_MAX_OUTPUT_TOKENS", "1536")
	t.Setenv("CHAT_MAX_INPUT_CHARS", "3500")
	t.Setenv("CHAT_HISTORY_LIMIT", "12")
	t.Setenv("CHAT_MAX_MESSAGES_PER_CONVERSATION", "80")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}

	if cfg.GeminiMaxOutputTokens != 1536 {
		t.Fatalf("GeminiMaxOutputTokens = %d, want 1536", cfg.GeminiMaxOutputTokens)
	}
	if cfg.Environment != "production" {
		t.Fatalf("Environment = %q, want production", cfg.Environment)
	}
	if cfg.InternalServiceSecret != "secret" {
		t.Fatalf("InternalServiceSecret = %q, want configured secret", cfg.InternalServiceSecret)
	}
	if cfg.ChatMaxInputChars != 3500 {
		t.Fatalf("ChatMaxInputChars = %d, want 3500", cfg.ChatMaxInputChars)
	}
	if cfg.ChatHistoryLimit != 12 {
		t.Fatalf("ChatHistoryLimit = %d, want 12", cfg.ChatHistoryLimit)
	}
	if cfg.MaxMessagesPerConv != 80 {
		t.Fatalf("MaxMessagesPerConv = %d, want 80", cfg.MaxMessagesPerConv)
	}
}

func TestLoadConfigRejectsInvalidCostGuardrails(t *testing.T) {
	t.Setenv("CHAT_HISTORY_LIMIT", "0")

	if _, err := LoadConfig(); err == nil {
		t.Fatal("LoadConfig() error = nil, want invalid CHAT_HISTORY_LIMIT error")
	}
}

func TestLoadConfigDefaultsSendLimits(t *testing.T) {
	t.Setenv("CHAT_SENDS_PER_MINUTE", "")
	t.Setenv("CHAT_SENDS_PER_DAY", "")
	t.Setenv("CHAT_SENDS_PER_MONTH", "")
	t.Setenv("CHAT_GLOBAL_SENDS_PER_MINUTE", "")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}

	if cfg.ChatSendsPerMinute != 4 {
		t.Fatalf("ChatSendsPerMinute = %d, want 4", cfg.ChatSendsPerMinute)
	}
	if cfg.ChatSendsPerDay != 40 {
		t.Fatalf("ChatSendsPerDay = %d, want 40", cfg.ChatSendsPerDay)
	}
	if cfg.ChatSendsPerMonth != 600 {
		t.Fatalf("ChatSendsPerMonth = %d, want 600", cfg.ChatSendsPerMonth)
	}
	if cfg.ChatGlobalSendsPerMinute != 60 {
		t.Fatalf("ChatGlobalSendsPerMinute = %d, want 60", cfg.ChatGlobalSendsPerMinute)
	}
}

func TestLoadConfigParsesSendLimits(t *testing.T) {
	t.Setenv("CHAT_SENDS_PER_MINUTE", "6")
	t.Setenv("CHAT_SENDS_PER_DAY", "50")
	t.Setenv("CHAT_SENDS_PER_MONTH", "900")
	t.Setenv("CHAT_GLOBAL_SENDS_PER_MINUTE", "120")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}

	if cfg.ChatSendsPerMinute != 6 || cfg.ChatSendsPerDay != 50 ||
		cfg.ChatSendsPerMonth != 900 || cfg.ChatGlobalSendsPerMinute != 120 {
		t.Fatalf("send limits = %d/%d/%d/%d, want 6/50/900/120",
			cfg.ChatSendsPerMinute, cfg.ChatSendsPerDay, cfg.ChatSendsPerMonth, cfg.ChatGlobalSendsPerMinute)
	}
}

func TestLoadConfigRejectsInvalidSendLimits(t *testing.T) {
	for _, name := range []string{
		"CHAT_SENDS_PER_MINUTE",
		"CHAT_SENDS_PER_DAY",
		"CHAT_SENDS_PER_MONTH",
		"CHAT_GLOBAL_SENDS_PER_MINUTE",
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv(name, "-1")

			if _, err := LoadConfig(); err == nil {
				t.Fatalf("LoadConfig() error = nil, want invalid %s error", name)
			}
		})
	}
}

func TestPostgresURLKeepsSpecialCharacterPassword(t *testing.T) {
	const pass = `p@ss/w:rd%41 "x"`
	raw := postgresURL("chat_user", pass, "db.example.com:5432", "shorts")
	cfg, err := pgxpool.ParseConfig(raw)
	if err != nil {
		t.Fatalf("ParseConfig(%q): %v", raw, err)
	}
	if cfg.ConnConfig.Password != pass {
		t.Fatalf("password = %q, want %q", cfg.ConnConfig.Password, pass)
	}
	if cfg.ConnConfig.User != "chat_user" || cfg.ConnConfig.Database != "shorts" {
		t.Fatalf("user = %q database = %q", cfg.ConnConfig.User, cfg.ConnConfig.Database)
	}
	if cfg.ConnConfig.Host != "db.example.com" || cfg.ConnConfig.Port != 5432 {
		t.Fatalf("host = %q port = %d", cfg.ConnConfig.Host, cfg.ConnConfig.Port)
	}
	if !strings.HasSuffix(raw, "?sslmode=require") {
		t.Fatalf("URL lost sslmode=require: %q", raw)
	}
}

// terraformChatEnv is exactly the env block terraform/modules/chat-service/main.tf
// gives the Cloud Run service, with the values terraform/environments/prod/main.tf
// passes, plus PORT that Cloud Run injects. Secrets are placeholders.
var terraformChatEnv = map[string]string{
	"PORT":                               "8080",
	"ENVIRONMENT":                        "production",
	"APP_STORE_POSTGRES_ADDRESS":         "db.example:6543",
	"APP_STORE_POSTGRES_DATABASE":        "postgres",
	"APP_STORE_POSTGRES_USERNAME":        "postgres.user",
	"APP_STORE_POSTGRES_PASSWORD":        "pw-placeholder",
	"GEMINI_API_KEY":                     "gemini-placeholder-key",
	"INTERNAL_SERVICE_SECRET":            "internal-placeholder",
	"SHORTS_API_URL":                     "https://api.shorted.com.au",
	"OTEL_EXPORTER_OTLP_ENDPOINT":        "https://otel.example",
	"OTEL_EXPORTER_OTLP_PROTOCOL":        "http/protobuf",
	"OTEL_EXPORTER_OTLP_HEADERS":         "x=y",
	"GEMINI_MAX_OUTPUT_TOKENS":           "1024",
	"CHAT_MAX_INPUT_CHARS":               "2000",
	"CHAT_HISTORY_LIMIT":                 "20",
	"CHAT_MAX_MESSAGES_PER_CONVERSATION": "100",
}

// setTerraformProdEnv clears every variable the config reads and sets only the
// Terraform ones, so nothing from the developer's shell leaks in.
func setTerraformProdEnv(t *testing.T) {
	t.Helper()
	clear := []string{
		"DATABASE_URL", "GEMINI_MODEL", "CHAT_PROVIDER", "CHAT_MODEL", "CHAT_MAX_OUTPUT_TOKENS",
		"CHAT_FALLBACK_PROVIDER", "CHAT_FALLBACK_MODEL", "CHAT_TURN_TIMEOUT", "CHAT_PROVIDER_FIRST_BYTE_TIMEOUT",
		chatAllowPRCHostedProviderEnv, "CHAT_SENDS_PER_MINUTE", "CHAT_SENDS_PER_DAY", "CHAT_SENDS_PER_MONTH",
		"CHAT_GLOBAL_SENDS_PER_MINUTE", "CHAT_GOLDEN_UPDATE",
	}
	for _, env := range providerKeyEnvs() {
		clear = append(clear, env)
	}
	for _, k := range clear {
		t.Setenv(k, "")
	}
	for k, v := range terraformChatEnv {
		t.Setenv(k, v)
	}
}

func TestProdEnvLoadsGeminiWithTheTerraformBounds(t *testing.T) {
	setTerraformProdEnv(t)
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() with the Terraform prod env error = %v", err)
	}
	if cfg.ChatProvider != "gemini" || cfg.ChatModel != "gemini-2.5-flash" || cfg.ChatFallbackProvider != "" {
		t.Fatalf("routing = %s/%s fallback %q, want gemini/gemini-2.5-flash and none", cfg.ChatProvider, cfg.ChatModel, cfg.ChatFallbackProvider)
	}
	if cfg.ChatMaxOutputTokens != 1024 || cfg.ChatTurnTimeout != 0 || cfg.ChatFirstByteTimeout != 0 {
		t.Fatalf("max output %d, turn %s, first byte %s; want 1024 and unset", cfg.ChatMaxOutputTokens, cfg.ChatTurnTimeout, cfg.ChatFirstByteTimeout)
	}
	r, err := NewModelRouter(context.Background(), cfg, nil)
	if err != nil || r == nil {
		t.Fatalf("NewModelRouter() = %v, %v", r, err)
	}
	if r.fallback != nil {
		t.Fatal("prod env built a fallback")
	}
	g, ok := r.primary.route.Provider.(*geminiProvider)
	if !ok {
		t.Fatalf("primary provider = %T, want *geminiProvider", r.primary.route.Provider)
	}
	if g.timeouts.FirstByte != 30*time.Second || g.timeouts.Idle != 20*time.Second || r.budget != 55*time.Second {
		t.Fatalf("bounds: first byte %s, idle %s, turn %s; want 30s, 20s, 55s", g.timeouts.FirstByte, g.timeouts.Idle, r.budget)
	}
	if !r.primary.route.Spec.Caps.ForcedToolChoice || r.primary.route.Ref.MaxOutputTokens != 1024 || r.Model() != "gemini-2.5-flash" {
		t.Fatalf("route = %+v, want forced first call, 1024 output tokens, gemini-2.5-flash", r.primary.route.Ref)
	}
}
