package main

import (
	"strings"
	"testing"
)

// TestDetailStubTreatedAsBlock is the FIX-2 regression: an anti-bot stub LDP
// (200-status, no data container) must be caught by pageLooksStub BEFORE extract
// — otherwise extractDetail returns ok=false and runDetails would stamp a HEALTHY
// listing detail_status='error' for 90 days. This proves the guard fires exactly
// on stubs (block path → nothing written) and not on real pages.
func TestDetailStubTreatedAsBlock(t *testing.T) {
	reaStub := []byte(`<html><body><script>window.kpsdk={};</script>blocked</body></html>`) // no ArgonautExchange
	domainStub := []byte(`<html><body><h1>Just a moment...</h1></body></html>`)             // no __NEXT_DATA__

	// Stubs: pageLooksStub true (→ block path, not stamped), and extractDetail would
	// have found no payload (the false 'error' stamp the guard prevents).
	if !pageLooksStub(reaStub, "rea") {
		t.Error("REA stub (no ArgonautExchange) must be detected as a stub")
	}
	if !pageLooksStub(domainStub, "domain") {
		t.Error("Domain stub (no __NEXT_DATA__) must be detected as a stub")
	}
	if _, ok := extractDetail(string(reaStub), "rea"); ok {
		t.Error("REA stub must not extract a payload (so, absent the guard, it would be stamped 'error')")
	}
	if _, ok := extractDetail(string(domainStub), "domain"); ok {
		t.Error("Domain stub must not extract a payload")
	}

	// A real LDP is NOT a stub (has the container) and extracts cleanly — the guard
	// leaves the healthy path untouched.
	if pageLooksStub([]byte(domainLDPHTML()), "domain") {
		t.Error("a real Domain LDP must not be flagged a stub")
	}
	rea := reaDoubleStringifiedLDP(map[string]any{
		"id": "synthetic-rea-listing-004", "price": map[string]any{"display": "Auction"},
		"address": map[string]any{"suburb": "Synthetic Suburb"}, "propertyType": "House",
	})
	if pageLooksStub([]byte(rea), "rea") {
		t.Error("a real REA LDP must not be flagged a stub")
	}
}

func TestIsDelistedDetail(t *testing.T) {
	healthy := []byte("<html><body>3 bed 2 bath house for sale</body></html>")
	removed := []byte("<html><body>This listing has been removed from realestate.com.au</body></html>")

	cases := []struct {
		name     string
		finalURL string
		source   string
		html     []byte
		want     bool
	}{
		// Healthy detail URLs (final path ends in the >=6-digit advert id) — NOT delisted.
		{"domain synthetic LDP", "https://www.domain.com.au/synthetic-listing-100001", "domain", healthy, false},
		{"rea synthetic LDP", "https://www.realestate.com.au/synthetic-listing-100001", "rea", healthy, false},
		// R2: bounced to the portal's search shape.
		{"domain -> /sale/ search", "https://www.domain.com.au/sale/synthetic-suburb-zz-0000/", "domain", healthy, true},
		{"rea -> /buy/ search", "https://www.realestate.com.au/buy/in-synthetic+suburb,+zz+0000/list-1", "rea", healthy, true},
		// R3: explicit not-found path.
		{"rea property-not-found", "https://www.realestate.com.au/property-not-found", "rea", healthy, true},
		// R4: lost the id on a recognized portal host (a sold/suburb index page).
		{"domain sold index (no id)", "https://www.domain.com.au/sold/synthetic-suburb-zz-0000", "domain", healthy, true},
		// R1: explicit removal marker in the page — fires even with an empty final URL.
		{"removal marker, empty url", "", "rea", removed, true},
		// Empty URL + healthy page: trust only markers → NOT delisted.
		{"empty url, healthy page", "", "rea", healthy, false},
		// Unknown (non-portal) host with a healthy page: never infer a delist.
		{"non-portal host", "https://example.com/anything", "rea", healthy, false},
	}
	for _, c := range cases {
		if got := isDelistedDetail(c.finalURL, c.source, c.html); got != c.want {
			t.Errorf("%s: isDelistedDetail(%q,%q) = %v, want %v", c.name, c.finalURL, c.source, got, c.want)
		}
	}
}

