package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/google/generative-ai-go/genai"
	"github.com/sashabaranov/go-openai"
	"google.golang.org/api/option"
)

// Citation represents an inline reference to a data source
type Citation struct {
	ID     string `json:"id"`     // "ref-1"
	Source string `json:"source"` // "BHP H1 FY2025 Results"
	Date   string `json:"date,omitempty"`
	URL    string `json:"url,omitempty"`
	Type   string `json:"type"` // "financial_report", "announcement", "asic_data", "price_data"
}

// NarrativeResult holds the LLM-generated narrative
type NarrativeResult struct {
	Headline   string     `json:"headline"`
	Summary    string     `json:"summary"`
	Narrative  Narrative  `json:"narrative"`
	FAQs       []FAQ      `json:"faqs"`
	Citations  []Citation `json:"citations,omitempty"`
	Model      string     `json:"model"`
	RetryCount int        `json:"retry_count"`
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

// LLMGenerator generates narrative using a two-pass GPT-5.2 + Gemini 3 Pro pipeline
type LLMGenerator struct {
	openaiClient *openai.Client
	geminiKey    string
	openaiModel  string
	geminiModel  string
}

// NewLLMGenerator creates a new multi-model LLM generator
func NewLLMGenerator(openaiKey, geminiKey string) *LLMGenerator {
	return &LLMGenerator{
		openaiClient: openai.NewClient(openaiKey),
		geminiKey:    geminiKey,
		openaiModel:  "gpt-5.2",
		geminiModel:  "gemini-3.5-flash",
	}
}

// The system prompts (analyticalSystemPrompt, geminiNarrativePrompt,
// amalgamationSystemPrompt) are composed in prompts.go.

func (g *LLMGenerator) Generate(ctx context.Context, data *ReportData) (*NarrativeResult, error) {
	return g.generateMultiPass(ctx, data, "")
}

func (g *LLMGenerator) GenerateWithFeedback(ctx context.Context, data *ReportData, feedback string) (*NarrativeResult, error) {
	return g.generateMultiPass(ctx, data, feedback)
}

// generateMultiPass runs the two-pass pipeline: GPT-5.2 + Gemini 3 Pro → GPT-5.2 amalgamation
func (g *LLMGenerator) generateMultiPass(ctx context.Context, data *ReportData, feedback string) (*NarrativeResult, error) {
	userPrompt := buildUserPrompt(data, feedback)

	// Pass 1a: GPT-5.2 analytical narrative
	log.Println("  Pass 1a: GPT-5.2 analytical narrative...")
	gptNarrative, err := g.gptGenerate(ctx, analyticalSystemPrompt, userPrompt)
	if err != nil {
		return nil, fmt.Errorf("GPT-5.2 pass 1 failed: %w", err)
	}
	log.Printf("  GPT-5.2 headline: %s", gptNarrative.Headline)

	// Pass 1b: Gemini 3 Pro independent narrative
	var geminiNarrative *NarrativeResult
	if g.geminiKey != "" {
		log.Println("  Pass 1b: Gemini 3 Pro narrative...")
		geminiNarrative, err = g.geminiGenerate(ctx, geminiNarrativePrompt, userPrompt)
		if err != nil {
			log.Printf("  WARNING: Gemini 3 Pro narrative failed: %v (continuing with GPT-5.2 only)", err)
		} else {
			log.Printf("  Gemini 3 headline: %s", geminiNarrative.Headline)
		}
	}

	// Pass 2: GPT-5.2 amalgamation with creative writing emphasis
	if geminiNarrative != nil {
		log.Println("  Pass 2: GPT-5.2 creative amalgamation...")
		amalgamated, err := g.amalgamate(ctx, data, gptNarrative, geminiNarrative, feedback)
		if err != nil {
			log.Printf("  WARNING: Amalgamation failed: %v (using GPT-5.2 pass 1 output)", err)
		} else {
			amalgamated.Model = fmt.Sprintf("%s+%s+%s-amalgamated", g.openaiModel, g.geminiModel, g.openaiModel)
			return amalgamated, nil
		}
	}

	// Fallback: return GPT-5.2 pass 1 if Gemini or amalgamation failed
	gptNarrative.Model = g.openaiModel
	return gptNarrative, nil
}

// narrativeResponseFormat is the strict structured-outputs format for
// NarrativeResult. Used first; callers fall back to json_object if the
// schema-constrained call errors.
func narrativeResponseFormat() *openai.ChatCompletionResponseFormat {
	return &openai.ChatCompletionResponseFormat{
		Type: openai.ChatCompletionResponseFormatTypeJSONSchema,
		JSONSchema: &openai.ChatCompletionResponseFormatJSONSchema{
			Name:   "narrative_result",
			Strict: true,
			Schema: json.RawMessage(narrativeResultJSONSchema),
		},
	}
}

// gptGenerate calls GPT-5.2 with a system prompt and user prompt.
// It requests structured outputs (json_schema); if that call errors it falls
// back to json_object mode, and extractLikelyJSON remains the final safety net.
func (g *LLMGenerator) gptGenerate(ctx context.Context, systemPrompt, userPrompt string) (*NarrativeResult, error) {
	return g.gptChatJSON(ctx, systemPrompt, userPrompt, 0.2, "draft")
}

// gptChatJSON runs a chat completion expecting a NarrativeResult JSON payload,
// with json_schema → json_object fallback. phase labels the cost_event
// ("draft", "amalgamate").
func (g *LLMGenerator) gptChatJSON(ctx context.Context, systemPrompt, userPrompt string, temperature float32, phase string) (*NarrativeResult, error) {
	callCtx, cancel := context.WithTimeout(ctx, 6*time.Minute)
	defer cancel()

	req := openai.ChatCompletionRequest{
		Model:       g.openaiModel,
		Temperature: temperature,
		Messages: []openai.ChatCompletionMessage{
			{Role: openai.ChatMessageRoleSystem, Content: systemPrompt},
			{Role: openai.ChatMessageRoleUser, Content: userPrompt},
		},
		ResponseFormat: narrativeResponseFormat(),
	}

	resp, err := g.openaiClient.CreateChatCompletion(callCtx, req)
	if err != nil {
		// Fall back to plain JSON mode if the schema-constrained call errors
		// (e.g., model/endpoint doesn't support json_schema).
		log.Printf("  WARNING: structured-output call failed (%v), falling back to json_object", err)
		req.ResponseFormat = &openai.ChatCompletionResponseFormat{
			Type: openai.ChatCompletionResponseFormatTypeJSONObject,
		}
		resp, err = g.openaiClient.CreateChatCompletion(callCtx, req)
		if err != nil {
			recordLLMUsage(ctx, g.openaiModel, phase, "error", 0, 0, 0, 0)
			return nil, fmt.Errorf("OpenAI API call failed: %w", err)
		}
	}

	var cachedPromptTokens int64
	if resp.Usage.PromptTokensDetails != nil {
		cachedPromptTokens = int64(resp.Usage.PromptTokensDetails.CachedTokens)
	}
	recordLLMUsage(ctx, g.openaiModel, phase, "success",
		int64(resp.Usage.PromptTokens), cachedPromptTokens,
		int64(resp.Usage.CompletionTokens), int64(resp.Usage.TotalTokens))

	if len(resp.Choices) == 0 {
		return nil, fmt.Errorf("no response from OpenAI")
	}

	raw := resp.Choices[0].Message.Content
	raw = extractLikelyJSON(raw)

	var result NarrativeResult
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return nil, fmt.Errorf("failed to parse GPT response: %w\nraw: %s", err, raw)
	}

	return &result, nil
}

