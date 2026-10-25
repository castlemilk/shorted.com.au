package main

// The provider catalog is the closed list of backends chat can route to. A
// config row or an env var names a provider and a model from here, and the
// catalog says how to talk to them. Keys come from the environment only. Prices
// and capabilities were read on catalogAsOf, and each entry names its source.
// Re-check them before activating a model.

// catalogAsOf is the date the prices and capabilities below were read.
const catalogAsOf = "2026-10-24"

// ProviderKind selects the wire adapter.
type ProviderKind string

const (
	kindGemini       ProviderKind = "gemini"
	kindOpenAICompat ProviderKind = "openai_compat"
)

// ProviderSpec is one backend in the catalog.
type ProviderSpec struct {
	Name         string
	Kind         ProviderKind
	BaseURL      string // openai_compat only
	KeyEnv       string // the environment variable that holds the key
	Dialect      OpenAIDialect
	DefaultModel string // used when the env names a provider but no model
	// TestOnly marks a provider with no verified tool-choice behaviour. It may be
	// selected for tests and smoke runs, never for a rollout.
	TestOnly bool
	Models   []ModelSpec
}

// OpenAIDialect holds the differences between OpenAI-compatible providers.
type OpenAIDialect struct {
	DisableThinking bool   // DeepSeek: always send "thinking":{"type":"disabled"}
	EndUserField    string // "user_id" (DeepSeek), "user" (OpenRouter) or "" (none)
	OpenRouterPrefs bool   // send provider.require_parameters, only and data_collection
	RequiredChoice  string // the tool_choice value that forces a call: "required"
}

// ModelSpec is one model a provider serves.
type ModelSpec struct {
	ID    string
	Label string
	Caps  ModelCapabilities
	Price Pricing
	// Activatable says the model may be chosen for a rollout. Test-only models
	// are false until their gate passes.
	Activatable bool
	// DefaultOnly is the OpenRouter provider pin for this model, sent as
	// provider.only. It is empty for direct providers.
	DefaultOnly []string
	Notes       string
}

// ModelCapabilities says what a model honours. A model whose ForcedToolChoice is
// false gets the verify policy: the engine asks for a tool with a sentence in the
// system prompt, then checks the reply.
type ModelCapabilities struct {
	ForcedToolChoice  bool // honours the required choice on the first call
	NoneToolChoice    bool // honours the none choice when the round budget is spent
	ParallelToolCalls bool
	// MaxOutputTokens is informational. Zero means the provider's limit was not recorded.
	MaxOutputTokens int32
}

// Shared pricing helpers.
var deepSeekPricing = func(input, cached, output float64, url string) Pricing {
	return Pricing{
		Input: input, CachedInput: cached, Output: output,
		OffPeakFactor: 0.5, IsOffPeak: deepSeekOffPeak,
		AsOf: catalogAsOf, SourceURL: url,
	}
}

const (
	deepSeekPricingURL = "https://api-docs.deepseek.com/quick_start/pricing"
	geminiPricingURL   = "https://ai.google.dev/gemini-api/docs/pricing"
)

var (
	dialectDeepSeek = OpenAIDialect{DisableThinking: true, EndUserField: "user_id", RequiredChoice: "required"}
	dialectOpenRtr  = OpenAIDialect{EndUserField: "user", OpenRouterPrefs: true, RequiredChoice: "required"}
	dialectPlain    = OpenAIDialect{RequiredChoice: "required"}
)