func TestFinalURLHasListingID(t *testing.T) {
	cases := []struct {
		url  string
		want bool
	}{
		{"https://www.domain.com.au/synthetic-listing-100001", true},
		{"https://www.realestate.com.au/synthetic-listing-100001", true},
		{"https://www.domain.com.au/synthetic-listing-100001?utm=x", true},  // query stripped
		{"https://www.domain.com.au/synthetic-listing-100001/", true},       // trailing slash trimmed
		{"https://www.domain.com.au/sale/synthetic-suburb-zz-0000/", false}, // postcode (4 digits) is not an id
		{"https://www.realestate.com.au/buy/in-synthetic+suburb,+zz+0000/list-1", false},
	}
	for _, c := range cases {
		if got := finalURLHasListingID(strings.ToLower(c.url)); got != c.want {
			t.Errorf("finalURLHasListingID(%q) = %v, want %v", c.url, got, c.want)
		}
	}
}

func TestWorklistSources(t *testing.T) {
	mixed := worklistSources([]detailTarget{{source: "domain"}, {source: "rea"}, {source: "rea"}})
	if len(mixed) != 2 || mixed[0] != "domain" || mixed[1] != "rea" {
		t.Errorf("mixed = %v, want [domain rea] sorted", mixed)
	}
	reaOnly := worklistSources([]detailTarget{{source: "rea"}, {source: "rea"}})
	if len(reaOnly) != 1 || reaOnly[0] != "rea" {
		t.Errorf("rea-only = %v, want [rea]", reaOnly)
	}
	// Empty/unknown falls back to both so allOpen still has a defined set.
	empty := worklistSources(nil)
	if len(empty) != 2 {
		t.Errorf("empty = %v, want both sources", empty)
	}
}

func TestBumpResetBlock(t *testing.T) {
	rea, dom := 0, 0
	bumpBlock(&rea, &dom, "rea")
	bumpBlock(&rea, &dom, "rea")
	bumpBlock(&rea, &dom, "domain")
	if rea != 2 || dom != 1 {
		t.Fatalf("after bumps rea=%d dom=%d, want 2,1", rea, dom)
	}
	resetBlock(&rea, &dom, "rea")
	if rea != 0 || dom != 1 {
		t.Fatalf("after reset rea=%d dom=%d, want 0,1 (a clean REA fetch must not reset domain)", rea, dom)
	}
}

func TestPreviewDetail(t *testing.T) {
	rec := detailRecord{
		PropertyType: "House",
		LandSizeSqm:  f64p(610),
		Features:     []string{"Pool", "Study"},
		AgencyName:   "Ray White",
	}
	got := previewDetail(rec)
	if !strings.Contains(got, "type=House") || !strings.Contains(got, "land=610") || !strings.Contains(got, "agency=Ray White") {
		t.Errorf("preview = %q", got)
	}
	if previewDetail(detailRecord{}) != "(no fields harvested)" {
		t.Errorf("empty preview = %q", previewDetail(detailRecord{}))
	}
}

func TestLoadDetailsConfig_Defaults(t *testing.T) {
	// With no env overrides the detail crawl must default to dry-run ON (the
	// ToS-restricted-tier safety posture) and a 500-item work-list cap.
	t.Setenv("CRAWL_DRY_RUN", "")
	t.Setenv("CRAWL_DETAILS_MAX", "")
	cfg := loadDetailsConfig()
	if !cfg.dryRun {
		t.Error("dryRun must default to true")
	}
	if cfg.maxItems != 500 {
		t.Errorf("maxItems = %d, want 500", cfg.maxItems)
	}
}
