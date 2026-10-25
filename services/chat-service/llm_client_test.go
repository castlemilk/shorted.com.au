package main

import (
	"context"
	"time"
)

// LLMClient is a single-route client for the tests. It runs the real TurnEngine
// over one provider, with no router, breaker or fallback. Production goes through
// ModelRouter.
type LLMClient struct {
	provider        ChatProvider
	engine          *TurnEngine
	model           string
	maxOutputTokens int32
	// forcedFirstCall and pricing describe the model. newLLMClient assumes a
	// forced model with no price.
	forcedFirstCall bool
	pricing         Pricing
}

// newLLMClient wires a provider to the engine. Tests use it with a fake provider.
func newLLMClient(provider ChatProvider, model string, maxOutputTokens int32, toolExecutor *ToolExecutor) *LLMClient {
	return &LLMClient{
		provider:        provider,
		engine:          &TurnEngine{tools: toolExecutor},
		model:           model,
		maxOutputTokens: maxOutputTokens,
		forcedFirstCall: true,
	}
}

// Close closes the provider.
func (lc *LLMClient) Close() {
	if lc != nil && lc.provider != nil {
		_ = lc.provider.Close()
	}
}

// Ready reports whether the client exists. The handler tests use it only as a
// configured stand-in.
func (lc *LLMClient) Ready() bool { return lc != nil }

// Model names the model, as the usage ledger records it.
func (lc *LLMClient) Model() string {
	if lc == nil {
		return ""
	}
	return lc.model
}

// RunTurn runs one turn on the single route.
func (lc *LLMClient) RunTurn(ctx context.Context, userID string, in TurnInput, onChunk func(text string)) (*LLMResponse, error) {
	return lc.ChatStream(ctx, in.System, in.History, in.UserText, onChunk)
}

// ChatStream sends a message and streams text chunks via the onChunk callback.
// Tool call rounds execute synchronously between streaming segments.
func (lc *LLMClient) ChatStream(ctx context.Context, systemPrompt string, history []Message, userMessage string, onChunk func(text string)) (*LLMResponse, error) {
	return lc.engine.run(ctx, turnSpec{
		provider: lc.provider,
		cfg: SessionConfig{
			Model:           lc.model,
			System:          systemPrompt,
			History:         history,
			Tools:           chatToolDefinitions(),
			MaxOutputTokens: lc.maxOutputTokens,
		},
		userText:        userMessage,
		forcedFirstCall: lc.forcedFirstCall,
		meta:            turnMeta{Provider: lc.provider.Name(), Model: lc.model, Pricing: lc.pricing, Start: time.Now()},
	}, onChunk)
}
