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
}

// ExaSearchResult represents a search result from Exa
type ExaSearchResult struct {
	Results    []ExaResult   `json:"results"`
	Autoprompt string        `json:"autoprompt,omitempty"`
}

// ExaResult represents a single search result from Exa
type ExaResult struct {
	ID          string `json:"id"`
	URL         string `json:"url"`
	Title       string `json:"title"`
	Author      string `json:"author,omitempty"`
	PublishedDate string `json:"published_date,omitempty"`
	Text        string `json:"text,omitempty"`
	Score       float64 `json:"score,omitempty"`
}

// ExaCitation represents a citation from Exa search (for answer endpoint)
type ExaCitation struct {
	ID          string `json:"id"`
	URL         string `json:"url"`
	Title       string `json:"title"`
	Author      string `json:"author"`
	PublishedDate string `json:"publishedDate"`
	Text        string `json:"text"`
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

// SearchPeople searches for information about a person using Exa AI
func (c *exaClient) SearchPeople(ctx context.Context, companyName, personName, role string) (*ExaSearchResult, error) {
	if strings.TrimSpace(personName) == "" {
		return nil, fmt.Errorf("person name is required")
	}

	// Build query for Exa people search
	query := personName
	if role != "" {
		query = fmt.Sprintf("%s %s", personName, role)
	}
	if companyName != "" {
		query = fmt.Sprintf("%s at %s", query, companyName)
	}

	// Use Exa's /search endpoint with category="people" for people search
	// This is more appropriate than /answer for finding people profiles
	reqBody := map[string]interface{}{
		"query":      query,
		"category":   "people", // Use people search category
		"num_results": 5,      // Limit to 5 results
		"text":       true,    // Include full text content
		"use_autoprompt": false, // Don't use autoprompt for people search
	}

	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	// Create HTTP request to /search endpoint
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/search", bytes.NewBuffer(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("x-api-key", c.apiKey)
	req.Header.Set("Content-Type", "application/json")

	// Execute request
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("exa API request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("exa API returned status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	// Parse response
	var result ExaSearchResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode exa response: %w", err)
	}

	return &result, nil
}

// EnhancePersonWithExa enhances person information using Exa search
func EnhancePersonWithExa(ctx context.Context, exaClient ExaClient, person *Person, companyName string) (*Person, error) {
	if exaClient == nil || person == nil {
		return person, nil // Return original if no client or person
	}

	// Search for additional information about this person
	result, err := exaClient.SearchPeople(ctx, companyName, person.Name, person.Role)
	if err != nil {
		// Log error but don't fail - return original person
		return person, nil
	}

	enhanced := *person

	// Enhance bio with information from Exa search results
	if len(result.Results) > 0 {
		// Combine text from top results
		var additionalInfo strings.Builder
		for i, res := range result.Results {
			if i >= 3 { // Limit to top 3 results
				break
			}
			if res.Text != "" {
				additionalInfo.WriteString(res.Text)
				additionalInfo.WriteString(" ")
			}
		}

		additionalText := strings.TrimSpace(additionalInfo.String())
		if additionalText != "" {
			if person.Bio == "" {
				enhanced.Bio = additionalText
			} else {
				// Append additional information
				enhanced.Bio = person.Bio + " " + additionalText
			}
		}

		// Add source URLs
		if len(result.Results) > 0 {
			sources := " Sources: "
			for i, res := range result.Results {
				if i >= 2 { // Limit to first 2 sources
					break
				}
				if res.URL != "" {
					sources += res.URL + " "
				}
			}
			enhanced.Bio += sources
		}
	}

	return &enhanced, nil
}
