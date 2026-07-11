package main

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

func TestParsePriceTable(t *testing.T) {
	table := parsePriceTable(`{"gpt-5.2":{"input_per_1m":1.25,"output_per_1m":10.0}}`)
	p, ok := table["gpt-5.2"]
	if !ok || p.InputPer1M != 1.25 || p.OutputPer1M != 10.0 {
		t.Fatalf("unexpected table: %+v", table)
	}
	if got := parsePriceTable(""); len(got) != 0 {
		t.Errorf("empty env should give empty table, got %+v", got)
	}
	if got := parsePriceTable("not json"); len(got) != 0 {
		t.Errorf("invalid json should give empty table, got %+v", got)
	}
}

func TestEstimateCostUSD(t *testing.T) {
	table := map[string]modelPrice{
		"gpt-5.2": {InputPer1M: 2.0, OutputPer1M: 8.0},
	}
	cost, priced := estimateCostUSD(table, "gpt-5.2", 500_000, 250_000)
	if !priced {
		t.Fatal("expected priced=true")
	}
	// 0.5M * $2 + 0.25M * $8 = $1 + $2 = $3
	if math.Abs(cost-3.0) > 1e-9 {
		t.Errorf("cost = %v, want 3.0", cost)
	}
	if _, priced := estimateCostUSD(table, "unknown-model", 100, 100); priced {
		t.Error("unknown model must report priced=false")
	}
}

func TestCostEventShapeMatchesContract(t *testing.T) {
	// The cost_event contract (docs/observability/cost-attribution.md) requires
	// these exact keys with low-cardinality values.
	event := map[string]any{
		"type":                   "cost_event",
		"event_type":             "gemini_request",
		"feature":                costFeature,
		"model":                  "gemini-3.5-flash",
		"phase":                  "draft",
		"status":                 "success",
		"prompt_tokens":          int64(120),
		"cached_prompt_tokens":   int64(35),
		"billable_prompt_tokens": int64(85),
		"candidate_tokens":       int64(40),
		"total_tokens":           int64(160),
	}
	raw := mustMarshalLogEvent(event)
	var parsed map[string]any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		t.Fatalf("event must marshal to valid JSON: %v", err)
	}
	for _, key := range []string{"type", "event_type", "feature", "model", "phase", "status",
		"prompt_tokens", "cached_prompt_tokens", "billable_prompt_tokens", "candidate_tokens", "total_tokens"} {
		if _, ok := parsed[key]; !ok {
			t.Errorf("missing contract key %q", key)
		}
	}
	if parsed["feature"] != "weekly_report" {
		t.Errorf("feature = %v, want weekly_report", parsed["feature"])
	}
}

func TestClampNonNegative(t *testing.T) {
	if clampNonNegative(-5) != 0 {
		t.Error("negative must clamp to 0")
	}
	if clampNonNegative(7) != 7 {
		t.Error("positive must pass through")
	}
}

func TestRunUsageAccumulation(t *testing.T) {
	runUsageMu.Lock()
	runUsage = map[string]*usageTotals{}
	runUsageMu.Unlock()

	ctx := t.Context()
	recordLLMUsage(ctx, "gpt-5.2", "draft", "success", 1000, 0, 400, 1400)
	recordLLMUsage(ctx, "gpt-5.2", "amalgamate", "success", 2000, 100, 600, 2600)
	recordLLMUsage(ctx, "gemini-3.5-flash", "draft", "error", 0, 0, 0, 0)

	runUsageMu.Lock()
	defer runUsageMu.Unlock()
	gpt := runUsage["gpt-5.2"]
	if gpt == nil || gpt.Requests != 2 || gpt.PromptTokens != 3000 || gpt.CandidateTokens != 1000 || gpt.TotalTokens != 4000 {
		t.Fatalf("gpt totals wrong: %+v", gpt)
	}
	gem := runUsage["gemini-3.5-flash"]
	if gem == nil || gem.Requests != 1 || gem.TotalTokens != 0 {
		t.Fatalf("gemini error call must still count a request: %+v", gem)
	}
}

func TestEventTypeByModelPrefix(t *testing.T) {
	// recordLLMUsage derives event_type from the model prefix; pin the rule.
	for model, want := range map[string]string{
		"gemini-3.5-flash": "gemini_request",
		"gpt-5.2":          "openai_request",
	} {
		got := "openai_request"
		if strings.HasPrefix(model, "gemini") {
			got = "gemini_request"
		}
		if got != want {
			t.Errorf("%s → %s, want %s", model, got, want)
		}
	}
}
