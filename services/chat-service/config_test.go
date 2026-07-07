package main

import "testing"

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