// providerCatalog is the list the router and the config read.
var providerCatalog = []ProviderSpec{
	{
		Name: "gemini", Kind: kindGemini, KeyEnv: "GEMINI_API_KEY", DefaultModel: "gemini-2.5-flash",
		Models: []ModelSpec{
			{
				ID: "gemini-2.5-flash", Label: "Gemini 2.5 Flash",
				Caps:        ModelCapabilities{ForcedToolChoice: true, NoneToolChoice: true, ParallelToolCalls: true, MaxOutputTokens: 65536},
				Price:       Pricing{Input: 0.30, CachedInput: 0.03, Output: 2.50, OffPeakFactor: 1, AsOf: catalogAsOf, SourceURL: geminiPricingURL},
				Activatable: true,
				Notes:       "The prod default. Output is billed at the output rate, thinking tokens included.",
			},
			{
				ID: "gemini-2.5-flash-lite", Label: "Gemini 2.5 Flash-Lite",
				Caps:  ModelCapabilities{ForcedToolChoice: true, NoneToolChoice: true, ParallelToolCalls: true, MaxOutputTokens: 65536},
				Price: Pricing{Input: 0.10, CachedInput: 0.01, Output: 0.40, OffPeakFactor: 1, AsOf: catalogAsOf, SourceURL: geminiPricingURL},
				// Not activatable: Google returns 404 for this model on new keys, so a
				// flagged route to it would fail every turn and fall back to the default.
				// Re-enable only after a key that can call it has passed the gate.
				Activatable: false,
				Notes:       "Not activatable: Google returns 404 for this model on new keys.",
			},
			{
				ID: "gemini-3.1-flash-lite", Label: "Gemini 3.1 Flash-Lite",
				Caps:  ModelCapabilities{ForcedToolChoice: true, NoneToolChoice: true, ParallelToolCalls: true},
				Price: Pricing{Input: 0.25, CachedInput: 0.25, Output: 1.50, OffPeakFactor: 1, AsOf: catalogAsOf, SourceURL: geminiPricingURL},
				// Not activatable until the genai adapter gates it (P6). The cached
				// price was not read, so it is billed at the input rate: a high estimate.
				Activatable: false,
				Notes:       "Test-only until P6. Cached input is billed at the input rate here, which overstates the cost.",
			},
		},
	},
	{
		Name: "deepseek", Kind: kindOpenAICompat, BaseURL: "https://api.deepseek.com", KeyEnv: "DEEPSEEK_API_KEY",
		Dialect: dialectDeepSeek, DefaultModel: "deepseek-flash",
		Models: []ModelSpec{
			{
				ID: "deepseek-flash", Label: "DeepSeek V4.1 Flash",
				Caps:        ModelCapabilities{ForcedToolChoice: true, NoneToolChoice: true, ParallelToolCalls: true, MaxOutputTokens: 384000},
				Price:       deepSeekPricing(0.30, 0.006, 1.20, deepSeekPricingURL),
				Activatable: true,
				Notes:       "Thinking is disabled on every call, which is what lets tool_choice=required work. Legacy names deepseek-v4-flash are served by this model at its price.",
			},
			{
				ID: "deepseek-v4-pro", Label: "DeepSeek V4 Pro",
				Caps:        ModelCapabilities{ForcedToolChoice: true, NoneToolChoice: true, ParallelToolCalls: true, MaxOutputTokens: 384000},
				Price:       deepSeekPricing(1.32, 0.044, 3.96, deepSeekPricingURL),
				Activatable: true,
				Notes:       "Not cheaper than gemini-2.5-flash at peak; kept for quality comparisons.",
			},
		},
	},
	{
		Name: "openrouter", Kind: kindOpenAICompat, BaseURL: "https://openrouter.ai/api/v1", KeyEnv: "OPENROUTER_API_KEY_CHAT",
		Dialect: dialectOpenRtr,
		Models: []ModelSpec{
			{
				ID: "deepseek/deepseek-v4-flash", Label: "DeepSeek V4 Flash 0423 (OpenRouter)",
				// parallel_tool_calls is off on OpenRouter: with require_parameters and a pinned
				// provider it may match no endpoint, and every turn would fall back. It needs a
				// live check on OpenRouter before it is enabled. DeepSeek direct keeps it.
				Caps: ModelCapabilities{ForcedToolChoice: true, NoneToolChoice: false, ParallelToolCalls: false},
				// Priced on DeepInfra, the cheapest pinned endpoint. OpenRouter's
				// reported cost wins when it is returned.
				Price:       Pricing{Input: 0.09, CachedInput: 0.018, Output: 0.18, OffPeakFactor: 1, AsOf: catalogAsOf, SourceURL: "https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-flash/endpoints"},
				Activatable: true,
				DefaultOnly: []string{"deepinfra", "azure"},
				// Pins checked against OpenRouter's public endpoints API on 2026-10-25, which
				// lists 15 endpoints. Of those, DeepInfra and Azure are pinned, and both
				// advertise required. Cloudflare and Wafer also advertise required but are
				// not pinned. DeepInfra does not advertise none, so the pin keeps this route
				// on forced choice. Both pins are US headquarters on OpenRouter's providers
				// list. DeepInfra's hosting location is not published there, so it is
				// reviewed by headquarters only.
				Notes: "Pinned to DeepInfra and Azure (both US headquarters). They are the only endpoints this route may be served by, and every other endpoint is excluded. It is a different model from DeepSeek direct's deepseek-flash (V4.1).",
			},
			{
				ID: "openai/gpt-5-mini", Label: "GPT-5 mini (OpenRouter)",
				// parallel_tool_calls is off on OpenRouter: with require_parameters and a pinned
				// provider it may match no endpoint, and every turn would fall back. It needs a
				// live check on OpenRouter before it is enabled. DeepSeek direct keeps it.
				Caps:        ModelCapabilities{ForcedToolChoice: true, NoneToolChoice: true, ParallelToolCalls: false, MaxOutputTokens: 0},
				Price:       Pricing{Input: 0.25, CachedInput: 0.025, Output: 2.00, OffPeakFactor: 1, AsOf: catalogAsOf, SourceURL: "https://openrouter.ai/api/v1/models/openai/gpt-5-mini/endpoints"},
				Activatable: true,
				// The plan names no provider for this model, so the pin is OpenAI's own
				// host. Unverified against the live endpoint list: check it before activation.
				DefaultOnly: []string{"openai"},
				Notes:       "Standard-tier price. The flex tier is cheaper but not used.",
			},
			{
				ID: "qwen/qwen3.8-flash", Label: "Qwen3.8 Flash (OpenRouter)",
				// required and a named function are not honoured, so the engine verifies.
				Caps:  ModelCapabilities{ForcedToolChoice: false, NoneToolChoice: true, ParallelToolCalls: false},
				Price: Pricing{Input: 0.15, CachedInput: 0.016, Output: 0.47, OffPeakFactor: 1, AsOf: catalogAsOf, SourceURL: "https://openrouter.ai/api/v1/models/qwen/qwen3.8-flash/endpoints"},
				// Not activatable: the plan names no provider for this model, so the pin is
				// Alibaba, which is not the US or EU host the docs promise. host not reviewed; see §11.2.
				Activatable: false,
				DefaultOnly: []string{"alibaba"},
				Notes:       "Verify policy: the first reply must call a tool, or the turn is retried with a nudge.",
			},
		},
	},
	// Test-only providers. Each has a base URL and a key variable, but no model
	// whose tool choice has been verified, so none may be activated.
	{Name: "groq", Kind: kindOpenAICompat, BaseURL: "https://api.groq.com/openai/v1", KeyEnv: "GROQ_API_KEY", Dialect: dialectPlain, TestOnly: true},
	{Name: "together", Kind: kindOpenAICompat, BaseURL: "https://api.together.xyz/v1", KeyEnv: "TOGETHER_API_KEY", Dialect: dialectPlain, TestOnly: true},
	{Name: "mistral", Kind: kindOpenAICompat, BaseURL: "https://api.mistral.ai/v1", KeyEnv: "MISTRAL_API_KEY", Dialect: dialectPlain, TestOnly: true},
	{Name: "dashscope", Kind: kindOpenAICompat, BaseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", KeyEnv: "DASHSCOPE_API_KEY", Dialect: dialectPlain, TestOnly: true},
	{Name: "moonshot", Kind: kindOpenAICompat, BaseURL: "https://api.moonshot.ai/v1", KeyEnv: "MOONSHOT_API_KEY", Dialect: dialectPlain, TestOnly: true},
}

// lookupProvider returns the catalog entry for a provider name.
func lookupProvider(name string) (ProviderSpec, bool) {
	for _, p := range providerCatalog {
		if p.Name == name {
			return p, true
		}
	}
	return ProviderSpec{}, false
}

// lookupModel returns the catalog entry for a model of a provider.
func lookupModel(provider, model string) (ModelSpec, bool) {
	p, ok := lookupProvider(provider)
	if !ok {
		return ModelSpec{}, false
	}
	for _, m := range p.Models {
		if m.ID == model {
			return m, true
		}
	}
	return ModelSpec{}, false
}

// modelOrUnverified returns the catalog entry for a model, or for a model the
// catalog does not list: no price, and the verify policy, except for Gemini. A
// Gemini model keeps the forced first call even when the catalog lacks it, because
// that is the policy prod has always run, and Gemini honours the choice.
func modelOrUnverified(provider, model string) (ModelSpec, bool) {
	if m, ok := lookupModel(provider, model); ok {
		return m, true
	}
	if provider == geminiProviderName {
		return ModelSpec{
			ID:    model,
			Caps:  ModelCapabilities{ForcedToolChoice: true, NoneToolChoice: true, ParallelToolCalls: true},
			Notes: "not in the catalog: forced choice as for Gemini, no price",
		}, false
	}
	return ModelSpec{ID: model, Notes: "not in the catalog: verify policy, no price"}, false
}

// providerKeyEnvs lists the key variable of every catalog provider.
func providerKeyEnvs() map[string]string {
	keys := make(map[string]string, len(providerCatalog))
	for _, p := range providerCatalog {
		keys[p.Name] = p.KeyEnv
	}
	return keys
}
