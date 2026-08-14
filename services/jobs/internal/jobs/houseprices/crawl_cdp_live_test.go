package houseprices

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// TestCDPFetcher_Live exercises the REAL production CDP fetcher (option (b):
// Playwright ConnectOverCDP to a host Chrome, reusing its warm default context)
// against live REA/Domain suburb pages. Skipped unless CRAWL_LIVE_CDP_URL points
// at a running Chrome started with --remote-debugging-port. This is the rig smoke
// test for the proven residential fetch path — NOT run in CI (no host Chrome).
func TestCDPFetcher_Live(t *testing.T) {
	cdp := os.Getenv("CRAWL_LIVE_CDP_URL")
	if cdp == "" {
		t.Skip("set CRAWL_LIVE_CDP_URL=http://127.0.0.1:9222 (a Chrome with --remote-debugging-port) to run")
	}
	f, err := newCDPFetcher(crawlConfig{cdpURL: cdp, fetchTimeout: 60 * time.Second})
	if err != nil {
		t.Fatalf("newCDPFetcher: %v", err)
	}
	defer f.Close()

	for _, u := range []string{
		"https://www.domain.com.au/sale/bondi-nsw-2026/",
		"https://www.realestate.com.au/buy/in-bondi,+nsw+2026/list-1",
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
		html, finalURL, err := f.fetch(ctx, u)
		cancel()
		if err != nil {
			t.Logf("FETCH ERR %s: %v", u, err)
			continue
		}
		body := string(html)
		t.Logf("%s\n  finalURL=%s bytes=%d NEXT_DATA=%v ArgonautExchange=%v KPSDK=%v blocked=%v",
			u, finalURL, len(body),
			strings.Contains(body, "__NEXT_DATA__"),
			strings.Contains(body, "ArgonautExchange"),
			strings.Contains(body, "KPSDK"),
			looksBlocked(html, finalURL))
	}
}
