package main

import (
	"testing"
	"time"
)

// clearChatRoutingEnv blanks every variable the routing reads, so the host's
// environment cannot change a test.
func clearChatRoutingEnv(t *testing.T) {
	t.Helper()
	for _, name := range []string{
		"CHAT_PROVIDER", "CHAT_MODEL", "CHAT_MAX_OUTPUT_TOKENS", "CHAT_FALLBACK_PROVIDER",
		"CHAT_FALLBACK_MODEL", "CHAT_TURN_TIMEOUT", "CHAT_PROVIDER_FIRST_BYTE_TIMEOUT",
		"GEMINI_MODEL", "GEMINI_API_KEY", "GEMINI_MAX_OUTPUT_TOKENS",
		"DEEPSEEK_API_KEY", "OPENROUTER_API_KEY_CHAT", "GROQ_API_KEY", "TOGETHER_API_KEY",
		"MISTRAL_API_KEY", "DASHSCOPE_API_KEY", "MOONSHOT_API_KEY",
	} {
		t.Setenv(name, "")
	}
}

// With none of the routing variables set, chat is the Gemini prod default: the
// same model, output limit and key as before the router existed.
func TestLoadConfigChatRoutingDefaultsStayOnGemini(t *testing.T) {
	clearChatRoutingEnv(t)
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}
	if cfg.ChatProvider != "gemini" || cfg.ChatModel != "gemini-2.5-flash" {
		t.Fatalf("primary = %s/%s, want gemini/gemini-2.5-flash", cfg.ChatProvider, cfg.ChatModel)
	}
	if cfg.ChatMaxOutputTokens != 1024 {
		t.Fatalf("ChatMaxOutputTokens = %d, want 1024", cfg.ChatMaxOutputTokens)
	}
	if cfg.ChatFallbackProvider != "" {
		t.Fatalf("fallback = %q, want none for a Gemini primary", cfg.ChatFallbackProvider)
	}
	if cfg.ChatTurnTimeout != 50*time.Second || cfg.ChatFirstByteTimeout != 15*time.Second {
		t.Fatalf("timeouts = %s and %s, want 50s and 15s", cfg.ChatTurnTimeout, cfg.ChatFirstByteTimeout)
	}
}

func TestLoadConfigGeminiModelStillSetsTheDefaultChatModel(t *testing.T) {
	clearChatRoutingEnv(t)
	t.Setenv("GEMINI_MODEL", "gemini-2.5-flash-lite")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}
	if cfg.ChatModel != "gemini-2.5-flash-lite" {
		t.Fatalf("ChatModel = %q, want the GEMINI_MODEL value", cfg.ChatModel)
	}
}

func TestLoadConfigNonGeminiPrimaryFallsBackToGeminiImplicitly(t *testing.T) {
	clearChatRoutingEnv(t)
	t.Setenv("CHAT_PROVIDER", "deepseek")
	t.Setenv("DEEPSEEK_API_KEY", "ds-key")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}
	if cfg.ChatModel != "" {
		t.Fatalf("ChatModel = %q, want empty so the catalog default applies", cfg.ChatModel)
	}
	if cfg.ChatFallbackProvider != "gemini" || cfg.ChatFallbackModel != "gemini-2.5-flash" || !cfg.ChatFallbackImplicit {
		t.Fatalf("fallback = %s/%s implicit=%v, want the implicit Gemini fallback", cfg.ChatFallbackProvider, cfg.ChatFallbackModel, cfg.ChatFallbackImplicit)
	}
	if cfg.ProviderKeys["deepseek"] != "ds-key" {
		t.Fatalf("ProviderKeys = %v, want the DeepSeek key read from the environment", cfg.ProviderKeys)
	}
}

func TestLoadConfigExplicitRoutingAndTimeouts(t *testing.T) {
	clearChatRoutingEnv(t)
	t.Setenv("CHAT_PROVIDER", "openrouter")
	t.Setenv("CHAT_MODEL", "openai/gpt-5-mini")
	t.Setenv("CHAT_MAX_OUTPUT_TOKENS", "512")
	t.Setenv("CHAT_FALLBACK_PROVIDER", "deepseek")
	t.Setenv("CHAT_FALLBACK_MODEL", "deepseek-v4-pro")
	t.Setenv("CHAT_TURN_TIMEOUT", "45s")
	t.Setenv("CHAT_PROVIDER_FIRST_BYTE_TIMEOUT", "12s")
	t.Setenv("OPENROUTER_API_KEY_CHAT", "or-key")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}
	if cfg.ChatProvider != "openrouter" || cfg.ChatModel != "openai/gpt-5-mini" || cfg.ChatMaxOutputTokens != 512 {
		t.Fatalf("primary = %s/%s max %d", cfg.ChatProvider, cfg.ChatModel, cfg.ChatMaxOutputTokens)
	}
	if cfg.ChatFallbackProvider != "deepseek" || cfg.ChatFallbackModel != "deepseek-v4-pro" || cfg.ChatFallbackImplicit {
		t.Fatalf("fallback = %s/%s implicit=%v", cfg.ChatFallbackProvider, cfg.ChatFallbackModel, cfg.ChatFallbackImplicit)
	}
	if cfg.ChatTurnTimeout != 45*time.Second || cfg.ChatFirstByteTimeout != 12*time.Second {
		t.Fatalf("timeouts = %s and %s", cfg.ChatTurnTimeout, cfg.ChatFirstByteTimeout)
	}
	if cfg.ProviderKeys["openrouter"] != "or-key" {
		t.Fatalf("openrouter key not read from OPENROUTER_API_KEY_CHAT")
	}
}

func TestLoadConfigRejectsUnknownProviderAndBadTimeouts(t *testing.T) {
	cases := map[string][2]string{
		"unknown primary":     {"CHAT_PROVIDER", "nosuch"},
		"unknown fallback":    {"CHAT_FALLBACK_PROVIDER", "nosuch"},
		"bad turn timeout":    {"CHAT_TURN_TIMEOUT", "soon"},
		"zero first byte":     {"CHAT_PROVIDER_FIRST_BYTE_TIMEOUT", "0s"},
		"negative max tokens": {"CHAT_MAX_OUTPUT_TOKENS", "-1"},
	}
	for name, kv := range cases {
		t.Run(name, func(t *testing.T) {
			clearChatRoutingEnv(t)
			t.Setenv(kv[0], kv[1])
			if _, err := LoadConfig(); err == nil {
				t.Fatalf("LoadConfig() accepted %s=%s", kv[0], kv[1])
			}
		})
	}
}

func TestLoadConfigOnlyCatalogKeysAreRead(t *testing.T) {
	clearChatRoutingEnv(t)
	t.Setenv("GEMINI_API_KEY", "gem-key")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}
	if cfg.ProviderKeys["gemini"] != "gem-key" || len(cfg.ProviderKeys) != 1 {
		t.Fatalf("ProviderKeys = %v, want only gemini", cfg.ProviderKeys)
	}
}
