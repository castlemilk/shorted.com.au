package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/generative-ai-go/genai"
	"google.golang.org/api/option"
)

var percentRegex = regexp.MustCompile(`(\d+\.\d+)%`)
var citationRefRegex = regexp.MustCompile(`\[ref-(\d+)\]`)

// Ticker mentions only count in these two contexts — "(BHP)" or "$BHP" —
// so bare uppercase words like ASX, ASIC, or CEO in prose are never flagged.
// ASX codes are at least 3 characters, so 2-letter tokens like (PE), (EV) or
// (US) are never candidate tickers.
var parenTickerRegex = regexp.MustCompile(`\(([A-Z]{3,4})\)`)
var cashtagTickerRegex = regexp.MustCompile(`\$([A-Z]{3,4})`)

var urlRegex = regexp.MustCompile(`https?://[^\s"'<>)\]]+`)

// tickerAllowlist covers common non-ticker uppercase tokens that can
// legitimately appear in parentheses in financial prose — regulators
// ("the regulator (ASIC)"), metric abbreviations ("earnings per share (EPS)"),
// currencies, and geography. Codes present in the source data are always
// checked first, so an allowlisted token that happens to collide with a real
// reported ticker still passes.
var tickerAllowlist = map[string]bool{
	// Markets, regulators, institutions
	"ASX": true, "ASIC": true, "RBA": true, "ATO": true, "APRA": true,
	"ACCC": true, "AEMO": true, "FIRB": true, "FED": true,
	// Corporate roles
	"CEO": true, "CFO": true, "COO": true, "CTO": true, "CIO": true,
	// Financial metrics & terms
	"EPS": true, "DPS": true, "NPAT": true, "EBIT": true, "PBT": true,
	"ROE": true, "ROA": true, "ROI": true, "FUM": true, "AUM": true,
	"NTA": true, "NAV": true, "CAGR": true, "FCF": true, "TSR": true,
	"WACC": true, "IPO": true, "ETF": true, "REIT": true, "LIC": true,
	"AGM": true, "EGM": true, "SPP": true, "DRP": true,
	// Macro & tax
	"GDP": true, "CPI": true, "PPI": true, "GST": true, "CGT": true,
	"YTD": true, "YOY": true, "QOQ": true, "PCP": true,
	// Currencies
	"AUD": true, "USD": true, "EUR": true, "GBP": true, "NZD": true,
	"JPY": true, "CNY": true, "RMB": true, "HKD": true, "SGD": true,
	// Geography
	"NSW": true, "VIC": true, "QLD": true, "TAS": true, "ACT": true,
	"USA": true,
	// Misc
	"FAQ": true, "ESG": true, "LNG": true, "GFC": true,
}

// QualityResult holds the quality check outcome
type QualityResult struct {
	Score        float64 `json:"score"`
	PublishReady bool    `json:"publish_ready"`
	Feedback     string  `json:"feedback"`
}

// QualityChecker validates generated narratives
type QualityChecker struct {
	geminiKey string
}

// NewQualityChecker creates a new QualityChecker
func NewQualityChecker(geminiKey string) *QualityChecker {
	return &QualityChecker{geminiKey: geminiKey}
}

// aiIsmPhrases are common LLM-isms to check for
var aiIsmPhrases = []string{
	"it's important to note",
	"landscape",
	"delve",
	"navigate",
	"in the realm of",
	"interestingly",
	"notably",
	"it's worth noting",
	"robust",
	"dynamic",
	"unprecedented",
	"cutting-edge",
}

