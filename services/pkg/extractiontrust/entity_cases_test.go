package extractiontrust

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// entityCase is one row of testdata/entity_matches_cases.json, the fixture the
// Python port (services/report-extractor/entity_match.py) is asserted against
// too: --repair-document-meta reports with it whether a rewritten entity
// changes what the entity gates decide, so the two must agree on every name.
type entityCase struct {
	Entity string `json:"entity"`
	// Company is "company-metadata".company_name; null stands for a code
	// with no row there, which every gate reads as "".
	Company string `json:"company"`
	Want    bool   `json:"want"`
	Note    string `json:"note,omitempty"`
}

func loadEntityCases(t *testing.T) []entityCase {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "entity_matches_cases.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var cases []entityCase
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	return cases
}

func TestEntityMatchesFixture(t *testing.T) {
	cases := loadEntityCases(t)
	if len(cases) < 30 {
		t.Fatalf("fixture must carry at least 30 pairs, has %d", len(cases))
	}
	var matches, mismatches int
	seen := map[[2]string]bool{}
	for _, c := range cases {
		key := [2]string{c.Entity, c.Company}
		if seen[key] {
			t.Errorf("duplicate fixture row %q / %q", c.Entity, c.Company)
		}
		seen[key] = true
		if c.Want {
			matches++
		} else {
			mismatches++
		}
		if got := EntityMatches(c.Entity, c.Company); got != c.Want {
			t.Errorf("EntityMatches(%q, %q) = %v, want %v (%s)", c.Entity, c.Company, got, c.Want, c.Note)
		}
	}
	if matches < 10 || mismatches < 10 {
		t.Errorf("fixture is lopsided: %d match, %d do not", matches, mismatches)
	}
}

// The names the repair's prod dry run turned on (2026-10-13) must be in the
// shared fixture, with these answers, so the Python port cannot pass without
// them.
func TestEntityFixtureCarriesTheRepairsNames(t *testing.T) {
	want := map[[2]string]bool{
		{"Vitura Health Limited", "Vitura Health"}:                                            true,
		{"Cortexa Pty Ltd", "Vitura Health"}:                                                  false,
		{"Sturt Exploration Pty Ltd", "Axiant Resources"}:                                     false,
		{"Ocean Sciences Ltd (formerly BPH Global Ltd)", "Bph Global"}:                        true,
		{"Ocean Sciences Ltd (formerly BPH Global Ltd)", "Ocean Sciences"}:                    true,
		{"Ocean Sciences Ltd", "Bph Global"}:                                                  false,
		{"Charter Hall Retail REIT", "Charter Hall Retail Reit"}:                              true,
		{"JPMorgan Global Equity Premium Income Fund", "Janus Henderson Cdi 1:1 For. Exempt"}: false,
		{"JPMorgan Global Select Equity Fund", "Jayex Healthcare"}:                            false,
	}
	got := map[[2]string]bool{}
	for _, c := range loadEntityCases(t) {
		got[[2]string{c.Entity, c.Company}] = c.Want
	}
	for pair, w := range want {
		g, ok := got[pair]
		if !ok {
			t.Errorf("fixture lacks %q / %q", pair[0], pair[1])
		} else if g != w {
			t.Errorf("fixture says %q / %q = %v, want %v", pair[0], pair[1], g, w)
		}
	}
}
