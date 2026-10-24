package main

import (
	"context"
	"encoding/json"
	"log"

	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

func (u *TokenUsage) Add(other TokenUsage) {
	u.PromptTokens += other.PromptTokens
	u.CachedPromptTokens += other.CachedPromptTokens
	u.CandidateTokens += other.CandidateTokens
	u.ReasoningTokens += other.ReasoningTokens
	u.TotalTokens += other.TotalTokens
}

func (u TokenUsage) BillablePromptTokens() int64 {
	billable := u.PromptTokens - u.CachedPromptTokens
	if billable < 0 {
		return 0
	}
	return billable
}

func (u TokenUsage) hasTokens() bool {
	return u.PromptTokens != 0 ||
		u.CachedPromptTokens != 0 ||
		u.CandidateTokens != 0 ||
		u.ReasoningTokens != 0 ||
		u.TotalTokens != 0
}

// recordModelRequest counts one model call. A Gemini call keeps the
// gemini_request event that the cost queries read, with the same attributes.
func recordModelRequest(ctx context.Context, provider, model, phase, status string, usage TokenUsage) {
	attrs := []attribute.KeyValue{
		attribute.String("feature", "chat"),
		attribute.String("model", model),
		attribute.String("phase", phase),
		attribute.String("status", status),
	}

	if shortedotel.AIRequestsTotal != nil {
		shortedotel.AIRequestsTotal.Add(ctx, 1, otelmetric.WithAttributes(attrs...))
	}
	recordTokenCount(ctx, attrs, "prompt", usage.PromptTokens)
	recordTokenCount(ctx, attrs, "cached_prompt", usage.CachedPromptTokens)
	recordTokenCount(ctx, attrs, "billable_prompt", usage.BillablePromptTokens())
	recordTokenCount(ctx, attrs, "candidate", usage.CandidateTokens)
	recordTokenCount(ctx, attrs, "total", usage.TotalTokens)

	span := trace.SpanFromContext(ctx)
	span.SetAttributes(
		attribute.String("shorted.ai.feature", "chat"),
		attribute.String("shorted.ai.model", model),
		attribute.String("shorted.ai.phase", phase),
		attribute.String("shorted.ai.status", status),
		attribute.Int64("shorted.ai.prompt_tokens", usage.PromptTokens),
		attribute.Int64("shorted.ai.cached_prompt_tokens", usage.CachedPromptTokens),
		attribute.Int64("shorted.ai.billable_prompt_tokens", usage.BillablePromptTokens()),
		attribute.Int64("shorted.ai.candidate_tokens", usage.CandidateTokens),
		attribute.Int64("shorted.ai.total_tokens", usage.TotalTokens),
	)

	eventType := "llm_request"
	if provider == geminiProviderName {
		eventType = "gemini_request"
	}
	log.Printf(
		"%s",
		mustMarshalLogEvent(map[string]any{
			"type":                   "cost_event",
			"event_type":             eventType,
			"feature":                "chat",
			"model":                  model,
			"phase":                  phase,
			"status":                 status,
			"prompt_tokens":          usage.PromptTokens,
			"cached_prompt_tokens":   usage.CachedPromptTokens,
			"billable_prompt_tokens": usage.BillablePromptTokens(),
			"candidate_tokens":       usage.CandidateTokens,
			"total_tokens":           usage.TotalTokens,
		}),
	)
}

func recordTokenCount(ctx context.Context, baseAttrs []attribute.KeyValue, tokenType string, value int64) {
	if value <= 0 || shortedotel.AITokensTotal == nil {
		return
	}
	attrs := append([]attribute.KeyValue{}, baseAttrs...)
	attrs = append(attrs, attribute.String("token_type", tokenType))
	shortedotel.AITokensTotal.Add(ctx, value, otelmetric.WithAttributes(attrs...))
}

func recordToolCall(ctx context.Context, toolName string, resultBytes int, status string) {
	attrs := []attribute.KeyValue{
		attribute.String("feature", "chat"),
		attribute.String("tool_name", toolName),
		attribute.String("status", status),
	}
	if shortedotel.AIToolCallsTotal != nil {
		shortedotel.AIToolCallsTotal.Add(ctx, 1, otelmetric.WithAttributes(attrs...))
	}
	if resultBytes > 0 && shortedotel.AIToolResultBytes != nil {
		shortedotel.AIToolResultBytes.Add(ctx, int64(resultBytes), otelmetric.WithAttributes(attrs...))
	}
	log.Printf(
		"%s",
		mustMarshalLogEvent(map[string]any{
			"type":         "cost_event",
			"event_type":   "chat_tool_call",
			"feature":      "chat",
			"tool_name":    toolName,
			"status":       status,
			"result_bytes": resultBytes,
		}),
	)
}

func recordChatStorageWrite(ctx context.Context, role string) {
	if shortedotel.ChatStorageWrites == nil {
		return
	}
	shortedotel.ChatStorageWrites.Add(ctx, 1,
		otelmetric.WithAttributes(attribute.String("role", role)),
	)
}

func recordChatMessagesPruned(ctx context.Context, count int64) {
	if count <= 0 || shortedotel.ChatMessagesPruned == nil {
		return
	}
	shortedotel.ChatMessagesPruned.Add(ctx, count)
}

func recordChatExperienceEvent(action, status, errorName string) {
	event := map[string]any{
		"type":    "product_event",
		"feature": "chat",
		"action":  action,
		"status":  status,
	}
	if errorName != "" {
		event["error_name"] = errorName
	}

	log.Printf("%s", mustMarshalLogEvent(event))
}

func mustMarshalLogEvent(event map[string]any) string {
	data, err := json.Marshal(event)
	if err != nil {
		return `{"type":"instrumentation_error","error_name":"json_marshal_failed"}`
	}
	// Events carry error text, and that text can name a provider URL. Scrub the
	// encoded line, where an escaped ampersand is what the key pattern must match.
	return redactSecrets(string(data))
}
