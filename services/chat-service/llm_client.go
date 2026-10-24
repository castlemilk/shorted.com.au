package main

import (
	"context"
)

// LLMClient is the chat model: one provider, one model and the turn engine that
// drives it. The service holds one of these and calls ChatStream per send.
type LLMClient struct {
	provider        ChatProvider
	engine          *TurnEngine
	model           string
	maxOutputTokens int32
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
	}
}

// Close closes the provider's client.
func (lc *LLMClient) Close() {
	_ = lc.provider.Close()
}

// ChatStream sends a message and streams text chunks via the onChunk callback.
// Tool call rounds execute synchronously between streaming segments.
func (lc *LLMClient) ChatStream(ctx context.Context, systemPrompt string, history []Message, userMessage string, onChunk func(text string)) (*LLMResponse, error) {
	session, err := lc.provider.NewSession(SessionConfig{
		Model:           lc.model,
		System:          systemPrompt,
		History:         history,
		Tools:           chatToolDefinitions(),
		MaxOutputTokens: lc.maxOutputTokens,
	})
	if err != nil {
		return nil, providerError("start session", err)
	}
	return lc.engine.run(ctx, session, turnMeta{Provider: lc.provider.Name(), Model: lc.model}, userMessage, onChunk)
}
