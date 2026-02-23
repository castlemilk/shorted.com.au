package enrichment

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ExaClient interface for searching with Exa AI
type ExaClient interface {
	SearchPeople(ctx context.Context, companyName, personName, role string) (*ExaSearchResult, error)
	SearchCompanyPeople(ctx context.Context, companyName, stockCode string) (*ExaSearchResult, error)
}

// ExaSearchResult represents a search result from Exa
type ExaSearchResult struct {
	Results    []ExaResult `json:"results"`
	Autoprompt string      `json:"autoprompt,omitempty"`
}

// ExaResult represents a single search result from Exa
type ExaResult struct {
	ID            string  `json:"id"`
	URL           string  `json:"url"`
	Title         string  `json:"title"`
	Author        string  `json:"author,omitempty"`
	PublishedDate string  `json:"published_date,omitempty"`
	Text          string  `json:"text,omitempty"`
	Score         float64 `json:"score,omitempty"`
	Image         string  `json:"image,omitempty"`
}

// ExaCitation represents a citation from Exa search (for answer endpoint)
type ExaCitation struct {
	ID            string `json:"id"`
	URL           string `json:"url"`
	Title         string `json:"title"`
	Author        string `json:"author"`
	PublishedDate string `json:"publishedDate"`
	Text          string `json:"text"`
}

// EnhancedPerson contains structured person data extracted from Exa search
type EnhancedPerson struct {
	Name        string
	Role        string
	Bio         string
	ImageURL    string // From Exa result.Image or LinkedIn profile
	LinkedInURL string // Extracted from result URLs containing linkedin.com/in/
	SourceURL   string // Best matching result URL
	SourceType  string // "exa"
}

type exaClient struct {
	apiKey  string
	baseURL string
	client  *http.Client
}

// NewExaClient creates a new Exa AI client
func NewExaClient(apiKey string) (ExaClient, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, fmt.Errorf("EXA_API_KEY is required")
	}
	return &exaClient{
		apiKey:  strings.TrimSpace(apiKey),
		baseURL: "https://api.exa.ai",
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
	}, nil
}

// doSearch performs a search request against the Exa API
func (c *exaClient) doSearch(ctx context.Context, reqBody map[string]interface{}) (*ExaSearchResult, error) {
	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/search", bytes.NewBuffer(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("x-api-key", c.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("exa API request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("exa API returned status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	var result ExaSearchResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode exa response: %w", err)
	}

	return &result, nil
}

// SearchPeople searches for information about a person using Exa AI
func (c *exaClient) SearchPeople(ctx context.Context, companyName, personName, role string) (*ExaSearchResult, error) {
	if strings.TrimSpace(personName) == "" {
		return nil, fmt.Errorf("person name is required")
	}

	query := personName
	if role != "" {
		query = fmt.Sprintf("%s %s", personName, role)
	}
	if companyName != "" {
		query = fmt.Sprintf("%s at %s", query, companyName)
	}

	reqBody := map[string]interface{}{
		"query":          query,
		"category":       "people",
		"num_results":    5,
		"text":           true,
		"use_autoprompt": false,
		"contents": map[string]interface{}{
			"text": map[string]interface{}{
				"max_characters": 1000,
			},
		},
	}

	return c.doSearch(ctx, reqBody)
}

// SearchCompanyPeople searches for a company's leadership/board page using Exa AI
func (c *exaClient) SearchCompanyPeople(ctx context.Context, companyName, stockCode string) (*ExaSearchResult, error) {
	if strings.TrimSpace(companyName) == "" {
		return nil, fmt.Errorf("company name is required")
	}

	query := fmt.Sprintf("%s ASX board of directors leadership team", companyName)
	if stockCode != "" {
		query = fmt.Sprintf("%s %s", query, stockCode)
	}

	reqBody := map[string]interface{}{
		"query":          query,
		"category":       "company",
		"num_results":    3,
		"text":           true,
		"use_autoprompt": false,
		"contents": map[string]interface{}{
			"text": map[string]interface{}{
				"max_characters": 2000,
			},
		},
	}

	return c.doSearch(ctx, reqBody)
}

// EnhancePersonWithExa enhances person information using Exa search.
// Returns an EnhancedPerson with image URL, LinkedIn URL, and source attribution.
func EnhancePersonWithExa(ctx context.Context, exaClient ExaClient, person *Person, companyName string) (*EnhancedPerson, error) {
	if exaClient == nil || person == nil {
		return nil, nil
	}

	result, err := exaClient.SearchPeople(ctx, companyName, person.Name, person.Role)
	if err != nil {
		return nil, err
	}

	enhanced := &EnhancedPerson{
		Name:       person.Name,
		Role:       person.Role,
		Bio:        person.Bio,
		SourceType: "exa",
	}

	if len(result.Results) == 0 {
		return enhanced, nil
	}

	// Extract LinkedIn URL and image from results
	for _, res := range result.Results {
		// Extract LinkedIn profile URL
		if enhanced.LinkedInURL == "" && strings.Contains(res.URL, "linkedin.com/in/") {
			enhanced.LinkedInURL = res.URL
		}

		// Extract image (Exa returns profile thumbnails for LinkedIn results)
		if enhanced.ImageURL == "" && res.Image != "" {
			enhanced.ImageURL = res.Image
		}

		// Use best result URL as source
		if enhanced.SourceURL == "" && res.URL != "" {
			enhanced.SourceURL = res.URL
		}
	}

	// If we found an image from a LinkedIn result but no separate image field,
	// check if the first LinkedIn result has an image
	if enhanced.ImageURL == "" {
		for _, res := range result.Results {
			if res.Image != "" {
				enhanced.ImageURL = res.Image
				break
			}
		}
	}

	return enhanced, nil
}
