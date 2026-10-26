package main

import (
	"context"
	"strings"
	"testing"
)

// prodEnvViaOpenRouter is the environment prod runs once Terraform sets the
// OpenRouter key and CHAT_ALLOW_PRC_HOSTED_PROVIDER=false (terraform/modules/chat-service).
// The DeepSeek key is still wired, so the only thing that keeps DeepSeek direct out
// is the PRC guard.
func prodEnvViaOpenRouter(t *testing.T) {
	t.Helper()
	for k, v := range map[string]string{
		"ENVIRONMENT":                        "production",
		"GEMINI_API_KEY":                     "test-gemini-key",
		"DEEPSEEK_API_KEY":                   "sk-test-deepseek",
		"OPENROUTER_API_KEY_CHAT":            "test-openrouter-key",
		"CHAT_ALLOW_PRC_HOSTED_PROVIDER":     "false",
		"GEMINI_MAX_OUTPUT_TOKENS":           "1024",
		"CHAT_MAX_INPUT_CHARS":               "2000",
		"CHAT_HISTORY_LIMIT":                 "20",
		"CHAT_MAX_MESSAGES_PER_CONVERSATION": "100",
		"CHAT_PROVIDER":                      "",
		"CHAT_MODEL":                         "",
		"GEMINI_MODEL":                       "",
		"CHAT_FALLBACK_PROVIDER":             "",
		"CHAT_FALLBACK_MODEL":                "",
		"FLAGGR_API_KEY":                     "",
		"FLAGGR_SERVICE_ID":                  "",
		"FLAGGR_ENVIRONMENT":                 "",
		"FLAGGR_API_URL":                     "",
	} {
		t.Setenv(k, v)
	}
}

// The flag's OpenRouter route is offered in prod with the key Terraform sets and
// the PRC flag false, and no DeepSeek direct route is offered.
func TestProdRegistryOffersOpenRouterDeepSeekAndNoDirectDeepSeek(t *testing.T) {
	prodEnvViaOpenRouter(t)
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() with the prod env = %v", err)
	}
	routes := buildChatModelRoutes(context.Background(), cfg, testToolExecutor(), routeID(cfg.ChatProvider, cfg.ChatModel))

	if _, ok := routes["openrouter:deepseek/deepseek-v4-flash"]; !ok {
		t.Fatalf("prod does not offer openrouter:deepseek/deepseek-v4-flash; offered %v", sortedRouteIDs(routes))
	}
	for id := range routes {
		if strings.HasPrefix(id, "deepseek:") {
			t.Fatalf("prod offers direct DeepSeek route %s with %s=false", id, chatAllowPRCHostedProviderEnv)
		}
	}
}

// Prod can also run the OpenRouter route as its primary: the guards load it.
func TestProdLoadsOpenRouterDeepSeekAsPrimaryWithPRCFalse(t *testing.T) {
	prodEnvViaOpenRouter(t)
	t.Setenv("CHAT_PROVIDER", "openrouter")
	t.Setenv("CHAT_MODEL", "deepseek/deepseek-v4-flash")
	if _, err := LoadConfig(); err != nil {
		t.Fatalf("LoadConfig() with the route as primary = %v", err)
	}
}

// The direct DeepSeek route stays refused as a primary in the same environment.
func TestProdRefusesDirectDeepSeekPrimaryWithPRCFalse(t *testing.T) {
	prodEnvViaOpenRouter(t)
	t.Setenv("CHAT_PROVIDER", "deepseek")
	t.Setenv("CHAT_MODEL", "deepseek-flash")
	if _, err := LoadConfig(); err == nil {
		t.Fatal("LoadConfig() accepted deepseek direct in production with the PRC flag false")
	}
}

// The OpenRouter route is served only by the reviewed, non-PRC endpoints.
func TestOpenRouterDeepSeekPinsAreTheReviewedNonPRCEndpoints(t *testing.T) {
	m, ok := lookupModel("openrouter", "deepseek/deepseek-v4-flash")
	if !ok {
		t.Fatal("openrouter:deepseek/deepseek-v4-flash is not in the catalog")
	}
	want := []string{"deepinfra", "azure"}
	if strings.Join(m.DefaultOnly, ",") != strings.Join(want, ",") {
		t.Fatalf("provider pins = %v, want %v (reviewed on OpenRouter's endpoints API 2026-10-25)", m.DefaultOnly, want)
	}
}