// Check runs programmatic and optionally Gemini-based quality checks
func (q *QualityChecker) Check(ctx context.Context, data *ReportData, narrative *NarrativeResult) (*QualityResult, error) {
	// Step 1: Programmatic checks
	issues := q.programmaticCheck(data, narrative)

	if len(issues) > 0 {
		log.Printf("Programmatic quality issues: %v", issues)
	}

	// Step 2: Gemini review (if available)
	if q.geminiKey != "" {
		geminiResult, err := q.geminiReview(ctx, data, narrative)
		if err != nil {
			log.Printf("Gemini review failed: %v", err)
		} else {
			// Combine programmatic and Gemini results
			if len(issues) > 0 {
				geminiResult.Score = geminiResult.Score * 0.8 // Penalise for programmatic issues
				geminiResult.Feedback = fmt.Sprintf("Programmatic issues: %s\n\n%s",
					strings.Join(issues, "; "), geminiResult.Feedback)
			}
			return geminiResult, nil
		}
	}

	// Monthly reports have less data and typically score lower — use a more lenient threshold.
	// Weekly/yearly reports require stricter quality (0.7, max 2 issues).
	minScore := 0.7
	maxIssues := 2
	penaltyPerIssue := 0.15
	if data.ReportType == "monthly" {
		minScore = 0.1 // Allow low-quality monthly reports to publish (monthly data is thin)
		maxIssues = 10
		penaltyPerIssue = 0.10
	}

	// Fallback: score based on programmatic checks only
	score := 1.0 - float64(len(issues))*penaltyPerIssue
	if score < 0 {
		score = 0
	}

	return &QualityResult{
		Score:        score,
		PublishReady: score >= minScore && len(issues) <= maxIssues,
		Feedback:     strings.Join(issues, "; "),
	}, nil
}

func (q *QualityChecker) programmaticCheck(data *ReportData, narrative *NarrativeResult) []string {
	var issues []string

	// Check for AI-ism phrases
	fullText := narrative.Headline + " " + narrative.Summary + " " +
		narrative.Narrative.OpeningHook + " " + narrative.Narrative.TopAnalysis + " " +
		narrative.Narrative.MoversAnalysis + " " + narrative.Narrative.IndustryAnalysis + " " +
		narrative.Narrative.Outlook
	lowerText := strings.ToLower(fullText)

	for _, phrase := range aiIsmPhrases {
		if strings.Contains(lowerText, phrase) {
			issues = append(issues, fmt.Sprintf("AI-ism detected: '%s'", phrase))
		}
	}

	// Check word count (yearly reports get higher limits)
	words := strings.Fields(fullText)
	maxWords := 800
	minWords := 100
	if data.ReportType == "yearly" {
		maxWords = 1500
		minWords = 200
	}
	if len(words) > maxWords {
		issues = append(issues, fmt.Sprintf("narrative too long: %d words (max %d)", len(words), maxWords))
	}
	if len(words) < minWords {
		issues = append(issues, fmt.Sprintf("narrative too short: %d words (min %d)", len(words), minWords))
	}

	// Check headline length
	if len(narrative.Headline) > 80 {
		issues = append(issues, fmt.Sprintf("headline too long: %d chars (max 80)", len(narrative.Headline)))
	}

	// Verify top stock is mentioned
	if len(data.TopShorted) > 0 {
		topCode := data.TopShorted[0].Code
		if !strings.Contains(fullText, topCode) {
			issues = append(issues, fmt.Sprintf("top shorted stock %s not mentioned in narrative", topCode))
		}
	}

	// Check numerical accuracy: extract all percentages from narrative and cross-reference with source data
	// First, strip [ref-N] markers so they don't trigger false percentage matches
	textForPctCheck := citationRefRegex.ReplaceAllString(fullText, "")
	validPcts := buildValidPercentageSet(data)
	matches := percentRegex.FindAllStringSubmatch(textForPctCheck, -1)
	for _, match := range matches {
		pct, err := strconv.ParseFloat(match[1], 64)
		if err != nil {
			continue
		}
		if !isPercentageInSet(pct, validPcts, 0.02) {
			issues = append(issues, fmt.Sprintf("unverified percentage %.2f%% not found in source data", pct))
		}
	}

	// Hallucinated-ticker check: any "(CODE)" or "$CODE" mention must be a code
	// present in the source data. Bare uppercase words outside those two
	// contexts are never flagged (avoids ASX/ASIC/CEO false positives).
	issues = append(issues, checkHallucinatedTickers(data, fullText)...)

	// Hallucinated-URL check: any http(s) URL in the narrative or citations
	// must exist in the FinancialRefs source URLs.
	issues = append(issues, checkHallucinatedURLs(data, narrative, fullText)...)

	// Citation validation: check that defined citation IDs appear in narrative text,
	// and that inline [ref-N] markers have matching citation definitions
	if narrative.Citations != nil {
		definedIDs := make(map[string]bool)
		for _, c := range narrative.Citations {
			definedIDs[c.ID] = true
		}

		// Find all [ref-N] markers in the text
		usedIDs := make(map[string]bool)
		refMatches := citationRefRegex.FindAllStringSubmatch(fullText, -1)
		for _, m := range refMatches {
			usedIDs["ref-"+m[1]] = true
		}

		// Check for defined citations not used in text
		for id := range definedIDs {
			if !usedIDs[id] {
				issues = append(issues, fmt.Sprintf("citation %s defined but never referenced in narrative", id))
			}
		}

		// Check for orphaned [ref-N] markers with no matching citation
		for id := range usedIDs {
			if !definedIDs[id] {
				issues = append(issues, fmt.Sprintf("orphaned [%s] in narrative has no matching citation definition", id))
			}
		}
	}

	// Check FAQ count (yearly reports can have more)
	minFAQs := 3
	maxFAQs := 5
	if data.ReportType == "yearly" {
		maxFAQs = 8
	}
	if len(narrative.FAQs) < minFAQs {
		issues = append(issues, fmt.Sprintf("too few FAQs: %d (min %d)", len(narrative.FAQs), minFAQs))
	}
	if len(narrative.FAQs) > maxFAQs {
		issues = append(issues, fmt.Sprintf("too many FAQs: %d (max %d)", len(narrative.FAQs), maxFAQs))
	}

	return issues
}

