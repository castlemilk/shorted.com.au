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
	if len(Statuses) != 11 {
		t.Fatalf("got %d statuses, want the eleven the table admits (000148 adds bounced, complained, skipped_suppressed)", len(Statuses))
	}
}

// The enriched shape adds the stock detail and the logo. It is pinned by its own
// golden, so an old row (no stock) still reads the golden above byte for byte.
func TestPayloadEnrichedJSONGolden(t *testing.T) {
	prev := 6.99
	latest := 12.15
	change := 5.16
	shares := 1.24e9
	onIssue := 1.21e10
	c20 := 6.3
	p := Payload{
		Companies: []Company{
			{Code: "GLC", Name: "Glencore", Latest: 12.15, Previous: &prev, Change: &change, Rank: 12, LogoURL: "https://example.test/glc.png"},
		},
		CompaniesTotal: 1,
		Stock: &StockDetail{
			Name:          "Glencore",
			Industry:      "Materials",
			LogoURL:       "https://example.test/glc.png",
			SharesShort:   &shares,
			SharesOnIssue: &onIssue,
			Rank:          12,
			Ranked:        640,
			Change20:      &c20,
			History:       []Point{{D: "2026-10-15", P: 6.99}, {D: "2026-10-16", P: latest}},
		},
	}
	got, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"companies":[{"code":"GLC","name":"Glencore","latest":12.15,"previous":6.99,"change":5.16,"rank":12,"previous_rank":0,"logo_url":"https://example.test/glc.png"}],"companies_total":1,"stock":{"name":"Glencore","industry":"Materials","logo_url":"https://example.test/glc.png","shares_short":1240000000,"shares_on_issue":12100000000,"rank":12,"ranked":640,"change20":6.3,"history":[{"d":"2026-10-15","p":6.99},{"d":"2026-10-16","p":12.15}]}}`
	if string(got) != want {
		t.Fatalf("enriched payload JSON drifted:\n got %s\nwant %s", got, want)
	}
	var back Payload
	if err := json.Unmarshal(got, &back); err != nil {
		t.Fatal(err)
	}
	if back.Stock == nil || back.Stock.Ranked != 640 || len(back.Stock.History) != 2 {
		t.Fatalf("round trip lost the stock detail: %+v", back.Stock)
	}
}

// A payload written before the stock detail existed has no stock key at all, and
// decodes with Stock nil.
func TestPayloadWithoutStockDecodesNil(t *testing.T) {
	var p Payload
	if err := json.Unmarshal([]byte(`{"companies":[{"code":"BHP","name":"BHP","latest":5,"previous":null,"change":null,"rank":0,"previous_rank":0}],"companies_total":1}`), &p); err != nil {
		t.Fatal(err)
	}
	if p.Stock != nil {
		t.Fatalf("an old payload must decode with no stock detail: %+v", p.Stock)
	}
}
