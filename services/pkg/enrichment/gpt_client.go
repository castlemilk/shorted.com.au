package enrichment

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"strings"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	openai "github.com/sashabaranov/go-openai"
)

// retryConfig holds retry parameters for OpenAI API calls
type retryConfig struct {
	maxRetries     int
	initialBackoff time.Duration
	maxBackoff     time.Duration
}

// defaultRetryConfig provides sensible defaults for OpenAI API retries
var defaultRetryConfig = retryConfig{
	maxRetries:     3,
	initialBackoff: 2 * time.Second,
	maxBackoff:     30 * time.Second,
}

// retryableOpenAICall executes an OpenAI API call with exponential backoff retry
func retryableOpenAICall[T any](ctx context.Context, cfg retryConfig, operation string, fn func() (T, error)) (T, error) {
	var lastErr error
	var zero T

	for attempt := 0; attempt <= cfg.maxRetries; attempt++ {
		result, err := fn()
		if err == nil {
			return result, nil
		}

		lastErr = err

		// Check if error is retryable (rate limits, timeouts, server errors)
		if !isRetryableError(err) {
			return zero, fmt.Errorf("%s failed (non-retryable): %w", operation, err)
		}

		// Don't retry if context is already cancelled
		if ctx.Err() != nil {
			return zero, fmt.Errorf("%s failed (context cancelled): %w", operation, ctx.Err())
		}

		// Calculate backoff with jitter
		if attempt < cfg.maxRetries {
			backoff := cfg.initialBackoff * time.Duration(1<<uint(attempt))
			if backoff > cfg.maxBackoff {
				backoff = cfg.maxBackoff
			}
			// Add 10-30% jitter
			jitter := time.Duration(float64(backoff) * (0.1 + rand.Float64()*0.2))
			backoff += jitter

			select {
			case <-ctx.Done():
				return zero, fmt.Errorf("%s failed (context cancelled during backoff): %w", operation, ctx.Err())
			case <-time.After(backoff):
				// Continue to next retry
			}
		}
	}

	return zero, fmt.Errorf("%s failed after %d retries: %w", operation, cfg.maxRetries, lastErr)
}

// isRetryableError determines if an OpenAI API error should be retried
func isRetryableError(err error) bool {
	if err == nil {
		return false
	}

	errStr := strings.ToLower(err.Error())

	// Retry on rate limits
	if strings.Contains(errStr, "rate limit") || strings.Contains(errStr, "429") {
		return true
	}

	// Retry on timeouts
	if strings.Contains(errStr, "timeout") || strings.Contains(errStr, "deadline exceeded") {
		return true
	}

	// Retry on server errors (5xx)
	if strings.Contains(errStr, "500") || strings.Contains(errStr, "502") ||
		strings.Contains(errStr, "503") || strings.Contains(errStr, "504") {
		return true
	}

	// Retry on connection errors
	if strings.Contains(errStr, "connection") || strings.Contains(errStr, "network") ||
		strings.Contains(errStr, "eof") {
		return true
	}

	return false
}

// GPTClient interface for company enrichment
type GPTClient interface {
	EnrichCompany(ctx context.Context, stockCode, companyName, industry, website, currentSummary string, reports []*stocksv1alpha1.FinancialReport, metadata *ScrapedMetadata) (*shortsv1alpha1.EnrichmentData, error)
	EvaluateQuality(ctx context.Context, stockCode string, data *shortsv1alpha1.EnrichmentData) (*shortsv1alpha1.QualityScore, error)
	DiscoverWebsite(ctx context.Context, stockCode, companyName, industry string) (string, error)
}

type OpenAIGPTClient struct {
	client *openai.Client
	model  string
}

func NewOpenAIGPTClient(apiKey string) (*OpenAIGPTClient, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, fmt.Errorf("OPENAI_API_KEY is required")
	}
	model := os.Getenv("OPENAI_MODEL")
	if model == "" {
		model = "gpt-4o" // Use gpt-4o as default (cost-effective flagship)
	}
	return &OpenAIGPTClient{
		client: openai.NewClient(apiKey),
		model:  model,
	}, nil
}

func (c *OpenAIGPTClient) EnrichCompany(ctx context.Context, stockCode, companyName, industry, website, currentSummary string, reports []*stocksv1alpha1.FinancialReport, metadata *ScrapedMetadata) (*shortsv1alpha1.EnrichmentData, error) {
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

	req := openai.ChatCompletionRequest{
		Model: c.model,
		Messages: []openai.ChatCompletionMessage{
			{Role: openai.ChatMessageRoleSystem, Content: systemPrompt},
			{Role: openai.ChatMessageRoleUser, Content: userPrompt},
		},
		Temperature: 0.2,
	}

	// Use retry wrapper for the API call with longer timeout for enrichment
	enrichRetryConfig := retryConfig{
		maxRetries:     3,
		initialBackoff: 3 * time.Second,
		maxBackoff:     45 * time.Second,
	}
	resp, err := retryableOpenAICall(ctx, enrichRetryConfig, "company enrichment", func() (openai.ChatCompletionResponse, error) {
		callCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
		defer cancel()
		return c.client.CreateChatCompletion(callCtx, req)
	})
	if err != nil {
		return nil, err
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

	// Use retry wrapper for the API call
	resp, err := retryableOpenAICall(ctx, defaultRetryConfig, "quality evaluation", func() (openai.ChatCompletionResponse, error) {
		callCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		defer cancel()
		return c.client.CreateChatCompletion(callCtx, req)
	})
	if err != nil {
		return nil, err
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

// DiscoverWebsite attempts to find the official corporate website for a company
// when the website field is missing from the company metadata.
// Includes automatic retry with exponential backoff for transient failures.
func (c *OpenAIGPTClient) DiscoverWebsite(ctx context.Context, stockCode, companyName, industry string) (string, error) {
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

	req := openai.ChatCompletionRequest{
		Model: c.model,
		Messages: []openai.ChatCompletionMessage{
			{Role: openai.ChatMessageRoleSystem, Content: systemPrompt},
			{Role: openai.ChatMessageRoleUser, Content: userPrompt},
		},
		Temperature: 0.0,
	}

	// Use retry wrapper for the API call
	resp, err := retryableOpenAICall(ctx, defaultRetryConfig, "website discovery", func() (openai.ChatCompletionResponse, error) {
		callCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
		defer cancel()
		return c.client.CreateChatCompletion(callCtx, req)
	})
	if err != nil {
		return "", err
	}
	if len(resp.Choices) == 0 {
		return "", fmt.Errorf("website discovery returned no choices")
	}

	result := strings.TrimSpace(resp.Choices[0].Message.Content)
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

// isValidWebsiteURL performs basic validation on a website URL
func isValidWebsiteURL(urlStr string) bool {
	// Must have a scheme
	if !strings.HasPrefix(urlStr, "http://") && !strings.HasPrefix(urlStr, "https://") {
		return false
	}
	// Must have a domain
	parts := strings.SplitN(urlStr, "://", 2)
	if len(parts) != 2 || parts[1] == "" {
		return false
	}
	domain := strings.Split(parts[1], "/")[0]
	// Domain must have at least one dot
	if !strings.Contains(domain, ".") {
		return false
	}
	// Domain shouldn't have spaces
	if strings.Contains(domain, " ") {
		return false
	}
	return true
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

