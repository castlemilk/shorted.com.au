package shorts

import (
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
)

// GetStockFinancialHighlights applies the trust funnel (plan
// fundamentals-coverage.md §4.1): ungrounded and echoed entries are dropped,
// provenance keys are stripped, and a real figure equal in VALUE to the old
// few-shot example survives.
func TestParseHighlightMetricsAppliesTheTrustFunnel(t *testing.T) {
	echo := extractiontrust.OldFewShotTexts[0] // the old example's revenue sentence, echoed for BHP/CBA/DRO/EDV/MSB
	raw := `{
		"revenue": [
			{"source_text": ` + quoteJSON(echo) + `, "value_millions": "5142", "period": "H1 FY2025"},
			{"source_text": "Revenue for the half was $3,212 million", "value_millions": "3212", "alignment": "match_exact", "char_start": "120", "char_end": "161"}
		],
		"net_profit": {"source_text": "Statutory NPAT2 $5,142m", "value_millions": "5142", "alignment": "match_fuzzy", "char_start": "10", "char_end": "33"},
		"eps": [{"source_text": "Basic EPS 31.2 cents", "value_cents": 31.2, "alignment": "unaligned"}],
		"dividend": [{"source_text": "Interim dividend 21 cents", "value_cents": "21", "alignment": null}],
		"ebitda": [{"source_text": "EBITDA $900m", "value_millions": 900, "franked": true, "nested": {"x": 1}}],
		"guidance": "not an object"
	}`
	got := parseHighlightMetrics([]byte(raw))

	byText := map[string]FinancialMetricEntry{}
	for _, m := range got {
		byText[m.SourceText] = m
		for k := range m.Attributes {
			if extractiontrust.IsProvenanceKey(k) || k == "source_text" {
				t.Errorf("%s leaked key %q", m.MetricType, k)
			}
		}
	}
	if _, ok := byText[echo]; ok {
		t.Error("an echoed few-shot sentence must be dropped")
	}
	if _, ok := byText["Basic EPS 31.2 cents"]; ok {
		t.Error("an unaligned extraction must be dropped")
	}
	if _, ok := byText["Interim dividend 21 cents"]; ok {
		t.Error("a null alignment is not grounded")
	}
	rev, ok := byText["Revenue for the half was $3,212 million"]
	if !ok || rev.MetricType != "revenue" || rev.Attributes["value_millions"] != "3212" {
		t.Errorf("an aligned revenue entry must survive intact: %+v", rev)
	}
	npat, ok := byText["Statutory NPAT2 $5,142m"]
	if !ok || npat.Attributes["value_millions"] != "5142" {
		t.Error("CBA's real $5,142m NPAT is the old example's VALUE, not its text: it must survive")
	}
	ebitda, ok := byText["EBITDA $900m"]
	if !ok || ebitda.Attributes["value_millions"] != "900" || ebitda.Attributes["franked"] != "true" {
		t.Errorf("a legacy entry without alignment survives, numbers rendered as strings: %+v", ebitda)
	}
	if _, ok := ebitda.Attributes["nested"]; ok {
		t.Error("an object attribute is dropped, not stringified")
	}
	if len(got) != 3 {
		t.Errorf("got %d entries, want 3: %+v", len(got), got)
	}
	// Stable order: metric types sorted.
	for i := 1; i < len(got); i++ {
		if got[i-1].MetricType > got[i].MetricType {
			t.Errorf("metric types out of order: %s before %s", got[i-1].MetricType, got[i].MetricType)
		}
	}

	for _, bad := range []string{"", "{}", "[]", "null", "not json"} {
		if out := parseHighlightMetrics([]byte(bad)); len(out) != 0 {
			t.Errorf("%q must yield nothing, got %v", bad, out)
		}
	}
}

func quoteJSON(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`).Replace(s) + `"`
}