// geminiGenerate calls Gemini 3 Pro with a system prompt and user prompt
func (g *LLMGenerator) geminiGenerate(ctx context.Context, systemPrompt, userPrompt string) (*NarrativeResult, error) {
	client, err := genai.NewClient(ctx, option.WithAPIKey(g.geminiKey))
	if err != nil {
		return nil, fmt.Errorf("failed to create Gemini client: %w", err)
	}
	defer func() { _ = client.Close() }()

	model := client.GenerativeModel(g.geminiModel)
	model.SetTemperature(0.3)
	// Force JSON output at the API level; extractLikelyJSON remains the final safety net.
	model.ResponseMIMEType = "application/json"
	model.SystemInstruction = &genai.Content{
		Parts: []genai.Part{genai.Text(systemPrompt)},
	}

	callCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()

	resp, err := model.GenerateContent(callCtx, genai.Text(userPrompt))
	if err != nil {
		recordLLMUsage(ctx, g.geminiModel, "draft", "error", 0, 0, 0, 0)
		return nil, fmt.Errorf("gemini API call failed: %w", err)
	}
	if resp.UsageMetadata != nil {
		recordLLMUsage(ctx, g.geminiModel, "draft", "success",
			int64(resp.UsageMetadata.PromptTokenCount),
			int64(resp.UsageMetadata.CachedContentTokenCount),
			int64(resp.UsageMetadata.CandidatesTokenCount),
			int64(resp.UsageMetadata.TotalTokenCount))
	}

	if len(resp.Candidates) == 0 {
		return nil, fmt.Errorf("no response from Gemini")
	}

	var raw string
	for _, part := range resp.Candidates[0].Content.Parts {
		if text, ok := part.(genai.Text); ok {
			raw += string(text)
		}
	}

	raw = extractLikelyJSON(raw)

	var result NarrativeResult
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return nil, fmt.Errorf("failed to parse Gemini response: %w\nraw: %s", err, raw)
	}

	return &result, nil
}

