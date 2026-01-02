package enrichment

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
)

// ScrapedMetadata contains structured data scraped from company websites
type ScrapedMetadata struct {
	// Leadership/Board information
	LeadershipPages []LeadershipPage `json:"leadership_pages"`
	
	// About/Company information pages
	AboutPages []AboutPage `json:"about_pages"`
	
	// Key links found on the website
	KeyLinks []KeyLink `json:"key_links"`
	
	// Raw text content from important pages (for LLM context)
	ContextText string `json:"context_text"`
}

// LeadershipPage contains information about leadership/board pages
type LeadershipPage struct {
	URL         string   `json:"url"`
	Title       string   `json:"title"`
	People      []Person `json:"people"`
	Content     string   `json:"content"` // Cleaned text content
}

// AboutPage contains information about company/about pages
type AboutPage struct {
	URL        string `json:"url"`
	Title      string `json:"title"`
	Content    string `json:"content"` // Extracted text content
}

// Person represents a key person found on leadership pages
type Person struct {
	Name string `json:"name"`
	Role string `json:"role"`
	Bio  string `json:"bio"`
}

// KeyLink represents an important link found on the website
type KeyLink struct {
	URL         string `json:"url"`
	Text        string `json:"text"`
	Description string `json:"description"`
	Category    string `json:"category"` // e.g., "investors", "sustainability", "news"
}

// CompanyMetadataScraper interface for scraping company metadata
type CompanyMetadataScraper interface {
	ScrapeMetadata(ctx context.Context, website, companyName string, exaClient ExaClient) (*ScrapedMetadata, error)
}

type MetadataScraper struct {
	httpClient *http.Client
}

