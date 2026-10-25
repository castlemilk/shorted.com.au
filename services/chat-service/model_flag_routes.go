package main

import (
	"context"
	"fmt"
	"log"
	"sort"
)

// routeFlag labels a route the chat-model flag chose. It is neither the env
// default nor the fallback.
const routeFlag = "flag"

// CatalogRouteIDs lists every "<provider>:<model>" the catalog marks activatable,
// in catalog order. The flag's valid values come from here, and so do the docs.
// It says what the catalog allows, not what this deployment can run:
// buildChatModelRoutes decides that from the environment.
func CatalogRouteIDs() []string {
	var ids []string
	for _, spec := range providerCatalog {
		for _, m := range spec.Models {
			if m.Activatable {
				ids = append(ids, routeID(spec.Name, m.ID))
			}
		}
	}
	return ids
}

// routeID is the flag value that names one route.
func routeID(provider, model string) string {
	return provider + ":" + model
}

// buildChatModelRoutes builds one router per catalog model the flag may choose
// in this deployment. A model is offered only when every check the config load
// applies passes: it is activatable, validateRoute accepts it for this
// environment (which refuses test-only providers in production, DeepSeek direct
// without CHAT_ALLOW_PRC_HOSTED_PROVIDER, and uncatalogued models), and its
// provider key is set. The default route is never built again, and no route is
// built without a Gemini key, because every flagged route falls back to Gemini.
//
// Building makes no network call. A route that fails to build is logged and left
// out, never fatal.
func buildChatModelRoutes(ctx context.Context, cfg *Config, tools *ToolExecutor, defaultID string) map[string]*ModelRouter {
	return buildChatModelRoutesAt(ctx, cfg, tools, defaultID, nil)
}

// buildChatModelRoutesAt is buildChatModelRoutes with each provider's base URL
// overridden by baseURLs. Tests use it to build the real routes against a fake
// endpoint; production passes nil.
func buildChatModelRoutesAt(ctx context.Context, cfg *Config, tools *ToolExecutor, defaultID string, baseURLs map[string]string) map[string]*ModelRouter {
	routes := make(map[string]*ModelRouter)
	if cfg.ProviderKeys["gemini"] == "" {
		log.Printf("chat model flag: no flagged routes, because the Gemini fallback has no key (GEMINI_API_KEY)")
		return routes
	}
	for _, spec := range providerCatalog {
		for _, m := range spec.Models {
			id := routeID(spec.Name, m.ID)
			if id == defaultID || !m.Activatable {
				continue
			}
			if err := validateRoute(cfg.Environment, spec, m.ID, "chat-model", "chat-model"); err != nil {
				log.Printf("chat model flag: route %s not offered: %v", id, err)
				continue
			}
			r, err := newFlaggedRouter(ctx, cfg, tools, spec.Name, m.ID, baseURLs)
			if err != nil {
				log.Printf("chat model flag: route %s not offered: %v", id, err)
				continue
			}
			routes[id] = r
		}
	}
	return routes
}

// newFlaggedRouter is a router whose primary is the flagged model and whose
// fallback is the default Gemini model, with its own breaker. It uses the bounds
// of a router with a fallback, and the same overrides as the default router.
func newFlaggedRouter(ctx context.Context, cfg *Config, tools *ToolExecutor, provider, model string, baseURLs map[string]string) (*ModelRouter, error) {
	primary, err := newRouteForAt(ctx, cfg, provider, model, routeFlag, cfg.ChatMaxOutputTokens, baseURLs[provider])
	if err != nil {
		return nil, err
	}
	fallback, err := newRouteForAt(ctx, cfg, geminiProviderName, cfg.GeminiModel, routeFallback, cfg.GeminiMaxOutputTokens, baseURLs[geminiProviderName])
	if err != nil {
		_ = primary.Provider.Close()
		return nil, fmt.Errorf("gemini fallback: %w", err)
	}

	firstByte, budget := firstByteWithFallback, turnBudgetWithFallback
	if cfg.ChatFirstByteTimeout > 0 {
		firstByte = cfg.ChatFirstByteTimeout
	}
	if cfg.ChatTurnTimeout > 0 {
		budget = cfg.ChatTurnTimeout
	}
	withFirstByteTimeout(primary.Provider, firstByte)
	withFirstByteTimeout(fallback.Provider, firstByte)
	return newModelRouter(primary, &fallback, tools, budget), nil
}

// closeChatModelRoutes closes every flagged router at shutdown.
func closeChatModelRoutes(routes map[string]*ModelRouter) {
	for _, r := range routes {
		r.Close()
	}
}

// sortedRouteIDs lists a route set's ids in a stable order, for the startup log.
func sortedRouteIDs(routes map[string]*ModelRouter) []string {
	ids := make([]string, 0, len(routes))
	for id := range routes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
