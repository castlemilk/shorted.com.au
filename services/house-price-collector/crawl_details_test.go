package main

import (
	"strings"
	"testing"
)

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
		{"domain live LDP", "https://www.domain.com.au/12-smith-street-bondi-nsw-2026-2020524930", "domain", healthy, false},
		{"rea live LDP", "https://www.realestate.com.au/property-house-qld-new+farm-140123456", "rea", healthy, false},
		// R2: bounced to the portal's search shape.
		{"domain -> /sale/ search", "https://www.domain.com.au/sale/bondi-nsw-2026/", "domain", healthy, true},
		{"rea -> /buy/ search", "https://www.realestate.com.au/buy/in-new+farm,+qld+4005/list-1", "rea", healthy, true},
		// R3: explicit not-found path.
		{"rea property-not-found", "https://www.realestate.com.au/property-not-found", "rea", healthy, true},
		// R4: lost the id on a recognized portal host (a sold/suburb index page).
		{"domain sold index (no id)", "https://www.domain.com.au/sold/bondi-nsw-2026", "domain", healthy, true},
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
		{"https://www.domain.com.au/12-smith-street-bondi-nsw-2026-2020524930", true},
		{"https://www.realestate.com.au/property-house-qld-new+farm-140123456", true},
		{"https://www.domain.com.au/12-smith-street-bondi-nsw-2026-2020524930?utm=x", true}, // query stripped
		{"https://www.domain.com.au/12-smith-street-bondi-nsw-2026-2020524930/", true},      // trailing slash trimmed
		{"https://www.domain.com.au/sale/bondi-nsw-2026/", false},                           // postcode (4 digits) is not an id
		{"https://www.realestate.com.au/buy/in-bondi,+nsw+2026/list-1", false},
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
