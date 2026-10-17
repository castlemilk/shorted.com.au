package extractiontrust

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestTrustedEntriesShapes(t *testing.T) {
	echo := oldFewShotExample.Extractions[0].Text
	cases := []struct {
		name    string
		in      any
		want    int
		dropped int
	}{
		{"single grounded object", map[string]any{"source_text": "Revenue $1m", "alignment": "match_exact"}, 1, 0},
		{"single unaligned object", map[string]any{"source_text": "Revenue $1m", "alignment": "unaligned"}, 0, 1},
		{"list mixes echo and real", []any{
			map[string]any{"source_text": echo},
			map[string]any{"source_text": "Statutory NPAT2 $5,142m"},
		}, 1, 1},
		{"non-object entries dropped", []any{"text", 3.0, nil, map[string]any{"source_text": "ok"}}, 1, 3},
		{"raw json list", json.RawMessage(`[{"source_text":"a","alignment":"match_fuzzy"},{"source_text":"b","alignment":null}]`), 1, 1},
		{"bad raw json", json.RawMessage(`{`), 0, 1},
		{"nil", nil, 0, 0},
		{"scalar", "revenue", 0, 1},
	}
	for _, c := range cases {
		got, dropped := TrustedEntries(c.in)
		if len(got) != c.want || dropped != c.dropped {
			t.Errorf("%s: got %d entries, %d dropped; want %d, %d", c.name, len(got), dropped, c.want, c.dropped)
		}
		for _, e := range got {
			for k := range e {
				if IsProvenanceKey(k) {
					t.Errorf("%s: provenance key %q survived", c.name, k)
				}
			}
		}
	}
}

func TestTrustedMetricsKeepsShapeAndNeverMutates(t *testing.T) {
	in := map[string]any{
		"revenue": map[string]any{"source_text": "Revenue up 7% to $3.9bn", "value_millions": "3900", "alignment": "match_exact", "char_start": "10", "char_end": "40"},
		"eps": []any{
			map[string]any{"source_text": "Basic earnings per share was 94.2 cents", "value_cents": "94.2"},
			map[string]any{"source_text": "Basic EPS 51.0 cents", "value_cents": "51.0", "alignment": "match_lesser"},
		},
		"ebitda":   map[string]any{"source_text": "EBITDA $1m", "alignment": "unaligned"},
		"dividend": []any{map[string]any{"source_text": "The Quokka Board declared an interim dividend of 21 cents per share, fully franked"}},
	}
	before, _ := json.Marshal(in)
	got, dropped := TrustedMetrics(in)
	after, _ := json.Marshal(in)
	if string(before) != string(after) {
		t.Fatal("TrustedMetrics modified its input")
	}
	if dropped != 3 {
		t.Errorf("dropped = %d, want 3 (the old echo, the unaligned EBITDA, the new echo)", dropped)
	}
	want := map[string]any{
		"revenue": map[string]any{"source_text": "Revenue up 7% to $3.9bn", "value_millions": "3900"},
		"eps":     []any{map[string]any{"source_text": "Basic EPS 51.0 cents", "value_cents": "51.0"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("TrustedMetrics:\n got %#v\nwant %#v", got, want)
	}
	if empty, d := TrustedMetrics(nil); len(empty) != 0 || d != 0 {
		t.Errorf("nil in: got %v, %d", empty, d)
	}
}
