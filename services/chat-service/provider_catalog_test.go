package main

import "testing"

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
	for _, id := range []string{"gemini-2.5-flash", "gemini-2.5-flash-lite"} {
		if m, ok := lookupModel("gemini", id); !ok || !m.Activatable {
			t.Fatalf("gemini model %q missing or not activatable", id)
		}
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
