package enrichment

import (
	"bytes"
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"
	"unicode"

	"github.com/PuerkitoBio/goquery"
	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	otelmetric "go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
)

var logoTracer = otel.Tracer("shorted.enrichment.logo")

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
	client      *stealthhttp.Client
	scraper     *DefaultLogoScraper
	useChromium bool // whether to fall back to Chromium for JS-heavy sites
}

// NewLogoDiscoverer creates a new LogoDiscoverer with a stealth client.
func NewLogoDiscoverer() LogoDiscoverer {
	client, err := stealthhttp.New(stealthhttp.WithTimeout(30 * time.Second))
	if err != nil {
		panic(fmt.Sprintf("stealthhttp: failed to create native client: %v", err))
	}
	return &logoDiscoverer{client: client}
}

// NewLogoDiscovererWithChromium creates a LogoDiscoverer that falls back to Chromium
// when native scraping finds no logo candidates (JS-rendered sites).
func NewLogoDiscovererWithChromium() LogoDiscoverer {
	client, err := stealthhttp.New(stealthhttp.WithTimeout(30 * time.Second))
	if err != nil {
		panic(fmt.Sprintf("stealthhttp: failed to create native client: %v", err))
	}
	return &logoDiscoverer{client: client, useChromium: true}
}

// NewLogoDiscovererWithCompanyName creates a LogoDiscoverer with company name for better matching.
func NewLogoDiscovererWithCompanyName(companyName string) LogoDiscoverer {
	client, err := stealthhttp.New(stealthhttp.WithTimeout(30 * time.Second))
	if err != nil {
		panic(fmt.Sprintf("stealthhttp: failed to create native client: %v", err))
	}
	return &logoDiscoverer{
		client:  client,
		scraper: NewLogoScraper(companyName),
	}
}

// NewLogoDiscovererWithClient creates a LogoDiscoverer with a provided stealth client.
func NewLogoDiscovererWithClient(client *stealthhttp.Client) LogoDiscoverer {
	return &logoDiscoverer{client: client}
}

func (d *logoDiscoverer) DiscoverLogo(ctx context.Context, website, companyName, stockCode string) (*DiscoveredLogo, error) {
	ctx, span := logoTracer.Start(ctx, "logo.discover",
		trace.WithAttributes(
			attribute.String("stock_code", stockCode),
			attribute.String("company_name", companyName),
			attribute.String("website", website),
		),
	)
	defer span.End()
	start := time.Now()

	website = strings.TrimSpace(website)
	if website == "" {
		span.SetStatus(codes.Error, "website is empty")
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
		span.AddEvent("website_scrape_failed", trace.WithAttributes(
			attribute.String("error", err.Error()),
		))
		// Log but continue — we might find a logo via LinkedIn fallback
		candidates = nil
	}

	span.SetAttributes(attribute.Int("logo.candidates_found", len(candidates)))

	// Chromium fallback: if native found no candidates and Chromium is enabled
	if len(candidates) == 0 && d.useChromium {
		span.AddEvent("trying_chromium_fallback")
		chromiumClient, chromErr := stealthhttp.NewChromium(stealthhttp.WithTimeout(30 * time.Second))
		if chromErr == nil {
			chromScraper := NewLogoScraperWithClient(companyName, chromiumClient)
			chromCandidates, chromScrapeErr := chromScraper.ScrapeLogos(ctx, website)
			_ = chromiumClient.Close()
			if chromScrapeErr == nil && len(chromCandidates) > 0 {
				candidates = chromCandidates
				span.AddEvent("chromium_found_candidates", trace.WithAttributes(
					attribute.Int("count", len(chromCandidates)),
				))
			}
		}
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

		span.SetAttributes(
			attribute.String("logo.source", "website"),
			attribute.String("logo.format", logo.Format),
			attribute.Int("logo.size_bytes", len(logo.ImageData)),
			attribute.Float64("logo.quality_score", logo.QualityScore),
		)
		span.SetStatus(codes.Ok, "")
		d.recordLogoMetrics(ctx, start, stockCode, "website", logo.Format, true)
		return logo, nil
	}

	// Fallback: try LinkedIn company page for logo
	if companyName != "" {
		span.AddEvent("trying_linkedin_fallback")
		linkedInLogo, linkedInErr := d.discoverLinkedInLogo(ctx, companyName)
		if linkedInErr == nil && linkedInLogo != nil {
			span.SetAttributes(
				attribute.String("logo.source", "linkedin"),
				attribute.String("logo.format", linkedInLogo.Format),
				attribute.Int("logo.size_bytes", len(linkedInLogo.ImageData)),
			)
			span.SetStatus(codes.Ok, "")
			d.recordLogoMetrics(ctx, start, stockCode, "linkedin", linkedInLogo.Format, true)
			return linkedInLogo, nil
		}
		if linkedInErr != nil {
			span.AddEvent("linkedin_fallback_failed", trace.WithAttributes(
				attribute.String("error", linkedInErr.Error()),
			))
		}
	}

	span.SetStatus(codes.Error, "no logo found")
	d.recordLogoMetrics(ctx, start, stockCode, "none", "", false)
	return nil, fmt.Errorf("no valid logo could be fetched for %s", stockCode)
}