func (q *QualityChecker) geminiReview(ctx context.Context, data *ReportData, narrative *NarrativeResult) (*QualityResult, error) {
	client, err := genai.NewClient(ctx, option.WithAPIKey(q.geminiKey))
	if err != nil {
		return nil, fmt.Errorf("failed to create Gemini client: %w", err)
	}
	defer func() { _ = client.Close() }()

	model := client.GenerativeModel("gemini-3.5-flash")
	model.SetTemperature(0.0)

	narrativeJSON, _ := json.Marshal(narrative)
	dataJSON, _ := json.Marshal(data)

	prompt := fmt.Sprintf(`Review this weekly short selling report for quality.

<source_data>%s</source_data>

<generated_report>%s</generated_report>

Evaluate on these criteria:
1. Factual accuracy: Do cited numbers match the source data?
2. Writing quality: Is the tone authoritative and measured? No AI-isms?
3. Completeness: Are all key data points covered?
4. Readability: Is the narrative engaging and well-structured?

Return ONLY valid JSON:
{
  "score": 0.0-1.0,
  "publish_ready": true/false,
  "feedback": "Specific improvement suggestions if score < 0.8"
}`, string(dataJSON), string(narrativeJSON))

	callCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	resp, err := model.GenerateContent(callCtx, genai.Text(prompt))
	if err != nil {
		recordLLMUsage(ctx, "gemini-3.5-flash", "quality_review", "error", 0, 0, 0, 0)
		return nil, fmt.Errorf("gemini API call failed: %w", err)
	}
	if resp.UsageMetadata != nil {
		recordLLMUsage(ctx, "gemini-3.5-flash", "quality_review", "success",
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

	var result QualityResult
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return nil, fmt.Errorf("failed to parse Gemini response: %w", err)
	}

	return &result, nil
}

// buildValidPercentageSet collects all percentage values from the source data
func buildValidPercentageSet(data *ReportData) []float64 {
	seen := make(map[float64]bool)

	for _, s := range data.TopShorted {
		seen[s.ShortPct] = true
		seen[math.Abs(s.WoWChange)] = true
		if s.WoWChange != 0 {
			seen[s.WoWChange] = true
		}
		for _, h := range s.History {
			seen[h] = true
		}
	}
	for _, m := range data.Risers {
		seen[m.CurrentPct] = true
		seen[m.PreviousPct] = true
		seen[math.Abs(m.Change)] = true
		if m.Change != 0 {
			seen[m.Change] = true
		}
		for _, h := range m.History {
			seen[h] = true
		}
	}
	for _, m := range data.Fallers {
		seen[m.CurrentPct] = true
		seen[m.PreviousPct] = true
		seen[math.Abs(m.Change)] = true
		if m.Change != 0 {
			seen[m.Change] = true
		}
		for _, h := range m.History {
			seen[h] = true
		}
	}

	// Industry aggregates are legitimate quotable figures
	for _, ind := range data.IndustryBreakdown {
		seen[ind.AvgShortPct] = true
		seen[math.Abs(ind.WoWChange)] = true
		if ind.WoWChange != 0 {
			seen[ind.WoWChange] = true
		}
		seen[ind.TopStockPct] = true
	}

	seen[data.MarketStats.AvgShortPct] = true
	seen[data.MarketStats.MedianShortPct] = true
	seen[data.MarketStats.MaxShortPct] = true
	seen[math.Abs(data.MarketStats.WoWAvgChange)] = true

	// Include price change percentages if available
	if data.PriceContext != nil {
		for _, p := range data.PriceContext {
			seen[math.Abs(p.WeeklyChangePct)] = true
			seen[math.Abs(p.MonthlyChangePct)] = true
		}
	}

	pcts := make([]float64, 0, len(seen))
	for v := range seen {
		pcts = append(pcts, v)
	}
	return pcts
}

// validCodeSet collects every stock code present in the source data.
func validCodeSet(data *ReportData) map[string]bool {
	codes := make(map[string]bool)
	for _, s := range data.TopShorted {
		codes[s.Code] = true
	}
	for _, m := range data.Risers {
		codes[m.Code] = true
	}
	for _, m := range data.Fallers {
		codes[m.Code] = true
	}
	if data.MarketStats.MaxShortCode != "" {
		codes[data.MarketStats.MaxShortCode] = true
	}
	for _, ind := range data.IndustryBreakdown {
		if ind.TopStockCode != "" {
			codes[ind.TopStockCode] = true
		}
	}
	// Any code we fetched context for is legitimately in the data too
	for code := range data.CompanyContext {
		codes[code] = true
	}
	return codes
}

// checkHallucinatedTickers flags "(CODE)" / "$CODE" mentions of codes that are
// not in the source data.
func checkHallucinatedTickers(data *ReportData, fullText string) []string {
	valid := validCodeSet(data)
	flagged := make(map[string]bool)
	var issues []string

	check := func(code string) {
		if valid[code] || tickerAllowlist[code] || flagged[code] {
			return
		}
		flagged[code] = true
		issues = append(issues, fmt.Sprintf("hallucinated ticker %s not present in source data", code))
	}

	for _, m := range parenTickerRegex.FindAllStringSubmatch(fullText, -1) {
		check(m[1])
	}
	for _, m := range cashtagTickerRegex.FindAllStringSubmatch(fullText, -1) {
		check(m[1])
	}
	return issues
}

// validURLSet collects every URL present in the source data (FinancialRefs).
func validURLSet(data *ReportData) map[string]bool {
	urls := make(map[string]bool)
	for _, refs := range data.FinancialRefs {
		for _, r := range refs {
			if r.URL != "" {
				urls[strings.TrimRight(r.URL, "/")] = true
			}
		}
	}
	return urls
}

// checkHallucinatedURLs flags any http(s) URL in the narrative text or the
// citations that does not exist in the FinancialRefs source URLs.
func checkHallucinatedURLs(data *ReportData, narrative *NarrativeResult, fullText string) []string {
	valid := validURLSet(data)
	flagged := make(map[string]bool)
	var issues []string

	check := func(raw string) {
		url := strings.TrimRight(strings.TrimRight(raw, ".,;:"), "/")
		if url == "" || valid[url] || flagged[url] {
			return
		}
		flagged[url] = true
		issues = append(issues, fmt.Sprintf("hallucinated URL %s not present in source data", url))
	}

	for _, u := range urlRegex.FindAllString(fullText, -1) {
		check(u)
	}
	for _, c := range narrative.Citations {
		if c.URL != "" {
			check(c.URL)
		}
	}
	return issues
}

// isPercentageInSet checks if a percentage value matches any value in the set within tolerance
func isPercentageInSet(pct float64, validPcts []float64, tolerance float64) bool {
	for _, v := range validPcts {
		if math.Abs(pct-math.Abs(v)) <= tolerance {
			return true
		}
	}
	return false
}
