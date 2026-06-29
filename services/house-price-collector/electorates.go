package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Federal electoral representation, joined per suburb. The boundaries→suburb
// spatial join + the division roll-up are precomputed (web/scripts/geo/
// join-electorates.mjs) and shipped as small JSON under the geo dir; this just
// loads them and upserts the federal_* columns onto suburb_demographics.

type federalDivision struct {
	Member  string  `json:"member"`
	Party   string  `json:"party"`
	PartyAb string  `json:"partyAb"`
	State   string  `json:"state"`
	TppAlp  float64 `json:"tppAlp"`
	Swing   float64 `json:"swing"`
}

// ElectorateRow is one suburb's federal representation (UPDATE target).
type ElectorateRow struct {
	SALCode         string
	FederalDivision string
	FederalMember   string
	FederalParty    string
	FederalPartyAb  string
	FederalTppAlp   *float64
}

// electoratesDir resolves the committed electorate data dir (sibling of the
// suburb boundary dir), overridable via ELECTORATES_DIR.
func electoratesDir() string {
	if d := strings.TrimSpace(os.Getenv("ELECTORATES_DIR")); d != "" {
		return d
	}
	return filepath.Join(filepath.Dir(censusGeoDir()), "electorates")
}

func readJSONFile(path string, v interface{}) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	return nil
}

// ingestElectorates joins the suburb→division mapping with the division roll-up
// into one row per matched suburb.
func ingestElectorates() ([]ElectorateRow, error) {
	dir := electoratesDir()
	divisions := map[string]federalDivision{}
	if err := readJSONFile(filepath.Join(dir, "federal-divisions.json"), &divisions); err != nil {
		return nil, err
	}
	salToDiv := map[string]string{}
	if err := readJSONFile(filepath.Join(dir, "suburb-federal-division.json"), &salToDiv); err != nil {
		return nil, err
	}
	// The AEC boundary file and results CSV disagree on casing of names with
	// apostrophes/Mc- (O'connor vs O'Connor) — match case-insensitively, keep the
	// canonical (results-CSV) name.
	canon := make(map[string]string, len(divisions))
	for name := range divisions {
		canon[strings.ToLower(name)] = name
	}
	rows := make([]ElectorateRow, 0, len(salToDiv))
	for sal, div := range salToDiv {
		name, ok := canon[strings.ToLower(div)]
		if !ok {
			continue
		}
		d := divisions[name]
		div = name
		tpp := d.TppAlp
		var tppPtr *float64
		if tpp > 0 {
			tppPtr = &tpp
		}
		rows = append(rows, ElectorateRow{
			SALCode:         sal,
			FederalDivision: div,
			FederalMember:   d.Member,
			FederalParty:    d.Party,
			FederalPartyAb:  d.PartyAb,
			FederalTppAlp:   tppPtr,
		})
	}
	return rows, nil
}
