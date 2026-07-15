package main

import (
	"context"
	"log"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

// crawl_warmcheck.go implements the `-mode warmcheck` preflight verifier. The
// crawl's REA reliability depends on a fact that isn't obvious from the code
// path alone: Chrome's own NATIVE startup navigation to a REA URL clears
// Kasada's KPSDK challenge and sets a session cookie, but a Playwright-DRIVEN
// navigation to the same URL does NOT — it returns an ~870-byte KPSDK stub
// with 0 listings, and the sweep silently marks the source "blocked". Once the
// session IS warm (started the right way), this same Playwright/CDP fetch
// path returns the real ~1.17MB ArgonautExchange listing page fine.
//
// Rather than depend on an operator remembering to launch Chrome with a REA
// startup URL, this mode PROVES warmth before a real crawl runs: it fetches
// one REA search page through the exact fetcher the crawl itself uses (CDP to
// the host Chrome in production) and classifies the result. The launcher
// (deploy/run-housing-crawl.sh) calls this after confirming Chrome is
// reachable, and re-warms + retries if it reports NOT warm.
//
// Exit codes (mirrored by the launcher):
//
//	0 = warm    — REA returned the real ArgonautExchange listing page
//	4 = fetcher init failed — Chrome/CDP unreachable, same convention as the
//	    crawl/listings modes use for an unusable browser client
//	5 = not warm — fetched fine but REA served the Kasada stub; re-warm needed

// reaWarmMinBytes is the size floor a real REA listing page clears easily
// (the observed Kasada KPSDK stub is ~870 bytes). Anything under this is
// treated as not warm even if it happens to contain the marker substring.
const reaWarmMinBytes = 5000

// reaWarmCheckURL returns a stable REA search-results URL used purely to
// PROBE warmth — the response is classified, never parsed for listings.
// Bondi is the suburb this reliability fact was originally verified against
// (see crawl_rea_settle_test.go), so it's reused here for consistency; the
// hardcoded fallback covers the (untestable in practice) case where
// crawlTargets is ever empty.
func reaWarmCheckURL() string {
	for _, t := range crawlTargets {
		if t.Display == "Bondi" {
			return t.reaSearchURL(1)
		}
	}
	if len(crawlTargets) > 0 {
		return crawlTargets[0].reaSearchURL(1)
	}
	return "https://www.realestate.com.au/buy/in-bondi,+nsw+2026/list-1"
}

// reaLooksWarm is the pure classification rule, factored out of runWarmCheck
// so it's directly unit-testable without a browser: a page is warm when it
// contains REA's ArgonautExchange listing blob AND is large enough not to be
// the tiny Kasada KPSDK stub.
func reaLooksWarm(html []byte) bool {
	return len(html) > reaWarmMinBytes && strings.Contains(string(html), "ArgonautExchange")
}

// runWarmCheck fetches one REA search page via the SAME fetcher the crawl
// itself uses and reports whether the session is warm. It never touches the
// database — pool is accepted only to keep the same call shape as the other
// run* entry points in main.go.
func runWarmCheck(ctx context.Context, pool *pgxpool.Pool) int {
	_ = pool
	cfg := loadCrawlConfig()

	fetcher, err := newCrawlFetcher(cfg)
	if err != nil {
		log.Printf("[warmcheck] fetcher init failed (%v) — Chrome unreachable", err)
		return 4
	}
	defer fetcher.Close()

	url := reaWarmCheckURL()
	html, _, err := fetcher.fetch(ctx, url)
	if err != nil {
		log.Printf("[warmcheck] REA fetch error: %v", err)
	}

	if reaLooksWarm(html) {
		log.Printf("[warmcheck] REA warm (%d bytes, ArgonautExchange present)", len(html))
		return 0
	}

	log.Printf("[warmcheck] REA NOT warm — Kasada stub (~%d bytes). Relaunch the dedicated Chrome with a REA startup URL: --user-data-dir=\"$HOME/.shorted-housing-crawl-chrome\" \"https://www.realestate.com.au/\"", len(html))
	return 5
}