func NewMetadataScraper() *MetadataScraper {
	return &MetadataScraper{
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (s *MetadataScraper) ScrapeMetadata(ctx context.Context, website, companyName string, exaClient ExaClient) (*ScrapedMetadata, error) {
	website = strings.TrimSpace(website)
	if website == "" {
		return &ScrapedMetadata{}, nil
	}

	rootURL, err := normalizeWebsiteURL(website)
	if err != nil {
		return nil, err
	}

	metadata := &ScrapedMetadata{
		LeadershipPages: []LeadershipPage{},
		AboutPages:       []AboutPage{},
		KeyLinks:         []KeyLink{},
	}

	// Build seed URLs for common patterns
	seedURLs := buildMetadataSeedURLs(rootURL)
	
	// Scrape leadership/board pages
	leadershipURLs := findLeadershipPages(ctx, s.httpClient, rootURL, seedURLs)
	for _, u := range leadershipURLs {
		page, err := s.scrapeLeadershipPage(ctx, u)
		if err != nil {
			continue // Skip failed pages
		}
		if page != nil {
			// Enhance people with Exa search if available
			if exaClient != nil && companyName != "" {
				for i := range page.People {
					enhanced, err := EnhancePersonWithExa(ctx, exaClient, &page.People[i], companyName)
					if err == nil && enhanced != nil {
						page.People[i] = *enhanced
					}
				}
			}
			metadata.LeadershipPages = append(metadata.LeadershipPages, *page)
		}
	}

	// Scrape about pages
	aboutURLs := findAboutPages(ctx, s.httpClient, rootURL, seedURLs)
	for _, u := range aboutURLs {
		page, err := s.scrapeAboutPage(ctx, u)
		if err != nil {
			continue
		}
		if page != nil {
			metadata.AboutPages = append(metadata.AboutPages, *page)
		}
	}

	// Find key links
	keyLinks := s.findKeyLinks(ctx, rootURL, seedURLs)
	metadata.KeyLinks = keyLinks

	// Build context text from scraped content
	metadata.ContextText = s.buildContextText(metadata)

	return metadata, nil
}

func buildMetadataSeedURLs(root *url.URL) []string {
	base := *root
	base.Path = strings.TrimRight(base.Path, "/")

	paths := []string{
		"",
		"/about",
		"/about-us",
		"/about/leadership",
		"/about/board",
		"/about/management",
		"/about-us/meet-the-board",
		"/about-us/leadership",
		"/about-us/board-of-directors",
		"/about-us/management-team",
		"/company",
		"/company/leadership",
		"/company/board",
		"/team",
		"/leadership",
		"/board",
		"/board-of-directors",
		"/management",
		"/executive-team",
	}

	seen := make(map[string]struct{}, len(paths))
	var out []string
	for _, p := range paths {
		u := base
		u.Path = p
		u.RawQuery = ""
		s := u.String()
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

func findLeadershipPages(ctx context.Context, client *http.Client, root *url.URL, seedURLs []string) []string {
	var found []string
	visited := make(map[string]struct{})

	for _, u := range seedURLs {
		if _, ok := visited[u]; ok {
			continue
		}
		visited[u] = struct{}{}

		doc, base, err := fetchHTML(ctx, client, u)
		if base == nil {
			continue
		}
		if err != nil || doc == nil {
			continue
		}

		// Check if this looks like a leadership page
		text := strings.ToLower(doc.Text())
		title := strings.ToLower(doc.Find("title").Text())
		combined := text + " " + title

		// Look for leadership indicators
		leadershipKeywords := []string{
			"board of directors", "board members", "directors", "leadership",
			"executive team", "management team", "ceo", "cfo", "chair",
			"meet the board", "our team", "key people", "senior management",
		}

		hasLeadershipContent := false
		for _, kw := range leadershipKeywords {
			if strings.Contains(combined, kw) {
				hasLeadershipContent = true
				break
			}
		}

		if hasLeadershipContent {
			found = append(found, u)
		}

		// Also check links on this page
		doc.Find("a[href]").Each(func(_ int, sel *goquery.Selection) {
			href, _ := sel.Attr("href")
			text := strings.ToLower(strings.TrimSpace(sel.Text()))
			combined := href + " " + text

			for _, kw := range leadershipKeywords {
				if strings.Contains(combined, kw) {
					abs := resolveURL(root, href)
					if abs != "" && sameHost(root, abs) {
						if _, ok := visited[abs]; !ok {
							visited[abs] = struct{}{}
							found = append(found, abs)
						}
					}
					break
				}
			}
		})
	}

	return found
}

func findAboutPages(ctx context.Context, client *http.Client, root *url.URL, seedURLs []string) []string {
	var found []string
	visited := make(map[string]struct{})

	for _, u := range seedURLs {
		if _, ok := visited[u]; ok {
			continue
		}
		visited[u] = struct{}{}

		// Check URL path for about indicators
		uLower := strings.ToLower(u)
		if strings.Contains(uLower, "/about") || strings.Contains(uLower, "/company") {
			doc, _, err := fetchHTML(ctx, client, u)
			if err == nil && doc != nil {
				found = append(found, u)
			}
		}
	}

	return found
}

func (s *MetadataScraper) scrapeLeadershipPage(ctx context.Context, pageURL string) (*LeadershipPage, error) {
	doc, _, err := fetchHTML(ctx, s.httpClient, pageURL)
	if err != nil || doc == nil {
		return nil, err
	}

	page := &LeadershipPage{
		URL:    pageURL,
		Title:  strings.TrimSpace(doc.Find("title").Text()),
		People: []Person{},
	}

	// Extract text content (remove scripts, styles, etc.)
	doc.Find("script, style, iframe, nav, footer, header, form, aside").Remove()
	page.Content = cleanText(doc.Find("body").Text())

	// Try to extract structured person data
	// Look for common patterns: headings with names, followed by roles/bios
	doc.Find("h1, h2, h3, h4, h5, h6, .person, .director, .executive, .team-member, [class*='person'], [class*='director'], [class*='executive']").Each(func(_ int, sel *goquery.Selection) {
		text := strings.TrimSpace(sel.Text())
		if text == "" {
			return
		}

		// Look for name patterns (typically in headings or strong tags)
		name := extractName(text)
		if name == "" {
			return
		}

		// Find role (often in the next sibling or in the same element)
		role := extractRole(sel, text)
		bio := extractBio(sel)

		if name != "" {
			page.People = append(page.People, Person{
				Name: name,
				Role: role,
				Bio:  bio,
			})
		}
	})

	// Also try to find people in structured sections
	doc.Find("section, div").Each(func(_ int, sel *goquery.Selection) {
		text := strings.ToLower(sel.Text())
		if strings.Contains(text, "chair") || strings.Contains(text, "ceo") || strings.Contains(text, "cfo") || strings.Contains(text, "director") {
			// This section might contain person info
			name := extractName(sel.Text())
			if name != "" {
				role := extractRole(sel, sel.Text())
				bio := extractBio(sel)
				// Avoid duplicates
				exists := false
				for _, p := range page.People {
					if strings.EqualFold(p.Name, name) {
						exists = true
						break
					}
				}
				if !exists {
					page.People = append(page.People, Person{
						Name: name,
						Role: role,
						Bio:  bio,
					})
				}
			}
		}
	})

	return page, nil
}

func (s *MetadataScraper) scrapeAboutPage(ctx context.Context, pageURL string) (*AboutPage, error) {
	doc, _, err := fetchHTML(ctx, s.httpClient, pageURL)
	if err != nil || doc == nil {
		return nil, err
	}

	page := &AboutPage{
		URL:   pageURL,
		Title: strings.TrimSpace(doc.Find("title").Text()),
	}

	// Extract text content (remove scripts, styles, etc.)
	doc.Find("script, style, iframe, nav, footer, header, form, aside").Remove()
	page.Content = cleanText(doc.Find("body").Text())

	return page, nil
}

// cleanText removes extra whitespace and junk from extracted text
func cleanText(text string) string {
	lines := strings.Split(text, "\n")
	var cleaned []string
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line != "" {
			cleaned = append(cleaned, line)
		}
	}
	return strings.Join(cleaned, " ")
}

func (s *MetadataScraper) findKeyLinks(ctx context.Context, root *url.URL, seedURLs []string) []KeyLink {
	var links []KeyLink
	visited := make(map[string]struct{})

	for _, u := range seedURLs {
		doc, base, err := fetchHTML(ctx, s.httpClient, u)
		if err != nil || doc == nil || base == nil {
			continue
		}

		doc.Find("a[href]").Each(func(_ int, sel *goquery.Selection) {
			href, _ := sel.Attr("href")
			text := strings.TrimSpace(sel.Text())
			abs := resolveURL(base, href)

			if abs == "" || !sameHost(root, abs) {
				return
			}

			normalized := normalizeURL(abs)
			if _, ok := visited[normalized]; ok {
				return
			}
			visited[normalized] = struct{}{}

			// Categorize links
			category := categorizeLink(abs, text)
			if category != "" {
				links = append(links, KeyLink{
					URL:         abs,
					Text:        text,
					Description: "",
					Category:    category,
				})
			}
		})
	}

	return links
}

func (s *MetadataScraper) buildContextText(metadata *ScrapedMetadata) string {
	var parts []string
	const maxGlobalChars = 12000 // Further limit to control costs

	// 1. Leadership & People
	if len(metadata.LeadershipPages) > 0 {
		parts = append(parts, "### KEY PEOPLE & LEADERSHIP ###")
		for _, page := range metadata.LeadershipPages {
			if len(page.People) > 0 {
				parts = append(parts, fmt.Sprintf("Source: %s", page.URL))
				for _, p := range page.People {
					personInfo := fmt.Sprintf("- Name: %s | Role: %s", p.Name, p.Role)
					if p.Bio != "" {
						bio := p.Bio
						if len(bio) > 200 {
							bio = bio[:200] + "..."
						}
						personInfo += fmt.Sprintf(" | Bio: %s", bio)
					}
					parts = append(parts, personInfo)
				}
			} else {
				// Fallback to limited text if no structured people found
				content := page.Content
				if len(content) > 1500 {
					content = content[:1500] + "... [truncated]"
				}
				parts = append(parts, fmt.Sprintf("Source: %s\nContent: %s", page.URL, content))
			}
		}
	}

	// 2. Company Information (About Pages)
	if len(metadata.AboutPages) > 0 {
		parts = append(parts, "\n### COMPANY OVERVIEW ###")
		for _, page := range metadata.AboutPages {
			content := page.Content
			if len(content) > 2000 {
				content = content[:2000] + "... [truncated]"
			}
			parts = append(parts, fmt.Sprintf("Source: %s\nTitle: %s\nContent: %s", page.URL, page.Title, content))
		}
	}

	// 3. Key Links
	if len(metadata.KeyLinks) > 0 {
		parts = append(parts, "\n### IMPORTANT LINKS ###")
		for _, link := range metadata.KeyLinks {
			parts = append(parts, fmt.Sprintf("- [%s] %s: %s", link.Category, link.Text, link.URL))
		}
	}

	fullContext := strings.Join(parts, "\n")
	if len(fullContext) > maxGlobalChars {
		return fullContext[:maxGlobalChars] + "\n\n... [METADATA TRUNCATED]"
	}

	return fullContext
}

// Helper functions

func extractName(text string) string {
	// Look for patterns like "First Last" or "First Middle Last"
	// Typically names are 2-4 words, capitalized
	words := strings.Fields(strings.TrimSpace(text))
	if len(words) < 2 || len(words) > 4 {
		return ""
	}

	// Check if all words start with capital letters (likely a name)
	allCapitalized := true
	for _, word := range words {
		if len(word) == 0 {
			allCapitalized = false
			break
		}
		first := word[0]
		if first < 'A' || first > 'Z' {
			allCapitalized = false
			break
		}
	}

	if allCapitalized {
		return strings.Join(words, " ")
	}

	return ""
}

func extractRole(sel *goquery.Selection, text string) string {
	// Look for common role patterns
	rolePatterns := []string{
		"CEO", "Chief Executive Officer",
		"CFO", "Chief Financial Officer",
		"COO", "Chief Operating Officer",
		"Chair", "Chairman", "Chairperson",
		"Director", "Non-Executive Director",
		"Managing Director", "MD",
		"President", "Vice President",
		"General Manager", "GM",
	}

	textLower := strings.ToLower(text)
	for _, pattern := range rolePatterns {
		if strings.Contains(textLower, strings.ToLower(pattern)) {
			return pattern
		}
	}

	// Try to find role in nearby elements
	parent := sel.Parent()
	if parent != nil {
		parentText := strings.ToLower(parent.Text())
		for _, pattern := range rolePatterns {
			if strings.Contains(parentText, strings.ToLower(pattern)) {
				return pattern
			}
		}
	}

	return ""
}

func extractBio(sel *goquery.Selection) string {
	// Look for bio in following siblings or parent
	next := sel.Next()
	if next != nil {
		text := strings.TrimSpace(next.Text())
		if len(text) > 20 && len(text) < 500 {
			return text
		}
	}

	parent := sel.Parent()
	if parent != nil {
		text := strings.TrimSpace(parent.Text())
		// Try to extract paragraph after name/role
		lines := strings.Split(text, "\n")
		for i, line := range lines {
			if strings.Contains(strings.ToLower(line), "chair") || strings.Contains(strings.ToLower(line), "ceo") || strings.Contains(strings.ToLower(line), "director") {
				if i+1 < len(lines) {
					bio := strings.TrimSpace(lines[i+1])
					if len(bio) > 20 {
						return bio
					}
				}
			}
		}
	}

	return ""
}

func categorizeLink(url, text string) string {
	urlLower := strings.ToLower(url)
	textLower := strings.ToLower(text)

	categories := map[string][]string{
		"investors":    {"investor", "shareholder", "asx", "announcement", "report", "presentation"},
		"sustainability": {"sustainability", "esg", "environment", "social", "governance"},
		"news":         {"news", "media", "press", "announcement"},
		"about":        {"about", "company", "history", "values"},
		"leadership":   {"leadership", "board", "director", "management", "team"},
	}

	for category, keywords := range categories {
		for _, kw := range keywords {
			if strings.Contains(urlLower, kw) || strings.Contains(textLower, kw) {
				return category
			}
		}
	}

	return ""
}

// Note: normalizeWebsiteURL, resolveURL, normalizeURL, and sameHost are defined in report_crawler.go
// We import them implicitly by being in the same package