// amalgamate merges GPT-5.2 and Gemini 3 Pro outputs with creative writing emphasis
func (g *LLMGenerator) amalgamate(ctx context.Context, data *ReportData, gpt, gemini *NarrativeResult, feedback string) (*NarrativeResult, error) {
	gptJSON, _ := json.MarshalIndent(gpt, "", "  ")
	geminiJSON, _ := json.MarshalIndent(gemini, "", "  ")

	var sb strings.Builder
	sb.WriteString("<source_data>\n")
	sb.WriteString(buildUserPrompt(data, ""))
	sb.WriteString("</source_data>\n\n")

	sb.WriteString("<draft_1_gpt>\n")
	sb.WriteString(string(gptJSON))
	sb.WriteString("\n</draft_1_gpt>\n\n")

	sb.WriteString("<draft_2_gemini>\n")
	sb.WriteString(string(geminiJSON))
	sb.WriteString("\n</draft_2_gemini>\n\n")

	if feedback != "" {
		fmt.Fprintf(&sb, "<editorial_feedback>\n%s\n</editorial_feedback>\n\n", feedback)
	}

	sb.WriteString("Merge these two drafts into a single, polished weekly short selling report. Take the best from each. Return ONLY valid JSON.")

	// Slightly higher temperature for the creative-writing pass.
	result, err := g.gptChatJSON(ctx, amalgamationSystemPrompt, sb.String(), 0.4, "amalgamate")
	if err != nil {
		return nil, fmt.Errorf("OpenAI amalgamation call failed: %w", err)
	}
	return result, nil
}

