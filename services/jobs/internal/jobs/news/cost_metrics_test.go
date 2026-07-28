package news

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"strings"
	"testing"

	"github.com/google/generative-ai-go/genai"
)

func captureNewsLogEvent(t *testing.T, fn func()) map[string]any {
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

func TestRecordNewsGeminiGenerationLogsStructuredCostEvent(t *testing.T) {
	event := captureNewsLogEvent(t, func() {
		recordNewsGeminiGeneration(context.Background(), "news_summary", "gemini-2.5-flash", "summarize", "success", &genai.UsageMetadata{
			PromptTokenCount:        120,
			CachedContentTokenCount: 20,
			CandidatesTokenCount:    30,
			TotalTokenCount:         150,
		})
	})

	if event["type"] != "cost_event" {
		t.Fatalf("type = %v, want cost_event", event["type"])
	}
	if event["event_type"] != "gemini_request" {
		t.Fatalf("event_type = %v, want gemini_request", event["event_type"])
	}
	if event["feature"] != "news_summary" {
		t.Fatalf("feature = %v, want news_summary", event["feature"])
	}
	if event["billable_prompt_tokens"] != float64(100) {
		t.Fatalf("billable_prompt_tokens = %v, want 100", event["billable_prompt_tokens"])
	}
}

func TestRecordNewsGeminiEmbeddingLogsStructuredCostEvent(t *testing.T) {
	event := captureNewsLogEvent(t, func() {
		recordNewsGeminiEmbedding(context.Background(), "news_embedding", "text-embedding-004", "embed_content", "success", 1234)
	})

	if event["type"] != "cost_event" {
		t.Fatalf("type = %v, want cost_event", event["type"])
	}
	if event["event_type"] != "gemini_embedding" {
		t.Fatalf("event_type = %v, want gemini_embedding", event["event_type"])
	}
	if event["input_chars"] != float64(1234) {
		t.Fatalf("input_chars = %v, want 1234", event["input_chars"])
	}
}
