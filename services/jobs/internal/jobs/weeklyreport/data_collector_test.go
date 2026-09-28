package weeklyreport

import "testing"

// parseKeyMetrics must reject non-finite values: prod enrichment JSONB contains
// literal "Infinity" strings (e.g. pe_ratio for zero-EPS companies), and a
// non-finite float poisons both the LLM prompt and json.Marshal of ReportData.
func TestParseKeyMetricsRejectsNonFinite(t *testing.T) {
	raw := `{"pe_ratio": "Infinity", "eps": 0.5, "beta": "NaN", "dividend_yield": "-Inf"}`
	pm := parseKeyMetrics(raw)
	if pm == nil {
		t.Fatal("expected metrics (eps is valid)")
	}
	if pm.PERatio != nil {
		t.Errorf("PERatio: want nil for Infinity, got %v", *pm.PERatio)
	}
	if pm.Beta != nil {
		t.Errorf("Beta: want nil for NaN, got %v", *pm.Beta)
	}
	if pm.DividendYield != nil {
		t.Errorf("DividendYield: want nil for -Inf, got %v", *pm.DividendYield)
	}
	if pm.EPS == nil || *pm.EPS != 0.5 {
		t.Errorf("EPS: want 0.5, got %v", pm.EPS)
	}
}

func TestParseKeyMetricsAllNonFinite(t *testing.T) {
	if pm := parseKeyMetrics(`{"pe_ratio": "Infinity"}`); pm != nil {
		t.Errorf("want nil when every metric is non-finite, got %+v", pm)
	}
}

// The weekly-report funnel (docs/plans/fundamentals-coverage.md 4.1): an echo
// of the extraction prompt's few-shot example, or an entry the extractor could
// not align, never reaches the report prompt, and the provenance keys never do
// either. These are the exact rows stored on prod for the five echo documents.
func TestTrustedHighlightMetricsDropsEchoesAndStripsProvenance(t *testing.T) {
	raw := `{
	  "revenue": {"source_text": "Revenue from continuing operations for the half year ended 31 December 2024 was $5,142 million", "value_millions": "5142", "period": "H1 FY2025", "change_pct": "+8"},
	  "net_profit": [
	    {"source_text": "Statutory net profit after tax (NPAT) was $1,823 million, up 12% on pcp", "value_millions": "1823", "period": "H1 FY2025"},
	    {"source_text": "Statutory NPAT2 $5,142m, up 6%", "value_millions": "5142", "period": "1H25", "alignment": "match_fuzzy", "char_start": "812", "char_end": "840"}
	  ],
	  "eps": {"source_text": "Basic earnings per share was 94.2 cents.", "value_cents": "94.2"},
	  "ebitda": {"source_text": "EBITDA of $2.1bn", "value_millions": "2100", "alignment": "unaligned"},
	  "dividend": {"source_text": "Interim dividend 2.35 per share", "value_cents": 235, "franked": true, "extra": {"nested": "x"}}
	}`
	got, dropped, err := trustedHighlightMetrics(raw)
	if err != nil {
		t.Fatal(err)
	}
	if dropped != 4 {
		t.Errorf("dropped = %d, want 4 (three old-example echoes and the unaligned EBITDA)", dropped)
	}
	if _, ok := got["revenue"]; ok {
		t.Error("the echoed revenue sentence must not reach the prompt")
	}
	if _, ok := got["eps"]; ok {
		t.Error("the echoed EPS sentence (with its trailing period) must not reach the prompt")
	}
	if _, ok := got["ebitda"]; ok {
		t.Error("an unaligned entry must not reach the prompt")
	}
	np := got["net_profit"]
	if len(np) != 1 || np[0]["value_millions"] != "5142" {
		t.Fatalf("CBA's real statutory NPAT (same value as the old example) must survive: %v", np)
	}
	for _, k := range []string{"alignment", "char_start", "char_end"} {
		if _, ok := np[0][k]; ok {
			t.Errorf("provenance key %q reached the prompt", k)
		}
	}
	div := got["dividend"]
	if len(div) != 1 || div[0]["value_cents"] != "235" || div[0]["franked"] != "true" {
		t.Errorf("numbers and bools are kept as strings: %v", div)
	}
	if _, ok := div[0]["extra"]; ok {
		t.Error("a nested value is left out of the entry")
	}

	if _, _, err := trustedHighlightMetrics(`not json`); err == nil {
		t.Error("unparseable metrics must error")
	}
	empty, dropped, err := trustedHighlightMetrics(`{"revenue": {"source_text": "Revenue from continuing operations for the half year ended 31 December 2024 was $5,142 million"}}`)
	if err != nil || len(empty) != 0 || dropped != 1 {
		t.Errorf("a report of echoes only yields no metrics: %v, %d, %v", empty, dropped, err)
	}
}