func buildUserPrompt(data *ReportData, feedback string) string {
	var sb strings.Builder

	fmt.Fprintf(&sb, "<report_data>\nWeek: %s\nReport Date: %s\nPrevious Date: %s\n\n",
		data.WeekSlug, data.ReportDate, data.PreviousDate)

	sb.WriteString("TOP 10 MOST SHORTED STOCKS:\n")
	for _, s := range data.TopShorted {
		fmt.Fprintf(&sb, "%d. %s (%s): %.2f%% short (WoW change: %+.2f%%)",
			s.Rank, s.Name, s.Code, s.ShortPct, s.WoWChange)
		if s.Industry != "" {
			fmt.Fprintf(&sb, " | industry: %s", s.Industry)
		}
		if s.DaysToCover > 0 {
			fmt.Fprintf(&sb, " | days-to-cover: %.1f", s.DaysToCover)
		}
		if s.IsNewEntrant {
			sb.WriteString(" | NEW TO TOP 10")
		}
		if len(s.History) > 1 {
			fmt.Fprintf(&sb, " | 13w history: %s", formatHistorySeries(s.History))
		}
		sb.WriteString("\n")
	}

	sb.WriteString("\nBIGGEST RISERS (increased short interest, ranked by significance):\n")
	for _, m := range data.Risers {
		writeMoverLine(&sb, m)
	}

	sb.WriteString("\nBIGGEST FALLERS (decreased short interest, ranked by significance):\n")
	for _, m := range data.Fallers {
		writeMoverLine(&sb, m)
	}

	fmt.Fprintf(&sb, "\nMARKET STATISTICS:\n- Total stocks shorted: %d\n- Average short %%: %.2f%%\n- Median short %%: %.2f%%\n- Max short %%: %.2f%% (%s)\n- WoW average change: %+.2f%%\n- Stocks above 10%% short: %d\n- Stocks above 5%% short: %d\n- Market breadth: %d risers vs %d fallers (moves >0.01pp)\n",
		data.MarketStats.TotalStocksShorted, data.MarketStats.AvgShortPct,
		data.MarketStats.MedianShortPct,
		data.MarketStats.MaxShortPct, data.MarketStats.MaxShortCode, data.MarketStats.WoWAvgChange,
		data.MarketStats.StocksAbove10Pct, data.MarketStats.StocksAbove5Pct,
		data.MarketStats.RiserCount, data.MarketStats.FallerCount)

	// Industry breakdown — the ONLY valid grounding for industry_analysis
	if len(data.IndustryBreakdown) > 0 {
		sb.WriteString("\nINDUSTRY BREAKDOWN (aggregate short interest by industry — the ONLY valid basis for industry_analysis):\n")
		for _, ind := range data.IndustryBreakdown {
			fmt.Fprintf(&sb, "- %s: avg %.2f%% short (WoW %+.2f%%), %d stocks, most shorted: %s at %.2f%%\n",
				ind.Industry, ind.AvgShortPct, ind.WoWChange, ind.StockCount, ind.TopStockCode, ind.TopStockPct)
		}
	}

	// Include company context
	if len(data.CompanyContext) > 0 {
		sb.WriteString("\nCOMPANY CONTEXT (use to add depth to your analysis):\n")
		for code, meta := range data.CompanyContext {
			fmt.Fprintf(&sb, "\n%s — %s (market cap: $%dM)\n", code, meta.Industry, meta.MarketCap/1_000_000)
			if meta.EnhancedSummary != "" {
				summary := meta.EnhancedSummary
				if len(summary) > 200 {
					summary = summary[:200] + "..."
				}
				fmt.Fprintf(&sb, "  Summary: %s\n", summary)
			}
			if meta.RecentDevelopments != "" {
				fmt.Fprintf(&sb, "  Recent: %s\n", meta.RecentDevelopments)
			}
			if meta.RiskFactors != "" {
				risks := meta.RiskFactors
				if len(risks) > 150 {
					risks = risks[:150] + "..."
				}
				fmt.Fprintf(&sb, "  Risks: %s\n", risks)
			}
			if meta.ParsedMetrics != nil {
				var parts []string
				if meta.ParsedMetrics.PERatio != nil {
					parts = append(parts, fmt.Sprintf("P/E: %.1f", *meta.ParsedMetrics.PERatio))
				}
				if meta.ParsedMetrics.EPS != nil {
					parts = append(parts, fmt.Sprintf("EPS: $%.2f", *meta.ParsedMetrics.EPS))
				}
				if meta.ParsedMetrics.DividendYield != nil {
					parts = append(parts, fmt.Sprintf("Div Yield: %.1f%%", *meta.ParsedMetrics.DividendYield))
				}
				if meta.ParsedMetrics.Beta != nil {
					parts = append(parts, fmt.Sprintf("Beta: %.2f", *meta.ParsedMetrics.Beta))
				}
				if len(parts) > 0 {
					fmt.Fprintf(&sb, "  Metrics: %s\n", strings.Join(parts, ", "))
				}
			}
		}
	}

	// Include financial report references
	if len(data.FinancialRefs) > 0 {
		sb.WriteString("\nCOMPANY FINANCIAL REPORTS (cite relevant reports with their URLs in your analysis):\n")
		for code, reports := range data.FinancialRefs {
			for _, r := range reports {
				fmt.Fprintf(&sb, "- %s: \"%s\" (%s)", code, r.Title, r.Date)
				if r.URL != "" {
					fmt.Fprintf(&sb, " [%s]", r.URL)
				}
				sb.WriteString("\n")
			}
		}
	}

	// Include extracted financial highlights (actual numbers from reports)
	if len(data.FinancialHighlights) > 0 {
		sb.WriteString("\nEXTRACTED FINANCIAL DATA (use these actual figures to explain WHY shorts are positioning):\n")
		for code, highlights := range data.FinancialHighlights {
			for _, h := range highlights {
				fmt.Fprintf(&sb, "\n%s — %s (%s, %s):\n", code, h.ReportTitle, h.ReportType, h.ReportDate)
				for metricName, entries := range h.Metrics {
					for _, attrs := range entries {
						sb.WriteString("  ")
						sb.WriteString(metricName)
						sb.WriteString(": ")
						parts := make([]string, 0, len(attrs))
						for k, v := range attrs {
							parts = append(parts, fmt.Sprintf("%s=%s", k, v))
						}
						sb.WriteString(strings.Join(parts, ", "))
						sb.WriteString("\n")
					}
				}
			}
		}
	}

	// Include stock price data
	if len(data.PriceContext) > 0 {
		sb.WriteString("\nSTOCK PRICE DATA (correlate short interest changes with price movements — rising stock + increasing shorts tells a different story than falling stock + increasing shorts):\n")
		for code, p := range data.PriceContext {
			if p.CurrentPrice > 0 {
				// 2dp to match the quality checker's exact-value validation —
				// the model copies what it sees, so 1dp here guarantees
				// "unverified percentage" flags on every price citation.
				fmt.Fprintf(&sb, "%s — $%.2f (week: %+.2f%%, month: %+.2f%%)", code, p.CurrentPrice, p.WeeklyChangePct, p.MonthlyChangePct)
				if p.WeekHigh > 0 {
					fmt.Fprintf(&sb, ", Range: $%.2f-$%.2f", p.WeekLow, p.WeekHigh)
				}
				if p.AvgVolume > 0 {
					fmt.Fprintf(&sb, ", Vol: %.1fM", float64(p.AvgVolume)/1_000_000)
				}
				sb.WriteString("\n")
			}
		}
	}

	// Include recent ASX announcements
	if len(data.Announcements) > 0 {
		sb.WriteString("\nRECENT ASX ANNOUNCEMENTS (explain WHY shorts may be changing):\n")
		for code, anns := range data.Announcements {
			fmt.Fprintf(&sb, "%s:\n", code)
			for _, a := range anns {
				sens := ""
				if a.IsPriceSensitive {
					sens = " *"
				}
				fmt.Fprintf(&sb, "  - [%s]%s %s (%s)\n", a.Date, sens, a.Headline, a.Type)
			}
		}
	}

	// Include trend insights for movers
	if len(data.TrendInsights) > 0 {
		sb.WriteString("\nTREND INSIGHTS (use these structured signals to explain WHY short interest changed — cite the pattern, announcements, and financial data in your analysis):\n")
		for code, ti := range data.TrendInsights {
			fmt.Fprintf(&sb, "\n%s [%s] — short change: %+.2f%%\n", code, ti.Direction, ti.ShortChange)
			if ti.PriceCorrelation != nil {
				fmt.Fprintf(&sb, "  Pattern: %s (weekly price: %+.1f%%, monthly: %+.1f%%)\n",
					ti.PriceCorrelation.Pattern, ti.PriceCorrelation.WeeklyPriceChange, ti.PriceCorrelation.MonthlyPriceChange)
			}
			if len(ti.KeyAnnouncements) > 0 {
				sb.WriteString("  Announcements:\n")
				for _, a := range ti.KeyAnnouncements {
					fmt.Fprintf(&sb, "    - %s\n", a)
				}
			}
			if len(ti.FinancialSignals) > 0 {
				sb.WriteString("  Financial signals:\n")
				for _, s := range ti.FinancialSignals {
					fmt.Fprintf(&sb, "    - %s\n", s)
				}
			}
			if len(ti.MetricSignals) > 0 {
				sb.WriteString("  Valuation signals:\n")
				for _, s := range ti.MetricSignals {
					fmt.Fprintf(&sb, "    - %s\n", s)
				}
			}
			fmt.Fprintf(&sb, "  Composite: %s\n", ti.CompositeSignal)
		}
	}

	sb.WriteString("</report_data>\n")

	// Include extra context (e.g., quarterly snapshots + monthly narratives for yearly reports)
	if data.ExtraContext != "" {
		sb.WriteString("\n<extra_context>\n")
		sb.WriteString(data.ExtraContext)
		sb.WriteString("\n</extra_context>\n")
	}

	if feedback != "" {
		fmt.Fprintf(&sb, "\n<quality_feedback>\n%s\n</quality_feedback>\n", feedback)
		sb.WriteString("\nPlease regenerate the report addressing the quality feedback above.\n")
	}

	// Report-type-specific instructions
	switch data.ReportType {
	case "yearly":
		sb.WriteString("\nGenerate a year-in-review short selling report based on the data above.")
		sb.WriteString("\nCITATION GUIDANCE: This is a yearly report covering 12 months of data. You should include 15-25 citations covering:")
		sb.WriteString("\n- ASIC short position data for key stocks at year start, year end, and major turning points")
		sb.WriteString("\n- Financial reports from the biggest movers (earnings, profit warnings, capital raises)")
		sb.WriteString("\n- Quarterly snapshot data showing how positions evolved through the year")
		sb.WriteString("\n- Monthly report narratives where relevant")
		sb.WriteString("\n- Price data correlated with short interest changes")
		sb.WriteString("\nEvery major claim about a stock's short interest trajectory should have a citation.\n")
	case "monthly":
		sb.WriteString("\nGenerate a monthly short selling report based on the data above.")
		sb.WriteString("\nCITATION GUIDANCE: This is a monthly report. Include 8-15 citations covering ASIC data, financial reports, and price data for the key movers.\n")
	default:
		sb.WriteString("\nGenerate a weekly short selling report based on the data above.\n")
	}
	sb.WriteString("Return ONLY valid JSON.")

	return sb.String()
}

