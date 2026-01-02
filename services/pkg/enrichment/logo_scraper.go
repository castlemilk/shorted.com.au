package enrichment

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
)

// LogoCandidate represents a potential logo found on a website
type LogoCandidate struct {
	URL         string  `json:"url"`
	Format      string  `json:"format"`       // "svg", "png", "jpeg", "gif", "webp"
	Source      string  `json:"source"`       // "inline_svg", "img_tag", "og_image", "favicon", "brand_page", "css_background"
	Score       float64 `json:"score"`
	Width       int     `json:"width"`
	Height      int     `json:"height"`
	Alt         string  `json:"alt"`
	FoundOnPage string  `json:"found_on_page"`
}

// LogoScraper defines the interface for scraping logos from websites
type LogoScraper interface {
	ScrapeLogos(ctx context.Context, websiteURL string) ([]LogoCandidate, error)
}

const (
	// DefaultMaxPages is the default maximum number of pages to crawl for logos
	DefaultMaxPages = 5
	// ScraperTimeout is the timeout for HTTP requests in the logo scraper
	ScraperTimeout = 30 * time.Second
)

// DefaultLogoScraper implements LogoScraper with intelligent crawling
type DefaultLogoScraper struct {
	httpClient  *http.Client
	maxPages    int
	companyName string
}

// NewLogoScraper creates a new DefaultLogoScraper
func NewLogoScraper(companyName string) *DefaultLogoScraper {
	return &DefaultLogoScraper{
		httpClient: &http.Client{
			Timeout: ScraperTimeout,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= 10 {
					return fmt.Errorf("too many redirects")
				}
				return nil
			},
		},
		maxPages:    DefaultMaxPages,
		companyName: strings.ToLower(companyName),
	}
}

// ScrapeLogos scrapes the website for logo candidates
func (s *DefaultLogoScraper) ScrapeLogos(ctx context.Context, websiteURL string) ([]LogoCandidate, error) {
	var candidates []LogoCandidate

	// Normalize URL
	baseURL, err := normalizeWebsiteBaseURL(websiteURL)
	if err != nil {
		return nil, fmt.Errorf("invalid website URL: %w", err)
	}

	// Phase 1: Scan homepage
	homepageCandidates, brandLinks, err := s.scanPage(ctx, baseURL, baseURL)
	if err != nil {
		// Log but continue - we might find logos on other pages
		// Note: HTTP 403/429 might indicate bot blocking, but we'll try other pages
		// Initialize empty brandLinks if homepage scan failed
		if brandLinks == nil {
			brandLinks = []string{}
		}
		// Debug: log the error but still use candidates if we got any
		if len(homepageCandidates) > 0 {
			// We got candidates despite an error - use them
			candidates = append(candidates, homepageCandidates...)
		}
	} else {
		candidates = append(candidates, homepageCandidates...)
	}

	// Phase 2: Check common brand/media paths
	commonPaths := []string{
		"/brand",
		"/brand-assets",
		"/media",
		"/media-kit",
		"/press",
		"/press-kit",
		"/about",
		"/about-us",
		"/assets",
		"/logos",
	}

	for _, path := range commonPaths {
		pageURL := baseURL + path
		if !containsURL(brandLinks, pageURL) {
			brandLinks = append(brandLinks, pageURL)
		}
	}

	// Phase 3: Crawl brand/media pages (up to maxPages)
	crawled := make(map[string]bool)
	crawled[baseURL] = true

	for i := 0; i < len(brandLinks) && i < s.maxPages; i++ {
		link := brandLinks[i]
		if crawled[link] {
			continue
		}
		crawled[link] = true

		pageCandidates, _, err := s.scanPage(ctx, link, baseURL)
		if err != nil {
			continue
		}
		candidates = append(candidates, pageCandidates...)
	}

	// Score all candidates
	for i := range candidates {
		candidates[i].Score = s.scoreCandidate(&candidates[i])
	}

	// Sort by score (descending)
	sortCandidatesByScore(candidates)

	return candidates, nil
}

