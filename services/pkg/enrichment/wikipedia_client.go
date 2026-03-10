package enrichment

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// WikipediaClient retrieves company and person data from Wikipedia
type WikipediaClient interface {
	GetCompanyPage(ctx context.Context, companyName string) (*WikipediaCompanyData, error)
	GetPersonImage(ctx context.Context, personName string) (imageURL, pageURL string, err error)
}

// WikipediaCompanyData contains structured data from a company's Wikipedia page
type WikipediaCompanyData struct {
	PageURL      string
	Extract      string // Plain text summary
	KeyPeople    []WikipediaPerson
	Founded      string
	Headquarters string
	WikidataID   string
}

// WikipediaPerson represents a key person found on a Wikipedia company page
type WikipediaPerson struct {
	Name     string
	Role     string
	ImageURL string // Wikimedia Commons thumbnail URL
	PageURL  string // Person's own Wikipedia page (if exists)
}

type wikipediaClient struct {
	client    *http.Client
	userAgent string
	delay     time.Duration
	lastCall  time.Time
}

// NewWikipediaClient creates a new Wikipedia API client
func NewWikipediaClient() WikipediaClient {
	return &wikipediaClient{
		client: &http.Client{
			Timeout: 15 * time.Second,
		},
		userAgent: "Shorted.com.au/1.0 (support@shorted.com.au)",
		delay:     200 * time.Millisecond,
	}
}

// rateLimit waits to respect Wikipedia API etiquette (200ms between requests)
func (w *wikipediaClient) rateLimit() {
	if !w.lastCall.IsZero() {
		elapsed := time.Since(w.lastCall)
		if elapsed < w.delay {
			time.Sleep(w.delay - elapsed)
		}
	}
	w.lastCall = time.Now()
}

