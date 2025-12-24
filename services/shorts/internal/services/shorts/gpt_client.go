package shorts

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	openai "github.com/sashabaranov/go-openai"
)

//go:generate mockgen -source=gpt_client.go -destination=mocks/mock_gpt_client.go -package=mocks
type GPTClient interface {
	EnrichCompany(ctx context.Context, stockCode, companyName, industry, website, currentSummary string, reports []*stocksv1alpha1.FinancialReport) (*shortsv1alpha1.EnrichmentData, error)
	EvaluateQuality(ctx context.Context, stockCode string, data *shortsv1alpha1.EnrichmentData) (*shortsv1alpha1.QualityScore, error)
}

type OpenAIGPTClient struct {
	client *openai.Client
	model  string
}

func NewOpenAIGPTClient(apiKey string) (*OpenAIGPTClient, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, fmt.Errorf("OPENAI_API_KEY is required")
	}
	return &OpenAIGPTClient{
		client: openai.NewClient(apiKey),
		model:  "gpt-5.1",
	}, nil
}

func (c *OpenAIGPTClient) EnrichCompany(ctx context.Context, stockCode, companyName, industry, website, currentSummary string, reports []*stocksv1alpha1.FinancialReport) (*shortsv1alpha1.EnrichmentData, error) {
	if strings.TrimSpace(stockCode) == "" {
		return nil, fmt.Errorf("stock code is required")
	}

	systemPrompt := `You are a financial analyst specializing in Australian Stock Exchange (ASX) companies.

Return ONLY valid JSON matching the requested schema. No markdown. No commentary.

Quality rules:
- Be specific and factual; avoid generic template language.
- If a field is truly unavailable, use null (for strings/objects) or [] (for arrays).
- Provide exactly 5 tags.`

	reportLines := make([]string, 0, len(reports))
	for _, r := range reports {
		if r == nil || strings.TrimSpace(r.Url) == "" {
			continue
		}
		reportLines = append(reportLines, fmt.Sprintf("- %s (%s)", strings.TrimSpace(r.Url), strings.TrimSpace(r.Title)))
	}
	reportsSection := "0 report(s) discovered"
	if len(reportLines) > 0 {
		reportsSection = fmt.Sprintf("%d report(s) discovered:\n%s", len(reportLines), strings.Join(reportLines, "\n"))
	}

	userPrompt := fmt.Sprintf(`
<company_context>
Company Name: %s
Stock Code: %s
Industry: %s
Website: %s
Current Summary: %s
</company_context>

<financial_reports_found>
%s
</financial_reports_found>

Return a JSON object with this EXACT structure (valid JSON only, no markdown):

{
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "enhanced_summary": "2-4 sentences covering business model, market position, unique value",
  "company_history": "3-5 sentences on founding, evolution, major milestones",
  "key_people": [
    {"name": "Full Name", "role": "CEO", "bio": "1-2 sentence bio"},
    {"name": "Full Name", "role": "CFO", "bio": "1-2 sentence bio"}
  ],
  "competitive_advantages": "2-3 specific competitive advantages with detail",
  "risk_factors": ["Specific risk 1", "Specific risk 2", "Specific risk 3"],
  "recent_developments": "Recent developments from the last ~6 months",
  "social_media_links": {
    "linkedin": "https://linkedin.com/company/...",
    "twitter": "https://twitter.com/..."
  }
}
`, companyName, stockCode, industry, website, currentSummary, reportsSection)

	req := openai.ChatCompletionRequest{
		Model: c.model,
		Messages: []openai.ChatCompletionMessage{
			{Role: openai.ChatMessageRoleSystem, Content: systemPrompt},
			{Role: openai.ChatMessageRoleUser, Content: userPrompt},
		},
		Temperature: 0.2,
	}

	// Protect against runaway calls.
	callCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()

	resp, err := c.client.CreateChatCompletion(callCtx, req)
	if err != nil {
		return nil, fmt.Errorf("gpt enrichment failed: %w", err)
	}
	if len(resp.Choices) == 0 {
		return nil, fmt.Errorf("gpt enrichment returned no choices")
	}

	raw := strings.TrimSpace(resp.Choices[0].Message.Content)
	raw = extractLikelyJSON(raw)

	var parsed struct {
		Tags                  []string `json:"tags"`
		EnhancedSummary       *string  `json:"enhanced_summary"`
		CompanyHistory        *string  `json:"company_history"`
		KeyPeople             []struct {
			Name string `json:"name"`
			Role string `json:"role"`
			Bio  string `json:"bio"`
		} `json:"key_people"`
		CompetitiveAdvantages *string  `json:"competitive_advantages"`
		RiskFactors           []string `json:"risk_factors"`
		RecentDevelopments    *string  `json:"recent_developments"`
		SocialMediaLinks      map[string]*string `json:"social_media_links"`
	}

	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil, fmt.Errorf("failed to parse GPT JSON: %w", err)
	}

	data := &shortsv1alpha1.EnrichmentData{
		Tags:                parsed.Tags,
		EnhancedSummary:     derefString(parsed.EnhancedSummary),
		CompanyHistory:      derefString(parsed.CompanyHistory),
		CompetitiveAdvantages: derefString(parsed.CompetitiveAdvantages),
		RiskFactors:         parsed.RiskFactors,
		RecentDevelopments:  derefString(parsed.RecentDevelopments),
		FinancialReports:    reports,
	}

	people := make([]*stocksv1alpha1.CompanyPerson, 0, len(parsed.KeyPeople))
	for _, p := range parsed.KeyPeople {
		if strings.TrimSpace(p.Name) == "" && strings.TrimSpace(p.Role) == "" && strings.TrimSpace(p.Bio) == "" {
			continue
		}
		people = append(people, &stocksv1alpha1.CompanyPerson{
			Name: strings.TrimSpace(p.Name),
			Role: strings.TrimSpace(p.Role),
			Bio:  strings.TrimSpace(p.Bio),
		})
	}
	data.KeyPeople = people

	if len(parsed.SocialMediaLinks) > 0 {
		links := &stocksv1alpha1.SocialMediaLinks{}
		if v := parsed.SocialMediaLinks["linkedin"]; v != nil {
			links.Linkedin = derefString(v)
		}
		if v := parsed.SocialMediaLinks["twitter"]; v != nil {
			links.Twitter = derefString(v)
		}
		if v := parsed.SocialMediaLinks["facebook"]; v != nil {
			links.Facebook = derefString(v)
		}
		if v := parsed.SocialMediaLinks["youtube"]; v != nil {
			links.Youtube = derefString(v)
		}
		if v := parsed.SocialMediaLinks["website"]; v != nil {
			links.Website = derefString(v)
		}
		data.SocialMediaLinks = links
	}

	return data, nil
}