// scanPage extracts logo candidates and brand-related links from a page
func (s *DefaultLogoScraper) scanPage(ctx context.Context, pageURL, baseURL string) ([]LogoCandidate, []string, error) {
	doc, err := s.fetchPage(ctx, pageURL)
	if err != nil {
		return nil, nil, err
	}

	var candidates []LogoCandidate

	// Extract different types of logo candidates
	candidates = append(candidates, s.extractImgTags(doc, pageURL, baseURL)...)
	candidates = append(candidates, s.extractOGImage(doc, pageURL, baseURL)...)
	candidates = append(candidates, s.extractFavicons(doc, pageURL, baseURL)...)
	candidates = append(candidates, s.extractLinkedSVGs(doc, pageURL, baseURL)...)

	// Extract brand/media links for further crawling
	brandLinks := s.extractBrandLinks(doc, baseURL)

	return candidates, brandLinks, nil
}

func (s *DefaultLogoScraper) fetchPage(ctx context.Context, pageURL string) (*goquery.Document, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", pageURL, nil)
	if err != nil {
		return nil, err
	}
	// Use a realistic browser User-Agent to avoid blocking
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("DNT", "1")
	req.Header.Set("Connection", "keep-alive")
	req.Header.Set("Upgrade-Insecure-Requests", "1")
	req.Header.Set("Sec-Fetch-Dest", "document")
	req.Header.Set("Sec-Fetch-Mode", "navigate")
	req.Header.Set("Sec-Fetch-Site", "none")
	req.Header.Set("Cache-Control", "max-age=0")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			// Log error but don't fail - response body close errors are usually non-critical
		}
	}()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	// Limit body size to 10MB
	body, err := io.ReadAll(io.LimitReader(resp.Body, 10*1024*1024))
	if err != nil {
		return nil, err
	}

	if len(body) == 0 {
		return nil, fmt.Errorf("empty response body")
	}

	return goquery.NewDocumentFromReader(strings.NewReader(string(body)))
}

func (s *DefaultLogoScraper) extractImgTags(doc *goquery.Document, pageURL, baseURL string) []LogoCandidate {
	var candidates []LogoCandidate
	doc.Find("img").Each(func(i int, sel *goquery.Selection) {
		src, exists := sel.Attr("src")
		if !exists || src == "" {
			src, _ = sel.Attr("data-src")
		}
		if src == "" {
			srcset, _ := sel.Attr("srcset")
			if srcset != "" {
				parts := strings.Split(srcset, ",")
				if len(parts) > 0 {
					src = strings.TrimSpace(strings.Split(parts[0], " ")[0])
				}
			}
		}

		if src == "" {
			return
		}

		absoluteURL := resolveLogoURL(baseURL, src)
		if absoluteURL == "" {
			return
		}

		format := detectFormat(absoluteURL)
		alt, _ := sel.Attr("alt")
		class, _ := sel.Attr("class")
		id, _ := sel.Attr("id")

		inHeader := sel.ParentsFiltered("header, nav, .header, .nav, .navbar, #header, #nav").Length() > 0
		source := "img_tag"
		if inHeader {
			source = "img_tag_header"
		}

		// Check if it's an SVG file in an img tag
		if format == "svg" {
			if inHeader {
				source = "img_svg_header"
			} else {
				source = "img_svg"
			}
		}

		candidate := LogoCandidate{
			URL:         absoluteURL,
			Format:      format,
			Source:      source,
			Width:       parseIntAttr(sel, "width"),
			Height:      parseIntAttr(sel, "height"),
			Alt:         alt,
			FoundOnPage: pageURL,
		}

		// Boost if logo-related
		if containsLogoKeyword(src) || containsLogoKeyword(alt) || containsLogoKeyword(class) || containsLogoKeyword(id) {
			candidate.Score += 20
		}

		candidates = append(candidates, candidate)
	})
	return candidates
}

func (s *DefaultLogoScraper) extractOGImage(doc *goquery.Document, pageURL, baseURL string) []LogoCandidate {
	var candidates []LogoCandidate
	doc.Find("meta[property='og:image']").Each(func(i int, sel *goquery.Selection) {
		content, exists := sel.Attr("content")
		if !exists || content == "" {
			return
		}

		absoluteURL := resolveLogoURL(baseURL, content)
		format := detectFormat(absoluteURL)

		candidates = append(candidates, LogoCandidate{
			URL:         absoluteURL,
			Format:      format,
			Source:      "og_image",
			FoundOnPage: pageURL,
		})
	})
	return candidates
}