// writeMoverLine renders a riser/faller with its full signal set.
func writeMoverLine(sb *strings.Builder, m Mover) {
	fmt.Fprintf(sb, "- %s (%s): %.2f%% → %.2f%% (change: %+.2f%%)",
		m.Name, m.Code, m.PreviousPct, m.CurrentPct, m.Change)
	if m.Industry != "" {
		fmt.Fprintf(sb, " | industry: %s", m.Industry)
	}
	if m.ZScore != 0 {
		fmt.Fprintf(sb, " | z-score: %+.2f", m.ZScore)
	}
	if m.StreakWeeks > 0 {
		fmt.Fprintf(sb, " | streak: %d wk", m.StreakWeeks)
		if m.StreakWeeks > 1 {
			sb.WriteString("s")
		}
	}
	if m.DaysToCover > 0 {
		fmt.Fprintf(sb, " | days-to-cover: %.1f", m.DaysToCover)
	}
	if len(m.History) > 1 {
		fmt.Fprintf(sb, " | 13w history: %s", formatHistorySeries(m.History))
	}
	sb.WriteString("\n")
}

// formatHistorySeries renders an oldest-first weekly series as "1.20 → 1.35 → ...".
func formatHistorySeries(history []float64) string {
	parts := make([]string, 0, len(history))
	for _, h := range history {
		parts = append(parts, fmt.Sprintf("%.2f", h))
	}
	return strings.Join(parts, " → ")
}

// extractLikelyJSON strips markdown fences and extracts the JSON object
func extractLikelyJSON(raw string) string {
	raw = strings.TrimSpace(raw)

	// Strip markdown code fences
	raw = strings.TrimPrefix(raw, "```json")
	raw = strings.TrimPrefix(raw, "```")
	raw = strings.TrimSuffix(raw, "```")
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
