package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/mxschmitt/playwright-go"
)

// crawl_playwright.go is the SELF-LAUNCHED real-browser FETCH for the Tier-3
// crawl: it launches its OWN headed, persistent-profile Chromium via playwright-go.
// This is the native/launchd FALLBACK path (used when CRAWL_CDP_URL is NOT set).
// The primary, "option (b)" path is crawl_cdp.go, which instead drives the HOST
// macOS Chrome over CDP — empirically the only client that survives
// realestate.com.au's Kasada and domain.com.au's Akamai from a residential IP
// (headless Chromium and chromedp are both detected and blocked/poisoned).
//
// Persistence is the whole point of this fallback: the user-data-dir
// (CRAWL_PROFILE_DIR) lets the Kasada clearance cookie survive across runs, so a
// warm profile rarely re-triggers the JS challenge. We reuse ONE browser context
// for the whole run and open a fresh page per suburb — the SAME fetch/settle logic
// (fetchInContext, below) that the CDP fetcher reuses.
//
// This file is compiled everywhere but only does real work when the Playwright
// driver + chromium browser are present. We NEVER call playwright.Install() here —
// that would download browsers at runtime. A missing driver yields a clear error
// so runCrawl can fail non-fatally and tests can verify the build without any
// browser.

// realistic, current desktop Chrome on Windows UA (matches the headed Chromium we
// launch closely enough to avoid trivial UA/engine mismatch heuristics).
const crawlUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

// settleCap bounds the post-navigation "network idle" settle wait. Kasada/Akamai
// pages keep beacons alive, so networkidle often never fires — we tolerate the
// timeout and return whatever DOM we have.
const settleCap = 12 * time.Second

// playwrightFetcher is a headed, persistent-context Chromium fetcher. It is NOT
// safe for concurrent fetches (one shared context); the crawl loop is serial by
// design (heavy human-like pacing), so a mutex is sufficient belt-and-braces.
type playwrightFetcher struct {
	pw      *playwright.Playwright
	ctx     playwright.BrowserContext
	cfg     crawlConfig
	mu      sync.Mutex
	closeMu sync.Once
}

// newPlaywrightFetcher starts the Playwright driver (already installed in the
// image) and launches a headed, persistent Chromium context with an AU locale /
// timezone, a realistic UA and a 1440x900 viewport. Returns a clear error if the
// driver or browser is missing (so the build is verifiable without browsers).
func newPlaywrightFetcher(cfg crawlConfig) (*playwrightFetcher, error) {
	pw, err := playwright.Run()
	if err != nil {
		return nil, fmt.Errorf("playwright driver/browsers unavailable (not installed in this environment — expected only inside Dockerfile.crawl): %w: %w", errPlaywrightDriverMissing, err)
	}

	bctx, err := pw.Chromium.LaunchPersistentContext(cfg.profileDir, playwright.BrowserTypeLaunchPersistentContextOptions{
		Headless:   playwright.Bool(false), // headed: the only posture Kasada/Akamai don't block from a residential IP
		Locale:     playwright.String("en-AU"),
		TimezoneId: playwright.String("Australia/Sydney"),
		UserAgent:  playwright.String(crawlUserAgent),
		Viewport:   &playwright.Size{Width: 1440, Height: 900},
		Args: []string{
			// reduce the most obvious automation tells without faking a headless flag
			"--disable-blink-features=AutomationControlled",
		},
	})
	if err != nil {
		_ = pw.Stop()
		return nil, fmt.Errorf("launch headed persistent chromium (profile=%s): %w", cfg.profileDir, err)
	}

	return &playwrightFetcher{pw: pw, ctx: bctx, cfg: cfg}, nil
}

// fetch navigates to url in a fresh page on the shared persistent context, waits
// for DOMContentLoaded then a bounded network-idle settle, and returns the fully
// rendered DOM plus the final URL. Everything is bounded by the page timeout and
// the caller's context; it never hangs.
func (f *playwrightFetcher) fetch(ctx context.Context, url string) ([]byte, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return fetchInContext(ctx, f.ctx, f.cfg, url)
}