func (s *DefaultLogoScraper) extractFavicons(doc *goquery.Document, pageURL, baseURL string) []LogoCandidate {
	var candidates []LogoCandidate
	doc.Find("link[rel='icon'], link[rel='shortcut icon'], link[rel='apple-touch-icon'], link[rel='apple-touch-icon-precomposed']").Each(func(i int, sel *goquery.Selection) {
		href, exists := sel.Attr("href")
		if !exists || href == "" {
			return
		}

		absoluteURL := resolveLogoURL(baseURL, href)
		format := detectFormat(absoluteURL)
		rel, _ := sel.Attr("rel")
		source := "favicon"
		if strings.Contains(rel, "apple-touch-icon") {
			source = "apple_touch_icon"
		}

		width, height := parseSizes(sel.AttrOr("sizes", ""))

		candidates = append(candidates, LogoCandidate{
			URL:         absoluteURL,
			Format:      format,
			Source:      source,
			Width:       width,
			Height:      height,
			FoundOnPage: pageURL,
		})
	})
	return candidates
}

func (s *DefaultLogoScraper) extractLinkedSVGs(doc *goquery.Document, pageURL, baseURL string) []LogoCandidate {
	var candidates []LogoCandidate
	doc.Find("a[href$='.svg'], a[href*='logo'], a[href*='brand']").Each(func(i int, sel *goquery.Selection) {
		href, exists := sel.Attr("href")
		if !exists || href == "" {
			return
		}

		absoluteURL := resolveLogoURL(baseURL, href)
		if strings.HasSuffix(strings.ToLower(absoluteURL), ".svg") {
			candidates = append(candidates, LogoCandidate{
				URL:         absoluteURL,
				Format:      "svg",
				Source:      "linked_svg",
				FoundOnPage: pageURL,
			})
		}
	})
	return candidates
}

func (s *DefaultLogoScraper) extractBrandLinks(doc *goquery.Document, baseURL string) []string {
	var brandLinks []string
	brandKeywords := []string{"brand", "media", "press", "logo", "asset", "download", "kit"}
	doc.Find("a[href]").Each(func(i int, sel *goquery.Selection) {
		href, exists := sel.Attr("href")
		if !exists || href == "" {
			return
		}

		text := strings.ToLower(sel.Text())
		hrefLower := strings.ToLower(href)

		for _, keyword := range brandKeywords {
			if strings.Contains(hrefLower, keyword) || strings.Contains(text, keyword) {
				absoluteURL := resolveLogoURL(baseURL, href)
				if absoluteURL != "" && !strings.HasPrefix(absoluteURL, "mailto:") && !strings.HasPrefix(absoluteURL, "tel:") {
					brandLinks = append(brandLinks, absoluteURL)
				}
				break
			}
		}
	})
	return brandLinks
}

// scoreCandidate calculates a score for a logo candidate
func (s *DefaultLogoScraper) scoreCandidate(c *LogoCandidate) float64 {
	score := 0.0

	// Format scoring (SVG is best)
	switch c.Format {
	case "svg":
		score += 100
	case "png":
		score += 50
	case "webp":
		score += 45
	case "jpeg", "jpg":
		score += 30
	case "gif":
		score += 20
	}

	// Size scoring (for raster images)
	if c.Width > 0 {
		score += float64(c.Width) / 100.0 // +1 per 100px
		if c.Width >= 256 {
			score += 10
		}
		if c.Width >= 512 {
			score += 10
		}
	}

	// Source scoring
	switch c.Source {
	case "inline_svg_header":
		score += 25
	case "img_svg_header":
		score += 25 // SVG in header is very likely to be logo
	case "img_tag_header":
		score += 20
	case "linked_svg":
		score += 15
	case "img_svg":
		score += 12 // SVG in img tag
	case "apple_touch_icon":
		score += 12
	case "og_image":
		score += 10
	case "inline_svg":
		score += 8
	case "img_tag":
		score += 5
	case "favicon":
		score += 3
	}

	// Name relevance scoring
	urlLower := strings.ToLower(c.URL)
	altLower := strings.ToLower(c.Alt)

	if strings.Contains(urlLower, "logo") || strings.Contains(altLower, "logo") {
		score += 20
	}
	if strings.Contains(urlLower, "brand") || strings.Contains(altLower, "brand") {
		score += 15
	}
	if s.companyName != "" && (strings.Contains(urlLower, s.companyName) || strings.Contains(altLower, s.companyName)) {
		score += 10
	}

	// Penalize tiny images
	if c.Width > 0 && c.Width < 32 {
		score -= 20
	}

	// Penalize data URIs (except for inline SVGs we extracted)
	if strings.HasPrefix(c.URL, "data:") && c.Format != "svg" {
		score -= 30
	}

	return score
}

// Helper functions

