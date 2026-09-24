package main

import (
	"os"
	"path/filepath"
	"testing"
)

// The NBN join now emits tech:null for a suburb no footprint covers, instead of
// guessing 'Satellite'. Those rows must reach the table as NULL with no score —
// an empty string or a leftover score would read as a measured technology.
func TestIngestConnectivity_UnknownTechIsNullWithNoScore(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "suburb-nbn.json")
	if err := os.WriteFile(file, []byte(`{
		"10462": {"tech": "Fixed Line", "score": 90},
		"50001": {"tech": null, "score": null},
		"50002": {"tech": "", "score": 20}
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CONNECTIVITY_FILE", file)

	rows, err := ingestConnectivity()
	if err != nil {
		t.Fatal(err)
	}
	bySAL := map[string]ConnectivityRow{}
	for _, r := range rows {
		bySAL[r.SALCode] = r
	}
	if r := bySAL["10462"]; r.Tech == nil || *r.Tech != "Fixed Line" || r.Score == nil || *r.Score != 90 {
		t.Fatalf("covered suburb lost its technology: %+v", r)
	}
	for _, sal := range []string{"50001", "50002"} {
		if r := bySAL[sal]; r.Tech != nil || r.Score != nil {
			t.Fatalf("uncovered suburb %s must be NULL tech + NULL score, got tech=%v score=%v", sal, r.Tech, r.Score)
		}
	}
}
