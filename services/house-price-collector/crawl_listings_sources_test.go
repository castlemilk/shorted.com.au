package main

import "testing"

// TestParseListingsSources_Unset: no env var set → default to both sources.
func TestParseListingsSources_Unset(t *testing.T) {
	t.Setenv("CRAWL_LISTINGS_SOURCES", "")
	got := parseListingsSources()
	if len(got) != 2 || !got["rea"] || !got["domain"] {
		t.Fatalf("unset: got %v, want rea+domain both true", got)
	}
}

// TestParseListingsSources_DomainOnly: "domain" → only domain enabled.
func TestParseListingsSources_DomainOnly(t *testing.T) {
	t.Setenv("CRAWL_LISTINGS_SOURCES", "domain")
	got := parseListingsSources()
	if len(got) != 1 || !got["domain"] {
		t.Fatalf("domain-only: got %v, want {domain:true}", got)
	}
}

// TestParseListingsSources_ReaOnly: "rea" → only rea enabled.
func TestParseListingsSources_ReaOnly(t *testing.T) {
	t.Setenv("CRAWL_LISTINGS_SOURCES", "rea")
	got := parseListingsSources()
	if len(got) != 1 || !got["rea"] {
		t.Fatalf("rea-only: got %v, want {rea:true}", got)
	}
}

// TestParseListingsSources_Both: "rea,domain" → both enabled.
func TestParseListingsSources_Both(t *testing.T) {
	t.Setenv("CRAWL_LISTINGS_SOURCES", "rea,domain")
	got := parseListingsSources()
	if len(got) != 2 || !got["rea"] || !got["domain"] {
		t.Fatalf("both: got %v, want rea+domain both true", got)
	}
}

// TestParseListingsSources_TrimAndCase: whitespace + mixed case is normalized.
func TestParseListingsSources_TrimAndCase(t *testing.T) {
	t.Setenv("CRAWL_LISTINGS_SOURCES", " Domain , REA ")
	got := parseListingsSources()
	if len(got) != 2 || !got["rea"] || !got["domain"] {
		t.Fatalf("trim/case: got %v, want rea+domain both true", got)
	}
}

// TestParseListingsSources_AllGarbage: no valid tokens → fall back to both
// (never silently crawl nothing).
func TestParseListingsSources_AllGarbage(t *testing.T) {
	t.Setenv("CRAWL_LISTINGS_SOURCES", "garbage")
	got := parseListingsSources()
	if len(got) != 2 || !got["rea"] || !got["domain"] {
		t.Fatalf("all-garbage: got %v, want fallback to rea+domain both true", got)
	}
}

// TestParseListingsSources_PartialGarbage: a valid subset is kept, garbage tokens dropped.
func TestParseListingsSources_PartialGarbage(t *testing.T) {
	t.Setenv("CRAWL_LISTINGS_SOURCES", "domain,garbage")
	got := parseListingsSources()
	if len(got) != 1 || !got["domain"] {
		t.Fatalf("partial-garbage: got %v, want {domain:true}", got)
	}
}

// TestListingsConfig_SourceEnabled exercises the sourceEnabled method against a
// domain-only config literal.
func TestListingsConfig_SourceEnabled(t *testing.T) {
	cfg := listingsConfig{sources: map[string]bool{"domain": true}}
	if !cfg.sourceEnabled("domain") {
		t.Fatalf("sourceEnabled(domain) = false, want true")
	}
	if cfg.sourceEnabled("rea") {
		t.Fatalf("sourceEnabled(rea) = true, want false")
	}
}
