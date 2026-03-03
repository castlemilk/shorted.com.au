package enrichment

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/PuerkitoBio/goquery"
)

// Integration tests for logo scraper
// Run with: go test -v -run TestDefaultLogoScraper ./pkg/enrichment/... -timeout 120s
// Note: These tests make real HTTP requests and may be blocked by bot protection

func TestDefaultLogoScraper_ScrapeLogos_Dominos(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	scraper := NewLogoScraper("Domino's Pizza")
	
	websiteURL := "https://www.dominos.com.au"
	t.Logf("Scraping logos from: %s", websiteURL)
	
	candidates, err := scraper.ScrapeLogos(ctx, websiteURL)
	if err != nil {
		t.Logf("ScrapeLogos returned error: %v", err)
		// Continue to check if we got any candidates despite the error
	}

	if len(candidates) == 0 {
		t.Logf("No candidates found")
		t.Logf("Possible reasons:")
		t.Logf("  1. Website blocking requests (HTTP 403/429)")
		t.Logf("  2. Site uses inline SVGs (not downloadable)")
		t.Logf("  3. Logos loaded via JavaScript")
		t.Logf("  4. No logo images found on scanned pages")
		// This is an integration test - don't fail, just inform
		t.Skip("No candidates found - check logs above for details")
	}

	t.Logf("Found %d logo candidates", len(candidates))
	
	// Print top candidates
	for i, candidate := range candidates {
		if i >= 10 { // Only show top 10
			break
		}
		t.Logf("Candidate %d: URL=%s, Format=%s, Source=%s, Score=%.2f, Size=%dx%d",
			i+1, candidate.URL, candidate.Format, candidate.Source, candidate.Score, candidate.Width, candidate.Height)
	}

	// Check that we found at least one SVG
	hasSVG := false
	for _, c := range candidates {
		if c.Format == "svg" {
			hasSVG = true
			t.Logf("Found SVG logo: %s (score: %.2f)", c.URL, c.Score)
			break
		}
	}

	// Check that the best candidate has a reasonable score
	best := SelectBestCandidate(candidates)
	if best == nil {
		t.Fatal("No best candidate selected")
	}

	t.Logf("Best candidate: URL=%s, Format=%s, Source=%s, Score=%.2f",
		best.URL, best.Format, best.Source, best.Score)

	// Validate best candidate
	if best.URL == "" {
		t.Error("Best candidate has empty URL")
	}
	if best.Format == "" {
		t.Error("Best candidate has empty format")
	}
	if best.Score < 0 {
		t.Errorf("Best candidate has negative score: %.2f", best.Score)
	}

	// If we found an SVG, it should be the best candidate (highest score)
	if hasSVG && best.Format != "svg" {
		t.Logf("Warning: Found SVG but best candidate is %s (score: %.2f)", best.Format, best.Score)
		// Find the SVG candidate
		for _, c := range candidates {
			if c.Format == "svg" {
				t.Logf("SVG candidate score: %.2f", c.Score)
			}
		}
	}
}

func TestDefaultLogoScraper_ScrapeLogos_CommonPaths(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	testCases := []struct {
		name           string
		websiteURL     string
		companyName    string
		minCandidates  int
		skipIfBlocked  bool // Skip test if we get 403/blocked
	}{
		{
			name:          "GitHub (simple, unlikely to block)",
			websiteURL:    "https://github.com",
			companyName:   "GitHub",
			minCandidates: 1,
			skipIfBlocked: false,
		},
		{
			name:          "Domino's Pizza",
			websiteURL:    "https://www.dominos.com.au",
			companyName:   "Domino's Pizza",
			minCandidates: 0, // Might be blocked
			skipIfBlocked: true,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			scraper := NewLogoScraper(tc.companyName)
			
			candidates, err := scraper.ScrapeLogos(ctx, tc.websiteURL)
			if err != nil {
				if tc.skipIfBlocked && (strings.Contains(err.Error(), "403") || strings.Contains(err.Error(), "429")) {
					t.Skipf("Website blocked the request: %v", err)
				}
				t.Logf("ScrapeLogos error (non-fatal): %v", err)
			}

			t.Logf("Found %d candidates for %s", len(candidates), tc.name)

			if len(candidates) < tc.minCandidates {
				if tc.skipIfBlocked {
					t.Skipf("Expected at least %d candidates, got %d (might be blocked)", tc.minCandidates, len(candidates))
				}
				t.Errorf("Expected at least %d candidates, got %d", tc.minCandidates, len(candidates))
			}

			if len(candidates) == 0 {
				return // Can't test further without candidates
			}

			best := SelectBestCandidate(candidates)
			if best == nil {
				t.Fatal("No best candidate found")
			}

			t.Logf("Best candidate for %s: %s (format: %s, score: %.2f)",
				tc.name, best.URL, best.Format, best.Score)
		})
	}
}

