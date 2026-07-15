package main

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/playwright-community/playwright-go"
)

// crawl_cdp.go implements the "option (b)" local-agent execution model: instead
// of the container rendering pages itself, the collector drives the HOST's
// macOS-native Chrome over the Chrome DevTools Protocol (CDP). A real,
// user-driven macOS Chrome is the only browser empirically proven to beat
// realestate.com.au's Kasada and domain.com.au's Akamai from a residential IP —
// a Linux/xvfb Chromium (even headed) is still detected.
//
// The runner container reaches the host Chrome via host.docker.internal (e.g.
// CRAWL_CDP_URL=http://host.docker.internal:9222 on Docker-Desktop-for-Mac).
// The host Chrome MUST be started with --remote-debugging-port=9222 AND a
// DEDICATED --user-data-dir (NEVER the personal profile — see the project's
// browser-automation safety rules), e.g.:
//
//	/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
//	  --remote-debugging-port=9222 \
//	  --user-data-dir="$HOME/.shorted-housing-crawl-chrome"
//
// Why reuse browser.Contexts()[0]: ConnectOverCDP attaches to the live browser,
// and its first (default) context IS the host Chrome's warm, persistent context.
// The Kasada clearance cookie + warmed profile live on the HOST and survive
// across runs, so we don't re-trigger the JS challenge every run. We open a fresh
// page per suburb on that shared context (same as the persistent-Chromium tier).
//
// Close() detaches WITHOUT killing the host browser — it's the user's Chrome, not
// ours to terminate. We never call browser.Close() here.

// cdpFetcher drives an already-running host Chrome over CDP. Like
// playwrightFetcher it is NOT safe for concurrent fetches (one shared context);
// the crawl loop is serial by design, and the mutex is belt-and-braces.
type cdpFetcher struct {
	pw       *playwright.Playwright
	browser  playwright.Browser
	ctx      playwright.BrowserContext
	ownedCtx bool // true if we created the context (must Close it); false if we reused the host's default context
	cfg      crawlConfig
	mu       sync.Mutex
	closeMu  sync.Once
}

// newCDPFetcher starts the Playwright driver (the CDP client needs only the
// DRIVER, not a bundled browser) and connects over CDP to the host Chrome at
// cfg.cdpURL. It reuses the host's warm default context when present (preserving
// the Kasada clearance cookie); only if the connected browser exposes no context
// does it create a fresh, AU-localised one. A connect failure returns a clear
// error so runCrawl fails non-fatally (the official backbone is unaffected).
func newCDPFetcher(cfg crawlConfig) (*cdpFetcher, error) {
	pw, err := playwright.Run()
	if err != nil {
		return nil, fmt.Errorf("playwright driver unavailable (CDP client still needs the driver; not installed in this environment — expected only inside Dockerfile.crawl): %w", err)
	}

	browser, err := pw.Chromium.ConnectOverCDP(cfg.cdpURL)
	if err != nil {
		_ = pw.Stop()
		return nil, fmt.Errorf("connect over CDP to %s: %w (is the host Chrome running with --remote-debugging-port and reachable via host.docker.internal?)", cfg.cdpURL, err)
	}

	// Reuse the host Chrome's warm, persistent default context (index 0). That is
	// where the Kasada clearance cookie + warmed profile live, so reusing it is
	// the whole point of option (b). Only fabricate a context if the connected
	// browser somehow exposes none.
	var bctx playwright.BrowserContext
	ownedCtx := false
	if ctxs := browser.Contexts(); len(ctxs) > 0 {
		bctx = ctxs[0]
	} else {
		bctx, err = browser.NewContext(playwright.BrowserNewContextOptions{
			Locale:     playwright.String("en-AU"),
			TimezoneId: playwright.String("Australia/Sydney"),
			UserAgent:  playwright.String(crawlUserAgent),
			Viewport:   &playwright.Size{Width: 1440, Height: 900},
		})
		if err != nil {
			_ = browser.Close()
			_ = pw.Stop()
			return nil, fmt.Errorf("create CDP browser context on %s: %w", cfg.cdpURL, err)
		}
		ownedCtx = true
	}

	return &cdpFetcher{pw: pw, browser: browser, ctx: bctx, ownedCtx: ownedCtx, cfg: cfg}, nil
}

// fetch reuses the SAME page-fetch/settle logic as playwrightFetcher (a fresh
// page on the shared context, floored DOMContentLoaded goto, bounded networkidle
// settle, Content() + URL()). looksBlocked detection happens in crawl.go's
// fetchPage, identical for both fetchers.
func (f *cdpFetcher) fetch(ctx context.Context, url string) ([]byte, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return fetchInContext(ctx, f.ctx, f.cfg, url)
}

// Close detaches from the host Chrome WITHOUT killing it. We only close a context
// WE created (never the host's warm default context), then stop the driver. We
// deliberately do NOT call browser.Close() — that would terminate the user's host
// Chrome. Idempotent.
func (f *cdpFetcher) Close() {
	f.closeMu.Do(func() {
		// Only tear down a context we created ourselves; never the host's warm
		// default context (closing it would discard the Kasada clearance cookie).
		if f.ownedCtx && f.ctx != nil {
			_ = f.ctx.Close()
		}
		// Stop the local driver. We intentionally skip browser.Close() so the
		// host Chrome keeps running (it's the user's browser, not ours).
		if f.pw != nil {
			_ = f.pw.Stop()
		}
	})
}

// screenshot captures a PNG screenshot of url on the shared warm host-Chrome
// context — the debug-trace mode's optional pageScreenshotter capability (see
// crawl_trace.go). fileFetcher/playwrightFetcher do NOT implement this
// interface, so tracing safely no-ops for them; only a live -mode
// listings/-mode agent run driven by CRAWL_CDP_URL against a real warm host
// Chrome exercises this method — it is NOT covered by the fixture-based unit
// tests (operationally verified by the operator, plan Task 10).
//
// This opens its OWN short-lived page independent of fetch()'s page lifecycle
// (fetch already closed its page by the time a caller decides to trace it),
// so it is an EXTRA navigation on top of the fetch that already happened for
// this page — an acceptable cost for an opt-in debug tool that the default
// (non-tracing) path never pays.
func (f *cdpFetcher) screenshot(ctx context.Context, url string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	page, err := f.ctx.NewPage()
	if err != nil {
		return nil, fmt.Errorf("trace screenshot new page: %w", err)
	}
	defer func() { _ = page.Close() }()

	gotoTimeout := float64(f.cfg.fetchTimeout / time.Millisecond)
	if gotoTimeout < 45000 {
		gotoTimeout = 45000
	}
	if _, err := page.Goto(url, playwright.PageGotoOptions{
		WaitUntil: playwright.WaitUntilStateDomcontentloaded,
		Timeout:   playwright.Float(gotoTimeout),
	}); err != nil {
		return nil, fmt.Errorf("trace screenshot goto %s: %w", url, err)
	}
	png, err := page.Screenshot(playwright.PageScreenshotOptions{FullPage: playwright.Bool(false)})
	if err != nil {
		return nil, fmt.Errorf("trace screenshot capture: %w", err)
	}
	return png, nil
}

// compile-time assertions that cdpFetcher satisfies all three seams.
var (
	_ htmlFetcher       = (*cdpFetcher)(nil)
	_ crawlFetcher      = (*cdpFetcher)(nil)
	_ pageScreenshotter = (*cdpFetcher)(nil)
)
