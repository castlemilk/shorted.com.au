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

// ElectorateRow is one suburb's electoral representation (UPDATE target).
type ElectorateRow struct {
	SALCode         string
	FederalDivision string
	FederalMember   string
	FederalParty    string
	FederalPartyAb  string
	FederalTppAlp   *float64
	StateDistrict   string // ABS State Electoral Division
	StateMember     string // single-member states only (TAS/ACT Hare-Clark = '')
	StateParty      string
	StatePartyAb    string
}

// sedEntry is one suburb's state electoral division (from the SED spatial join).
type sedEntry struct {
	State    string `json:"state"`
	District string `json:"district"`
}

// stateMember is one district's sitting state lower-house member.
type stateMember struct {
	Member  string `json:"member"`
	Party   string `json:"party"`
	PartyAb string `json:"partyAb"`
}

// absStateToCode maps the ABS state name (in the SED join) to our 2-3 letter code.
var absStateToCode = map[string]string{
	"New South Wales": "NSW", "Victoria": "VIC", "Queensland": "QLD",
	"South Australia": "SA", "Western Australia": "WA", "Tasmania": "TAS",
	"Northern Territory": "NT", "Australian Capital Territory": "ACT",
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
	// State electoral division per suburb (ABS SED spatial join).
	sed := map[string]sedEntry{}
	if err := readJSONFile(filepath.Join(dir, "suburb-sed.json"), &sed); err != nil {
		return nil, err
	}
	// State member+party per district, keyed by state code → district.
	stateMembers := map[string]map[string]stateMember{}
	if err := readJSONFile(filepath.Join(dir, "state-members.json"), &stateMembers); err != nil {
		return nil, err
	}
	// One row per suburb present in EITHER mapping.
	byCode := make(map[string]*ElectorateRow, len(salToDiv))
	get := func(sal string) *ElectorateRow {
		r := byCode[sal]
		if r == nil {
			r = &ElectorateRow{SALCode: sal}
			byCode[sal] = r
		}
		return r
	}
	for sal, div := range salToDiv {
		name, ok := canon[strings.ToLower(div)]
		if !ok {
			continue
		}
		d := divisions[name]
		r := get(sal)
		r.FederalDivision = name
		r.FederalMember = d.Member
		r.FederalParty = d.Party
		r.FederalPartyAb = d.PartyAb
		if d.TppAlp > 0 {
			tpp := d.TppAlp
			r.FederalTppAlp = &tpp
		}
	}
	for sal, e := range sed {
		r := get(sal)
		r.StateDistrict = e.District
		if byDist, ok := stateMembers[absStateToCode[e.State]]; ok {
			if m, ok := byDist[e.District]; ok {
				r.StateMember = m.Member
				r.StateParty = m.Party
				r.StatePartyAb = m.PartyAb
			}
		}
	}
	rows := make([]ElectorateRow, 0, len(byCode))
	for _, r := range byCode {
		rows = append(rows, *r)
	}
	return rows, nil
}
