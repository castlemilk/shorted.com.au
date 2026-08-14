package influence

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestNormalizeDivisionKey(t *testing.T) {
	// The AEC's boundary file and its results CSV disagree on capitalisation and
	// apostrophes for the same seat. Both must land on one key, or those seats
	// silently lose their party.
	cases := []struct{ a, b string }{
		{"O'connor", "O'Connor"},
		{"Eden-Monaro", "Eden Monaro"},
		{"  Adelaide  ", "adelaide"},
		{"Fraser", "FRASER"},
	}
	for _, c := range cases {
		if normalizeDivisionKey(c.a) != normalizeDivisionKey(c.b) {
			t.Errorf("normalizeDivisionKey(%q)=%q != normalizeDivisionKey(%q)=%q",
				c.a, normalizeDivisionKey(c.a), c.b, normalizeDivisionKey(c.b))
		}
	}
	// Distinct seats must stay distinct.
	if normalizeDivisionKey("Melbourne") == normalizeDivisionKey("Melbourne Ports") {
		t.Error("Melbourne and Melbourne Ports collapsed to the same key")
	}
}

func TestLoadFederalDivisions(t *testing.T) {
	dir := t.TempDir()
	payload := map[string]federalDivision{
		"Adelaide": {Member: "Steve GEORGANAS", Party: "Australian Labor Party", PartyAb: "ALP", State: "SA"},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, federalDivisionsFile), raw, 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := loadFederalDivisions(dir)
	if err != nil {
		t.Fatalf("loadFederalDivisions: %v", err)
	}
	if got["Adelaide"].PartyAb != "ALP" {
		t.Errorf("PartyAb = %q, want ALP", got["Adelaide"].PartyAb)
	}

	if _, err := loadFederalDivisions(t.TempDir()); err == nil {
		t.Error("expected an error for a directory with no federal-divisions.json")
	}
}

func TestLoadFederalDivisionsRejectsEmpty(t *testing.T) {
	// An empty object would silently seed nothing and read as "no seats matched".
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, federalDivisionsFile), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadFederalDivisions(dir); err == nil {
		t.Error("expected an error for an empty division map")
	}
}

// The committed data must actually parse and cover a full parliament — this is
// the file the seeder depends on, so a refresh that changes its shape fails here
// rather than quietly blanking every party chip.
func TestCommittedFederalDivisionsParse(t *testing.T) {
	byDivision, err := loadFederalDivisions(repoElectoratesDir(t))
	if err != nil {
		t.Fatalf("committed electorate data did not load: %v", err)
	}
	if len(byDivision) < 140 {
		t.Errorf("only %d divisions; the House has 150 seats", len(byDivision))
	}
	missing := 0
	for _, d := range byDivision {
		if d.PartyAb == "" || d.Party == "" {
			missing++
		}
	}
	if missing > 0 {
		t.Errorf("%d divisions carry no party", missing)
	}
}

// repoElectoratesDir walks up to the repo root to find the COMMITTED electorate
// data, rather than trusting a relative path.
//
// electoratesDir()'s default is relative to the old standalone binary's working
// directory. After the port into services/jobs the test package sits four levels
// deeper, so this test began SKIPPING — silently, and it was the only skip in the
// suite. A test that guards "a refresh must not quietly blank every party chip"
// is worthless if it opts out whenever it cannot find the file.
func repoElectoratesDir(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		candidate := filepath.Join(dir, "web", "public", "geo", "electorates")
		if _, err := os.Stat(filepath.Join(candidate, federalDivisionsFile)); err == nil {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			// Genuinely not a full checkout (sparse clone, vendored build).
			t.Skip("repo root with web/public/geo/electorates not found above the working dir")
		}
		dir = parent
	}
}
