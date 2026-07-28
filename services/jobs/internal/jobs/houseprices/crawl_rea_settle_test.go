package houseprices

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/mxschmitt/playwright-go"
)

// TestREASettle_Live drives a REA suburb SRP through the SAME Playwright
// ConnectOverCDP path the crawl uses, then POLLS the DOM for ~40s to see
// whether the Kasada KPSDK interstitial ever settles/reloads to the real page
// (ArgonautExchange listing blob) for an automated tab. Skipped unless
// REA_SETTLE_CDP_URL points at a running Chrome (--remote-debugging-port).
// This is a diagnostic, not a CI test.
func TestREASettle_Live(t *testing.T) {
	cdp := os.Getenv("REA_SETTLE_CDP_URL")
	if cdp == "" {
		t.Skip("set REA_SETTLE_CDP_URL=http://127.0.0.1:9335 to run")
	}
	pw, err := playwright.Run()
	if err != nil {
		t.Fatalf("playwright.Run: %v", err)
	}
	defer func() { _ = pw.Stop() }()
	browser, err := pw.Chromium.ConnectOverCDP(cdp)
	if err != nil {
		t.Fatalf("ConnectOverCDP: %v", err)
	}
	var ctx playwright.BrowserContext
	if cs := browser.Contexts(); len(cs) > 0 {
		ctx = cs[0] // reuse the warm host context (the crawl's pattern)
	} else {
		ctx, err = browser.NewContext()
		if err != nil {
			t.Fatalf("NewContext: %v", err)
		}
	}
	page, err := ctx.NewPage()
	if err != nil {
		t.Fatalf("NewPage: %v", err)
	}
	defer func() { _ = page.Close() }()

	// WARM STEP (the candidate fix): load the REA homepage first + let Kasada's
	// KPSDK settle, so the session carries a clearance cookie into the SRP fetch.
	if os.Getenv("REA_WARM") == "1" {
		if _, err := page.Goto("https://www.realestate.com.au/", playwright.PageGotoOptions{
			WaitUntil: playwright.WaitUntilStateDomcontentloaded, Timeout: playwright.Float(30000),
		}); err != nil {
			t.Logf("warm goto (non-fatal): %v", err)
		}
		t.Logf("warming: loaded REA homepage, settling 8s...")
		time.Sleep(8 * time.Second)
	}

	url := "https://www.realestate.com.au/buy/in-bondi,+nsw+2026/list-1"
	if _, err := page.Goto(url, playwright.PageGotoOptions{
		WaitUntil: playwright.WaitUntilStateDomcontentloaded,
		Timeout:   playwright.Float(30000),
	}); err != nil {
		t.Logf("goto (non-fatal): %v", err)
	}

	for i := 0; i < 14; i++ {
		html, _ := page.Content()
		low := strings.ToLower(html)
		arg := strings.Contains(html, "ArgonautExchange")
		t.Logf("t=%2ds bytes=%7d ArgonautExchange=%-5v KPSDK=%-5v jsCookieWall=%v url=%s",
			i*3, len(html), arg, strings.Contains(html, "KPSDK"),
			strings.Contains(low, "please enable javascript and cookies"), page.URL())
		if arg {
			t.Logf(">>> REA REAL PAGE appeared at t=%ds (a settle-wait fix IS viable)", i*3)
			return
		}
		time.Sleep(3 * time.Second)
	}
	t.Logf(">>> REA never surfaced ArgonautExchange in 40s — automated tab stays walled (settle-wait alone won't fix it)")
}
