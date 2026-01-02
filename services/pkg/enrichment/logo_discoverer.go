package enrichment

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// DiscoveredLogo contains information about a logo discovered on a website
type DiscoveredLogo struct {
	SourceURL    string `json:"source_url"`
	ImageData    []byte `json:"-"`
	Format       string `json:"format"` // png, svg, jpg, webp
	Width        int    `json:"width"`
	Height       int    `json:"height"`
	QualityScore float64 `json:"quality_score"`
	IsSVG        bool   `json:"is_svg"`
	SVGData      []byte `json:"-"` // Raw SVG data if format is svg
}

// LogoDiscoverer interface for discovering company logos
type LogoDiscoverer interface {
	DiscoverLogo(ctx context.Context, website, companyName, stockCode string) (*DiscoveredLogo, error)
}

type logoDiscoverer struct {
	httpClient *http.Client
	scraper    *DefaultLogoScraper
}

// NewLogoDiscoverer creates a new LogoDiscoverer
func NewLogoDiscoverer() LogoDiscoverer {
	return &logoDiscoverer{
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// NewLogoDiscovererWithCompanyName creates a LogoDiscoverer with company name for better matching
func NewLogoDiscovererWithCompanyName(companyName string) LogoDiscoverer {
	return &logoDiscoverer{
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		scraper: NewLogoScraper(companyName),
	}
}

func (d *logoDiscoverer) DiscoverLogo(ctx context.Context, website, companyName, stockCode string) (*DiscoveredLogo, error) {
	website = strings.TrimSpace(website)
	if website == "" {
		return nil, fmt.Errorf("website is empty")
	}

	// Ensure we have a scraper with company name
	scraper := d.scraper
	if scraper == nil {
		scraper = NewLogoScraper(companyName)
	}

	// Use the intelligent scraper to find all logo candidates
	candidates, err := scraper.ScrapeLogos(ctx, website)
	if err != nil {
		return nil, fmt.Errorf("failed to scrape logos from %s: %w", website, err)
	}

	if len(candidates) == 0 {
		return nil, fmt.Errorf("no logo candidates found for %s", stockCode)
	}

	// Try candidates in order of score (already sorted by scraper)
	for _, candidate := range candidates {
		// Skip data URIs for now (we'd need to decode them)
		if strings.HasPrefix(candidate.URL, "data:") {
			continue
		}

		logo, err := d.fetchLogo(ctx, candidate)
		if err != nil {
			continue
		}

		return logo, nil
	}

	return nil, fmt.Errorf("no valid logo could be fetched for %s", stockCode)
}

// fetchLogo downloads and validates a logo from a candidate
func (d *logoDiscoverer) fetchLogo(ctx context.Context, candidate LogoCandidate) (*DiscoveredLogo, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", candidate.URL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "image/svg+xml,image/*,*/*;q=0.8")

	resp, err := d.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			// Log error but don't fail - response body close errors are usually non-critical
		}
	}()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("failed to fetch logo: status %d", resp.StatusCode)
	}

	// Read the data (limit to 10MB)
	data, err := io.ReadAll(io.LimitReader(resp.Body, 10*1024*1024))
	if err != nil {
		return nil, err
	}

	if len(data) == 0 {
		return nil, fmt.Errorf("empty logo data")
	}

	// Determine format from content-type or candidate format
	format := candidate.Format
	contentType := resp.Header.Get("Content-Type")
	
	if format == "unknown" || format == "" {
		format = detectFormatFromContentType(contentType)
	}

	// Validate it's actually an image
	if !isValidImageFormat(format) && !strings.HasPrefix(contentType, "image/") && !strings.Contains(contentType, "svg") {
		return nil, fmt.Errorf("not an image: %s", contentType)
	}

	// Build the discovered logo
	logo := &DiscoveredLogo{
		SourceURL:    candidate.URL,
		Format:       format,
		Width:        candidate.Width,
		Height:       candidate.Height,
		QualityScore: candidate.Score,
		IsSVG:        format == "svg",
	}

	if format == "svg" {
		logo.SVGData = data
		// SVG data can also be in ImageData for compatibility
		logo.ImageData = data
	} else {
		logo.ImageData = data
	}

	return logo, nil
}

// detectFormatFromContentType determines format from HTTP Content-Type header
func detectFormatFromContentType(contentType string) string {
	contentType = strings.ToLower(contentType)
	
	switch {
	case strings.Contains(contentType, "svg"):
		return "svg"
	case strings.Contains(contentType, "png"):
		return "png"
	case strings.Contains(contentType, "jpeg") || strings.Contains(contentType, "jpg"):
		return "jpeg"
	case strings.Contains(contentType, "webp"):
		return "webp"
	case strings.Contains(contentType, "gif"):
		return "gif"
	case strings.Contains(contentType, "ico") || strings.Contains(contentType, "icon"):
		return "ico"
	default:
		return "unknown"
	}
}

// isValidImageFormat checks if the format is a known image format
func isValidImageFormat(format string) bool {
	validFormats := map[string]bool{
		"svg":  true,
		"png":  true,
		"jpeg": true,
		"jpg":  true,
		"webp": true,
		"gif":  true,
		"ico":  true,
	}
	return validFormats[format]
}
