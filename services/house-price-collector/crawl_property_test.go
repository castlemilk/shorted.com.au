package main

import (
	"strings"
	"testing"
)

// TestPropertyStubTreatedAsBlock is the #333 regression carried into this tier: an
// anti-bot stub profile page (200-status, tiny, no payload) must be caught by
// pageLooksStub BEFORE extract — otherwise extractPropertyProfile returns ok=false
// and runProperty would stamp a HEALTHY address fetch_status='error' for the whole
// TTL. property.com.au is the SAME Kasada tenant as REA, so the stub-as-block guard
// is essential.
func TestPropertyStubTreatedAsBlock(t *testing.T) {
	stub := []byte(`<html><body><script>window.kpsdk={};</script>blocked</body></html>`) // ~1KB, no profile payload
	if !pageLooksStub(stub, propertySource) {
		t.Error("a tiny Kasada stub must be detected as a stub (→ block path, not stamped)")
	}
	// Absent the guard this stub would have extracted no payload — the false 'error'
	// stamp the guard prevents.
	if _, ok := extractPropertyProfile(string(stub)); ok {
		t.Error("the stub must not extract a payload")
	}
	// A real, large profile page is NOT a stub (clears the size floor) and extracts.
	real := propertyNextDataHTML() + strings.Repeat("<!-- padding to clear the 5KB size floor -->", 200)
	if pageLooksStub([]byte(real), propertySource) {
		t.Error("a real property.com.au profile page must not be flagged a stub")
	}
	if _, ok := extractPropertyProfile(real); !ok {
		t.Error("a real profile page must extract cleanly")
	}
}

func TestResolveProfileURL(t *testing.T) {
	cases := []struct {
		name string
		in   propertyTarget
		want string
		ok   bool
	}{
		{
			name: "full address → constructed slug",
			in:   propertyTarget{displayAddress: "12 Smith Street, Bondi NSW 2026", suburb: "Bondi", stateCode: "NSW", postcode: "2026"},
			want: "https://www.property.com.au/nsw/bondi-2026/12-smith-street",
			ok:   true,
		},
		{
			name: "domain-style street-only display (no suburb suffix)",
			in:   propertyTarget{displayAddress: "5/40 Terrace Road", suburb: "New Farm", stateCode: "QLD", postcode: "4005"},
			want: "https://www.property.com.au/qld/new-farm-4005/5-40-terrace-road",
			ok:   true,
		},
		{
			name: "missing postcode → unresolved",
			in:   propertyTarget{displayAddress: "1 Test St, Foo VIC", suburb: "Foo", stateCode: "VIC", postcode: ""},
			ok:   false,
		},
		{
			name: "missing suburb → unresolved",
			in:   propertyTarget{displayAddress: "1 Test St", suburb: "", stateCode: "VIC", postcode: "3000"},
			ok:   false,
		},
		{
			name: "display collapses to just the suburb → no street → unresolved",
			in:   propertyTarget{displayAddress: "Bondi", suburb: "Bondi", stateCode: "NSW", postcode: "2026"},
			ok:   false,
		},
	}
	for _, c := range cases {
		got, ok := resolveProfileURL(c.in)
		if ok != c.ok {
			t.Errorf("%s: ok = %v, want %v (url=%q)", c.name, ok, c.ok, got)
			continue
		}
		if ok && got != c.want {
			t.Errorf("%s: url = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestResolveViaSearch_IsStub(t *testing.T) {
	// The Phase-0 search-resolve hook is a stub until the live probe wires it — it
	// must always defer to the constructed slug.
	if _, ok := resolveViaSearch(propertyTarget{suburb: "Bondi", stateCode: "NSW", postcode: "2026"}); ok {
		t.Error("resolveViaSearch must be a no-op stub (return ok=false) until the probe wires it")
	}
}

func TestIsProfileNotFound(t *testing.T) {
	healthy := []byte("<html><body>3 bed house, estimated value $2.35m</body></html>")
	marker := []byte("<html><body>Sorry, we couldn't find that property.</body></html>")

	cases := []struct {
		name     string
		finalURL string
		html     []byte
		want     bool
	}{
		// A live profile URL (final path is a real profile) — NOT not-found.
		{"live profile", "https://www.property.com.au/nsw/bondi-2026/12-smith-street", healthy, false},
		// Redirected to the search/find surface → address has no profile.
		{"redirect to /find", "https://www.property.com.au/find?q=12+smith+st", healthy, true},
		{"redirect to /search", "https://www.property.com.au/search/results", healthy, true},
		// Explicit not-found path.
		{"property-not-found path", "https://www.property.com.au/property-not-found", healthy, true},
		{"404 path", "https://www.property.com.au/404", healthy, true},
		// Explicit page marker fires even with an empty final URL.
		{"marker, empty url", "", marker, true},
		// Empty URL + healthy page: trust only markers → NOT not-found.
		{"empty url, healthy page", "", healthy, false},
		// Non-property host with a healthy page: never infer not-found from the URL.
		{"non-property host", "https://example.com/anything", healthy, false},
	}
	for _, c := range cases {
		if got := isProfileNotFound(c.finalURL, c.html); got != c.want {
			t.Errorf("%s: isProfileNotFound(%q) = %v, want %v", c.name, c.finalURL, got, c.want)
		}
	}
}

func TestPreviewProperty(t *testing.T) {
	p := propertyProfile{
		EstimateLow:        f64p(2100000),
		EstimateMid:        f64p(2350000),
		EstimateHigh:       f64p(2600000),
		EstimateConfidence: "high",
		PropertyType:       "House",
		Bedrooms:           int16p(3),
		YearBuilt:          int16p(1998),
		SalesHistory:       []saleRecord{{Date: "2018-05-01"}, {Date: "2009-03-14"}},
	}
	got := previewProperty(p)
	for _, want := range []string{"est=", "conf=high", "sales=2", "type=House", "beds=3", "built=1998"} {
		if !strings.Contains(got, want) {
			t.Errorf("preview %q missing %q", got, want)
		}
	}
	if previewProperty(propertyProfile{}) != "(no fields harvested)" {
		t.Errorf("empty preview = %q", previewProperty(propertyProfile{}))
	}
}

func TestNeedsRewarmStreak(t *testing.T) {
	if needsRewarmStreak(2, 2) != true {
		t.Error("streak==threshold should signal rewarm")
	}
	if needsRewarmStreak(2, 1) != false {
		t.Error("streak below threshold should not signal")
	}
	if needsRewarmStreak(0, 5) != false {
		t.Error("a disabled breaker (maxConsec<=0) must never signal")
	}
}

func TestLoadPropertyConfig_Defaults(t *testing.T) {
	// With no env overrides the property crawl must default to dry-run ON (the
	// ToS-restricted-tier safety posture), a 200-address work-list cap, and a 90-day
	// refresh TTL.
	t.Setenv("CRAWL_DRY_RUN", "")
	t.Setenv("CRAWL_PROPERTY_MAX", "")
	t.Setenv("CRAWL_PROPERTY_TTL_DAYS", "")
	cfg := loadPropertyConfig()
	if !cfg.dryRun {
		t.Error("dryRun must default to true")
	}
	if cfg.maxItems != 200 {
		t.Errorf("maxItems = %d, want 200", cfg.maxItems)
	}
	if cfg.ttlDays != 90 {
		t.Errorf("ttlDays = %d, want 90", cfg.ttlDays)
	}
}