// fetchInContext is the SHARED page-fetch/settle logic used by BOTH browser
// fetchers (the self-launched persistent Chromium and the CDP-to-host-Chrome
// fetcher). It opens a fresh page on the given BrowserContext, navigates with a
// floored DOMContentLoaded timeout, waits a bounded network-idle settle (Kasada/
// Akamai beacons keep the network "busy", so the settle is best-effort), and
// returns the rendered DOM + final URL. Bounded by the page timeout and the
// caller's context; it never hangs. The same looksBlocked detection (in crawl.go's
// fetchPage) classifies the result for both fetchers.
func fetchInContext(ctx context.Context, bctx playwright.BrowserContext, cfg crawlConfig, url string) ([]byte, string, error) {
	if ctx.Err() != nil {
		return nil, "", ctx.Err()
	}

	page, err := bctx.NewPage()
	if err != nil {
		return nil, "", fmt.Errorf("new page: %w", err)
	}
	defer func() { _ = page.Close() }()

	gotoTimeout := float64(cfg.fetchTimeout / time.Millisecond)
	if gotoTimeout < 45000 {
		gotoTimeout = 45000 // floor: a real first navigation through a JS challenge is slow
	}
	if _, err := page.Goto(url, playwright.PageGotoOptions{
		WaitUntil: playwright.WaitUntilStateDomcontentloaded,
		Timeout:   playwright.Float(gotoTimeout),
	}); err != nil {
		return nil, "", fmt.Errorf("goto %s: %w", url, err)
	}

	// Bounded settle wait: try for networkidle but tolerate the (common) timeout —
	// Kasada/Akamai beacons keep the network "busy" indefinitely.
	_ = page.WaitForLoadState(playwright.PageWaitForLoadStateOptions{
		State:   playwright.LoadStateNetworkidle,
		Timeout: playwright.Float(float64(settleCap / time.Millisecond)),
	})

	html, err := page.Content()
	if err != nil {
		return nil, "", fmt.Errorf("content: %w", err)
	}
	return []byte(html), page.URL(), nil
}

// Close tears down the browser context and the driver. Idempotent.
func (f *playwrightFetcher) Close() {
	f.closeMu.Do(func() {
		if f.ctx != nil {
			_ = f.ctx.Close()
		}
		if f.pw != nil {
			_ = f.pw.Stop()
		}
	})
}

// --- block detection (shared by the orchestration in crawl.go) ---

// isBlockError reports whether a fetch error looks like an anti-bot block (vs a
// transient network/timeout error). Playwright surfaces HTTP status only via the
// Response object, so a hard 403/429 navigation generally still resolves with a
// body; the textual heuristics in looksBlocked catch those. Here we only treat an
// explicit access-denied style navigation error as a block.
func isBlockError(err error) bool {
	if err == nil {
		return false
	}
	// A gateway-reported block/poison, and a lost warm-Chrome clearance, both
	// back off the per-site circuit breaker (repeated needs_rewarm → exit-3 rewarm).
	if errors.Is(err, errGatewayBlocked) || errors.Is(err, errGatewayNeedsRewarm) {
		return true
	}
	msg := strings.ToLower(err.Error())
	for _, s := range []string{"err_http_response_code_failure", "403", "429", "access denied", "net::err_blocked"} {
		if strings.Contains(msg, s) {
			return true
		}
	}
	// context cancellation/timeout is NOT a block — let it be a transient error.
	return false
}

// blockMarkers are fragments that appear on a Kasada/Akamai challenge or
// access-denied interstitial (rather than a real suburb page). A rendered DOM
// containing one of these — or a redirect to a challenge URL — is treated as a
// block so the circuit breaker can back off.
// NOTE: do NOT match the bare vendor name "kasada" — realestate.com.au (which USES
// Kasada) references it in the SDK on EVERY legitimate page, so matching it
// discarded every real REA page as a false "block". Match only actual
// challenge/denied interstitial markers; a genuine block is also caught downstream
// by "no listings/medians extracted".
var blockMarkers = []string{
	"px-captcha",
	"/_incapsula_",
	"access denied",
	"are you a human",
	"please enable javascript and cookies",
	"reference #", // Akamai access-denied interstitial
	"request unsuccessful. incapsula",
}

// looksBlocked inspects the rendered HTML and final URL for anti-bot interstitial
// markers. It is conservative (substring match on lowercased content) and only
// used to trip the circuit breaker — never to mutate stored data.
func looksBlocked(html []byte, finalURL string) bool {
	if len(html) == 0 {
		return true
	}
	lower := strings.ToLower(string(html))
	for _, m := range blockMarkers {
		if strings.Contains(lower, m) {
			return true
		}
	}
	u := strings.ToLower(finalURL)
	if strings.Contains(u, "/distil_") || strings.Contains(u, "challenge") {
		return true
	}
	return false
}

// compile-time assertions that playwrightFetcher satisfies both seams.
var (
	_ htmlFetcher  = (*playwrightFetcher)(nil)
	_ crawlFetcher = (*playwrightFetcher)(nil)
)
