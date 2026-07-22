package main

import (
	"strings"
	"testing"
)

// All addresses/suburbs/streets/PIDs below are SYNTHETIC (invented) — they exercise
// the URL structure + street-type-abbreviation logic without embedding any captured
// data.

// TestPropertyStubTreatedAsBlock is the #333 regression carried into this tier: an
// anti-bot stub page (200-status, tiny, no payload) must be caught by pageLooksStub
// BEFORE extract — property.com.au is the SAME Kasada tenant as REA.
func TestPropertyStubTreatedAsBlock(t *testing.T) {
	stub := []byte(`<html><body><script>window.kpsdk={};</script>blocked</body></html>`)
	if !pageLooksStub(stub, propertySource) {
		t.Error("a tiny Kasada stub must be detected as a stub (→ block path, not stamped)")
	}
	if _, ok := extractPropertyProfile(string(stub)); ok {
		t.Error("the stub must not extract a payload")
	}
	real := propertyArgonautHTML(sampleProfile()) + strings.Repeat("<!-- padding to clear the 5KB size floor -->", 200)
	if pageLooksStub([]byte(real), propertySource) {
		t.Error("a real property.com.au profile page must not be flagged a stub")
	}
	if _, ok := extractPropertyProfile(real); !ok {
		t.Error("a real profile page must extract cleanly")
	}
}

func TestSplitStreetNumber(t *testing.T) {
	cases := []struct {
		in, num, name string
	}{
		{"19 Example Road", "19", "Example Road"},
		{"5/40 Sample Road", "5/40", "Sample Road"},
		{"1a Test Street", "1a", "Test Street"},
		{"Example Road", "", "Example Road"}, // no leading number
	}
	for _, c := range cases {
		num, name := splitStreetNumber(c.in)
		if num != c.num || name != c.name {
			t.Errorf("splitStreetNumber(%q) = (%q,%q), want (%q,%q)", c.in, num, name, c.num, c.name)
		}
	}
}

