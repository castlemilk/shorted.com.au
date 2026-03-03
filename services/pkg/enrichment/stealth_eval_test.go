package enrichment

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
)

// TestStealthFetchHTML_CompareWithRaw tests stealth client against various company websites.
// Run with: go test -v -run TestStealthFetchHTML_CompareWithRaw ./pkg/enrichment/ -timeout 120s
func TestStealthFetchHTML_CompareWithRaw(t *testing.T) {
	if os.Getenv("RUN_STEALTH_EVAL") == "" {
		t.Skip("Set RUN_STEALTH_EVAL=1 to run stealth eval tests")
	}

	sites := []struct {
		name string
		url  string
	}{
		{"BHP", "https://www.bhp.com"},
		{"CBA", "https://www.commbank.com.au"},
		{"CSL", "https://www.csl.com"},
		{"Dominos", "https://www.dominos.com.au"},
		{"ASX Announcements", "https://www.asx.com.au/asx/v2/statistics/announcements.do?by=asxCode&timeframe=Y&year=2025&asxCode=BHP"},
	}

	client, err := stealthhttp.New(stealthhttp.WithTimeout(30 * time.Second))
	if err != nil {
		t.Fatalf("Failed to create stealth client: %v", err)
	}
	defer func() { _ = client.Close() }()

	for _, site := range sites {
		t.Run(site.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()

			start := time.Now()
			doc, finalURL, err := client.FetchHTML(ctx, site.url)
			elapsed := time.Since(start)

			if err != nil {
				t.Logf("FAIL %s: %v (%.2fs)", site.name, err, elapsed.Seconds())
				return
			}

			title := doc.Find("title").Text()
			imgCount := doc.Find("img").Length()
			linkCount := doc.Find("a").Length()

			t.Logf("OK %s (%.2fs): title=%q, imgs=%d, links=%d, finalURL=%s",
				site.name, elapsed.Seconds(), title, imgCount, linkCount, finalURL)
		})
	}
}

// TestLinkedInLogoDiscovery_Eval tests LinkedIn logo discovery for real ASX companies.
// Run with: go test -v -run TestLinkedInLogoDiscovery_Eval ./pkg/enrichment/ -timeout 300s
func TestLinkedInLogoDiscovery_Eval(t *testing.T) {
	if os.Getenv("RUN_STEALTH_EVAL") == "" {
		t.Skip("Set RUN_STEALTH_EVAL=1 to run stealth eval tests")
	}

	companies := []struct {
		name      string
		stockCode string
		website   string
	}{
		{"BHP Group Limited", "BHP", "https://www.bhp.com"},
		{"Commonwealth Bank of Australia", "CBA", "https://www.commbank.com.au"},
		{"CSL Limited", "CSL", "https://www.csl.com"},
		{"Telstra Group Limited", "TLS", "https://www.telstra.com.au"},
		{"Woolworths Group Ltd", "WOW", "https://www.woolworthsgroup.com.au"},
	}

	for _, c := range companies {
		t.Run(c.stockCode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()

			// Test 1: Standard logo discovery (website scraping)
			t.Log("--- Website logo discovery ---")
			start := time.Now()
			discoverer := NewLogoDiscoverer()
			logo, err := discoverer.DiscoverLogo(ctx, c.website, c.name, c.stockCode)
			websiteElapsed := time.Since(start)

			if err != nil {
				t.Logf("Website logo: FAIL (%v) (%.2fs)", err, websiteElapsed.Seconds())
			} else {
				t.Logf("Website logo: OK format=%s size=%d quality=%.1f source=%s (%.2fs)",
					logo.Format, len(logo.ImageData), logo.QualityScore, logo.SourceURL, websiteElapsed.Seconds())
			}

			// Test 2: LinkedIn slug generation
			slug := companyNameToLinkedInSlug(c.name)
			t.Logf("LinkedIn slug: %q -> %q (URL: https://www.linkedin.com/company/%s/)", c.name, slug, slug)

			// Test 3: LinkedIn logo discovery directly
			t.Log("--- LinkedIn logo discovery ---")
			start = time.Now()
			ld := &logoDiscoverer{}
			client, clientErr := stealthhttp.New(stealthhttp.WithTimeout(30 * time.Second))
			if clientErr != nil {
				t.Fatalf("Failed to create client: %v", clientErr)
			}
			defer func() { _ = client.Close() }()
			ld.client = client

			linkedInLogo, linkedInErr := ld.discoverLinkedInLogo(ctx, c.name)
			linkedInElapsed := time.Since(start)

			if linkedInErr != nil {
				t.Logf("LinkedIn logo: FAIL (%v) (%.2fs)", linkedInErr, linkedInElapsed.Seconds())
			} else {
				t.Logf("LinkedIn logo: OK format=%s size=%d quality=%.1f source=%s (%.2fs)",
					linkedInLogo.Format, len(linkedInLogo.ImageData), linkedInLogo.QualityScore,
					linkedInLogo.SourceURL, linkedInElapsed.Seconds())
			}
		})
	}
}

