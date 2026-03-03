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
	ID     string `json:"id"`               // "ref-1"
	Source string `json:"source"`            // "BHP H1 FY2025 Results"
	Date   string `json:"date,omitempty"`
	URL    string `json:"url,omitempty"`
	Type   string `json:"type"`             // "financial_report", "announcement", "asic_data", "price_data"
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
		geminiModel:  "gemini-3-pro-preview",
	}
}

// analyticalSystemPrompt is the first-pass prompt for GPT-5.2: data-driven analysis
const analyticalSystemPrompt = `You are writing a weekly short selling column for Shorted.com.au, an Australian financial data platform. Write as a knowledgeable market commentator — someone who reads the data carefully, spots the interesting stories, and explains what retail investors should pay attention to.

CRITICAL ACCURACY RULES:
- NEVER round, estimate, or approximate. Use exact figures from the data.
- 15.23% means write "15.23%", not "about 15%" or "over 15%".
- Every percentage and stock code you mention MUST appear in the source data above.
- If unsure of a number, omit it rather than guess.

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
"unprecedented", "cutting-edge", "a shifting landscape", "bears are circling", "all eyes on",
"amidst", "the stage is set", "remains to be seen"

Format:
- Total narrative: 300-500 words across all sections
- Headline: punchy, under 80 chars, references the most newsworthy data point
- Summary: 2-3 sentences a busy person can skim
- 3-5 FAQs with 1-2 sentence answers each

Citations:
- When referencing specific data points (financial results, announcements, price data, ASIC figures), add inline markers like [ref-1], [ref-2] in the narrative text
- List all citations in the "citations" array with matching IDs
- Citation types: "financial_report", "announcement", "asic_data", "price_data"
- Only cite data that actually appears in the source data above
- Scale citations to report scope: ~3-8 for weekly, ~8-15 for monthly, ~15-25 for yearly. Cite key claims, not every number

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
  ],
  "citations": [
    {"id": "ref-1", "source": "Description of the data source", "date": "2026-01-15", "url": "", "type": "asic_data"}
  ]
}`

// geminiNarrativePrompt is the first-pass prompt for Gemini 3 Pro: independent perspective
const geminiNarrativePrompt = `You are a veteran Australian financial markets columnist writing a weekly short selling wrap for Shorted.com.au.

Your job: look at this week's ASIC short position data and write a concise, opinionated market commentary. You're writing for retail investors who want to understand what the shorts are doing and why it matters.

CRITICAL ACCURACY RULES:
- NEVER round, estimate, or approximate. Use exact figures from the data.
- 15.23% means write "15.23%", not "about 15%" or "over 15%".
- Every percentage and stock code you mention MUST appear in the source data above.
- If unsure of a number, omit it rather than guess.

Style:
- Write the way Marcus Padley or Alan Kohler would for their subscribers — informal authority, no corporate fluff
- Australian English. ASX tickers. No American market analogies
- If the data tells a clear story (sector rotation, crowded trade unwinding, earnings positioning), say it plainly
- Short sentences punch harder. Use them
- Every number you cite must come directly from the data provided
- Don't pad. If you can say it in fewer words, do

Avoid these dead giveaways of AI writing: "it's important to note", "landscape", "delve", "navigate",
"in the realm of", "interestingly", "notably", "it's worth noting", "robust", "dynamic",
"unprecedented", "cutting-edge", "bears are circling", "all eyes on", "amidst", "the stage is set",
"remains to be seen", "a testament to"

Citations:
- When referencing specific data points (financial results, announcements, price data, ASIC figures), add inline markers like [ref-1], [ref-2] in the narrative text
- List all citations in the "citations" array with matching IDs
- Citation types: "financial_report", "announcement", "asic_data", "price_data"
- Only cite data that actually appears in the source data above
- Scale citations to report scope: ~3-8 for weekly, ~8-15 for monthly, ~15-25 for yearly

Return ONLY valid JSON in this exact structure:
{
  "headline": "Punchy headline under 80 chars",
  "summary": "2-3 sentence summary with the key numbers",
  "narrative": {
    "opening_hook": "The single most interesting thing in this week's data",
    "top_analysis": "What the top shorted list tells us — who's new, who dropped out, what changed",
    "movers_analysis": "The real action: biggest risers and fallers and what might be driving it",
    "industry_analysis": "Sector-level read — where are shorts concentrating or retreating?",
    "outlook": "One sharp observation about what to watch next week"
  },
  "faqs": [
    {"question": "Question a retail investor would actually search for", "answer": "Direct, factual answer"}
  ],
  "citations": [
    {"id": "ref-1", "source": "Description of the data source", "date": "2026-01-15", "url": "", "type": "asic_data"}
  ]
}`

