package reportextract

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	lx "github.com/skunkworq/stealth/brws/langextract"

	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
)

// extractions_to_metrics produces the JSONB the weekly-report generator reads,
// including its deliberate heterogeneity (object for one hit, array for repeats).
func TestExtractionsToMetrics(t *testing.T) {
	got := extractionsToMetrics([]extraction{
		{Class: "revenue", Text: "Revenue was $1m", Attributes: map[string]any{"value_millions": "1", "period": "FY25"}},
		{Class: "eps", Text: "EPS 12c", Attributes: map[string]any{"value_cents": "12"}},
		{Class: "revenue", Text: "Underlying revenue $2m", Attributes: map[string]any{"value_millions": "2"}},
		{Class: "revenue", Text: "Segment revenue $3m", Attributes: nil},
	})

	eps, ok := got["eps"].(map[string]any)
	if !ok {
		t.Fatalf("single-hit class must stay an object, got %T", got["eps"])
	}
	if eps["source_text"] != "EPS 12c" || eps["value_cents"] != "12" {
		t.Errorf("attributes must be merged alongside source_text: %v", eps)
	}

	revenue, ok := got["revenue"].([]any)
	if !ok {
		t.Fatalf("repeated class must collapse to a list, got %T", got["revenue"])
	}
	if len(revenue) != 3 {
		t.Fatalf("want 3 revenue entries, got %d", len(revenue))
	}
	first := revenue[0].(map[string]any)
	if first["source_text"] != "Revenue was $1m" {
		t.Errorf("first occurrence must lead the list: %v", first)
	}
	third := revenue[2].(map[string]any)
	if len(third) != 1 || third["source_text"] != "Segment revenue $3m" {
		t.Errorf("nil attributes must yield source_text only: %v", third)
	}

	// The whole thing has to survive the trip into a jsonb parameter.
	if _, err := json.Marshal(got); err != nil {
		t.Fatalf("metrics must be JSON-marshalable: %v", err)
	}
}

func TestExtractionsToMetricsEmpty(t *testing.T) {
	got := extractionsToMetrics(nil)
	if len(got) != 0 {
		t.Fatalf("want empty metrics, got %v", got)
	}
	b, err := json.Marshal(got)
	if err != nil || string(b) != "{}" {
		t.Errorf("empty metrics must marshal to {}, got %q (%v)", b, err)
	}
}

// The few-shot examples ARE the prompt contract with Gemini: the class names
// become the metric keys stored in the database.
func TestExtractionExamplesPinTheMetricVocabulary(t *testing.T) {
	examples := extractionExamples()
	if len(examples) != 1 {
		t.Fatalf("want exactly 1 ExampleData (extract.py's EXTRACTION_EXAMPLES), got %d", len(examples))
	}

	var classes []string
	for _, e := range examples[0].Extractions {
		classes = append(classes, e.ExtractionClass)
	}
	want := []string{"revenue", "net_profit", "eps", "dividend", "cash_flow", "ebitda", "guidance"}
	if !reflect.DeepEqual(classes, want) {
		t.Errorf("extraction classes drifted: got %v, want %v", classes, want)
	}
}

// langextract validates that each example's extraction_text can be aligned back
// into the example text. The synthetic example is written so every extraction
// text appears verbatim, on one line (the old example's revenue sentence had a
// line break where its extraction had a space, so it never aligned exactly).
func TestExtractionExamplesAlignToTheirSourceText(t *testing.T) {
	ex := extractionExamples()[0]
	for _, e := range ex.Extractions {
		if !strings.Contains(ex.Text, e.ExtractionText) {
			t.Errorf("%s: extraction_text not present verbatim in the example text: %q",
				e.ExtractionClass, e.ExtractionText)
		}
	}

	report := lx.ValidatePromptExamples([]lx.ExampleData{ex}, lx.DefaultTokenizer)
	_ = report // the call must not panic; alignment quality is asserted above
}

// The prompt's example is extractiontrust's, byte for byte (contract 6.3): the
// text, and every extraction's class, text and attributes in order.
func TestExtractionExamplesAreTheTrustExample(t *testing.T) {
	want := extractiontrust.FewShotExample()
	got := extractionExamples()[0]
	if got.Text != want.Text {
		t.Errorf("example text differs from extractiontrust.FewShotExample():\n got %q\nwant %q", got.Text, want.Text)
	}
	if len(got.Extractions) != len(want.Extractions) {
		t.Fatalf("%d extractions, want %d", len(got.Extractions), len(want.Extractions))
	}
	for i, e := range got.Extractions {
		w := want.Extractions[i]
		if e.ExtractionClass != w.Class || e.ExtractionText != w.Text {
			t.Errorf("extraction %d: got %s %q, want %s %q", i, e.ExtractionClass, e.ExtractionText, w.Class, w.Text)
		}
		attrs := map[string]string{}
		for k, v := range e.Attributes {
			s, ok := v.(string)
			if !ok {
				t.Errorf("extraction %d attribute %s is %T, want a string", i, k, v)
			}
			attrs[k] = s
		}
		if !reflect.DeepEqual(attrs, w.Attributes) {
			t.Errorf("extraction %d attributes: got %v, want %v", i, attrs, w.Attributes)
		}
		if !extractiontrust.IsFewShotText(e.ExtractionText) {
			t.Errorf("extraction %d text is not on the denylist, so an echo of it would be stored: %q", i, e.ExtractionText)
		}
	}
	for _, old := range extractiontrust.OldFewShotTexts {
		if strings.Contains(got.Text, old) {
			t.Errorf("the prompt still carries the old example text %q", old)
		}
	}
}

