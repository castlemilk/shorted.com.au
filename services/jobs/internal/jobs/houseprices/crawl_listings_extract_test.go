package houseprices

import (
	"os"
	"strings"
	"testing"

	"github.com/PuerkitoBio/goquery"
)

// extractPageMeta fixtures are deliberately synthetic. They preserve the
// nested JSON-string and pagination shapes the extractor supports without
// republishing portal payloads, listing data, or real-world identities.

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
	// Synthetic structural values: totalResultsCount=47 (broadened),
	// pagination.maxPageNumberAvailable=5, savedSearchQuery.pageSize=20,
	// savedSearchQuery.filters.surroundingSuburbs=true.
	if m.TotalResults != 47 {
		t.Errorf("rea TotalResults = %d, want 47", m.TotalResults)
	}
	if m.PageSize != 20 {
		t.Errorf("rea PageSize = %d, want 20", m.PageSize)
	}
	if m.TotalPages != 5 {
		t.Errorf("rea TotalPages = %d, want 5 (from maxPageNumberAvailable, not ceil(47/20)=3)", m.TotalPages)
	}
	if !m.SurroundingSuburbs {
		t.Error("rea SurroundingSuburbs should be true in the synthetic pagination shape")
	}
	// The synthetic blob also carries a distinct exact on-target count under
	// "listings_total" so both sizing signals remain covered.
	if m.OnTargetResults != 7 {
		t.Errorf("rea OnTargetResults = %d, want 7 (the exact on-target listings_total, not the broadened total)", m.OnTargetResults)
	}
}

func TestExtractPageMeta_Domain(t *testing.T) {
	html, err := os.ReadFile("testdata/domain-pagemeta.html")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	fixture := string(html)
	if !strings.Contains(fixture, `"totalListings":61`) {
		t.Fatal("synthetic Domain fixture must exercise componentProps.totalListings")
	}
	if !strings.Contains(fixture, `"searchRequest":`) {
		t.Fatal("synthetic Domain fixture must exercise pageViewMetadata.searchRequest")
	}
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(string(html)))
	if err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	m := extractPageMeta(doc, "domain")
	if !m.OK || m.TotalResults <= 0 || m.PageSize <= 0 {
		t.Fatalf("domain pagemeta = %+v", m)
	}
	// Synthetic structural values: totalResults=61 (broadened), totalPages=3,
	// pageViewMetadata.searchRequest.pageSize=20,
	// locations[0].includeSurroundingSuburbs=true.
	if m.TotalResults != 61 {
		t.Errorf("domain TotalResults = %d, want 61", m.TotalResults)
	}
	if m.PageSize != 20 {
		t.Errorf("domain PageSize = %d, want 20", m.PageSize)
	}
	if m.TotalPages != 3 {
		t.Errorf("domain TotalPages = %d, want 3 (the explicit field, not ceil(61/20)=4)", m.TotalPages)
	}
	if !m.SurroundingSuburbs {
		t.Error("domain SurroundingSuburbs should be true in the synthetic pagination shape")
	}
	// This Domain-like shape intentionally has no exact on-target field, so
	// OnTargetResults must stay 0 and callers retain their fallback behavior.
	if m.OnTargetResults != 0 {
		t.Errorf("domain OnTargetResults = %d, want 0 (Domain has no on-target field)", m.OnTargetResults)
	}
}

func TestExtractPageMeta_DomainProductionAliases(t *testing.T) {
	html := `<html><body><script type="application/json">` +
		`{"componentProps":{"totalListings":61,"totalPages":3,"pageViewMetadata":{"searchRequest":{"pageSize":20,"locations":[{"includeSurroundingSuburbs":true}]}}}}` +
		`</script></body></html>`
	m := extractPageMeta(docFrom(html), "domain")
	if !m.OK || m.TotalResults != 61 || m.PageSize != 20 || m.TotalPages != 3 || !m.SurroundingSuburbs {
		t.Fatalf("Domain production aliases were not extracted: %+v", m)
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
// (listers) fields are pulled from one synthetic REA-shaped listing object.
func TestHarvestListing_AgencyAndAgents(t *testing.T) {
	lm := map[string]any{
		"id":             "synthetic-rea-listing-001",
		"price":          map[string]any{"display": "$765,432"},
		"address":        map[string]any{"display": map[string]any{"fulladdress": "Example Avenue, Synthetic Suburb, ZZ 0000"}},
		"listingcompany": map[string]any{"id": "SYNTHETIC-AGENCY", "name": "Example Realty - Synthetic Suburb"},
		"listers": []any{
			map[string]any{"name": "Alex Example"},
			map[string]any{"name": "Sam Example"},
			map[string]any{"name": "Alex Example"}, // dup — must be deduped
		},
	}
	l, ok := harvestListing(lm, "rea")
	if !ok {
		t.Fatal("expected listing to harvest")
	}
	if l.AgencyID != "SYNTHETIC-AGENCY" || l.AgencyName != "Example Realty - Synthetic Suburb" {
		t.Fatalf("agency not extracted: id=%q name=%q", l.AgencyID, l.AgencyName)
	}
	if len(l.AgentNames) != 2 || l.AgentNames[0] != "Alex Example" || l.AgentNames[1] != "Sam Example" {
		t.Fatalf("agents not extracted/deduped: %v", l.AgentNames)
	}
}
