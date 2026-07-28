package houseprices

import (
	"os"
	"strings"
	"testing"

	"github.com/PuerkitoBio/goquery"
)

// extractPageMeta fixtures are trimmed captures of the Phase-0 live New Farm
// SRP dumps (/tmp/rea-srp.html, /tmp/domain-srp.html — 2026-07-15), hand-built
// to the CONFIRMED key paths (see PageMeta's doc comment) rather than a raw
// byte-slice of the 1.5-2MB originals: same nesting/escaping shape, same
// values, a couple of listings, none of the unrelated bulk (images, agent
// bios, long descriptions).

func TestExtractPageMeta_REA(t *testing.T) {
	html, err := os.ReadFile("testdata/rea-pagemeta.html")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(string(html)))
	if err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	m := extractPageMeta(doc, "rea")
	if !m.OK || m.TotalResults <= 0 || m.PageSize <= 0 {
		t.Fatalf("rea pagemeta = %+v", m)
	}
	// Confirmed live values: totalResultsCount=969 (BROADENED, not on-target),
	// pagination.maxPageNumberAvailable=39, savedSearchQuery.pageSize=25,
	// savedSearchQuery.filters.surroundingSuburbs=true.
	if m.TotalResults != 969 {
		t.Errorf("rea TotalResults = %d, want 969", m.TotalResults)
	}
	if m.PageSize != 25 {
		t.Errorf("rea PageSize = %d, want 25", m.PageSize)
	}
	if m.TotalPages != 39 {
		t.Errorf("rea TotalPages = %d, want 39 (from maxPageNumberAvailable, not a ceil() computation)", m.TotalPages)
	}
	if !m.SurroundingSuburbs {
		t.Error("rea SurroundingSuburbs should be true (confirmed live: New Farm SRP broadens)")
	}
	// Confirmed live: the SRP blob also carries the exact on-target count under
	// "listings_total" (969 broadened − 906 surrounding = 63), distinct from the
	// broadened TotalResults above.
	if m.OnTargetResults != 63 {
		t.Errorf("rea OnTargetResults = %d, want 63 (the exact on-target listings_total, not the broadened total)", m.OnTargetResults)
	}
}

func TestExtractPageMeta_Domain(t *testing.T) {
	html, err := os.ReadFile("testdata/domain-pagemeta.html")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(string(html)))
	if err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	m := extractPageMeta(doc, "domain")
	if !m.OK || m.TotalResults <= 0 || m.PageSize <= 0 {
		t.Fatalf("domain pagemeta = %+v", m)
	}
	// Confirmed live values: totalListings/totalResults=608 (BROADENED),
	// totalPages=30, pageViewMetadata.searchRequest.pageSize=20,
	// locations[0].includeSurroundingSuburbs=true.
	if m.TotalResults != 608 {
		t.Errorf("domain TotalResults = %d, want 608", m.TotalResults)
	}
	if m.PageSize != 20 {
		t.Errorf("domain PageSize = %d, want 20", m.PageSize)
	}
	if m.TotalPages != 30 {
		t.Errorf("domain TotalPages = %d, want 30 (the portal's own field — NOT ceil(608/20)=31, it's capped upstream)", m.TotalPages)
	}
	if !m.SurroundingSuburbs {
		t.Error("domain SurroundingSuburbs should be true (confirmed live: New Farm SRP broadens)")
	}
	// Domain exposes no equivalent exact on-target field (only the broadened
	// totalListings + a boolean includeSurroundingSuburbs) — OnTargetResults
	// must stay 0 so the sizing falls back to the broadened-TotalPages clamp.
	if m.OnTargetResults != 0 {
		t.Errorf("domain OnTargetResults = %d, want 0 (Domain has no on-target field)", m.OnTargetResults)
	}
}

func TestExtractPageMeta_Missing(t *testing.T) {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader("<html><body></body></html>"))
	if err != nil {
		t.Fatalf("parse empty doc: %v", err)
	}
	if m := extractPageMeta(doc, "rea"); m.OK {
		t.Fatalf("empty page must yield OK=false, got %+v", m)
	}
}

// TestExtractPageMeta_TotalPagesFallsBackToCeil covers the "only count+size
// present" branch of Task 2 (TotalPages computed, not taken from a portal
// field) using the SAME domainPageHTML-style fixture the sweep tests use.
func TestExtractPageMeta_TotalPagesFallsBackToCeil(t *testing.T) {
	html := `<html><body><script id="__NEXT_DATA__" type="application/json">` +
		`{"props":{"pageProps":{"totalResults":63,"pageSize":25}}}` +
		`</script></body></html>`
	m := extractPageMeta(docFrom(html), "domain")
	if !m.OK {
		t.Fatalf("pagemeta should be OK: %+v", m)
	}
	if m.TotalPages != 3 { // ceil(63/25) = 3
		t.Errorf("TotalPages = %d, want 3 (ceil(63/25))", m.TotalPages)
	}
}

// TestHarvestListing_AgencyAndAgents verifies the agency (listingCompany) + agent
// (listers) fields are pulled from the same REA search-results listing object.
func TestHarvestListing_AgencyAndAgents(t *testing.T) {
	lm := map[string]any{
		"id":             "151008144",
		"price":          map[string]any{"display": "$2,310,000"},
		"address":        map[string]any{"display": map[string]any{"fulladdress": "67 Alma Street, Paddington, Qld 4064"}},
		"listingcompany": map[string]any{"id": "PRDPAD", "name": "Place - Paddington"},
		"listers": []any{
			map[string]any{"name": "Tim Douglas"},
			map[string]any{"name": "Jane Smith"},
			map[string]any{"name": "Tim Douglas"}, // dup — must be deduped
		},
	}
	l, ok := harvestListing(lm, "rea")
	if !ok {
		t.Fatal("expected listing to harvest")
	}
	if l.AgencyID != "PRDPAD" || l.AgencyName != "Place - Paddington" {
		t.Fatalf("agency not extracted: id=%q name=%q", l.AgencyID, l.AgencyName)
	}
	if len(l.AgentNames) != 2 || l.AgentNames[0] != "Tim Douglas" || l.AgentNames[1] != "Jane Smith" {
		t.Fatalf("agents not extracted/deduped: %v", l.AgentNames)
	}
}