func (d *logoDiscoverer) recordLogoMetrics(ctx context.Context, start time.Time, stockCode, source, format string, success bool) {
	duration := time.Since(start).Seconds()
	attrs := []attribute.KeyValue{
		attribute.String("stock_code", stockCode),
		attribute.String("logo.source", source),
		attribute.String("logo.format", format),
		attribute.Bool("logo.success", success),
	}
	if shortedotel.LogoDiscoveryTotal != nil {
		shortedotel.LogoDiscoveryTotal.Add(ctx, 1, otelmetric.WithAttributes(attrs...))
	}
	if shortedotel.LogoDiscoveryDuration != nil {
		shortedotel.LogoDiscoveryDuration.Record(ctx, duration, otelmetric.WithAttributes(attrs...))
	}
}

// fetchLogo downloads and validates a logo from a candidate
func (d *logoDiscoverer) fetchLogo(ctx context.Context, candidate LogoCandidate) (*DiscoveredLogo, error) {
	data, contentType, err := d.client.FetchBytesWithLimit(ctx, candidate.URL, "image/svg+xml,image/*,*/*;q=0.8", 10*1024*1024)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch logo: %w", err)
	}

	if len(data) == 0 {
		return nil, fmt.Errorf("empty logo data")
	}

	// Determine format from content-type or candidate format
	format := candidate.Format
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

// discoverLinkedInLogo attempts to find a company logo from LinkedIn.
// It uses a Chromium-backed stealth client since LinkedIn requires JS rendering
// and has aggressive bot detection.
func (d *logoDiscoverer) discoverLinkedInLogo(ctx context.Context, companyName string) (*DiscoveredLogo, error) {
	ctx, span := logoTracer.Start(ctx, "logo.discover_linkedin",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("company_name", companyName),
		),
	)
	defer span.End()

	slug := companyNameToLinkedInSlug(companyName)
	if slug == "" {
		span.SetStatus(codes.Error, "empty slug")
		return nil, fmt.Errorf("could not derive LinkedIn slug from company name")
	}

	linkedInURL := fmt.Sprintf("https://www.linkedin.com/company/%s/", slug)
	span.SetAttributes(
		attribute.String("linkedin.slug", slug),
		attribute.String("linkedin.url", linkedInURL),
	)

	// Use chromium engine for LinkedIn (requires JS rendering)
	chromiumClient, err := stealthhttp.NewChromium(stealthhttp.WithTimeout(30 * time.Second))
	if err != nil {
		// Chromium engine not available (e.g. no Chromium installed) — graceful fallback
		return nil, fmt.Errorf("chromium engine not available: %w", err)
	}
	defer func() { _ = chromiumClient.Close() }()

	// Fetch the LinkedIn page
	doc, _, fetchErr := chromiumClient.FetchHTML(ctx, linkedInURL)
	if fetchErr != nil {
		return nil, fmt.Errorf("failed to fetch LinkedIn page: %w", fetchErr)
	}

	// Try to extract logo URL from LinkedIn page
	logoURL := extractLinkedInLogo(doc, linkedInURL)
	if logoURL == "" {
		return nil, fmt.Errorf("no logo found on LinkedIn page for %s", companyName)
	}

	// Fetch the logo image using the native client (LinkedIn image CDN doesn't need JS)
	data, contentType, fetchErr := d.client.FetchBytesWithLimit(ctx, logoURL, "image/*,*/*;q=0.8", 10*1024*1024)
	if fetchErr != nil {
		return nil, fmt.Errorf("failed to fetch LinkedIn logo image: %w", fetchErr)
	}

	if len(data) == 0 {
		return nil, fmt.Errorf("empty LinkedIn logo data")
	}

	format := detectFormatFromContentType(contentType)
	if format == "unknown" {
		format = detectFormat(logoURL)
	}

	return &DiscoveredLogo{
		SourceURL:    logoURL,
		ImageData:    data,
		Format:       format,
		QualityScore: 50, // Medium priority — below direct website logos
		IsSVG:        format == "svg",
	}, nil
}

