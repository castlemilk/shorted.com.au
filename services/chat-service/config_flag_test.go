package main

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestFlaggrConfigDefaults(t *testing.T) {
	t.Setenv("ENVIRONMENT", "production")
	t.Setenv("FLAGGR_ENVIRONMENT", "")
	t.Setenv("CHAT_MODEL_FLAG_TIMEOUT", "")
	t.Setenv("CHAT_MODEL_FLAG_TTL", "")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}
	if cfg.FlaggrEnvironment != "production" {
		t.Fatalf("FlaggrEnvironment = %q, want production in a production service", cfg.FlaggrEnvironment)
	}
	if cfg.ChatModelFlagTimeout != 200*time.Millisecond || cfg.ChatModelFlagTTL != 30*time.Second {
		t.Fatalf("timeout = %s, ttl = %s; want 200ms and 30s", cfg.ChatModelFlagTimeout, cfg.ChatModelFlagTTL)
	}
}

func TestFlaggrEnvironmentFollowsTheServiceEnvironment(t *testing.T) {
	t.Setenv("ENVIRONMENT", "development")
	t.Setenv("FLAGGR_ENVIRONMENT", "")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}
	if cfg.FlaggrEnvironment != "development" {
		t.Fatalf("FlaggrEnvironment = %q, want development outside production", cfg.FlaggrEnvironment)
	}
}

func TestBadFlaggrDurationNeverStopsStartup(t *testing.T) {
	t.Setenv("CHAT_MODEL_FLAG_TIMEOUT", "soon")
	t.Setenv("CHAT_MODEL_FLAG_TTL", "-5s")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() error = %v, want startup to go on with the defaults", err)
	}
	if cfg.ChatModelFlagTimeout != 200*time.Millisecond || cfg.ChatModelFlagTTL != 30*time.Second {
		t.Fatalf("timeout = %s, ttl = %s; want the defaults after bad values", cfg.ChatModelFlagTimeout, cfg.ChatModelFlagTTL)
	}
}

// With the environment Terraform sets on prod (the DeepSeek key and the PRC flag,
// no Flaggr), config loading succeeds, the default is Gemini and no flag client is
// made. With the Flaggr pair set too, the registry offers the DeepSeek routes only:
// OpenRouter has no key in prod.
func TestProdEnvLoadsWithTheFlagOffAndOffersDeepSeekWhenOn(t *testing.T) {
	for k, v := range map[string]string{
		"ENVIRONMENT":                        "production",
		"GEMINI_API_KEY":                     "test-gemini-key",
		"DEEPSEEK_API_KEY":                   "sk-test-deepseek",
		"CHAT_ALLOW_PRC_HOSTED_PROVIDER":     "true",
		"GEMINI_MAX_OUTPUT_TOKENS":           "1024",
		"CHAT_MAX_INPUT_CHARS":               "2000",
		"CHAT_HISTORY_LIMIT":                 "20",
		"CHAT_MAX_MESSAGES_PER_CONVERSATION": "100",
		"CHAT_PROVIDER":                      "",
		"CHAT_MODEL":                         "",
		"GEMINI_MODEL":                       "",
		"CHAT_FALLBACK_PROVIDER":             "",
		"CHAT_FALLBACK_MODEL":                "",
		"OPENROUTER_API_KEY_CHAT":            "",
		"FLAGGR_API_KEY":                     "",
		"FLAGGR_SERVICE_ID":                  "",
		"FLAGGR_ENVIRONMENT":                 "",
		"FLAGGR_API_URL":                     "",
	} {
		t.Setenv(k, v)
	}
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() with the prod env = %v", err)
	}
	if id := routeID(cfg.ChatProvider, cfg.ChatModel); id != "gemini:gemini-2.5-flash" {
		t.Fatalf("default route = %s, want gemini:gemini-2.5-flash", id)
	}
	if c, err := newChatModelFlagClient(cfg); c != nil || err != nil {
		t.Fatalf("flag client = %v, %v; want none with no Flaggr pair", c, err)
	}

	cfg.FlaggrAPIKey, cfg.FlaggrServiceID = "fgr_x", "svc"
	routes := buildChatModelRoutes(context.Background(), cfg, testToolExecutor(), "gemini:gemini-2.5-flash")
	got := sortedRouteIDs(routes)
	want := []string{"deepseek:deepseek-flash", "deepseek:deepseek-v4-pro"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("prod would offer %v, want %v", got, want)
	}
}