func normalizeWebsiteBaseURL(rawURL string) (string, error) {
	if !strings.HasPrefix(rawURL, "http://") && !strings.HasPrefix(rawURL, "https://") {
		rawURL = "https://" + rawURL
	}

	u, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}

	// Remove path, query, fragment - get base URL
	u.Path = ""
	u.RawQuery = ""
	u.Fragment = ""

	return u.String(), nil
}

func resolveLogoURL(baseURL, ref string) string {
	if ref == "" {
		return ""
	}

	// Already absolute
	if strings.HasPrefix(ref, "http://") || strings.HasPrefix(ref, "https://") {
		return ref
	}

	// Data URI
	if strings.HasPrefix(ref, "data:") {
		return ref
	}

	// Parse base URL
	base, err := url.Parse(baseURL)
	if err != nil {
		return ""
	}

	// Parse reference
	refURL, err := url.Parse(ref)
	if err != nil {
		return ""
	}

	// Resolve
	resolved := base.ResolveReference(refURL)
	return resolved.String()
}

func detectFormat(urlStr string) string {
	urlLower := strings.ToLower(urlStr)

	// Check for data URIs
	if strings.HasPrefix(urlLower, "data:image/svg") {
		return "svg"
	}
	if strings.HasPrefix(urlLower, "data:image/png") {
		return "png"
	}
	if strings.HasPrefix(urlLower, "data:image/jpeg") || strings.HasPrefix(urlLower, "data:image/jpg") {
		return "jpeg"
	}

	// Parse URL to get path
	u, err := url.Parse(urlStr)
	if err != nil {
		return "unknown"
	}

	path := strings.ToLower(u.Path)

	switch {
	case strings.HasSuffix(path, ".svg"):
		return "svg"
	case strings.HasSuffix(path, ".png"):
		return "png"
	case strings.HasSuffix(path, ".jpg") || strings.HasSuffix(path, ".jpeg"):
		return "jpeg"
	case strings.HasSuffix(path, ".gif"):
		return "gif"
	case strings.HasSuffix(path, ".webp"):
		return "webp"
	case strings.HasSuffix(path, ".ico"):
		return "ico"
	default:
		return "unknown"
	}
}

func containsLogoKeyword(s string) bool {
	sLower := strings.ToLower(s)
	keywords := []string{"logo", "brand", "emblem", "mark", "icon"}
	for _, kw := range keywords {
		if strings.Contains(sLower, kw) {
			return true
		}
	}
	return false
}

func parseIntAttr(sel *goquery.Selection, attr string) int {
	val, exists := sel.Attr(attr)
	if !exists {
		return 0
	}

	// Remove "px" suffix if present
	val = strings.TrimSuffix(val, "px")

	var result int
	if _, err := fmt.Sscanf(val, "%d", &result); err != nil {
		return 0
	}
	return result
}

func parseSizes(sizes string) (width, height int) {
	if sizes == "" {
		return 0, 0
	}

	// Format: "WxH" or "W"
	re := regexp.MustCompile(`(\d+)(?:x(\d+))?`)
	matches := re.FindStringSubmatch(sizes)
	if len(matches) >= 2 {
		if _, err := fmt.Sscanf(matches[1], "%d", &width); err != nil {
			width = 0
		}
		if len(matches) >= 3 && matches[2] != "" {
			if _, err := fmt.Sscanf(matches[2], "%d", &height); err != nil {
				height = width // Fallback to square if parsing fails
			}
		} else {
			height = width // Square
		}
	}
	return
}

func containsURL(urls []string, target string) bool {
	for _, u := range urls {
		if u == target {
			return true
		}
	}
	return false
}

func sortCandidatesByScore(candidates []LogoCandidate) {
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].Score > candidates[j].Score
	})
}

// SelectBestCandidate returns the highest-scoring candidate
func SelectBestCandidate(candidates []LogoCandidate) *LogoCandidate {
	if len(candidates) == 0 {
		return nil
	}

	// Find highest score
	best := &candidates[0]
	for i := 1; i < len(candidates); i++ {
		if candidates[i].Score > best.Score {
			best = &candidates[i]
		}
	}

	return best
}

// FilterByFormat returns candidates matching the given format
func FilterByFormat(candidates []LogoCandidate, format string) []LogoCandidate {
	var filtered []LogoCandidate
	for _, c := range candidates {
		if c.Format == format {
			filtered = append(filtered, c)
		}
	}
	return filtered
}