// wikiPageSummary is the response from Wikipedia REST API /page/summary/{title}
type wikiPageSummary struct {
	Title       string `json:"title"`
	DisplayName string `json:"displaytitle"`
	Extract     string `json:"extract"`
	ContentURLs struct {
		Desktop struct {
			Page string `json:"page"`
		} `json:"desktop"`
	} `json:"content_urls"`
	Thumbnail *struct {
		Source string `json:"source"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
	} `json:"thumbnail"`
	WikibaseItem string `json:"wikibase_item"`
	Type         string `json:"type"`
}

// GetCompanyPage finds a company's Wikipedia page and extracts basic data
func (w *wikipediaClient) GetCompanyPage(ctx context.Context, companyName string) (*WikipediaCompanyData, error) {
	if strings.TrimSpace(companyName) == "" {
		return nil, fmt.Errorf("company name is required")
	}

	// Step 1: Search for the company page
	w.rateLimit()
	pageTitle, err := w.searchPage(ctx, companyName)
	if err != nil {
		return nil, fmt.Errorf("wikipedia search failed: %w", err)
	}
	if pageTitle == "" {
		return nil, fmt.Errorf("no Wikipedia page found for %q", companyName)
	}

	// Step 2: Get page summary
	w.rateLimit()
	summary, err := w.getPageSummary(ctx, pageTitle)
	if err != nil {
		return nil, fmt.Errorf("failed to get page summary: %w", err)
	}

	data := &WikipediaCompanyData{
		PageURL:    summary.ContentURLs.Desktop.Page,
		Extract:    summary.Extract,
		WikidataID: summary.WikibaseItem,
	}

	return data, nil
}

// GetPersonImage retrieves a person's image from their Wikipedia page.
// It validates that the page is likely about the correct person by checking
// that the extract mentions business/executive context, to avoid false positives
// where similarly-named athletes, artists, or historical figures are returned.
func (w *wikipediaClient) GetPersonImage(ctx context.Context, personName string) (string, string, error) {
	if strings.TrimSpace(personName) == "" {
		return "", "", fmt.Errorf("person name is required")
	}

	// Clean name for searching — remove titles and qualifications
	cleanName := cleanPersonNameForSearch(personName)
	if cleanName == "" {
		return "", "", nil
	}

	// Search for the person's page
	w.rateLimit()
	pageTitle, err := w.searchPage(ctx, cleanName)
	if err != nil {
		return "", "", err
	}
	if pageTitle == "" {
		return "", "", nil // No page found — not an error
	}

	// Get page summary (includes thumbnail)
	w.rateLimit()
	summary, err := w.getPageSummary(ctx, pageTitle)
	if err != nil {
		return "", "", err
	}

	// Validate: check if the Wikipedia page is likely about the correct person.
	// Most ASX executives are not famous enough for Wikipedia, so we get false
	// positives like "George Saoud" → "George Sand" (French novelist).
	if !isLikelyCorrectPerson(cleanName, summary) {
		return "", "", nil // Wrong person — skip
	}

	pageURL := summary.ContentURLs.Desktop.Page
	var imageURL string
	if summary.Thumbnail != nil && summary.Thumbnail.Source != "" {
		imageURL = summary.Thumbnail.Source
	}

	return imageURL, pageURL, nil
}

// cleanPersonNameForSearch removes titles (Mr., Dr., etc.) and qualifications
// (B.Sc., MBA, etc.) from a person's name for better Wikipedia search results.
func cleanPersonNameForSearch(name string) string {
	name = strings.TrimSpace(name)

	// Remove common prefixes
	prefixes := []string{"Mr. ", "Mr ", "Mrs. ", "Mrs ", "Ms. ", "Ms ", "Dr. ", "Dr ", "Prof. ", "Prof "}
	for _, prefix := range prefixes {
		name = strings.TrimPrefix(name, prefix)
	}

	// Remove qualifications after the name (anything after common suffixes)
	qualSeps := []string{" B.Sc", " BSc", " B.Com", " BCom", " MBA", " PhD", " Ph.D", " CPA", " CA,", " ACIS", " AFin", " AM,", " AM ", " AO,", " AO ", " FCIS", " FAICD", " BEng", " B.E.", " MAusIMM"}
	nameLower := strings.ToLower(name)
	for _, sep := range qualSeps {
		idx := strings.Index(nameLower, strings.ToLower(sep))
		if idx > 0 {
			name = strings.TrimSpace(name[:idx])
			nameLower = strings.ToLower(name)
		}
	}

	// Remove double spaces
	for strings.Contains(name, "  ") {
		name = strings.ReplaceAll(name, "  ", " ")
	}

	return strings.TrimSpace(name)
}

// isLikelyCorrectPerson checks if a Wikipedia page summary is likely about
// the person we're looking for (a business executive) vs a similarly-named
// athlete, artist, or historical figure.
func isLikelyCorrectPerson(searchName string, summary *wikiPageSummary) bool {
	if summary == nil || summary.Extract == "" {
		return false
	}

	extract := strings.ToLower(summary.Extract)
	title := strings.ToLower(summary.Title)

	// Check that the Wikipedia title roughly matches the search name
	searchParts := strings.Fields(strings.ToLower(searchName))
	if len(searchParts) >= 2 {
		// At minimum, the surname should appear in the Wikipedia title
		surname := searchParts[len(searchParts)-1]
		if !strings.Contains(title, surname) {
			return false
		}
	}

	// Business/executive context keywords — if the extract mentions these,
	// it's more likely to be the right person
	businessKeywords := []string{
		"business", "executive", "ceo", "chairman", "director",
		"managing director", "chief", "company", "corporation",
		"limited", "asx", "australian", "mining", "energy",
		"pharmaceutical", "technology", "financial", "board",
	}

	for _, kw := range businessKeywords {
		if strings.Contains(extract, kw) {
			return true
		}
	}

	// If the extract is about a clearly different domain, reject
	nonBusinessKeywords := []string{
		"footballer", "soccer", "baseball", "basketball", "hockey",
		"cricket", "tennis", "olympic", "athlete", "singer",
		"actor", "actress", "musician", "novelist", "poet",
		"painter", "artist", "composer", "politician", "senator",
		"congressman", "governor", "bishop", "archbishop",
	}

	for _, kw := range nonBusinessKeywords {
		if strings.Contains(extract, kw) {
			return false
		}
	}

	// No strong signal either way — default to rejecting to avoid false positives.
	// ASX executives rarely have Wikipedia pages, so false positives are much more
	// common than true positives.
	return false
}

// searchPage searches Wikipedia for a page title matching the query
func (w *wikipediaClient) searchPage(ctx context.Context, query string) (string, error) {
	searchURL := fmt.Sprintf(
		"https://en.wikipedia.org/w/api.php?action=opensearch&search=%s&limit=3&namespace=0&format=json",
		url.QueryEscape(query),
	)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, searchURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", w.userAgent)

	resp, err := w.client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("wikipedia API returned status %d", resp.StatusCode)
	}

	// opensearch returns: [query, [titles...], [descriptions...], [urls...]]
	var raw []json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return "", err
	}

	if len(raw) < 2 {
		return "", nil
	}

	var titles []string
	if err := json.Unmarshal(raw[1], &titles); err != nil {
		return "", err
	}

	if len(titles) == 0 {
		return "", nil
	}

	return titles[0], nil
}

// getPageSummary fetches the summary for a Wikipedia page title
func (w *wikipediaClient) getPageSummary(ctx context.Context, title string) (*wikiPageSummary, error) {
	summaryURL := fmt.Sprintf(
		"https://en.wikipedia.org/api/rest_v1/page/summary/%s",
		url.PathEscape(title),
	)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, summaryURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", w.userAgent)

	resp, err := w.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("wikipedia summary API returned status %d for %q", resp.StatusCode, title)
	}

	var summary wikiPageSummary
	if err := json.NewDecoder(resp.Body).Decode(&summary); err != nil {
		return nil, err
	}

	return &summary, nil
}
