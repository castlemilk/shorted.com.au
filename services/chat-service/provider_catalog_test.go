package main

import (
	"regexp"
	"testing"
)

func TestCatalogDeepSeekModelIDsMatchTheAPI(t *testing.T) {
	// The IDs GET https://api.deepseek.com/models returned on 2026-10-25.
	for _, id := range []string{"deepseek-flash", "deepseek-v4-pro"} {
		m, ok := lookupModel("deepseek", id)
		if !ok {
			t.Fatalf("deepseek model %q is not in the catalog", id)
		}
		if !m.Activatable || !m.Caps.ForcedToolChoice {
			t.Fatalf("deepseek model %q must be activatable with a forced tool choice", id)
		}
	}
	p, _ := lookupProvider("deepseek")
	if p.BaseURL != "https://api.deepseek.com" || p.KeyEnv != "DEEPSEEK_API_KEY" {
		t.Fatalf("deepseek = %q / %q, want https://api.deepseek.com and DEEPSEEK_API_KEY", p.BaseURL, p.KeyEnv)
	}
	if !p.Dialect.DisableThinking || p.Dialect.EndUserField != "user_id" {
		t.Fatalf("deepseek dialect = %+v, want thinking disabled and user_id", p.Dialect)
	}
}

func TestCatalogGeminiEntriesKeepTheProdKeyAndDefault(t *testing.T) {
	p, ok := lookupProvider("gemini")
	if !ok || p.KeyEnv != "GEMINI_API_KEY" || p.DefaultModel != "gemini-2.5-flash" {
		t.Fatalf("gemini provider = %+v, want GEMINI_API_KEY and gemini-2.5-flash", p)
	}
	if m, ok := lookupModel("gemini", "gemini-2.5-flash"); !ok || !m.Activatable {
		t.Fatal("gemini-2.5-flash missing or not activatable")
	}
}

func TestCatalogTestOnlyProvidersHaveNoActivatableModel(t *testing.T) {
	for _, name := range []string{"groq", "together", "mistral", "dashscope", "moonshot"} {
		p, ok := lookupProvider(name)
		if !ok {
			t.Fatalf("provider %q missing from the catalog", name)
		}
		if !p.TestOnly {
			t.Fatalf("provider %q must be test-only until its tool choice is verified", name)
		}
		for _, m := range p.Models {
			if m.Activatable {
				t.Fatalf("test-only provider %q has activatable model %q", name, m.ID)
			}
		}
	}
}

func TestCatalogEveryPriceCarriesItsDateAndSource(t *testing.T) {
	for _, p := range providerCatalog {
		for _, m := range p.Models {
			if m.Price.AsOf == "" || m.Price.SourceURL == "" {
				t.Fatalf("%s/%s has a price with no as-of date or source", p.Name, m.ID)
			}
			if m.Price.Input <= 0 || m.Price.Output <= 0 {
				t.Fatalf("%s/%s has an unpriced input or output", p.Name, m.ID)
			}
		}
	}
}

func TestCatalogOpenRouterDeepSeekIsPinnedAndForced(t *testing.T) {
	m, ok := lookupModel("openrouter", "deepseek/deepseek-v4-flash")
	if !ok {
		t.Fatal("openrouter deepseek/deepseek-v4-flash is not in the catalog")
	}
	if !m.Caps.ForcedToolChoice {
		t.Fatal("the pinned DeepInfra and Azure endpoints honour required, so the model is forced")
	}
	if len(m.DefaultOnly) != 2 || m.DefaultOnly[0] != "deepinfra" || m.DefaultOnly[1] != "azure" {
		t.Fatalf("DefaultOnly = %v, want [deepinfra azure]", m.DefaultOnly)
	}
}

func TestCatalogOpenRouterQwenUsesTheVerifyPolicy(t *testing.T) {
	m, ok := lookupModel("openrouter", "qwen/qwen3.8-flash")
	if !ok || m.Caps.ForcedToolChoice {
		t.Fatalf("qwen/qwen3.8-flash must not be forced: required is not honoured")
	}
}

func TestUncataloguedModelGetsTheVerifyPolicyAndNoPrice(t *testing.T) {
	m, ok := modelOrUnverified("deepseek", "not-a-real-model")
	if ok {
		t.Fatal("an uncatalogued model reported as catalogued")
	}
	if m.Caps.ForcedToolChoice || m.Price.Input != 0 {
		t.Fatalf("uncatalogued model = %+v, want no forced choice and no price", m)
	}
}

func TestProviderKeyEnvsCoverEveryProvider(t *testing.T) {
	keys := providerKeyEnvs()
	for _, p := range providerCatalog {
		if keys[p.Name] != p.KeyEnv || p.KeyEnv == "" {
			t.Fatalf("provider %q has no key variable", p.Name)
		}
	}
}

// A Gemini model the catalog does not list keeps the forced first call, as the
// Gemini adapter has always run it.
func TestModelOrUnverifiedKeepsTheForcedChoiceForGemini(t *testing.T) {
	m, ok := modelOrUnverified("gemini", "gemini-9-future")
	if ok {
		t.Fatal("an uncatalogued Gemini model reported as catalogued")
	}
	if !m.Caps.ForcedToolChoice || !m.Caps.NoneToolChoice || m.Price.Input != 0 {
		t.Fatalf("uncatalogued Gemini model = %+v, want forced and none choices and no price", m)
	}
}

// Plan §0.3: OpenRouter can silently drop tool_choice, so every OpenRouter entry
// carries a pinned provider list, and each slug is one the wire accepts.
func TestEveryOpenRouterEntryIsPinnedToProviders(t *testing.T) {
	slug := regexp.MustCompile(`^[a-z0-9-]{1,40}$`)
	seen := 0
	for _, p := range providerCatalog {
		if !p.Dialect.OpenRouterPrefs {
			continue
		}
		for _, m := range p.Models {
			seen++
			if len(m.DefaultOnly) == 0 {
				t.Errorf("%s/%s has no pinned provider list: OpenRouter may drop tool_choice without one", p.Name, m.ID)
			}
			for _, s := range m.DefaultOnly {
				if !slug.MatchString(s) {
					t.Errorf("%s/%s pins %q, which is not a valid provider slug", p.Name, m.ID, s)
				}
			}
		}
	}
	if seen == 0 {
		t.Fatal("no OpenRouter entries found in the catalog")
	}
}

// Production routes only activatable models. The qwen entry is pinned to Alibaba,
// which is not the US or EU host the docs promise, so it stays out of production
// until its host is reviewed.
func TestCatalogOpenRouterQwenIsNotActivatable(t *testing.T) {
	m, ok := lookupModel("openrouter", "qwen/qwen3.8-flash")
	if !ok {
		t.Fatal("qwen/qwen3.8-flash is no longer in the catalog")
	}
	if m.Activatable {
		t.Fatal("qwen/qwen3.8-flash is activatable, but its host is not reviewed (docs/plans/chat-llm-providers.md §11.2)")
	}
}

// parallel_tool_calls is off on every OpenRouter entry until a live check shows the
// pinned endpoints honour it with require_parameters.
func TestCatalogOpenRouterEntriesDoNotSendParallelToolCalls(t *testing.T) {
	for _, spec := range providerCatalog {
		if spec.Name != "openrouter" {
			continue
		}
		for _, m := range spec.Models {
			if m.Caps.ParallelToolCalls {
				t.Fatalf("openrouter/%s has ParallelToolCalls set: it needs a live check before it is enabled", m.ID)
			}
		}
	}
}
