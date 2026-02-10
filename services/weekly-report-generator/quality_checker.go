package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/google/generative-ai-go/genai"
	"google.golang.org/api/option"
)

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

	// Fallback: score based on programmatic checks only
	score := 1.0 - float64(len(issues))*0.15
	if score < 0 {
		score = 0
	}

	return &QualityResult{
		Score:        score,
		PublishReady: score >= 0.7 && len(issues) <= 2,
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

	// Check word count
	words := strings.Fields(fullText)
	if len(words) > 600 {
		issues = append(issues, fmt.Sprintf("narrative too long: %d words (max 600)", len(words)))
	}
	if len(words) < 100 {
		issues = append(issues, fmt.Sprintf("narrative too short: %d words (min 100)", len(words)))
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

	// Check FAQ count
	if len(narrative.FAQs) < 3 {
		issues = append(issues, fmt.Sprintf("too few FAQs: %d (min 3)", len(narrative.FAQs)))
	}
	if len(narrative.FAQs) > 5 {
		issues = append(issues, fmt.Sprintf("too many FAQs: %d (max 5)", len(narrative.FAQs)))
	}

	return issues
}

func (q *QualityChecker) geminiReview(ctx context.Context, data *ReportData, narrative *NarrativeResult) (*QualityResult, error) {
	client, err := genai.NewClient(ctx, option.WithAPIKey(q.geminiKey))
	if err != nil {
		return nil, fmt.Errorf("failed to create Gemini client: %w", err)
	}
	defer func() { _ = client.Close() }()

	model := client.GenerativeModel("gemini-2.0-flash")
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

	var result QualityResult
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return nil, fmt.Errorf("failed to parse Gemini response: %w", err)
	}

	return &result, nil
}