func TestDefaultLogoScraper_scanPage_Direct(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	scraper := NewLogoScraper("Test Company")
	
	// Test with DMP
	testURL := "https://www.dominos.com.au"
	if testSite := strings.TrimSpace(os.Getenv("TEST_LOGO_SITE")); testSite != "" {
		testURL = testSite
	}
	t.Logf("Testing scanPage directly with: %s", testURL)
	
	candidates, brandLinks, err := scraper.scanPage(ctx, testURL, testURL)
	if err != nil {
		t.Logf("scanPage error: %v", err)
		// Check if it's a blocking error
		if strings.Contains(err.Error(), "403") || strings.Contains(err.Error(), "429") {
			t.Skipf("Website blocked request: %v", err)
		}
		// For other errors, still check candidates but log the error
		t.Logf("Error type: %T, Error message: %s", err, err.Error())
		// Don't return - check candidates even if there's an error
	} else {
		t.Logf("scanPage completed successfully with no errors")
	}

	t.Logf("Found %d candidates, %d brand links", len(candidates), len(brandLinks))
	
	if len(candidates) == 0 {
		t.Logf("No candidates found - this might indicate:")
		t.Logf("  1. Website blocked the request (check error above)")
		t.Logf("  2. HTML parsing issue")
		t.Logf("  3. No logo images on the page")
		if err != nil {
			t.Fatalf("scanPage returned error and no candidates: %v", err)
		}
	}
	
	for i, candidate := range candidates {
		if i >= 10 {
			break
		}
		t.Logf("Candidate %d: URL=%s, Format=%s, Source=%s, Score=%.2f",
			i+1, candidate.URL, candidate.Format, candidate.Source, candidate.Score)
	}
	
	// Verify we found the DMP logo
	if testURL == "https://www.dominos.com.au" {
		foundLogo := false
		for _, c := range candidates {
			if strings.Contains(c.URL, "dpe-logo") || strings.Contains(c.URL, "logo") {
				foundLogo = true
				t.Logf("✓ Found logo candidate: %s", c.URL)
				break
			}
		}
		if !foundLogo && len(candidates) > 0 {
			t.Logf("⚠ Warning: Found %d candidates but none appear to be the main logo", len(candidates))
		}
	}
}

func TestDefaultLogoScraper_HTTPRequest(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	scraper := NewLogoScraper("Test")
	defer func() { _ = scraper.client.Close() }()

	// Test HTTP request directly - can test different sites
	testURL := "https://github.com"
	if testSite := strings.TrimSpace(os.Getenv("TEST_LOGO_SITE")); testSite != "" {
		testURL = testSite
		t.Logf("Using custom test site from TEST_LOGO_SITE: %s", testURL)
	}

	doc, _, err := scraper.client.FetchHTMLWithLimit(ctx, testURL, 100*1024)
	if err != nil {
		t.Logf("HTTP request failed (might be blocking): %v", err)
		return
	}

	// Count img tags
	imgCount := doc.Find("img").Length()
	svgCount := doc.Find("svg").Length()
	linkCount := doc.Find("a[href$='.svg']").Length()

	t.Logf("Found: %d img tags, %d svg tags, %d SVG links", imgCount, svgCount, linkCount)

	// Check for common logo patterns
	doc.Find("img").Each(func(i int, sel *goquery.Selection) {
		if i >= 5 {
			return
		}
		src, _ := sel.Attr("src")
		alt, _ := sel.Attr("alt")
		class, _ := sel.Attr("class")
		t.Logf("Img %d: src=%s, alt=%s, class=%s", i+1, src, alt, class)
	})
}