// extractLinkedInLogo extracts the company logo URL from a LinkedIn company page.
func extractLinkedInLogo(doc *goquery.Document, pageURL string) string {
	base, _ := url.Parse(pageURL)

	// Try: org-top-card logo image
	var logoURL string
	doc.Find("img").EachWithBreak(func(_ int, sel *goquery.Selection) bool {
		class, _ := sel.Attr("class")
		alt, _ := sel.Attr("alt")

		// LinkedIn uses classes like "org-top-card-primary-content__logo-image"
		// or "top-card-layout__entity-image"
		classLower := strings.ToLower(class)
		if strings.Contains(classLower, "org-top-card") && strings.Contains(classLower, "logo") {
			if src, ok := sel.Attr("src"); ok && src != "" {
				logoURL = resolveLinkedInURL(base, src)
				return false
			}
		}
		if strings.Contains(classLower, "top-card-layout") && strings.Contains(classLower, "entity-image") {
			if src, ok := sel.Attr("src"); ok && src != "" {
				logoURL = resolveLinkedInURL(base, src)
				return false
			}
		}
		// Also check alt text for "logo"
		if strings.Contains(strings.ToLower(alt), "logo") {
			if src, ok := sel.Attr("src"); ok && src != "" {
				logoURL = resolveLinkedInURL(base, src)
				return false
			}
		}
		return true
	})

	if logoURL != "" {
		return logoURL
	}

	// Fallback: OG image meta tag
	doc.Find("meta[property='og:image']").EachWithBreak(func(_ int, sel *goquery.Selection) bool {
		content, exists := sel.Attr("content")
		if exists && content != "" {
			logoURL = content
			return false
		}
		return true
	})

	return logoURL
}

// resolveLinkedInURL resolves a potentially relative URL against the LinkedIn base.
func resolveLinkedInURL(base *url.URL, ref string) string {
	if strings.HasPrefix(ref, "http://") || strings.HasPrefix(ref, "https://") {
		return ref
	}
	if strings.HasPrefix(ref, "data:") {
		return ""
	}
	refURL, err := url.Parse(ref)
	if err != nil {
		return ""
	}
	return base.ResolveReference(refURL).String()
}

// companyNameToLinkedInSlug converts a company name to a LinkedIn URL slug.
// e.g. "BHP Group Limited" → "bhp-group-limited"
func companyNameToLinkedInSlug(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	if name == "" {
		return ""
	}

	// Remove common suffixes that LinkedIn often omits
	suffixes := []string{
		" ltd", " limited", " pty ltd", " pty", " inc", " inc.",
		" corp", " corporation", " group limited", " group",
		" holdings limited", " holdings", " international",
		" australia", " nz", " energy", " resources", " mining",
	}
	cleaned := name
	for _, suffix := range suffixes {
		cleaned = strings.TrimSuffix(cleaned, suffix)
	}
	cleaned = strings.TrimSpace(cleaned)
	if cleaned == "" {
		cleaned = name // Use original if cleaning removed everything
	}

	// Replace non-alphanumeric chars with hyphens
	var b bytes.Buffer
	prevHyphen := false
	for _, r := range cleaned {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			prevHyphen = false
		} else if !prevHyphen {
			b.WriteByte('-')
			prevHyphen = true
		}
	}

	slug := strings.Trim(b.String(), "-")
	if slug == "" {
		return ""
	}
	return slug
}
