package main

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
