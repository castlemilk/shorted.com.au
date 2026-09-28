package extractiontrust

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestGrounded(t *testing.T) {
	const cbaReal = "Statutory NPAT2 $5,142m"
	cases := []struct {
		name  string
		attrs map[string]string
		text  string
		want  bool
	}{
		// Every aligned status passes.
		{"exact", map[string]string{"alignment": "match_exact"}, cbaReal, true},
		{"greater", map[string]string{"alignment": "match_greater"}, cbaReal, true},
		{"lesser", map[string]string{"alignment": "match_lesser"}, cbaReal, true},
		{"fuzzy", map[string]string{"alignment": "match_fuzzy"}, cbaReal, true},
		{"padded status", map[string]string{"alignment": " match_exact "}, cbaReal, true},
		// A present alignment that is not an aligned status fails.
		{"empty status", map[string]string{"alignment": ""}, cbaReal, false},
		{"unaligned", map[string]string{"alignment": "unaligned"}, cbaReal, false},
		{"None", map[string]string{"alignment": "None"}, cbaReal, false},
		{"enum repr", map[string]string{"alignment": "AlignmentStatus.MATCH_EXACT"}, cbaReal, false},
		{"upper case", map[string]string{"alignment": "MATCH_EXACT"}, cbaReal, false},
		// Legacy entries (no alignment key) pass unless they echo the prompt.
		{"legacy", map[string]string{"value_millions": "5142", "period": "1H25"}, cbaReal, true},
		{"nil attrs", nil, cbaReal, true},
		{"legacy empty quote", map[string]string{}, "", true},
		// The CBA real NPAT is the old example's revenue VALUE; it is not a text
		// match, so it is grounded (never deny by value).
		{"CBA real value collision", map[string]string{"value_millions": "5142", "alignment": "match_exact"}, cbaReal, true},
		// The prod echo sentences fail, legacy or aligned.
		{"echo revenue legacy", map[string]string{"value_millions": "5142", "period": "H1 FY2025", "change_pct": "+8"},
			"Revenue from continuing operations for the half year ended 31 December 2024 was $5,142 million", false},
		{"echo npat legacy", map[string]string{"value_millions": "1823", "period": "H1 FY2025"},
			"Statutory net profit after tax (NPAT) was $1,823 million, up 12% on pcp", false},
		{"echo eps legacy", map[string]string{"value_cents": "94.2", "period": "H1 FY2025"},
			"Basic earnings per share was 94.2 cents", false},
		{"echo dividend legacy", map[string]string{"value_cents": "45"},
			"interim dividend of 45 cents per share, fully franked", false},
		{"echo ocf legacy", map[string]string{"value_millions": "2156"}, "Operating cash flow was $2,156 million", false},
		{"echo ebitda legacy", map[string]string{"value_millions": "2891"}, "EBITDA was $2,891 million, representing a margin of 56.2%", false},
		{"echo guidance legacy", map[string]string{"range": "6-8%"}, "FY2025 guidance: Revenue growth of 6-8% expected", false},
		{"echo even if aligned", map[string]string{"alignment": "match_fuzzy"}, "Basic earnings per share was 94.2 cents", false},
		{"new example echo", map[string]string{"alignment": "match_exact"},
			"Operating cash flow for H1 FY2031 was $1,094 million", false},
		// Unaligned AND echo: fails on either count.
		{"unaligned echo", map[string]string{"alignment": "unaligned"}, "Operating cash flow was $2,156 million", false},
	}
	for _, c := range cases {
		if got := Grounded(c.attrs, c.text); got != c.want {
			t.Errorf("%s: Grounded(%v, %q) = %v, want %v", c.name, c.attrs, c.text, got, c.want)
		}
	}
}

