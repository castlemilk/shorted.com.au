package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestParseWikidataLGA(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "lga", "wikidata-sparql.json"))
	if err != nil {
		t.Fatal(err)
	}
	got, notes, err := parseWikidataLGA(raw)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]wikidataCouncil{
		"10050": {QID: "Q1719401", Website: "https://www.alburycity.nsw.gov.au"},
		// Merri-bek is stored on Wikidata under its LGA_2021 code, LGA25250.
		"24700": {QID: "Q1947531", Website: "https://www.merri-bek.vic.gov.au"},
		// Two official websites: https over http, then the shorter.
		"71300": {QID: "Q3688163", Website: "https://eastarnhem.nt.gov.au"},
		// Two items claim one code: the lower QID wins (numerically, not
		// lexically — Q815555 < Q99999999), and its missing website stays missing.
		"20910": {QID: "Q815555"},
		// A website that is not an absolute URL is dropped, the QID kept.
		"10130": {QID: "Q5"},
		// An unknown LGA code is kept here; the join reports it.
		"99999": {QID: "Q7"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("parse =\n%#v\nwant\n%#v", got, want)
	}
	if len(notes) != 1 {
		t.Errorf("notes = %v, want the one duplicated code", notes)
	}

	ix := fixtureIndex()
	codes, missing, unknown := wikidataMatch(got, ix)
	if !reflect.DeepEqual(codes, []string{"10050", "10130", "20910", "24700", "71300"}) {
		t.Errorf("codes = %v", codes)
	}
	if len(missing) != 0 || !reflect.DeepEqual(unknown, []string{"99999"}) {
		t.Errorf("missing = %v, unknown = %v", missing, unknown)
	}
}

// The committed snapshot is what -mode wikidata-lga writes to every
// environment, so it is checked like any other data artifact.
func TestWikidataSnapshotIsCommittedAndClean(t *testing.T) {
	snap, err := readWikidataSnapshot(filepath.Join("data", "wikidata-lga.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Councils) < wikidataMinCouncils {
		t.Fatalf("snapshot has %d councils (< %d)", len(snap.Councils), wikidataMinCouncils)
	}
	if snap.Query != wikidataQuery {
		t.Error("snapshot was produced by a different query: refresh it with WIKIDATA_REFRESH=true")
	}
	web := 0
	for code, c := range snap.Councils {
		if !wikidataQIDRe.MatchString(c.QID) || len(code) != 5 {
			t.Errorf("%s: bad entry %+v", code, c)
		}
		if c.Website != "" {
			web++
			if !validWebsite(c.Website) {
				t.Errorf("%s: bad website %q", code, c.Website)
			}
		}
	}
	if web < 500 {
		t.Errorf("only %d councils have a website", web)
	}
	if _, err := readWikidataSnapshot(filepath.Join("testdata", "lga", "wikidata-sparql.json")); err == nil {
		t.Error("a file without the CC0 licence stamp must be refused")
	}
}