func TestAbbreviateStreetType(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"Example Road", "example-rd"},
		{"Test Street", "test-st"},
		{"Sample Avenue", "sample-ave"},
		{"Sample Crescent", "sample-cres"},
		{"Sample Lane", "sample-lane"}, // confirmed live: Lane→"lane", NOT "ln"
		{"New Test Road", "new-test-rd"},
		{"Foo Unknowntype", "foo-unknowntype"}, // unknown type kept, suburb traversal corrects
	}
	for _, c := range cases {
		if got := abbreviateStreetType(c.in); got != c.want {
			t.Errorf("abbreviateStreetType(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestBuildURLs(t *testing.T) {
	if got := buildSuburbURL("VIC", "Sampleton", "3999"); got != "https://www.property.com.au/vic/sampleton-3999/" {
		t.Errorf("suburb URL = %q", got)
	}
	if got := buildStreetURL("VIC", "Sampleton", "3999", "Example Road"); got != "https://www.property.com.au/vic/sampleton-3999/example-rd/" {
		t.Errorf("street URL = %q", got)
	}
	if got := buildStreetURL("QLD", "New Testville", "4999", "Sample Road"); got != "https://www.property.com.au/qld/new-testville-4999/sample-rd/" {
		t.Errorf("multi-word suburb street URL = %q", got)
	}
}

// synthetic street page mirroring the link shape /{...}/{num}-pid-{PID}/.
func streetPageHTML() string {
	links := []string{
		"/vic/sampleton-3999/example-rd/19-pid-100001/",
		"/vic/sampleton-3999/example-rd/1a-pid-100002/",
		"/vic/sampleton-3999/example-rd/1-43-pid-100003/",                                // unit 1/43
		"https://www.property.com.au/vic/sampleton-3999/example-rd/10-pid-100004/?utm=x", // absolute + query
		"/vic/sampleton-3999/example-rd/19-pid-100001/",                                  // dup pid — collapsed
		"/vic/othertown-1234/other-rd/5-pid-100099/",                                     // different street — excluded by scope
	}
	var b strings.Builder
	b.WriteString("<html><body>")
	for _, l := range links {
		b.WriteString(`<a href="` + l + `">x</a>`)
	}
	b.WriteString("</body></html>")
	return b.String()
}

func TestParseStreetProperties(t *testing.T) {
	props := parseStreetProperties(streetPageHTML(), "/vic/sampleton-3999/example-rd/")
	if len(props) != 4 { // 19, 1a, 1-43, 10 (dup collapsed, cross-street excluded)
		t.Fatalf("parsed %d street properties, want 4: %+v", len(props), props)
	}
	if path, ok := matchStreetProperty(props, "19"); !ok || path != "/vic/sampleton-3999/example-rd/19-pid-100001/" {
		t.Errorf("match 19 = %q ok=%v", path, ok)
	}
	if path, ok := matchStreetProperty(props, "5/40"); ok {
		t.Errorf("match 5/40 should fail (not on street), got %q", path)
	}
	if path, ok := matchStreetProperty(props, "1/43"); !ok || path != "/vic/sampleton-3999/example-rd/1-43-pid-100003/" {
		t.Errorf("match unit 1/43 = %q ok=%v (want the 1-43 link)", path, ok)
	}
}

// synthetic suburb page mirroring the street-link shape /{state}/{suburb}-{pc}/{street}/.
func suburbPageHTML() string {
	links := []string{
		"/vic/sampleton-3999/example-rd/",
		"/vic/sampleton-3999/sample-lane/",              // Lane→lane
		"/vic/sampleton-3999/test-cr/",                  // Crescent→cr (the other variant)
		"/vic/sampleton-3999/example-rd/19-pid-100001/", // a property link — excluded
		"/vic/sampleton-3999/",                          // the suburb itself — excluded (no street segment)
		"/vic/othertown-1234/foo-st/",                   // different suburb — excluded by scope
	}
	var b strings.Builder
	b.WriteString("<html><body>")
	for _, l := range links {
		b.WriteString(`<a href="` + l + `">x</a>`)
	}
	b.WriteString("</body></html>")
	return b.String()
}

func TestParseSuburbStreets(t *testing.T) {
	streets := parseSuburbStreets(suburbPageHTML(), "/vic/sampleton-3999/")
	if len(streets) != 3 { // example-rd, sample-lane, test-cr
		t.Fatalf("parsed %d suburb streets, want 3: %+v", len(streets), streets)
	}
	// Exact-slug match.
	if path, ok := matchSuburbStreet(streets, "Example Road"); !ok || path != "/vic/sampleton-3999/example-rd/" {
		t.Errorf("match Example Road = %q ok=%v", path, ok)
	}
	// Lane→lane: exact via abbrev map.
	if path, ok := matchSuburbStreet(streets, "Sample Lane"); !ok || path != "/vic/sampleton-3999/sample-lane/" {
		t.Errorf("match Sample Lane = %q ok=%v", path, ok)
	}
	// Crescent→"cr" on the page but our abbrev map yields "cres" → name-part fallback
	// matches abbreviation-agnostically. This is the real cr/cres inconsistency.
	if path, ok := matchSuburbStreet(streets, "Test Crescent"); !ok || path != "/vic/sampleton-3999/test-cr/" {
		t.Errorf("match Test Crescent (cr/cres variance) = %q ok=%v", path, ok)
	}
}

func TestResolveViaSearch_IsStub(t *testing.T) {
	if _, ok := resolveViaSearch(propertyTarget{suburb: "Sampleton", stateCode: "VIC", postcode: "3999"}); ok {
		t.Error("resolveViaSearch must be a documented no-op fallback (return ok=false)")
	}
}

func TestIsProfileNotFound(t *testing.T) {
	notFound := []byte("<html><body><h1>Page not found</h1><p>We can’t find that page for you - it has possibly been misplaced...</p></body></html>")
	healthy := []byte("<html><body>3 bed house, estimated value $1.35m</body></html>")

	cases := []struct {
		name     string
		finalURL string
		html     []byte
		want     bool
	}{
		{"real 404 markers", "", notFound, true},
		{"healthy profile, empty url", "", healthy, false},
		{"redirect to /find", "https://www.property.com.au/find?q=x", healthy, true},
		{"not-found path", "https://www.property.com.au/property-not-found", healthy, true},
		{"live profile url", "https://www.property.com.au/vic/sampleton-3999/example-rd/19-pid-100001/", healthy, false},
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
		EstimateLow:        f64p(1200000),
		EstimateMid:        f64p(1350000),
		EstimateHigh:       f64p(1500000),
		EstimateConfidence: "high",
		PropertyType:       "house",
		Bedrooms:           int16p(4),
		SalesHistory:       []saleRecord{{Date: "2024-03-06"}, {Date: "2015-02-02"}},
	}
	got := previewProperty(p)
	for _, want := range []string{"est=", "conf=high", "sales=2", "type=house", "beds=4"} {
		if !strings.Contains(got, want) {
			t.Errorf("preview %q missing %q", got, want)
		}
	}
	if previewProperty(propertyProfile{}) != "(no fields harvested)" {
		t.Errorf("empty preview = %q", previewProperty(propertyProfile{}))
	}
}

func TestNeedsRewarmStreak(t *testing.T) {
	if !needsRewarmStreak(2, 2) {
		t.Error("streak==threshold should signal rewarm")
	}
	if needsRewarmStreak(2, 1) {
		t.Error("streak below threshold should not signal")
	}
	if needsRewarmStreak(0, 5) {
		t.Error("a disabled breaker (maxConsec<=0) must never signal")
	}
}

func TestLoadPropertyConfig_Defaults(t *testing.T) {
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