func TestDefaultLogoScraper_DebugScanPage(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	testURL := "https://www.dominos.com.au"
	t.Logf("Debugging scanPage for: %s", testURL)

	scraper := NewLogoScraper("dominos")
	defer func() { _ = scraper.client.Close() }()

	// Step 1: Fetch HTML via stealth client
	doc, _, err := scraper.client.FetchHTMLWithLimit(ctx, testURL, 10*1024*1024)
	if err != nil {
		t.Fatalf("HTTP request failed: %v", err)
	}

	// Step 4: Count img tags
	imgCount := doc.Find("img").Length()
	t.Logf("Found %d img tags", imgCount)

	// Step 5: Process each img tag (same logic as scanPage)
	processedCount := 0
	skippedNoSrc := 0
	skippedEmptyURL := 0
	doc.Find("img").Each(func(i int, sel *goquery.Selection) {
		if i < 5 {
			src, _ := sel.Attr("src")
			alt, _ := sel.Attr("alt")
			class, _ := sel.Attr("class")
			t.Logf("Img %d: src=%q, alt=%q, class=%q", i+1, src, alt, class)
		}

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
			skippedNoSrc++
			return
		}

		absoluteURL := resolveLogoURL(testURL, src)
		if absoluteURL == "" {
			skippedEmptyURL++
			if i < 5 {
				t.Logf("  -> Skipped: resolveLogoURL returned empty for src=%q", src)
			}
			return
		}
		processedCount++
		if i < 5 {
			t.Logf("  -> Processed: absoluteURL=%q", absoluteURL)
		}
	})

	t.Logf("Summary: %d img tags, %d processed, %d skipped (no src), %d skipped (empty URL)",
		imgCount, processedCount, skippedNoSrc, skippedEmptyURL)

	if processedCount == 0 && imgCount > 0 {
		t.Errorf("Found %d img tags but processed 0 - check resolveLogoURL logic", imgCount)
	}
}

func TestResolveLogoURL(t *testing.T) {
	testCases := []struct {
		name    string
		baseURL string
		ref     string
		want    string
	}{
		{
			name:    "Absolute URL",
			baseURL: "https://www.dominos.com.au",
			ref:     "https://example.com/logo.png",
			want:    "https://example.com/logo.png",
		},
		{
			name:    "Relative path from root",
			baseURL: "https://www.dominos.com.au",
			ref:     "/Content/Images/svg/dpe-logo.svg",
			want:    "https://www.dominos.com.au/Content/Images/svg/dpe-logo.svg",
		},
		{
			name:    "Relative path",
			baseURL: "https://www.dominos.com.au",
			ref:     "Content/Images/svg/dpe-logo.svg",
			want:    "https://www.dominos.com.au/Content/Images/svg/dpe-logo.svg",
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			got := resolveLogoURL(tc.baseURL, tc.ref)
			if got != tc.want {
				t.Errorf("resolveLogoURL(%q, %q) = %q, want %q", tc.baseURL, tc.ref, got, tc.want)
			} else {
				t.Logf("✓ resolveLogoURL(%q, %q) = %q", tc.baseURL, tc.ref, got)
			}
		})
	}
}

func TestSelectBestCandidate(t *testing.T) {
	candidates := []LogoCandidate{
		{URL: "logo.png", Format: "png", Score: 50.0, Width: 200, Height: 200},
		{URL: "logo.svg", Format: "svg", Score: 100.0, Width: 0, Height: 0},
		{URL: "logo.jpg", Format: "jpeg", Score: 30.0, Width: 100, Height: 100},
	}

	best := SelectBestCandidate(candidates)
	if best == nil {
		t.Fatal("No best candidate selected")
	}

	if best.Format != "svg" {
		t.Errorf("Expected SVG to be selected (score: %.2f), got %s (score: %.2f)",
			candidates[1].Score, best.Format, best.Score)
	}
}

func TestFilterByFormat(t *testing.T) {
	candidates := []LogoCandidate{
		{URL: "logo1.svg", Format: "svg", Score: 100.0},
		{URL: "logo2.png", Format: "png", Score: 50.0},
		{URL: "logo3.svg", Format: "svg", Score: 90.0},
		{URL: "logo4.jpg", Format: "jpeg", Score: 30.0},
	}

	svgCandidates := FilterByFormat(candidates, "svg")
	if len(svgCandidates) != 2 {
		t.Errorf("Expected 2 SVG candidates, got %d", len(svgCandidates))
	}

	for _, c := range svgCandidates {
		if c.Format != "svg" {
			t.Errorf("Expected SVG format, got %s", c.Format)
		}
	}
}

func TestCompanyNameToLinkedInSlug(t *testing.T) {
	tests := []struct {
		name string
		want string
	}{
		{"BHP Group Limited", "bhp"},
		{"Commonwealth Bank", "commonwealth-bank"},
		{"Rio Tinto Ltd", "rio-tinto"},
		{"Domino's Pizza Enterprises", "domino-s-pizza-enterprises"},
		{"", ""},
		{"  BHP  ", "bhp"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := companyNameToLinkedInSlug(tc.name)
			if got != tc.want {
				t.Errorf("companyNameToLinkedInSlug(%q) = %q, want %q", tc.name, got, tc.want)
			}
		})
	}
}