// Unaligned results never reach storage (contract 6.3): no char interval, or a
// status outside the four aligned ones, is dropped; aligned results carry their
// status and span.
func TestGroundedExtractionsDropsUnaligned(t *testing.T) {
	raw := []lx.Extraction{
		{ExtractionClass: "revenue", ExtractionText: "Revenue up 7% to $3.9bn", Alignment: lx.AlignmentExact, CharInterval: &lx.CharInterval{StartPos: 10, EndPos: 33}},
		{ExtractionClass: "eps", ExtractionText: "Basic earnings per share was 94.2 cents", Alignment: "", CharInterval: nil},
		{ExtractionClass: "net_profit", ExtractionText: "NPAT $612m", Alignment: lx.AlignmentFuzzy, CharInterval: nil},
		{ExtractionClass: "ebitda", ExtractionText: "EBITDA $1.5bn", Alignment: "unaligned", CharInterval: &lx.CharInterval{StartPos: 1, EndPos: 5}},
		{ExtractionClass: "dividend", ExtractionText: "Interim dividend 21c", Alignment: lx.AlignmentLesser, CharInterval: &lx.CharInterval{StartPos: 40, EndPos: 60}, Attributes: map[string]any{"value_cents": "21"}},
	}
	got, dropped := groundedExtractions(raw)
	if dropped != 3 {
		t.Errorf("dropped = %d, want 3", dropped)
	}
	if len(got) != 2 || got[0].Class != "revenue" || got[1].Class != "dividend" {
		t.Fatalf("kept %+v", got)
	}
	if got[0].Alignment != "match_exact" || got[0].CharStart != 10 || got[0].CharEnd != 33 {
		t.Errorf("provenance not carried: %+v", got[0])
	}

	metrics := extractionsToMetrics(got)
	rev := metrics["revenue"].(map[string]any)
	if rev["alignment"] != "match_exact" || rev["char_start"] != "10" || rev["char_end"] != "33" {
		t.Errorf("provenance must be stored as STRING attributes (extract.py parity): %v", rev)
	}
	div := metrics["dividend"].(map[string]any)
	if div["value_cents"] != "21" || div["alignment"] != "match_lesser" {
		t.Errorf("model attributes and provenance side by side: %v", div)
	}
	// What is stored passes the trust funnel every reader applies.
	if !extractiontrust.GroundedEntry(rev) || !extractiontrust.GroundedEntry(div) {
		t.Error("a stored aligned entry must be grounded")
	}
}

func TestExtractionPromptIsVerbatim(t *testing.T) {
	for _, want := range []string{
		"Extract key financial metrics from this ASX company financial report.",
		"Focus on the MOST RECENT reporting period (not comparative/prior period).",
		"All monetary values should be in millions AUD unless stated otherwise.",
		"Only extract metrics that are explicitly stated - do not calculate or infer.",
	} {
		if !strings.Contains(extractionPrompt, want) {
			t.Errorf("prompt drifted, missing: %q", want)
		}
	}
}

// Python's len()/slicing count CODE POINTS; using Go's byte length here would
// change the stored raw_text_length and both char floors.
func TestRuneLengthSemanticsMatchPython(t *testing.T) {
	s := "Résumé — ½" // 10 code points, 15 bytes
	if got := runeLen(s); got != 10 {
		t.Errorf("runeLen = %d, want 10 (Python len())", got)
	}
	if got := truncateRunes(s, 3); got != "Rés" {
		t.Errorf("truncateRunes(3) = %q, want %q", got, "Rés")
	}
	if got := truncateRunes(s, 100); got != s {
		t.Errorf("truncateRunes past the end must be a no-op, got %q", got)
	}
	if got := truncateRunes("abc", 0); got != "" {
		t.Errorf("truncateRunes(0) = %q, want empty", got)
	}
}

func TestLangextractTuningMatchesPython(t *testing.T) {
	if extractionPasses != 1 || extractMaxWorkers != 1 || extractMaxCharBuffer != 2000 {
		t.Errorf("lx.extract tuning drifted: passes=%d workers=%d buffer=%d (want 1/1/2000)",
			extractionPasses, extractMaxWorkers, extractMaxCharBuffer)
	}
	if maxExtractionChars != 50000 {
		t.Errorf("text truncation drifted: %d, want 50000", maxExtractionChars)
	}
}

// The Go langextract port takes the API key explicitly where Python's library
// read it from the environment; both env names must still be honoured.
func TestLangextractAPIKeyPrefersLangextractVar(t *testing.T) {
	t.Setenv("LANGEXTRACT_API_KEY", "lx-key")
	t.Setenv("GEMINI_API_KEY", "gem-key")
	if got := langextractAPIKey(); got != "lx-key" {
		t.Errorf("got %q, want the LANGEXTRACT_API_KEY value", got)
	}
	t.Setenv("LANGEXTRACT_API_KEY", "")
	if got := langextractAPIKey(); got != "gem-key" {
		t.Errorf("got %q, want the GEMINI_API_KEY fallback", got)
	}
}
