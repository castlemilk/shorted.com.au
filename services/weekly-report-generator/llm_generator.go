package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/sashabaranov/go-openai"
)

// NarrativeResult holds the LLM-generated narrative
type NarrativeResult struct {
	Headline   string    `json:"headline"`
	Summary    string    `json:"summary"`
	Narrative  Narrative `json:"narrative"`
	FAQs       []FAQ     `json:"faqs"`
	Model      string    `json:"model"`
	RetryCount int       `json:"retry_count"`
}

// Narrative holds the structured narrative sections
type Narrative struct {
	OpeningHook      string `json:"opening_hook"`
	TopAnalysis      string `json:"top_analysis"`
	MoversAnalysis   string `json:"movers_analysis"`
	IndustryAnalysis string `json:"industry_analysis"`
	Outlook          string `json:"outlook"`
}

// FAQ holds a question/answer pair
type FAQ struct {
	Question string `json:"question"`
	Answer   string `json:"answer"`
}

// LLMGenerator generates narrative using OpenAI GPT-4o
type LLMGenerator struct {
	client *openai.Client
	model  string
}

// NewLLMGenerator creates a new LLM generator
func NewLLMGenerator(apiKey string) *LLMGenerator {
	return &LLMGenerator{
		client: openai.NewClient(apiKey),
		model:  "gpt-4o",
	}
}

const systemPrompt = `You are a senior financial journalist covering the Australian stock market for Shorted.com.au.

Writing style:
- Authoritative and measured
- Australian English spelling (analyse, favourite, colour)
- Active voice
- Reference specific numbers from the data provided
- Keep sentences concise
- No hedging phrases

DO NOT use these phrases: "it's important to note", "landscape", "delve", "navigate",
"in the realm of", "interestingly", "notably", "it's worth noting", "significant",
"robust", "dynamic", "unprecedented", "cutting-edge"

Format requirements:
- Opening paragraph must hook with the week's most interesting data point
- Total narrative should be 300-500 words across all sections
- Each FAQ answer should be 1-2 sentences

Return ONLY valid JSON in this exact structure:
{
  "headline": "Concise headline under 80 chars",
  "summary": "2-3 sentence executive summary",
  "narrative": {
    "opening_hook": "Opening paragraph highlighting the most notable data point",
    "top_analysis": "Analysis of the top shorted stocks",
    "movers_analysis": "Analysis of biggest risers and fallers",
    "industry_analysis": "Brief sector-level observations",
    "outlook": "Forward-looking note (1-2 sentences)"
  },
  "faqs": [
    {"question": "Data-driven question", "answer": "Factual answer"}
  ]
}`

func (g *LLMGenerator) Generate(ctx context.Context, data *ReportData) (*NarrativeResult, error) {
	return g.generate(ctx, data, "")
}

func (g *LLMGenerator) GenerateWithFeedback(ctx context.Context, data *ReportData, feedback string) (*NarrativeResult, error) {
	return g.generate(ctx, data, feedback)
}

func (g *LLMGenerator) generate(ctx context.Context, data *ReportData, feedback string) (*NarrativeResult, error) {
	userPrompt := buildUserPrompt(data, feedback)

	callCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()

	temp := float32(0.2)
	resp, err := g.client.CreateChatCompletion(callCtx, openai.ChatCompletionRequest{
		Model:       g.model,
		Temperature: temp,
		Messages: []openai.ChatCompletionMessage{
			{Role: openai.ChatMessageRoleSystem, Content: systemPrompt},
			{Role: openai.ChatMessageRoleUser, Content: userPrompt},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("OpenAI API call failed: %w", err)
	}

	if len(resp.Choices) == 0 {
		return nil, fmt.Errorf("no response from OpenAI")
	}

	raw := resp.Choices[0].Message.Content
	raw = extractLikelyJSON(raw)

	var result NarrativeResult
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return nil, fmt.Errorf("failed to parse LLM response: %w\nraw: %s", err, raw)
	}

	result.Model = g.model
	return &result, nil
}

func buildUserPrompt(data *ReportData, feedback string) string {
	var sb strings.Builder

	sb.WriteString(fmt.Sprintf("<report_data>\nWeek: %s\nReport Date: %s\nPrevious Date: %s\n\n",
		data.WeekSlug, data.ReportDate, data.PreviousDate))

	sb.WriteString("TOP 10 MOST SHORTED STOCKS:\n")
	for _, s := range data.TopShorted {
		sb.WriteString(fmt.Sprintf("%d. %s (%s): %.2f%% short (WoW change: %+.2f%%)\n",
			s.Rank, s.Name, s.Code, s.ShortPct, s.WoWChange))
	}

	sb.WriteString("\nBIGGEST RISERS (increased short interest):\n")
	for _, m := range data.Risers {
		sb.WriteString(fmt.Sprintf("- %s (%s): %.2f%% → %.2f%% (change: %+.2f%%)\n",
			m.Name, m.Code, m.PreviousPct, m.CurrentPct, m.Change))
	}

	sb.WriteString("\nBIGGEST FALLERS (decreased short interest):\n")
	for _, m := range data.Fallers {
		sb.WriteString(fmt.Sprintf("- %s (%s): %.2f%% → %.2f%% (change: %+.2f%%)\n",
			m.Name, m.Code, m.PreviousPct, m.CurrentPct, m.Change))
	}

	sb.WriteString(fmt.Sprintf("\nMARKET STATISTICS:\n- Total stocks shorted: %d\n- Average short %%: %.2f%%\n- Max short %%: %.2f%% (%s)\n- WoW average change: %+.2f%%\n",
		data.MarketStats.TotalStocksShorted, data.MarketStats.AvgShortPct,
		data.MarketStats.MaxShortPct, data.MarketStats.MaxShortCode, data.MarketStats.WoWAvgChange))

	sb.WriteString("</report_data>\n")

	if feedback != "" {
		sb.WriteString(fmt.Sprintf("\n<quality_feedback>\n%s\n</quality_feedback>\n", feedback))
		sb.WriteString("\nPlease regenerate the report addressing the quality feedback above.\n")
	}

	sb.WriteString("\nGenerate a weekly short selling report based on the data above. Return ONLY valid JSON.")

	return sb.String()
}

// extractLikelyJSON strips markdown fences and extracts the JSON object
func extractLikelyJSON(raw string) string {
	raw = strings.TrimSpace(raw)

	// Strip markdown code fences
	if strings.HasPrefix(raw, "```json") {
		raw = strings.TrimPrefix(raw, "```json")
	}
	if strings.HasPrefix(raw, "```") {
		raw = strings.TrimPrefix(raw, "```")
	}
	if strings.HasSuffix(raw, "```") {
		raw = strings.TrimSuffix(raw, "```")
	}
	raw = strings.TrimSpace(raw)

	// Find first { and last }
	start := strings.Index(raw, "{")
	end := strings.LastIndex(raw, "}")
	if start >= 0 && end > start {
		raw = raw[start : end+1]
	}

	log.Printf("Extracted JSON length: %d bytes", len(raw))
	return raw
}
