package main

import (
	"context"
	"time"
)

// LLMClient is the chat model: one provider, one model and the turn engine that
// drives it. The service holds one of these and calls ChatStream per send.
type LLMClient struct {
	provider        ChatProvider
	engine          *TurnEngine
	model           string
	maxOutputTokens int32
	// forcedFirstCall and pricing describe the model. The facade is used by the
	// tests; newLLMClient assumes a forced model with no price.
	forcedFirstCall bool
	pricing         Pricing
}

// NewLLMClient creates the chat model client for the Gemini provider.
func NewLLMClient(ctx context.Context, apiKey, model string, maxOutputTokens int32, toolExecutor *ToolExecutor) (*LLMClient, error) {
	provider, err := newGeminiProvider(ctx, apiKey)
	if err != nil {
		return nil, err
	}
	return newLLMClient(provider, model, maxOutputTokens, toolExecutor), nil
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

// Close closes the provider's client.
func (lc *LLMClient) Close() {
	_ = lc.provider.Close()
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
