package enrichment

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"strings"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"github.com/google/generative-ai-go/genai"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
	"google.golang.org/api/option"
)

type GeminiGPTClient struct {
	client *genai.Client
	model  string
}

func recordEnrichmentGeminiGeneration(ctx context.Context, model, phase, status string, usage *genai.UsageMetadata) {
	attrs := []attribute.KeyValue{
		attribute.String("feature", "enrichment"),
		attribute.String("model", model),
		attribute.String("phase", phase),
		attribute.String("status", status),
	}
	if shortedotel.AIRequestsTotal != nil {
		shortedotel.AIRequestsTotal.Add(ctx, 1, otelmetric.WithAttributes(attrs...))
	}
	billablePromptTokens := int64(0)
	if usage != nil {
		recordEnrichmentTokenCount(ctx, attrs, "prompt", int64(usage.PromptTokenCount))
		recordEnrichmentTokenCount(ctx, attrs, "cached_prompt", int64(usage.CachedContentTokenCount))
		billablePrompt := int64(usage.PromptTokenCount - usage.CachedContentTokenCount)
		if billablePrompt < 0 {
			billablePrompt = 0
		}
		billablePromptTokens = billablePrompt
		recordEnrichmentTokenCount(ctx, attrs, "billable_prompt", billablePrompt)
		recordEnrichmentTokenCount(ctx, attrs, "candidate", int64(usage.CandidatesTokenCount))
		recordEnrichmentTokenCount(ctx, attrs, "total", int64(usage.TotalTokenCount))
	}

	promptTokens, cachedTokens, candidateTokens, totalTokens := int32(0), int32(0), int32(0), int32(0)
	if usage != nil {
		promptTokens = usage.PromptTokenCount
		cachedTokens = usage.CachedContentTokenCount
		candidateTokens = usage.CandidatesTokenCount
		totalTokens = usage.TotalTokenCount
	}
	log.Printf(
		"%s",
		mustMarshalEnrichmentLogEvent(map[string]any{
			"type":                   "cost_event",
			"event_type":             "gemini_request",
			"feature":                "enrichment",
			"model":                  model,
			"phase":                  phase,
			"status":                 status,
			"prompt_tokens":          promptTokens,
			"cached_prompt_tokens":   cachedTokens,
			"billable_prompt_tokens": billablePromptTokens,
			"candidate_tokens":       candidateTokens,
			"total_tokens":           totalTokens,
		}),
	)
}

func recordEnrichmentTokenCount(ctx context.Context, baseAttrs []attribute.KeyValue, tokenType string, value int64) {
	if value <= 0 || shortedotel.AITokensTotal == nil {
		return
	}
	attrs := append([]attribute.KeyValue{}, baseAttrs...)
	attrs = append(attrs, attribute.String("token_type", tokenType))
	shortedotel.AITokensTotal.Add(ctx, value, otelmetric.WithAttributes(attrs...))
}

func mustMarshalEnrichmentLogEvent(event map[string]any) string {
	data, err := json.Marshal(event)
	if err != nil {
		return `{"type":"instrumentation_error","error_name":"json_marshal_failed"}`
	}
	return string(data)
}