// TestLogoDiscovery_FullPipeline runs the full logo discovery pipeline with LinkedIn fallback.
// Run with: go test -v -run TestLogoDiscovery_FullPipeline ./pkg/enrichment/ -timeout 300s
func TestLogoDiscovery_FullPipeline(t *testing.T) {
	if os.Getenv("RUN_STEALTH_EVAL") == "" {
		t.Skip("Set RUN_STEALTH_EVAL=1 to run stealth eval tests")
	}

	// Test with a company that might have a hard-to-scrape website
	// but should be findable on LinkedIn
	companies := []struct {
		name      string
		stockCode string
		website   string
	}{
		{"BHP Group Limited", "BHP", "https://www.bhp.com"},
		{"Rio Tinto Limited", "RIO", "https://www.riotinto.com"},
		{"Afterpay Limited", "APT", "https://www.afterpay.com"},
	}

	for _, c := range companies {
		t.Run(c.stockCode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()

			discoverer := NewLogoDiscovererWithCompanyName(c.name)
			start := time.Now()
			logo, err := discoverer.DiscoverLogo(ctx, c.website, c.name, c.stockCode)
			elapsed := time.Since(start)

			if err != nil {
				t.Logf("FAIL: %v (%.2fs)", err, elapsed.Seconds())
			} else {
				t.Logf("OK: format=%s size=%dB quality=%.1f svg=%v source=%s (%.2fs)",
					logo.Format, len(logo.ImageData), logo.QualityScore, logo.IsSVG,
					logo.SourceURL, elapsed.Seconds())
			}
		})
	}
}

// TestLinkedInSlugMapping verifies slug generation for common ASX companies.
func TestLinkedInSlugMapping(t *testing.T) {
	tests := []struct {
		companyName string
		wantSlug    string
	}{
		{"BHP Group Limited", "bhp"},
		{"Commonwealth Bank of Australia", "commonwealth-bank-of-australia"},
		{"CSL Limited", "csl"},
		{"Telstra Group Limited", "telstra"},
		{"Woolworths Group Ltd", "woolworths"},
		{"Rio Tinto Limited", "rio-tinto"},
		{"National Australia Bank Limited", "national-australia-bank"},
		{"Afterpay Limited", "afterpay"},
		{"Fortescue Metals Group Ltd", "fortescue-metals"},
		{"Macquarie Group Limited", "macquarie"},
	}

	for _, tc := range tests {
		t.Run(tc.companyName, func(t *testing.T) {
			got := companyNameToLinkedInSlug(tc.companyName)
			fmt.Printf("  %-40s -> %-30s (want: %s)\n", tc.companyName, got, tc.wantSlug)
			if got != tc.wantSlug {
				t.Errorf("companyNameToLinkedInSlug(%q) = %q, want %q", tc.companyName, got, tc.wantSlug)
			}
		})
	}
}
