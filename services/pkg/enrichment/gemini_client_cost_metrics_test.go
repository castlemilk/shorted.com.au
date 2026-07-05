package enrichment

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"strings"
	"testing"

	"github.com/google/generative-ai-go/genai"
)

func captureEnrichmentLogEvent(t *testing.T, fn func()) map[string]any {
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

func TestRecordEnrichmentGeminiGenerationLogsStructuredCostEvent(t *testing.T) {
	event := captureEnrichmentLogEvent(t, func() {
		recordEnrichmentGeminiGeneration(context.Background(), "gemini-2.5-flash", "company_profile", "success", &genai.UsageMetadata{
			PromptTokenCount:        200,
			CachedContentTokenCount: 75,
			CandidatesTokenCount:    60,
			TotalTokenCount:         260,
		})
	})

	if event["type"] != "cost_event" {
		t.Fatalf("type = %v, want cost_event", event["type"])
	}
	if event["event_type"] != "gemini_request" {
		t.Fatalf("event_type = %v, want gemini_request", event["event_type"])
	}
	if event["feature"] != "enrichment" {
		t.Fatalf("feature = %v, want enrichment", event["feature"])
	}
	if event["phase"] != "company_profile" {
		t.Fatalf("phase = %v, want company_profile", event["phase"])
	}
	if event["billable_prompt_tokens"] != float64(125) {
		t.Fatalf("billable_prompt_tokens = %v, want 125", event["billable_prompt_tokens"])
	}
}
