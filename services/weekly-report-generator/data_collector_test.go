package main

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
