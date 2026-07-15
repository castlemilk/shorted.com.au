package main

import (
	"context"
	"os"
	"testing"
)

// TestDumpSRPBlobs is a Phase-0 discovery helper: it fetches one REA and one
// Domain search-results page through the SAME CDP path the crawl uses and writes
// the raw HTML to /tmp so the total-result-count / total-pages / page-size key
// paths can be confirmed before implementing extractPageMeta. Guarded on
// PAGEMETA_CDP_URL (a warm Chrome). Diagnostic only.
func TestDumpSRPBlobs(t *testing.T) {
	cdp := os.Getenv("PAGEMETA_CDP_URL")
	if cdp == "" {
		t.Skip("set PAGEMETA_CDP_URL=http://127.0.0.1:9335 (warm Chrome) to run")
	}
	t.Setenv("CRAWL_CDP_URL", cdp)

	fetcher, err := newCrawlFetcher(loadCrawlConfig())
	if err != nil {
		t.Fatalf("newCrawlFetcher: %v", err)
	}
	defer fetcher.Close()

	tgt := CrawlTarget{Suburb: "new-farm", Display: "New Farm", Postcode: "4005", State: "QLD", Capital: "3GBRI"}
	ctx := context.Background()

	for _, c := range []struct {
		name string
		url  string
		out  string
	}{
		{"rea", tgt.reaSearchURL(1), "/tmp/rea-srp.html"},
		{"domain", tgt.domainSearchURL(1), "/tmp/domain-srp.html"},
	} {
		html, _, err := fetcher.fetch(ctx, c.url)
		if err != nil {
			t.Errorf("%s fetch: %v", c.name, err)
			continue
		}
		if werr := os.WriteFile(c.out, html, 0o644); werr != nil {
			t.Errorf("%s write: %v", c.name, werr)
			continue
		}
		t.Logf("%s: %d bytes → %s", c.name, len(html), c.out)
	}
}
