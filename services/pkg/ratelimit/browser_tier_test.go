package ratelimit

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// "Unlimited" must not be advertised as zero
// ---------------------------------------------------------------------------
//
// A limit of 0 in the tier table means UNLIMITED — paid browser access has 0 in
// both columns. Emitting `X-RateLimit-Limit: 0` would tell a client it may make
// zero requests, which is the exact opposite of the truth, and a client that
// believed it would stop calling.

func TestUnlimitedTiersEmitNoQuotaHeadersAtAll(t *testing.T) {
	rec := httptest.NewRecorder()
	writeQuotaHeaders(rec.Header().Set, &Result{
		Allowed:      true,
		Tier:         "premium",
		Limit:        0, // unlimited
		MonthlyLimit: 0, // unlimited
	})

	for _, h := range []string{
		headerLimit, headerRemaining, headerReset,
		headerMonthlyLimit, headerMonthlyUsed, headerMonthlyRemain, headerMonthlyReset,
	} {
		if got := rec.Header().Get(h); got != "" {
			t.Errorf("%s = %q on an unlimited tier; it must be omitted, not zero", h, got)
		}
	}
}

// One window unlimited and the other metered is a real combination (a paid
// browser caller is unlimited per minute but the API column is not), so the two
// halves have to be independent rather than all-or-nothing.
func TestTheTwoWindowsAreAdvertisedIndependently(t *testing.T) {
	rec := httptest.NewRecorder()
	writeQuotaHeaders(rec.Header().Set, &Result{
		Allowed:        true,
		Tier:           "premium",
		Limit:          0, // per-minute unlimited
		MonthlyLimit:   10000,
		MonthlyUsed:    150,
		MonthlyResetAt: time.Now().Add(72 * time.Hour),
	})

	if got := rec.Header().Get(headerLimit); got != "" {
		t.Errorf("per-minute header emitted for an unlimited window: %q", got)
	}
	if got := rec.Header().Get(headerMonthlyLimit); got != "10000" {
		t.Errorf("X-RateLimit-Monthly-Limit = %q, want 10000", got)
	}
	if got := rec.Header().Get(headerMonthlyRemain); got != "9850" {
		t.Errorf("X-RateLimit-Monthly-Remaining = %q, want 9850", got)
	}
}

// Remaining is clamped at zero. A negative remaining is not a number a client
// can act on, and it leaks that we counted past the ceiling.
func TestRemainingNeverGoesNegative(t *testing.T) {
	rec := httptest.NewRecorder()
	writeQuotaHeaders(rec.Header().Set, &Result{
		Allowed:      true,
		Limit:        60,
		Remaining:    -5,
		MonthlyLimit: 1000,
		MonthlyUsed:  1200, // over, e.g. after a cross-instance overshoot
	})

	if got := rec.Header().Get(headerRemaining); got != "0" {
		t.Errorf("X-RateLimit-Remaining = %q, want 0", got)
	}
	if got := rec.Header().Get(headerMonthlyRemain); got != "0" {
		t.Errorf("X-RateLimit-Monthly-Remaining = %q, want 0", got)
	}
}

// A zero time must not be published as the unix epoch: 1970 tells a client the
// window reset 56 years ago, so it retries immediately and forever.
func TestAZeroResetTimeIsPublishedAsZeroNotTheEpoch(t *testing.T) {
	rec := httptest.NewRecorder()
	writeQuotaHeaders(rec.Header().Set, &Result{
		Allowed: true,
		Limit:   60, ResetAt: time.Time{},
	})
	if got := rec.Header().Get(headerReset); got != "0" {
		t.Errorf("X-RateLimit-Reset = %q for a zero time", got)
	}
}

// ---------------------------------------------------------------------------
// The browser-tier downgrade
// ---------------------------------------------------------------------------
//
// Browser tiers are far more generous than API tiers — paid browser access is
// unlimited. So a scraper holding a stolen Firebase token would love to be
// treated as a browser. isValidBrowserOrigin is the check that stops it: a
// caller claiming browser auth without a recognisable Origin/Referer is
// downgraded to the API column.
//
// This is pre-existing code that had NO direct coverage. It is asserted here
// because the cost of it silently returning true is that every API tier becomes
// the browser tier.

func TestOnlyOurOwnOriginsCountAsBrowserTraffic(t *testing.T) {
	allowed := []string{"shorted.com.au", "www.shorted.com.au"}

	valid := []string{
		"https://shorted.com.au",
		"https://www.shorted.com.au",
		"https://shorted.com.au/reports/weekly",
		"shorted.com.au",
		// Preview deployments are always trusted.
		"https://shorted-com-abc123.vercel.app",
		"https://anything.vercel.app",
	}
	for _, origin := range valid {
		if !isValidBrowserOrigin(origin, allowed) {
			t.Errorf("%q was not recognised as our own origin", origin)
		}
	}

	invalid := []string{
		"",
		"https://evil.example",
		// The classic near-miss: our domain as a PREFIX of theirs.
		"https://shorted.com.au.evil.example",
		// And as a subdomain of theirs.
		"https://www.shorted.com.au.attacker.test",
		// A path that merely mentions us.
		"https://evil.example/https://shorted.com.au",
		// vercel.app as a prefix rather than a suffix.
		"https://vercel.app.evil.example",
		// Not a URL at all.
		"::::",
	}
	for _, origin := range invalid {
		if isValidBrowserOrigin(origin, allowed) {
			t.Errorf("%q was accepted as our own origin — a scraper gets browser-tier limits", origin)
		}
	}
}

func TestExtractHostnameHandlesTheShapesOriginArrivesIn(t *testing.T) {
	cases := map[string]string{
		"https://shorted.com.au":             "shorted.com.au",
		"https://www.shorted.com.au/a/b?c=d": "www.shorted.com.au",
		"shorted.com.au":                     "shorted.com.au",
		"localhost:3020":                     "localhost",
		"shorted.com.au/reports":             "shorted.com.au",
		"http://127.0.0.1:8080":              "127.0.0.1",
		"":                                   "",
	}
	for in, want := range cases {
		if got := extractHostname(in); got != want {
			t.Errorf("extractHostname(%q) = %q, want %q", in, got, want)
		}
	}
}

// ---------------------------------------------------------------------------
// ClientIP, on the paths the earlier tests did not reach
// ---------------------------------------------------------------------------

// Trailing empty entries are how a caller tries to push the proxy-appended
// address out of the rightmost slot.
func TestClientIPSkipsEmptyTrailingForwardedEntries(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	r.Header.Set("X-Forwarded-For", "evil, 203.0.113.9, , ")
	if got := ClientIP(r); got != "203.0.113.9" {
		t.Errorf("ClientIP = %q — empty entries defeated the rightmost rule", got)
	}
}

func TestClientIPAlwaysReturnsSomething(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	r.RemoteAddr = ""
	// An empty key would collapse every unidentifiable caller into one shared
	// bucket, which either throttles innocents together or collides with a
	// real key.
	if got := ClientIP(r); got == "" {
		t.Error("ClientIP returned an empty rate-limit key")
	}
}

func TestClientIPHandlesABareRemoteAddrWithNoPort(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	r.RemoteAddr = "192.0.2.7"
	if got := ClientIP(r); got != "192.0.2.7" {
		t.Errorf("ClientIP = %q, want 192.0.2.7", got)
	}
}
