package shorts

import (
	"math"
	"testing"
)

// A P/E ratio of Infinity is what an upstream feed produces when it divides a
// price by zero earnings. It is not a very large P/E — it is an UNDEFINED one,
// and storing it as a number claims a fact nobody measured.
//
// It also does not survive the trip out. `key_metrics->>'pe_ratio'` is text in
// JSONB, and mv_screener_data casts it with `::double precision`, so the string
// "Infinity" becomes a float Infinity at the view boundary and every consumer
// downstream inherits it:
//
//   - protojson renders it as the STRING "Infinity" in a numeric field, so any
//     strict API client parsing peRatio as a number breaks;
//   - encoding/json refuses it outright, which took the MCP screener tool down
//     on its default call until that tool added its own guard;
//   - weekly-report-generator had already added a third guard, for the same
//     value, in its own snapshot path.
//
// Three consumers guarding the same defect is the signal that it belongs at the
// write funnel instead. Measured 2026-08-28: 70 rows in company-metadata held
// the literal text "Infinity"; 23 of 964 mv_screener_data rows were infinite
// locally, 3 of 3,275 in production.
func TestSanitiseKeyMetricsDropsNonFiniteValues(t *testing.T) {
	cases := []struct {
		name string
		in   any
	}{
		{"float infinity", mustInf()},
		{"negative float infinity", -mustInf()},
		{"float NaN", mustNaN()},
		{"string Infinity", "Infinity"},
		{"string -Infinity", "-Infinity"},
		{"string NaN", "NaN"},
		{"string infinity lowercase", "infinity"},
		{"string inf", "inf"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := sanitiseKeyMetrics(map[string]any{
				"pe_ratio":   tc.in,
				"market_cap": 1_691_086_080.0,
			})

			if _, present := got["pe_ratio"]; present {
				t.Errorf("pe_ratio=%v should have been dropped, got %v", tc.in, got["pe_ratio"])
			}
			// Dropping the bad key must not disturb the good ones. An absent
			// key reads as "unknown" everywhere downstream, which is the
			// honest rendering; a zeroed sibling would be a wrong measurement.
			if got["market_cap"] != 1_691_086_080.0 {
				t.Errorf("market_cap should be untouched, got %v", got["market_cap"])
			}
		})
	}
}

func TestSanitiseKeyMetricsKeepsEverythingFinite(t *testing.T) {
	in := map[string]any{
		"pe_ratio":       18.4,
		"market_cap":     1_691_086_080.0,
		"dividend_yield": 0.0,
		"eps":            -1.25,
		"beta":           "1.08",
		"currency":       "AUD",
		"as_at":          nil,
	}

	got := sanitiseKeyMetrics(in)

	if len(got) != len(in) {
		t.Fatalf("expected all %d keys kept, got %d: %v", len(in), len(got), got)
	}
	for k, want := range in {
		if got[k] != want {
			t.Errorf("%s = %v, want %v", k, got[k], want)
		}
	}
}

func TestSanitiseKeyMetricsHandlesNilAndEmpty(t *testing.T) {
	if got := sanitiseKeyMetrics(nil); got != nil {
		t.Errorf("nil in, nil out expected, got %v", got)
	}
	if got := sanitiseKeyMetrics(map[string]any{}); len(got) != 0 {
		t.Errorf("empty in, empty out expected, got %v", got)
	}
}

// "Infinity" is a legitimate substring of ordinary text. Only drop a key whose
// value IS a non-finite number, never one that merely mentions one.
func TestSanitiseKeyMetricsKeepsProseThatMentionsInfinity(t *testing.T) {
	got := sanitiseKeyMetrics(map[string]any{
		"note": "P/E is effectively infinity while earnings are negative",
	})
	if _, present := got["note"]; !present {
		t.Error("prose mentioning infinity was dropped; only non-finite NUMBERS should be")
	}
}

func mustInf() float64 { return math.Inf(1) }
func mustNaN() float64 { return math.NaN() }
