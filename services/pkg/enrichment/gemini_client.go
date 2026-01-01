package enrichment

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/google/generative-ai-go/genai"
	"google.golang.org/api/option"
)

type GeminiGPTClient struct {
	client *genai.Client
	model  string
}

func NewGeminiGPTClient(apiKey string) (*GeminiGPTClient, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, fmt.Errorf("GEMINI_API_KEY is required")
	}

	ctx := context.Background()
	client, err := genai.NewClient(ctx, option.WithAPIKey(apiKey))
	if err != nil {
		return nil, fmt.Errorf("failed to create Gemini client: %w", err)
	}

	return &GeminiGPTClient{
		client: client,
		model:  "gemini-1.5-pro",
	}, nil
}

func (c *GeminiGPTClient) EnrichCompany(ctx context.Context, stockCode, companyName, industry, website, currentSummary string, reports []*stocksv1alpha1.FinancialReport, metadata *ScrapedMetadata) (*shortsv1alpha1.EnrichmentData, error) {
	if strings.TrimSpace(stockCode) == "" {
		return nil, fmt.Errorf("stock code is required")
	}

	systemPrompt := `You are a financial analyst specializing in Australian Stock Exchange (ASX) companies.

Return ONLY valid JSON matching the requested schema. No markdown. No commentary.

Quality rules:
- Be specific and factual; avoid generic template language.
- If a field is truly unavailable, use null (for strings/objects) or [] (for arrays).
- Provide exactly 5 tags.
- Use the scraped website metadata to extract accurate information, especially for key_people.`

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

	// Build metadata section
	metadataSection := ""
	if metadata != nil && metadata.ContextText != "" {
		metadataSection = fmt.Sprintf(`
<scraped_website_metadata>
%s
</scraped_website_metadata>`, metadata.ContextText)
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
%s

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

IMPORTANT: Extract key_people information from the scraped_website_metadata section above. Look for leadership pages, board members, and executive team information.
`, companyName, stockCode, industry, website, currentSummary, reportsSection, metadataSection)

	// Create model
	model := c.client.GenerativeModel(c.model)
	model.SetTemperature(0.2)
	
	// Set system instruction
	model.SystemInstruction = &genai.Content{
		Parts: []genai.Part{genai.Text(systemPrompt)},
	}

	// Protect against runaway calls
	callCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()

	// Generate content with system instruction and user prompt
	resp, err := model.GenerateContent(callCtx, genai.Text(userPrompt))
	if err != nil {
		return nil, fmt.Errorf("gemini enrichment failed: %w", err)
	}

	if len(resp.Candidates) == 0 || len(resp.Candidates[0].Content.Parts) == 0 {
		return nil, fmt.Errorf("gemini enrichment returned no content")
	}

	raw := ""
	for _, part := range resp.Candidates[0].Content.Parts {
		if text, ok := part.(genai.Text); ok {
			raw += string(text)
		}
	}

	raw = strings.TrimSpace(raw)
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
		CompetitiveAdvantages *string                `json:"competitive_advantages"`
		RiskFactors           []string               `json:"risk_factors"`
		RecentDevelopments    *string                `json:"recent_developments"`
		SocialMediaLinks      map[string]*string     `json:"social_media_links"`
	}

	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil, fmt.Errorf("failed to parse Gemini JSON: %w", err)
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

func (c *GeminiGPTClient) EvaluateQuality(ctx context.Context, stockCode string, data *shortsv1alpha1.EnrichmentData) (*shortsv1alpha1.QualityScore, error) {
	if data == nil {
		return nil, fmt.Errorf("enrichment data is required")
	}

	systemPrompt := `You are evaluating the quality of an ASX company enrichment result for internal review.
Return ONLY valid JSON. No markdown. No commentary.
Scores must be between 0.0 and 1.0.`

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

	model := c.client.GenerativeModel(c.model)
	model.SetTemperature(0.0)
	
	// Set system instruction
	model.SystemInstruction = &genai.Content{
		Parts: []genai.Part{genai.Text(systemPrompt)},
	}

	callCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	resp, err := model.GenerateContent(callCtx, genai.Text(userPrompt))
	if err != nil {
		return nil, fmt.Errorf("gemini quality evaluation failed: %w", err)
	}

	if len(resp.Candidates) == 0 || len(resp.Candidates[0].Content.Parts) == 0 {
		return nil, fmt.Errorf("gemini quality evaluation returned no content")
	}

	raw := ""
	for _, part := range resp.Candidates[0].Content.Parts {
		if text, ok := part.(genai.Text); ok {
			raw += string(text)
		}
	}

	raw = strings.TrimSpace(raw)
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

func (c *GeminiGPTClient) Close() error {
	if c.client != nil {
		return c.client.Close()
	}
	return nil
}

