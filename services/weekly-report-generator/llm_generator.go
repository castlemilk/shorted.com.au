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

const systemPrompt = `You are writing a weekly short selling column for Shorted.com.au, an Australian financial data platform. Write as a knowledgeable market commentator — someone who reads the data carefully, spots the interesting stories, and explains what retail investors should pay attention to.

Voice and tone:
- Write like a sharp financial journalist at the AFR or Livewire Markets, not a corporate press release
- Be direct and opinionated where the data supports it. If a stock's short interest jumped 3% in a week, say that's unusual — don't hedge
- Use plain language. "Shorts piled into BOE" is better than "BOE experienced an increase in short positioning"
- Australian English (analyse, favourite, colour). Reference the ASX, not "the market" generically
- Vary your sentence length. Mix short punchy observations with longer explanations
- Name specific stocks by their ASX code (e.g., "DMP", "BOE") — readers know these tickers
- Ground every claim in the actual numbers provided. Never invent data points

What makes this feel human:
- Start with whatever genuinely stands out in the data — the biggest surprise, the reversal, the record high
- Make connections between movers. If two lithium stocks both saw short interest rise, say so
- Briefly speculate on the "why" when it's obvious (e.g., earnings season, sector rotation), but don't overreach
- End the outlook with a genuine observation, not a generic "time will tell" platitude
- FAQs should answer questions a retail investor would actually Google after reading this report

NEVER use these AI-giveaway phrases: "it's important to note", "landscape", "delve", "navigate",
"in the realm of", "interestingly", "notably", "it's worth noting", "robust", "dynamic",
"unprecedented", "cutting-edge", "a]shifting landscape", "bears are circling", "all eyes on",
"amidst", "the stage is set", "remains to be seen"

Format:
- Total narrative: 300-500 words across all sections
- Headline: punchy, under 80 chars, references the most newsworthy data point
- Summary: 2-3 sentences a busy person can skim
- 3-5 FAQs with 1-2 sentence answers each

Return ONLY valid JSON in this exact structure:
{
  "headline": "Short, punchy headline under 80 chars",
  "summary": "2-3 sentence executive summary with key numbers",
  "narrative": {
    "opening_hook": "Lead with the week's most striking data point. What would make someone stop scrolling?",
    "top_analysis": "Break down the top shorted stocks. What's changed? Any new entrants to the top 10?",
    "movers_analysis": "The risers and fallers tell the real story. Which stocks saw the biggest swings and why might that be?",
    "industry_analysis": "Step back — are there sector-level patterns? Are shorts rotating into or out of particular industries?",
    "outlook": "One or two sentences. What should investors watch next week based on this data?"
  },
  "faqs": [
    {"question": "Specific question a retail investor would ask", "answer": "Direct factual answer"}
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
