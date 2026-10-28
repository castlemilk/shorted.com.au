package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"strings"
	"testing"

	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"google.golang.org/genai"
)

func captureLogEvent(t *testing.T, fn func()) map[string]any {
	t.Helper()

	var buf bytes.Buffer
	oldOutput := log.Writer()
	oldFlags := log.Flags()
	oldPrefix := log.Prefix()
	log.SetOutput(&buf)
	log.SetFlags(0)
	log.SetPrefix("")
	defer func() {
		log.SetOutput(oldOutput)
		log.SetFlags(oldFlags)
		log.SetPrefix(oldPrefix)
	}()

	fn()

	line := strings.TrimSpace(buf.String())
	if line == "" {
		t.Fatal("expected one structured log event, got empty output")
	}

	var event map[string]any
	if err := json.Unmarshal([]byte(line), &event); err != nil {
		t.Fatalf("log event is not JSON: %q: %v", line, err)
	}
	return event
}

func TestTokenUsageFromResponseHandlesNilMetadata(t *testing.T) {
	usage := genaiUsage(nil)
	if usage != (TokenUsage{}) {
		t.Fatalf("nil response usage = %+v, want zero value", usage)
	}

	usage = genaiUsage(&genai.GenerateContentResponse{})
	if usage != (TokenUsage{}) {
		t.Fatalf("nil metadata usage = %+v, want zero value", usage)
	}
}

func TestTokenUsageTracksBillablePromptTokens(t *testing.T) {
	usage := genaiUsage(&genai.GenerateContentResponse{
		UsageMetadata: &genai.GenerateContentResponseUsageMetadata{
			PromptTokenCount:        120,
			CachedContentTokenCount: 35,
			CandidatesTokenCount:    40,
			TotalTokenCount:         160,
		},
	})

	if usage.PromptTokens != 120 {
		t.Fatalf("PromptTokens = %d, want 120", usage.PromptTokens)
	}
	if usage.CachedPromptTokens != 35 {
		t.Fatalf("CachedPromptTokens = %d, want 35", usage.CachedPromptTokens)
	}
	if usage.CandidateTokens != 40 {
		t.Fatalf("CandidateTokens = %d, want 40", usage.CandidateTokens)
	}
	if usage.TotalTokens != 160 {
		t.Fatalf("TotalTokens = %d, want 160", usage.TotalTokens)
	}
	if usage.BillablePromptTokens() != 85 {
		t.Fatalf("BillablePromptTokens = %d, want 85", usage.BillablePromptTokens())
	}
}

func TestTokenUsageAddsMultipleModelCalls(t *testing.T) {
	var total TokenUsage
	total.Add(TokenUsage{PromptTokens: 100, CachedPromptTokens: 30, CandidateTokens: 25, TotalTokens: 125})
	total.Add(TokenUsage{PromptTokens: 60, CachedPromptTokens: 0, CandidateTokens: 20, TotalTokens: 80})

	if total.PromptTokens != 160 {
		t.Fatalf("PromptTokens = %d, want 160", total.PromptTokens)
	}
	if total.CachedPromptTokens != 30 {
		t.Fatalf("CachedPromptTokens = %d, want 30", total.CachedPromptTokens)
	}
	if total.CandidateTokens != 45 {
		t.Fatalf("CandidateTokens = %d, want 45", total.CandidateTokens)
	}
	if total.TotalTokens != 205 {
		t.Fatalf("TotalTokens = %d, want 205", total.TotalTokens)
	}
	if total.BillablePromptTokens() != 130 {
		t.Fatalf("BillablePromptTokens = %d, want 130", total.BillablePromptTokens())
	}
}

func TestRecordGeminiRequestLogsStructuredCostEvent(t *testing.T) {
	event := captureLogEvent(t, func() {
		recordModelRequest(context.Background(), "gemini", "gemini-2.5-flash", "initial", "success", TokenUsage{
			PromptTokens:       120,
			CachedPromptTokens: 35,
			CandidateTokens:    40,
			TotalTokens:        160,
		}, 0)
	})

	if event["type"] != "cost_event" {
		t.Fatalf("type = %v, want cost_event", event["type"])
	}
	if event["event_type"] != "gemini_request" {
		t.Fatalf("event_type = %v, want gemini_request", event["event_type"])
	}
	if event["feature"] != "chat" {
		t.Fatalf("feature = %v, want chat", event["feature"])
	}
	if event["billable_prompt_tokens"] != float64(85) {
		t.Fatalf("billable_prompt_tokens = %v, want 85", event["billable_prompt_tokens"])
	}
}

