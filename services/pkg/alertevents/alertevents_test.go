package alertevents

import (
	"encoding/json"
	"testing"
)

// The JSON shape is read by the evaluator and by the API from different
// modules. This golden pins it: renaming a tag breaks this test, not a page.
func TestPayloadJSONGolden(t *testing.T) {
	prev := 5.1
	change := 0.32
	p := Payload{
		Companies: []Company{
			{Code: "BHP", Name: "BHP Group Ltd", Latest: 5.42, Previous: &prev, Change: &change, Rank: 3, PreviousRank: 0},
			{Code: "NEW", Name: "New Listing Ltd", Latest: 7, Previous: nil, Change: nil, Rank: 0, PreviousRank: 0},
		},
		CompaniesTotal: 2,
	}
	got, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"companies":[{"code":"BHP","name":"BHP Group Ltd","latest":5.42,"previous":5.1,"change":0.32,"rank":3,"previous_rank":0},{"code":"NEW","name":"New Listing Ltd","latest":7,"previous":null,"change":null,"rank":0,"previous_rank":0}],"companies_total":2}`
	if string(got) != want {
		t.Fatalf("payload JSON drifted:\n got %s\nwant %s", got, want)
	}
}

func TestPayloadDecodesNullPreviousAndOmitsEmptyNote(t *testing.T) {
	var p Payload
	if err := json.Unmarshal([]byte(`{"companies":[{"code":"NEW","name":"","latest":7,"previous":null,"change":null,"rank":0,"previous_rank":0}],"companies_total":1}`), &p); err != nil {
		t.Fatal(err)
	}
	if len(p.Companies) != 1 || p.Companies[0].Previous != nil || p.Companies[0].Change != nil {
		t.Fatalf("null previous and change must decode to nil: %+v", p.Companies)
	}
	if p.Note != "" {
		t.Fatalf("note = %q, want empty", p.Note)
	}
}

func TestStatusesAreDistinct(t *testing.T) {
	seen := map[string]bool{}
	for _, s := range Statuses {
		if seen[s] {
			t.Fatalf("duplicate status %q", s)
		}
		seen[s] = true
	}
	if len(Statuses) != 7 {
		t.Fatalf("got %d statuses, want the seven the table admits", len(Statuses))
	}
}