func (c *OpenAIGPTClient) EvaluateQuality(ctx context.Context, stockCode string, data *shortsv1alpha1.EnrichmentData) (*shortsv1alpha1.QualityScore, error) {
	if data == nil {
		return nil, fmt.Errorf("enrichment data is required")
	}

	systemPrompt := `You are evaluating the quality of an ASX company enrichment result for internal review.
Return ONLY valid JSON. No markdown. No commentary.
Scores must be between 0.0 and 1.0.`

	// Keep the evaluation prompt stable and deterministic.
	payload, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal enrichment data for quality evaluation: %w", err)
	}

	userPrompt := fmt.Sprintf(`
Stock Code: %s

Evaluate the enrichment JSON below. Score:
- completeness_score: are the key fields present and non-empty?
- accuracy_score: does the content look plausible and specific (not generic)?
- overall_score: weighted overall (you choose weights, explain via strengths/warnings)

Return JSON:
{
  "overall_score": 0.0,
  "completeness_score": 0.0,
  "accuracy_score": 0.0,
  "warnings": ["..."],
  "strengths": ["..."]
}

Enrichment JSON:
%s
`, stockCode, string(payload))

	req := openai.ChatCompletionRequest{
		Model: c.model,
		Messages: []openai.ChatCompletionMessage{
			{Role: openai.ChatMessageRoleSystem, Content: systemPrompt},
			{Role: openai.ChatMessageRoleUser, Content: userPrompt},
		},
		Temperature: 0.0,
	}

	callCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	resp, err := c.client.CreateChatCompletion(callCtx, req)
	if err != nil {
		return nil, fmt.Errorf("gpt quality evaluation failed: %w", err)
	}
	if len(resp.Choices) == 0 {
		return nil, fmt.Errorf("gpt quality evaluation returned no choices")
	}

	raw := strings.TrimSpace(resp.Choices[0].Message.Content)
	raw = extractLikelyJSON(raw)

	var parsed struct {
		OverallScore      float64  `json:"overall_score"`
		CompletenessScore float64  `json:"completeness_score"`
		AccuracyScore     float64  `json:"accuracy_score"`
		Warnings          []string `json:"warnings"`
		Strengths         []string `json:"strengths"`
	}
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil, fmt.Errorf("failed to parse quality JSON: %w", err)
	}

	return &shortsv1alpha1.QualityScore{
		OverallScore:      clamp01(parsed.OverallScore),
		CompletenessScore: clamp01(parsed.CompletenessScore),
		AccuracyScore:     clamp01(parsed.AccuracyScore),
		Warnings:          parsed.Warnings,
		Strengths:         parsed.Strengths,
	}, nil
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return strings.TrimSpace(*s)
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func extractLikelyJSON(s string) string {
	// Strip common markdown fences if present.
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "```json")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSuffix(s, "```")
	s = strings.TrimSpace(s)

	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start >= 0 && end > start {
		return s[start : end+1]
	}
	return s
}