// GroundedEntry reads the JSON shape the picks ingest decodes (map[string]any),
// where the model may have written numbers and the extractor strings.
func TestGroundedEntry(t *testing.T) {
	cases := []struct {
		name string
		json string
		want bool
	}{
		{"aligned real", `{"source_text":"Statutory NPAT2 $5,142m","value_millions":"5142","alignment":"match_exact","char_start":"120","char_end":"143"}`, true},
		{"legacy real", `{"source_text":"Statutory NPAT2 $5,142m","value_millions":5142}`, true},
		{"legacy echo", `{"source_text":"Basic earnings per share was 94.2 cents","value_cents":"94.2","period":"H1 FY2025"}`, false},
		{"unaligned", `{"source_text":"Statutory NPAT2 $5,142m","alignment":"unaligned"}`, false},
		{"null alignment", `{"source_text":"Statutory NPAT2 $5,142m","alignment":null}`, false},
		{"numeric alignment", `{"source_text":"Statutory NPAT2 $5,142m","alignment":1}`, false},
		{"no quote", `{"value_millions":"5142"}`, true},
		{"numeric quote", `{"source_text":5142}`, true},
	}
	for _, c := range cases {
		var entry map[string]any
		if err := json.Unmarshal([]byte(c.json), &entry); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if got := GroundedEntry(entry); got != c.want {
			t.Errorf("%s: GroundedEntry(%s) = %v, want %v", c.name, c.json, got, c.want)
		}
	}
}

// Grounded and GroundedEntry agree on every string-valued entry.
func TestGroundedAndGroundedEntryAgree(t *testing.T) {
	entries := []map[string]string{
		{"source_text": "Statutory NPAT2 $5,142m", "alignment": "match_exact"},
		{"source_text": "Statutory NPAT2 $5,142m", "alignment": "unaligned"},
		{"source_text": "Statutory NPAT2 $5,142m"},
		{"source_text": "Operating cash flow was $2,156 million"},
		{"source_text": "EBITDA was $2,891 million, representing a margin of 56.2%", "alignment": "match_lesser"},
		{},
	}
	for _, e := range entries {
		anyEntry := map[string]any{}
		for k, v := range e {
			anyEntry[k] = v
		}
		if a, b := Grounded(e, e["source_text"]), GroundedEntry(anyEntry); a != b {
			t.Errorf("%v: Grounded %v, GroundedEntry %v", e, a, b)
		}
	}
}

func TestIsProvenanceKey(t *testing.T) {
	for k, want := range map[string]bool{
		"alignment":      true,
		"char_start":     true,
		"char_end":       true,
		"source_text":    false,
		"value_millions": false,
		"period":         false,
		"Alignment":      false,
		"char_interval":  false,
		"":               false,
	} {
		if got := IsProvenanceKey(k); got != want {
			t.Errorf("IsProvenanceKey(%q) = %v, want %v", k, got, want)
		}
	}
}

func TestStripProvenance(t *testing.T) {
	in := map[string]string{
		"source_text":    "Statutory NPAT2 $5,142m",
		"value_millions": "5142",
		"period":         "1H25",
		"alignment":      "match_exact",
		"char_start":     "120",
		"char_end":       "143",
	}
	want := map[string]string{
		"source_text":    "Statutory NPAT2 $5,142m",
		"value_millions": "5142",
		"period":         "1H25",
	}
	got := StripProvenance(in)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("StripProvenance = %v, want %v", got, want)
	}
	if len(in) != 6 || in["alignment"] != "match_exact" {
		t.Error("StripProvenance must not modify its input")
	}
	got["period"] = "changed"
	if in["period"] != "1H25" {
		t.Error("StripProvenance must return a copy")
	}
	if StripProvenance(nil) != nil {
		t.Error("nil in, nil out")
	}
	if out := StripProvenance(map[string]string{"alignment": "x"}); out == nil || len(out) != 0 {
		t.Errorf("only provenance keys -> empty non-nil map, got %v", out)
	}
}

func TestStripProvenanceEntry(t *testing.T) {
	in := map[string]any{
		"source_text":    "Statutory NPAT2 $5,142m",
		"value_millions": 5142.0,
		"alignment":      "match_exact",
		"char_start":     "120",
		"char_end":       "143",
	}
	got := StripProvenanceEntry(in)
	want := map[string]any{"source_text": "Statutory NPAT2 $5,142m", "value_millions": 5142.0}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("StripProvenanceEntry = %v, want %v", got, want)
	}
	if len(in) != 5 {
		t.Error("StripProvenanceEntry must not modify its input")
	}
	if StripProvenanceEntry(nil) != nil {
		t.Error("nil in, nil out")
	}
}