// retryableGeminiCall wraps a Gemini API call with exponential backoff retry logic.
func retryableGeminiCall(ctx context.Context, maxRetries int, label string, fn func() (*genai.GenerateContentResponse, error)) (*genai.GenerateContentResponse, error) {
	var lastErr error
	for attempt := 0; attempt <= maxRetries; attempt++ {
		if attempt > 0 {
			backoff := time.Duration(math.Min(float64(time.Second)*math.Pow(2, float64(attempt)), float64(30*time.Second)))
			select {
			case <-ctx.Done():
				return nil, fmt.Errorf("%s: context cancelled during retry backoff: %w", label, ctx.Err())
			case <-time.After(backoff):
			}
		}

		resp, err := fn()
		if err == nil {
			return resp, nil
		}
		lastErr = err

		errStr := err.Error()
		retryable := strings.Contains(errStr, "429") ||
			strings.Contains(errStr, "500") ||
			strings.Contains(errStr, "502") ||
			strings.Contains(errStr, "503") ||
			strings.Contains(errStr, "504") ||
			strings.Contains(errStr, "deadline exceeded") ||
			strings.Contains(errStr, "connection reset") ||
			strings.Contains(errStr, "RESOURCE_EXHAUSTED")
		if !retryable {
			return nil, err
		}
	}
	return nil, fmt.Errorf("%s failed after %d retries: %w", label, maxRetries, lastErr)
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
		model:  "gemini-2.5-flash",
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

IMPORTANT rules for key_people:
- First check the scraped_website_metadata for leadership pages, board members, and executive team information.
- If no people are found in the scraped data, use your own knowledge of the company's current leadership team. For major ASX-listed companies (e.g., BHP, CBA, CSL, NAB, TLS), the CEO, CFO, and Chair are widely known public figures.
- Every person MUST have an actual full name. Do NOT return placeholder entries like {"name": "", "role": "CEO"}.
- If you genuinely cannot determine any real names from either the scraped data or your knowledge, return "key_people": [] (empty array).
- Include at least the CEO/MD, Chair, and CFO when their names are known. Add other C-suite/board members if available.
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

	// Generate content with retries for transient errors
	resp, err := retryableGeminiCall(callCtx, 3, "gemini enrichment", func() (*genai.GenerateContentResponse, error) {
		return model.GenerateContent(callCtx, genai.Text(userPrompt))
	})
	if err != nil {
		recordEnrichmentGeminiGeneration(ctx, c.model, "company_enrichment", "error", nil)
		return nil, fmt.Errorf("gemini enrichment failed: %w", err)
	}
	recordEnrichmentGeminiGeneration(ctx, c.model, "company_enrichment", "success", resp.UsageMetadata)

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
		Tags            []string `json:"tags"`
		EnhancedSummary *string  `json:"enhanced_summary"`
		CompanyHistory  *string  `json:"company_history"`
		KeyPeople       []struct {
			Name string `json:"name"`
			Role string `json:"role"`
			Bio  string `json:"bio"`
		} `json:"key_people"`
		CompetitiveAdvantages *string            `json:"competitive_advantages"`
		RiskFactors           []string           `json:"risk_factors"`
		RecentDevelopments    *string            `json:"recent_developments"`
		SocialMediaLinks      map[string]*string `json:"social_media_links"`
	}

	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil, fmt.Errorf("failed to parse Gemini JSON: %w", err)
	}

	data := &shortsv1alpha1.EnrichmentData{
		Tags:                  parsed.Tags,
		EnhancedSummary:       derefString(parsed.EnhancedSummary),
		CompanyHistory:        derefString(parsed.CompanyHistory),
		CompetitiveAdvantages: derefString(parsed.CompetitiveAdvantages),
		RiskFactors:           parsed.RiskFactors,
		RecentDevelopments:    derefString(parsed.RecentDevelopments),
		FinancialReports:      reports,
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

	resp, err := retryableGeminiCall(callCtx, 3, "gemini quality evaluation", func() (*genai.GenerateContentResponse, error) {
		return model.GenerateContent(callCtx, genai.Text(userPrompt))
	})
	if err != nil {
		recordEnrichmentGeminiGeneration(ctx, c.model, "quality_evaluation", "error", nil)
		return nil, fmt.Errorf("gemini quality evaluation failed: %w", err)
	}
	recordEnrichmentGeminiGeneration(ctx, c.model, "quality_evaluation", "success", resp.UsageMetadata)

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

// DiscoverWebsite attempts to find the official corporate website for a company
// when the website field is missing from the company metadata.
func (c *GeminiGPTClient) DiscoverWebsite(ctx context.Context, stockCode, companyName, industry string) (string, error) {
	if strings.TrimSpace(companyName) == "" {
		return "", fmt.Errorf("company name is required")
	}

	systemPrompt := `You are an expert at finding official corporate websites for Australian Stock Exchange (ASX) listed companies.

Your task is to return the official corporate website URL for the given company.

Rules:
- Return ONLY a valid URL string (no JSON, no markdown, no explanation)
- The URL must be the official company website, NOT social media profiles
- For well-known Australian companies, use their known domain (e.g., guzmanygomez.com for Guzman Y Gomez)
- If you know the company website, return it even if you're not 100% certain
- Only return "UNKNOWN" if you truly have no idea what the company's website might be`

	userPrompt := fmt.Sprintf(`Find the official corporate website for this ASX-listed company:

Company Name: %s
ASX Stock Code: %s
Industry: %s

Common patterns for Australian company websites:
- companyname.com.au
- companyname.com
- thecompanyname.com.au

Return ONLY the website URL or "UNKNOWN" if you cannot determine it.`, companyName, stockCode, industry)

	model := c.client.GenerativeModel(c.model)
	model.SetTemperature(0.0)

	// Set system instruction
	model.SystemInstruction = &genai.Content{
		Parts: []genai.Part{genai.Text(systemPrompt)},
	}

	callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	resp, err := retryableGeminiCall(callCtx, 2, "website discovery", func() (*genai.GenerateContentResponse, error) {
		return model.GenerateContent(callCtx, genai.Text(userPrompt))
	})
	if err != nil {
		recordEnrichmentGeminiGeneration(ctx, c.model, "website_discovery", "error", nil)
		return "", fmt.Errorf("website discovery failed: %w", err)
	}
	recordEnrichmentGeminiGeneration(ctx, c.model, "website_discovery", "success", resp.UsageMetadata)

	if len(resp.Candidates) == 0 || len(resp.Candidates[0].Content.Parts) == 0 {
		return "", fmt.Errorf("website discovery returned no content")
	}

	result := ""
	for _, part := range resp.Candidates[0].Content.Parts {
		if text, ok := part.(genai.Text); ok {
			result += string(text)
		}
	}

	result = strings.TrimSpace(result)
	result = strings.Trim(result, "\"'`")
	result = strings.TrimSpace(result)

	// Check for unknown response
	if strings.EqualFold(result, "UNKNOWN") || result == "" {
		return "", nil // No website found, but not an error
	}

	// Validate URL format
	if !strings.HasPrefix(result, "http://") && !strings.HasPrefix(result, "https://") {
		result = "https://" + result
	}

	// Basic URL validation
	if !isValidWebsiteURL(result) {
		return "", nil // Invalid URL format
	}

	return result, nil
}

// ExtractPeopleFromText extracts key people from raw scraped text using the LLM.
// Used as a fallback when the main enrichment phase returns 0 key_people.
func (c *GeminiGPTClient) ExtractPeopleFromText(ctx context.Context, stockCode, companyName, rawText string) ([]*stocksv1alpha1.CompanyPerson, error) {
	if strings.TrimSpace(rawText) == "" {
		return nil, nil
	}

	systemPrompt := `You are extracting key people (board members, executives, leadership) from raw website text for an ASX-listed company.

Return ONLY valid JSON. No markdown. No commentary.`

	userPrompt := fmt.Sprintf(`Extract key people from the following website content for %s (ASX: %s).

Return a JSON object with this EXACT structure:
{
  "key_people": [
    {"name": "Full Name", "role": "Title/Role", "bio": "Brief 1-2 sentence bio if available"}
  ]
}

Rules:
- Every person MUST have a real full name. Do NOT include entries with empty names.
- Include roles like CEO, CFO, Chair, Managing Director, Non-Executive Director, etc.
- If you cannot determine any real names, return {"key_people": []}
- Maximum 10 people.

Website content:
%s`, companyName, stockCode, rawText)

	model := c.client.GenerativeModel(c.model)
	model.SetTemperature(0.1)
	model.SystemInstruction = &genai.Content{
		Parts: []genai.Part{genai.Text(systemPrompt)},
	}

	callCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	resp, err := retryableGeminiCall(callCtx, 2, "people extraction", func() (*genai.GenerateContentResponse, error) {
		return model.GenerateContent(callCtx, genai.Text(userPrompt))
	})
	if err != nil {
		recordEnrichmentGeminiGeneration(ctx, c.model, "people_extraction", "error", nil)
		return nil, fmt.Errorf("people extraction failed: %w", err)
	}
	recordEnrichmentGeminiGeneration(ctx, c.model, "people_extraction", "success", resp.UsageMetadata)

	if len(resp.Candidates) == 0 || len(resp.Candidates[0].Content.Parts) == 0 {
		return nil, fmt.Errorf("people extraction returned no content")
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
		KeyPeople []struct {
			Name string `json:"name"`
			Role string `json:"role"`
			Bio  string `json:"bio"`
		} `json:"key_people"`
	}
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil, fmt.Errorf("failed to parse people extraction JSON: %w", err)
	}

	people := make([]*stocksv1alpha1.CompanyPerson, 0, len(parsed.KeyPeople))
	for _, p := range parsed.KeyPeople {
		name := strings.TrimSpace(p.Name)
		if name == "" {
			continue
		}
		people = append(people, &stocksv1alpha1.CompanyPerson{
			Name: name,
			Role: strings.TrimSpace(p.Role),
			Bio:  strings.TrimSpace(p.Bio),
		})
	}

	return people, nil
}

func (c *GeminiGPTClient) Close() error {
	if c.client != nil {
		return c.client.Close()
	}
	return nil
}