func TestRecordToolCallLogsStructuredCostEvent(t *testing.T) {
	event := captureLogEvent(t, func() {
		recordToolCall(context.Background(), "get_stock", 120, "success")
	})

	if event["type"] != "cost_event" {
		t.Fatalf("type = %v, want cost_event", event["type"])
	}
	if event["event_type"] != "chat_tool_call" {
		t.Fatalf("event_type = %v, want chat_tool_call", event["event_type"])
	}
	if event["tool_name"] != "get_stock" {
		t.Fatalf("tool_name = %v, want get_stock", event["tool_name"])
	}
	if event["result_bytes"] != float64(120) {
		t.Fatalf("result_bytes = %v, want 120", event["result_bytes"])
	}
}

func TestToolMetricsAggregateUnknownNamesBeforeExport(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	meter := provider.Meter("test")
	previousCalls, previousBytes := shortedotel.AIToolCallsTotal, shortedotel.AIToolResultBytes
	var err error
	shortedotel.AIToolCallsTotal, err = meter.Int64Counter("shorted.ai.tool_calls_total")
	if err != nil {
		t.Fatal(err)
	}
	shortedotel.AIToolResultBytes, err = meter.Int64Counter("shorted.ai.tool_result_bytes")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		shortedotel.AIToolCallsTotal, shortedotel.AIToolResultBytes = previousCalls, previousBytes
		_ = provider.Shutdown(context.Background())
	})

	const result = "fixture"
	wantCalls := map[string]int64{"unknown": 3}
	var names []string
	for _, definition := range GetToolDefinitions() {
		names = append(names, definition.Name)
		wantCalls[definition.Name] = 1
	}
	names = append(names, "invented_private_tool_1", "invented_private_tool_2", strings.Repeat("x", 400))
	for _, name := range names {
		var records []ToolCallRecord
		event := captureLogEvent(t, func() {
			records = recordToolRun(context.Background(), nil, name, nil, result, "error")
		})
		if event["tool_name"] != name || len(records) != 1 || records[0].Name != name {
			t.Fatalf("raw tool name must survive in logs and results: name=%q event=%v records=%v", name, event, records)
		}
	}

	var resourceMetrics metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &resourceMetrics); err != nil {
		t.Fatal(err)
	}
	seen := 0
	for _, scope := range resourceMetrics.ScopeMetrics {
		for _, metric := range scope.Metrics {
			multiplier := int64(1)
			if metric.Name == "shorted.ai.tool_result_bytes" {
				multiplier = int64(len(result))
			}
			sum, ok := metric.Data.(metricdata.Sum[int64])
			if !ok {
				t.Fatalf("%s is not a counter", metric.Name)
			}
			if len(sum.DataPoints) != len(wantCalls) {
				t.Errorf("%s exported %d series, want %d bounded tool names", metric.Name, len(sum.DataPoints), len(wantCalls))
			}
			for _, point := range sum.DataPoints {
				name, _ := point.Attributes.Value(attribute.Key("tool_name"))
				want, known := wantCalls[name.AsString()]
				if !known || point.Value != want*multiplier {
					t.Errorf("%s tool_name=%q value=%d, want bounded name with value %d", metric.Name, name.AsString(), point.Value, want*multiplier)
				}
			}
			seen++
		}
	}
	if seen != 2 {
		t.Fatalf("collected %d metrics, want tool calls and result bytes", seen)
	}
}

func TestRecordChatExperienceEventLogsStructuredProductEvent(t *testing.T) {
	event := captureLogEvent(t, func() {
		recordChatExperienceEvent("send_message", "error", "llm_error")
	})

	if event["type"] != "product_event" {
		t.Fatalf("type = %v, want product_event", event["type"])
	}
	if event["feature"] != "chat" {
		t.Fatalf("feature = %v, want chat", event["feature"])
	}
	if event["action"] != "send_message" {
		t.Fatalf("action = %v, want send_message", event["action"])
	}
	if event["status"] != "error" {
		t.Fatalf("status = %v, want error", event["status"])
	}
	if event["error_name"] != "llm_error" {
		t.Fatalf("error_name = %v, want llm_error", event["error_name"])
	}
}