// amalgamationSystemPrompt is the second-pass prompt: creative writing emphasis
const amalgamationSystemPrompt = `You are the chief editor of Shorted.com.au's weekly column. You've received two draft analyses of this week's ASIC short position data — one from a data-focused analyst and one from a market columnist. Your job is to merge them into a single, polished piece that reads like the best financial journalism.

CRITICAL ACCURACY RULES:
- NEVER round, estimate, or approximate. Use exact figures from the source data.
- 15.23% means write "15.23%", not "about 15%" or "over 15%".
- Every percentage and stock code you mention MUST appear in the source data.
- If unsure of a number, omit it rather than guess.
- Cross-check all figures against the source data before including them.

Your editorial mandate:
- Take the strongest insights from each draft. If both noticed the same thing, pick the better framing
- Where they disagree or emphasise different stories, use your judgement — the more surprising, data-backed angle wins
- The final piece should feel like it was written by ONE person: a sharp, experienced market watcher who writes with personality
- Prioritise readability. A fund manager skimming this at 6am should get the key points in 30 seconds
- Every number must match the source data. Do not invent or round figures
- Write in Australian English. ASX codes. No hedging with weasel words
- The opening must hook — lead with whatever is genuinely most interesting this week
- The outlook should leave the reader with one specific thing to watch, not a vague "time will tell"

Creative writing emphasis:
- Vary rhythm. A three-word sentence after a complex one creates impact
- Use concrete imagery over abstractions: "shorts piled in" not "there was increased short interest"
- Let the data tell the story — don't tell the reader how to feel about it
- The headline should make someone click. Think trading desk banter, not press releases
- FAQs should be things people would genuinely type into Google after reading the report

ABSOLUTELY DO NOT USE: "it's important to note", "landscape", "delve", "navigate", "in the realm of",
"interestingly", "notably", "it's worth noting", "robust", "dynamic", "unprecedented", "cutting-edge",
"bears are circling", "all eyes on", "amidst", "the stage is set", "remains to be seen", "a testament to",
"make waves", "sent shockwaves", "a double-edged sword"

Citations:
- Merge citations from both drafts. Deduplicate by source. Renumber sequentially as [ref-1], [ref-2], etc.
- Ensure every [ref-N] marker in the narrative text has a matching entry in the citations array
- Citation types: "financial_report", "announcement", "asic_data", "price_data"
- Scale citations to report scope: ~3-8 for weekly, ~8-15 for monthly, ~15-25 for yearly

Return ONLY valid JSON in this exact structure:
{
  "headline": "Punchy headline under 80 chars — the most click-worthy angle",
  "summary": "2-3 crisp sentences. Key numbers. No filler",
  "narrative": {
    "opening_hook": "The hook. What's the most interesting thing in the data this week?",
    "top_analysis": "The top shorted stocks — what changed, what's new, what matters",
    "movers_analysis": "Risers and fallers — where the real action was and why",
    "industry_analysis": "The bigger picture — sector trends, rotation patterns",
    "outlook": "One or two sentences. Specific. What should investors actually watch next week?"
  },
  "faqs": [
    {"question": "Question a retail investor would Google", "answer": "Direct factual answer"}
  ],
  "citations": [
    {"id": "ref-1", "source": "Description of the data source", "date": "2026-01-15", "url": "", "type": "asic_data"}
  ]
}`

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

