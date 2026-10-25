package main

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// testToolExecutor is the tool executor the registry is built with.
func testToolExecutor() *ToolExecutor {
	return newTestToolExecutor(httpHandlerCounting(new(atomic.Int32)))
}

func TestCatalogRouteIDsListTheActivatableModels(t *testing.T) {
	want := []string{
		"gemini:gemini-2.5-flash",
		"deepseek:deepseek-flash",
		"deepseek:deepseek-v4-pro",
		"openrouter:deepseek/deepseek-v4-flash",
		"openrouter:openai/gpt-5-mini",
	}
	got := CatalogRouteIDs()
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("CatalogRouteIDs() = %v, want %v", got, want)
	}
}

// keysFor is a provider-key map with every catalog provider a test needs.
func keysFor(names ...string) map[string]string {
	keys := make(map[string]string, len(names))
	for _, n := range names {
		keys[n] = "test-" + n + "-key"
	}
	return keys
}

// registryConfig is a config a registry is built from, in one environment.
func registryConfig(environment string, keys map[string]string) *Config {
	return &Config{
		Environment:           environment,
		ChatProvider:          "gemini",
		ChatModel:             "gemini-2.5-flash",
		GeminiModel:           "gemini-2.5-flash",
		GeminiMaxOutputTokens: 1024,
		ChatMaxOutputTokens:   1024,
		ProviderKeys:          keys,
	}
}

func TestFlaggedRoutesFollowTheConfigGuards(t *testing.T) {
	cases := []struct {
		name         string
		environment  string
		prcAllowed   string
		wantDeepSeek bool
	}{
		{name: "development", environment: "development", wantDeepSeek: true},
		{name: "production without the PRC flag", environment: "production", prcAllowed: "", wantDeepSeek: false},
		{name: "production with the PRC flag", environment: "production", prcAllowed: "true", wantDeepSeek: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CHAT_ALLOW_PRC_HOSTED_PROVIDER", tc.prcAllowed)
			keys := keysFor("gemini", "deepseek", "openrouter")
			routes := buildChatModelRoutes(context.Background(), registryConfig(tc.environment, keys), testToolExecutor(), "gemini:gemini-2.5-flash")

			if _, ok := routes["deepseek:deepseek-flash"]; ok != tc.wantDeepSeek {
				t.Fatalf("deepseek route offered = %t, want %t", ok, tc.wantDeepSeek)
			}
			if _, ok := routes["openrouter:openai/gpt-5-mini"]; !ok {
				t.Fatal("openrouter:openai/gpt-5-mini is not offered, want it offered in both environments")
			}
			if _, ok := routes["gemini:gemini-2.5-flash"]; ok {
				t.Fatal("the default route was built again, want it left to the env router")
			}
			if _, ok := routes["gemini:gemini-3.1-flash-lite"]; ok {
				t.Fatal("a route that is not activatable was built")
			}
		})
	}
}

// The registry offers a flagged route exactly when config loading accepts it. A
// route only validateRoute refuses (DeepSeek direct in production without the PRC
// flag) is therefore left out, and the test fails if validateRoute is removed.
func TestFlaggedRoutesOfferExactlyTheRoutesConfigLoadingAccepts(t *testing.T) {
	cases := []struct{ name, environment, prc string }{
		{"development", "development", ""},
		{"production without the PRC flag", "production", ""},
		{"production with the PRC flag", "production", "true"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("ENVIRONMENT", tc.environment)
			t.Setenv("CHAT_ALLOW_PRC_HOSTED_PROVIDER", tc.prc)
			t.Setenv("GEMINI_API_KEY", "test-gemini-key")
			t.Setenv("DEEPSEEK_API_KEY", "test-deepseek-key")
			t.Setenv("OPENROUTER_API_KEY_CHAT", "test-openrouter-key")
			t.Setenv("CHAT_PROVIDER", "")
			t.Setenv("CHAT_MODEL", "")
			t.Setenv("CHAT_FALLBACK_PROVIDER", "")
			t.Setenv("CHAT_FALLBACK_MODEL", "")
			base, err := LoadConfig()
			if err != nil {
				t.Fatalf("LoadConfig() = %v", err)
			}
			defaultID := routeID(base.ChatProvider, base.ChatModel)
			routes := buildChatModelRoutes(context.Background(), base, testToolExecutor(), defaultID)

			for _, id := range CatalogRouteIDs() {
				if id == defaultID {
					continue
				}
				provider, model, _ := strings.Cut(id, ":")
				t.Setenv("CHAT_PROVIDER", provider)
				t.Setenv("CHAT_MODEL", model)
				_, loadErr := LoadConfig()
				offered := routes[id] != nil
				if offered != (loadErr == nil) {
					t.Fatalf("%s: registry offers it = %t, but config loading accepts it = %t (%v)", id, offered, loadErr == nil, loadErr)
				}
			}
		})
	}
}

