package news

import (
	"context"
	"encoding/json"
	"log"

	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"github.com/google/generative-ai-go/genai"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
)

func recordNewsGeminiGeneration(ctx context.Context, feature, model, phase, status string, usage *genai.UsageMetadata) {
	attrs := []attribute.KeyValue{
		attribute.String("feature", feature),
		attribute.String("model", model),
		attribute.String("phase", phase),
		attribute.String("status", status),
	}
	if shortedotel.AIRequestsTotal != nil {
		shortedotel.AIRequestsTotal.Add(ctx, 1, otelmetric.WithAttributes(attrs...))
	}
	if usage != nil {
		recordNewsTokenCount(ctx, attrs, "prompt", int64(usage.PromptTokenCount))
		recordNewsTokenCount(ctx, attrs, "cached_prompt", int64(usage.CachedContentTokenCount))
		recordNewsTokenCount(ctx, attrs, "billable_prompt", billableNewsPromptTokens(usage))
		recordNewsTokenCount(ctx, attrs, "candidate", int64(usage.CandidatesTokenCount))
		recordNewsTokenCount(ctx, attrs, "total", int64(usage.TotalTokenCount))
	}

	promptTokens, cachedTokens, candidateTokens, totalTokens := int32(0), int32(0), int32(0), int32(0)
	billablePromptTokens := int64(0)
	if usage != nil {
		promptTokens = usage.PromptTokenCount
		cachedTokens = usage.CachedContentTokenCount
		candidateTokens = usage.CandidatesTokenCount
		totalTokens = usage.TotalTokenCount
		billablePromptTokens = billableNewsPromptTokens(usage)
	}
	log.Printf(
		"%s",
		mustMarshalNewsLogEvent(map[string]any{
			"type":                   "cost_event",
			"event_type":             "gemini_request",
			"feature":                feature,
			"model":                  model,
			"phase":                  phase,
			"status":                 status,
			"prompt_tokens":          promptTokens,
			"cached_prompt_tokens":   cachedTokens,
			"billable_prompt_tokens": billablePromptTokens,
			"candidate_tokens":       candidateTokens,
			"total_tokens":           totalTokens,
		}),
	)
}

func recordNewsGeminiEmbedding(ctx context.Context, feature, model, phase, status string, inputChars int) {
	attrs := []attribute.KeyValue{
		attribute.String("feature", feature),
		attribute.String("model", model),
		attribute.String("phase", phase),
		attribute.String("status", status),
	}
	if shortedotel.AIRequestsTotal != nil {
		shortedotel.AIRequestsTotal.Add(ctx, 1, otelmetric.WithAttributes(attrs...))
	}
	if inputChars > 0 && shortedotel.AIInputCharsTotal != nil {
		shortedotel.AIInputCharsTotal.Add(ctx, int64(inputChars), otelmetric.WithAttributes(attrs...))
	}
	log.Printf(
		"%s",
		mustMarshalNewsLogEvent(map[string]any{
			"type":        "cost_event",
			"event_type":  "gemini_embedding",
			"feature":     feature,
			"model":       model,
			"phase":       phase,
			"status":      status,
			"input_chars": inputChars,
		}),
	)
}

func recordNewsTokenCount(ctx context.Context, baseAttrs []attribute.KeyValue, tokenType string, value int64) {
	if value <= 0 || shortedotel.AITokensTotal == nil {
		return
	}
	attrs := append([]attribute.KeyValue{}, baseAttrs...)
	attrs = append(attrs, attribute.String("token_type", tokenType))
	shortedotel.AITokensTotal.Add(ctx, value, otelmetric.WithAttributes(attrs...))
}

func billableNewsPromptTokens(usage *genai.UsageMetadata) int64 {
	if usage == nil {
		return 0
	}
	billable := int64(usage.PromptTokenCount - usage.CachedContentTokenCount)
	if billable < 0 {
		return 0
	}
	return billable
}

func mustMarshalNewsLogEvent(event map[string]any) string {
	data, err := json.Marshal(event)
	if err != nil {
		return `{"type":"instrumentation_error","error_name":"json_marshal_failed"}`
	}
	return string(data)
}
