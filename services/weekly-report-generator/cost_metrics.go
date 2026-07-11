package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"strings"
	"sync"

	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
)

// Cost/usage instrumentation for LLM calls, following the shared cost_event
// contract in docs/observability/cost-attribution.md (same shape as
// news-aggregator/cost_metrics.go and chat-service/cost_metrics.go):
// one cost_event JSON log line + OTel counters per request, with the
// low-cardinality attrs {feature, model, phase, status}. Do not add slugs,
// stock codes, or other high-cardinality fields to these events.

const costFeature = "weekly_report"

// modelPrice holds per-1M-token USD rates for a model.
type modelPrice struct {
	InputPer1M  float64 `json:"input_per_1m"`
	OutputPer1M float64 `json:"output_per_1m"`
}

// defaultPriceTable holds published list rates per 1M tokens, current as of
// July 2026 (OpenAI + Gemini API pricing pages). Cost estimates are
// indicative — update these when provider pricing changes, or override
// per-deployment with LLM_PRICE_TABLE_JSON.
var defaultPriceTable = map[string]modelPrice{
	"gpt-5.2":          {InputPer1M: 1.75, OutputPer1M: 14.00},
	"gemini-3.5-flash": {InputPer1M: 1.50, OutputPer1M: 9.00},
}

// priceTable maps model → rates: defaults above, merged with (and overridden
// by) the LLM_PRICE_TABLE_JSON env var, e.g.
// {"gpt-5.2":{"input_per_1m":1.75,"output_per_1m":14.0}}.
var (
	priceTableOnce sync.Once
	priceTable     map[string]modelPrice
)

func loadPriceTable() map[string]modelPrice {
	priceTableOnce.Do(func() {
		priceTable = map[string]modelPrice{}
		for model, p := range defaultPriceTable {
			priceTable[model] = p
		}
		for model, p := range parsePriceTable(os.Getenv("LLM_PRICE_TABLE_JSON")) {
			priceTable[model] = p
		}
	})
	return priceTable
}

func parsePriceTable(raw string) map[string]modelPrice {
	table := map[string]modelPrice{}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return table
	}
	if err := json.Unmarshal([]byte(raw), &table); err != nil {
		log.Printf("WARNING: invalid LLM_PRICE_TABLE_JSON (%v) — cost estimates disabled", err)
		return map[string]modelPrice{}
	}
	return table
}

// estimateCostUSD returns the estimated cost for a call and whether the model
// had configured rates. Cached prompt tokens are billed at the input rate —
// provider cache discounts vary, so this is a deliberate upper bound.
func estimateCostUSD(table map[string]modelPrice, model string, promptTokens, candidateTokens int64) (float64, bool) {
	p, ok := table[model]
	if !ok {
		return 0, false
	}
	return float64(promptTokens)/1_000_000*p.InputPer1M +
		float64(candidateTokens)/1_000_000*p.OutputPer1M, true
}

// usageTotals accumulates per-model usage across one generator run.
type usageTotals struct {
	Requests        int64
	PromptTokens    int64
	CandidateTokens int64
	TotalTokens     int64
	CostUSD         float64
	Priced          bool
}

var (
	runUsageMu sync.Mutex
	runUsage   = map[string]*usageTotals{}
)