func TestFlaggedRoutesNeedAGeminiFallbackKey(t *testing.T) {
	routes := buildChatModelRoutes(context.Background(), registryConfig("development", keysFor("deepseek")), testToolExecutor(), "gemini:gemini-2.5-flash")
	if len(routes) != 0 {
		t.Fatalf("built %d routes without a Gemini key, want none: every flagged route falls back to Gemini", len(routes))
	}
}

func TestFlaggedRoutesLeaveOutAProviderWithoutAKey(t *testing.T) {
	routes := buildChatModelRoutes(context.Background(), registryConfig("development", keysFor("gemini")), testToolExecutor(), "gemini:gemini-2.5-flash")
	for id := range routes {
		if !strings.HasPrefix(id, "gemini:") {
			t.Fatalf("route %s was built with no key for its provider", id)
		}
	}
	if len(routes) != 0 {
		t.Fatalf("built %d routes with only the Gemini key, want none: the catalog has no other activatable Gemini model", len(routes))
	}
}

func TestGeminiFlashLiteIsNotActivatable(t *testing.T) {
	m, ok := lookupModel("gemini", "gemini-2.5-flash-lite")
	if !ok {
		t.Fatal("gemini-2.5-flash-lite is missing from the catalog")
	}
	if m.Activatable {
		t.Fatal("gemini-2.5-flash-lite is activatable, but Google returns 404 for it on new keys")
	}
	routes := buildChatModelRoutes(context.Background(), registryConfig("development", keysFor("gemini")), testToolExecutor(), "gemini:gemini-2.5-flash")
	if _, built := routes["gemini:gemini-2.5-flash-lite"]; built {
		t.Fatal("the registry offers gemini-2.5-flash-lite, want it left out")
	}
}

func TestFlaggedRoutesNeverRebuildTheDefault(t *testing.T) {
	routes := buildChatModelRoutes(context.Background(), registryConfig("development", keysFor("gemini", "deepseek")), testToolExecutor(), "deepseek:deepseek-flash")
	if _, ok := routes["deepseek:deepseek-flash"]; ok {
		t.Fatal("the env default route was built again as a flagged route")
	}
}

func TestExcludedRouteIsDefaultEvenWhenFlaggrNamesIt(t *testing.T) {
	t.Setenv("CHAT_ALLOW_PRC_HOSTED_PROVIDER", "")
	// Production, DeepSeek direct, no PRC flag: validateRoute refuses it, so the
	// registry has no route for it, and Flaggr naming it must mean the default.
	routes := buildChatModelRoutes(context.Background(), registryConfig("production", keysFor("gemini", "deepseek")), testToolExecutor(), "gemini:gemini-2.5-flash")
	fake := newFlaggrFake(t, answer("deepseek:deepseek-flash"))
	s, _ := flagSelector(t, fake.srv.URL, routes, time.Second)

	route, outcome := choiceOf(s, "uid-owner")
	if route != "" || outcome != flagOutcomeUnknownRoute {
		t.Fatalf("choose() = %q, %q; want the default and %s", route, outcome, flagOutcomeUnknownRoute)
	}
}

func TestRegistryAnswersWithTheRouteFlaggrChoseOnly(t *testing.T) {
	t.Setenv("CHAT_ALLOW_PRC_HOSTED_PROVIDER", "true")
	routes := buildChatModelRoutes(context.Background(), registryConfig("production", keysFor("gemini", "deepseek")), testToolExecutor(), "gemini:gemini-2.5-flash")
	fake := newFlaggrFake(t, answer("deepseek:deepseek-flash"))
	s, _ := flagSelector(t, fake.srv.URL, routes, time.Second)

	route, outcome := choiceOf(s, "uid-owner")
	if route != "deepseek:deepseek-flash" || outcome != flagOutcomeFlag {
		t.Fatalf("choose() = %q, %q; want the PRC-flagged route once the flag allows it", route, outcome)
	}
	if s.routeFor(route) == nil {
		t.Fatal("routeFor() = nil for a route the registry built")
	}
}

func TestFlaggedRoutesFallBackToTheGeminiDefault(t *testing.T) {
	routes := buildChatModelRoutes(context.Background(), registryConfig("development", keysFor("gemini", "deepseek")), testToolExecutor(), "gemini:gemini-2.5-flash")
	r := routes["deepseek:deepseek-flash"]
	if r == nil || r.fallback == nil {
		t.Fatal("the flagged route has no fallback, so a failure before text would not reach the default")
	}
	if r.fallback.route.Ref.Provider != "gemini" || r.fallback.route.Ref.Model != "gemini-2.5-flash" || r.fallback.route.Label != routeFallback {
		t.Fatalf("fallback = %s/%s label %q, want the default Gemini route", r.fallback.route.Ref.Provider, r.fallback.route.Ref.Model, r.fallback.route.Label)
	}
	if r.primary.route.Label != routeFlag || r.primary == r.fallback {
		t.Fatal("the flagged primary must have its own breaker, not share the fallback's")
	}
}