// gptGenerate calls GPT-5.2 with a system prompt and user prompt
func (g *LLMGenerator) gptGenerate(ctx context.Context, systemPrompt, userPrompt string) (*NarrativeResult, error) {
	callCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()

	temp := float32(0.2)
	resp, err := g.openaiClient.CreateChatCompletion(callCtx, openai.ChatCompletionRequest{
		Model:       g.openaiModel,
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
	model.SystemInstruction = &genai.Content{
		Parts: []genai.Part{genai.Text(systemPrompt)},
	}

	callCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()

	resp, err := model.GenerateContent(callCtx, genai.Text(userPrompt))
	if err != nil {
		return nil, fmt.Errorf("gemini API call failed: %w", err)
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

	callCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()

	temp := float32(0.4) // Slightly higher temperature for creative writing
	resp, err := g.openaiClient.CreateChatCompletion(callCtx, openai.ChatCompletionRequest{
		Model:       g.openaiModel,
		Temperature: temp,
		Messages: []openai.ChatCompletionMessage{
			{Role: openai.ChatMessageRoleSystem, Content: amalgamationSystemPrompt},
			{Role: openai.ChatMessageRoleUser, Content: sb.String()},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("OpenAI amalgamation call failed: %w", err)
	}

	if len(resp.Choices) == 0 {
		return nil, fmt.Errorf("no response from OpenAI amalgamation")
	}

	raw := resp.Choices[0].Message.Content
	raw = extractLikelyJSON(raw)

	var result NarrativeResult
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return nil, fmt.Errorf("failed to parse amalgamation response: %w\nraw: %s", err, raw)
	}

	return &result, nil
}

func buildUserPrompt(data *ReportData, feedback string) string {
	var sb strings.Builder

	fmt.Fprintf(&sb, "<report_data>\nWeek: %s\nReport Date: %s\nPrevious Date: %s\n\n",
		data.WeekSlug, data.ReportDate, data.PreviousDate)

	sb.WriteString("TOP 10 MOST SHORTED STOCKS:\n")
	for _, s := range data.TopShorted {
		fmt.Fprintf(&sb, "%d. %s (%s): %.2f%% short (WoW change: %+.2f%%)\n",
			s.Rank, s.Name, s.Code, s.ShortPct, s.WoWChange)
	}

	sb.WriteString("\nBIGGEST RISERS (increased short interest):\n")
	for _, m := range data.Risers {
		fmt.Fprintf(&sb, "- %s (%s): %.2f%% → %.2f%% (change: %+.2f%%)\n",
			m.Name, m.Code, m.PreviousPct, m.CurrentPct, m.Change)
	}

	sb.WriteString("\nBIGGEST FALLERS (decreased short interest):\n")
	for _, m := range data.Fallers {
		fmt.Fprintf(&sb, "- %s (%s): %.2f%% → %.2f%% (change: %+.2f%%)\n",
			m.Name, m.Code, m.PreviousPct, m.CurrentPct, m.Change)
	}

	fmt.Fprintf(&sb, "\nMARKET STATISTICS:\n- Total stocks shorted: %d\n- Average short %%: %.2f%%\n- Max short %%: %.2f%% (%s)\n- WoW average change: %+.2f%%\n",
		data.MarketStats.TotalStocksShorted, data.MarketStats.AvgShortPct,
		data.MarketStats.MaxShortPct, data.MarketStats.MaxShortCode, data.MarketStats.WoWAvgChange)

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
				fmt.Fprintf(&sb, "%s — $%.2f (week: %+.1f%%, month: %+.1f%%)", code, p.CurrentPrice, p.WeeklyChangePct, p.MonthlyChangePct)
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