// recordLLMUsage emits one cost_event log + OTel counters for a single LLM
// call and accumulates run totals. Zero-token error calls are still counted
// as requests. cachedPromptTokens may be 0 when the provider doesn't report it.
func recordLLMUsage(ctx context.Context, model, phase, status string, promptTokens, cachedPromptTokens, candidateTokens, totalTokens int64) {
	attrs := []attribute.KeyValue{
		attribute.String("feature", costFeature),
		attribute.String("model", model),
		attribute.String("phase", phase),
		attribute.String("status", status),
	}
	if shortedotel.AIRequestsTotal != nil {
		shortedotel.AIRequestsTotal.Add(ctx, 1, otelmetric.WithAttributes(attrs...))
	}
	recordTokenCount(ctx, attrs, "prompt", promptTokens)
	recordTokenCount(ctx, attrs, "cached_prompt", cachedPromptTokens)
	recordTokenCount(ctx, attrs, "billable_prompt", clampNonNegative(promptTokens-cachedPromptTokens))
	recordTokenCount(ctx, attrs, "candidate", candidateTokens)
	recordTokenCount(ctx, attrs, "total", totalTokens)

	eventType := "openai_request"
	if strings.HasPrefix(model, "gemini") {
		eventType = "gemini_request"
	}
	event := map[string]any{
		"type":                   "cost_event",
		"event_type":             eventType,
		"feature":                costFeature,
		"model":                  model,
		"phase":                  phase,
		"status":                 status,
		"prompt_tokens":          promptTokens,
		"cached_prompt_tokens":   cachedPromptTokens,
		"billable_prompt_tokens": clampNonNegative(promptTokens - cachedPromptTokens),
		"candidate_tokens":       candidateTokens,
		"total_tokens":           totalTokens,
	}
	cost, priced := estimateCostUSD(loadPriceTable(), model, promptTokens, candidateTokens)
	if priced {
		event["estimated_cost_usd"] = cost
	}
	log.Printf("%s", mustMarshalLogEvent(event))

	runUsageMu.Lock()
	defer runUsageMu.Unlock()
	t, ok := runUsage[model]
	if !ok {
		t = &usageTotals{Priced: priced}
		runUsage[model] = t
	}
	t.Requests++
	t.PromptTokens += promptTokens
	t.CandidateTokens += candidateTokens
	t.TotalTokens += totalTokens
	t.CostUSD += cost
	t.Priced = t.Priced && priced
}

// logRunUsageSummary prints per-model usage/cost totals for the whole run.
// This is an operator-facing log line, not a cost_event (the per-request
// events are the queryable source of truth).
func logRunUsageSummary(slug string) {
	runUsageMu.Lock()
	defer runUsageMu.Unlock()
	if len(runUsage) == 0 {
		return
	}
	var totalTokens int64
	var totalCost float64
	allPriced := true
	for model, t := range runUsage {
		costStr := "unpriced (set LLM_PRICE_TABLE_JSON)"
		if t.Priced {
			costStr = "$" + trimFloat(t.CostUSD)
		} else {
			allPriced = false
		}
		log.Printf("LLM usage [%s] %s: %d requests, %d prompt + %d candidate = %d tokens, est. %s",
			slug, model, t.Requests, t.PromptTokens, t.CandidateTokens, t.TotalTokens, costStr)
		totalTokens += t.TotalTokens
		totalCost += t.CostUSD
	}
	if allPriced {
		log.Printf("LLM usage [%s] TOTAL: %d tokens, est. $%s", slug, totalTokens, trimFloat(totalCost))
	} else {
		log.Printf("LLM usage [%s] TOTAL: %d tokens (cost estimate incomplete — unpriced models)", slug, totalTokens)
	}
}

func recordTokenCount(ctx context.Context, baseAttrs []attribute.KeyValue, tokenType string, value int64) {
	if value <= 0 || shortedotel.AITokensTotal == nil {
		return
	}
	attrs := append([]attribute.KeyValue{}, baseAttrs...)
	attrs = append(attrs, attribute.String("token_type", tokenType))
	shortedotel.AITokensTotal.Add(ctx, value, otelmetric.WithAttributes(attrs...))
}

func clampNonNegative(v int64) int64 {
	if v < 0 {
		return 0
	}
	return v
}

func trimFloat(v float64) string {
	b, _ := json.Marshal(float64(int(v*10000+0.5)) / 10000)
	return string(b)
}

func mustMarshalLogEvent(event map[string]any) string {
	data, err := json.Marshal(event)
	if err != nil {
		return `{"type":"instrumentation_error","error_name":"json_marshal_failed"}`
	}
	return string(data)
}
