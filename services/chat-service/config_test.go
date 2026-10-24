package main

import (
	"strings"
	"testing"

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
