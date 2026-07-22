package main

import (
	"encoding/json"
	"testing"
	"time"
)

// LDP fixtures are SYNTHETIC (no real detail-page capture exists yet — Phase 0).
// They're hand-built to the EXPECTED shapes the extractor targets: the SRP shapes
// extended with the detail-only fields. The Phase-0 live probe will confirm/refine
// them; until then these lock in the tolerant walk + all the harvest helpers.

// domainLDPHTML is a Domain __NEXT_DATA__ detail page: the listing lives under
// props.pageProps.componentProps with the summary/sizes/features/agents split
// across sub-objects, exactly like the SRP but for a single listing.
func domainLDPHTML() string {
	payload := map[string]any{
		"props": map[string]any{"pageProps": map[string]any{"componentProps": map[string]any{
			"listingId":      "2020524930",
			"listingSummary": map[string]any{"description": "Sun-drenched semi steps from the beach.", "propertyType": "House"},
			"address":        map[string]any{"street": "12 Smith Street", "suburb": "Bondi", "state": "NSW", "postcode": "2026"},
			"geoLocation":    map[string]any{"latitude": -33.891, "longitude": 151.276},
			"propertySizes": map[string]any{
				"land":     map[string]any{"displayValue": "610 m²", "sizeUnit": "m²", "value": 610},
				"building": map[string]any{"displayValue": "220 m²"},
			},
			"structuredFeatures": []any{
				map[string]any{"name": "Air conditioning"},
				map[string]any{"name": "Balcony"},
				map[string]any{"name": "Air conditioning"}, // dup — must be deduped
			},
			"media":             []any{map[string]any{"url": "a"}, map[string]any{"url": "b"}, map[string]any{"url": "c"}},
			"inspectionDetails": map[string]any{"inspections": []any{map[string]any{"startTime": "2026-08-01T10:00:00"}}},
			"auction":           map[string]any{"dateTime": "2026-08-10T13:00:00"},
			"listedDate":        "2026-07-15",
			"agencyProfile":     map[string]any{"name": "Ray White Bondi"},
			"contactAgents":     []any{map[string]any{"name": "Jane Agent", "phoneNumber": "0400111222"}},
		}}},
	}
	b, _ := json.Marshal(payload)
	return `<html><body><script id="__NEXT_DATA__" type="application/json">` + string(b) + `</script></body></html>`
}

// reaDoubleStringifiedLDP wraps a listing object in REA's triple-stringified
// ArgonautExchange → urqlClientCache → data chain (a JSON string inside a JSON
// string inside a JSON string), which the walk must transparently descend.
func reaDoubleStringifiedLDP(listing map[string]any) string {
	s2, _ := json.Marshal(listing)                                                    // the listing object
	inner, _ := json.Marshal(map[string]any{"data": string(s2)})                      // query result: {"data":"<listing>"}
	cache, _ := json.Marshal(map[string]any{"listingResolver:140123456": string(inner)}) // urql cache keyed by query
	arg, _ := json.Marshal(map[string]any{"urqlClientCache": string(cache)})          // ArgonautExchange
	return `<html><body><script>window.ArgonautExchange = ` + string(arg) + `;</script></body></html>`
}

func TestExtractDetail_DomainAllFields(t *testing.T) {
	rec, ok := extractDetail(domainLDPHTML(), "domain")
	if !ok {
		t.Fatal("expected a recognizable Domain LDP payload")
	}
	if rec.Description != "Sun-drenched semi steps from the beach." {
		t.Errorf("description = %q", rec.Description)
	}
	if rec.PropertyType != "House" {
		t.Errorf("property_type = %q", rec.PropertyType)
	}
	if rec.Lat == nil || rec.Lng == nil || *rec.Lat != -33.891 || *rec.Lng != 151.276 {
		t.Errorf("geo = %v,%v", rec.Lat, rec.Lng)
	}
	if rec.LandSizeSqm == nil || *rec.LandSizeSqm != 610 {
		t.Errorf("land = %v, want 610", rec.LandSizeSqm)
	}
	if rec.BuildingSizeSqm == nil || *rec.BuildingSizeSqm != 220 {
		t.Errorf("building = %v, want 220", rec.BuildingSizeSqm)
	}
	if len(rec.Features) != 2 { // deduped
		t.Errorf("features = %v, want 2 deduped", rec.Features)
	}
	if rec.ImageCount == nil || *rec.ImageCount != 3 {
		t.Errorf("image_count = %v, want 3", rec.ImageCount)
	}
	if rec.InspectionNext == nil || !rec.InspectionNext.Equal(time.Date(2026, 8, 1, 10, 0, 0, 0, time.UTC)) {
		t.Errorf("inspection_next = %v", rec.InspectionNext)
	}
	if rec.AuctionAt == nil || !rec.AuctionAt.Equal(time.Date(2026, 8, 10, 13, 0, 0, 0, time.UTC)) {
		t.Errorf("auction_at = %v", rec.AuctionAt)
	}
	if rec.ListedAt == nil || !rec.ListedAt.Equal(time.Date(2026, 7, 15, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("listed_at = %v", rec.ListedAt)
	}
	if rec.AgencyName != "Ray White Bondi" {
		t.Errorf("agency = %q (Domain SRP has none — this is the gap the LDP closes)", rec.AgencyName)
	}
	if len(rec.AgentPhones) != 1 || rec.AgentPhones[0] != "0400111222" {
		t.Errorf("agent_phones = %v", rec.AgentPhones)
	}
	// raw must be valid JSON carrying the recognized fields (feeds the JSONB column
	// + content hash).
	var raw map[string]any
	if err := json.Unmarshal([]byte(rec.Raw), &raw); err != nil {
		t.Fatalf("raw is not valid JSON: %v (%s)", err, rec.Raw)
	}
	if raw["property_type"] != "House" {
		t.Errorf("raw missing property_type: %v", raw)
	}
}

func TestExtractDetail_READoubleStringified(t *testing.T) {
	listing := map[string]any{
		"id":             "140123456",
		"description":    "Charming Queenslander in the heart of New Farm.",
		"propertyType":   "House",
		"price":          map[string]any{"display": "Auction"},
		"address":        map[string]any{"display": map[string]any{"fullAddress": "12 Terrace St, New Farm QLD 4005"}, "suburb": "New Farm", "state": "QLD", "postcode": "4005"},
		"geoLocation":    map[string]any{"latitude": -27.467, "longitude": 153.052},
		"propertySizes":  map[string]any{"land": map[string]any{"displayValue": "405m²"}},
		"features":       []any{"Ducted air", "Pool", "Study"},
		"images":         []any{map[string]any{"i": 1}, map[string]any{"i": 2}, map[string]any{"i": 3}, map[string]any{"i": 4}, map[string]any{"i": 5}},
		"listingCompany": map[string]any{"id": "PLACE", "name": "Place New Farm"},
		"listers":        []any{map[string]any{"name": "Tim Douglas", "phoneNumber": "07 3000 0000"}},
	}
	rec, ok := extractDetail(reaDoubleStringifiedLDP(listing), "rea")
	if !ok {
		t.Fatal("expected the double-stringified REA listing to be recognized")
	}
	// The whole point of the REA LDP: the geo/land/property-type the SRP blob lacks.
	if rec.Lat == nil || rec.Lng == nil || *rec.Lat != -27.467 {
		t.Errorf("geo not harvested from REA LDP: %v,%v (this is REA's SRP gap)", rec.Lat, rec.Lng)
	}
	if rec.LandSizeSqm == nil || *rec.LandSizeSqm != 405 {
		t.Errorf("land = %v, want 405 (parsed from \"405m²\")", rec.LandSizeSqm)
	}
	if rec.PropertyType != "House" {
		t.Errorf("property_type = %q", rec.PropertyType)
	}
	if len(rec.Features) != 3 {
		t.Errorf("features = %v, want 3", rec.Features)
	}
	if rec.ImageCount == nil || *rec.ImageCount != 5 {
		t.Errorf("image_count = %v, want 5", rec.ImageCount)
	}
	if rec.AgencyName != "Place New Farm" {
		t.Errorf("agency = %q", rec.AgencyName)
	}
	if len(rec.AgentPhones) != 1 || rec.AgentPhones[0] != "07 3000 0000" {
		t.Errorf("agent_phones = %v", rec.AgentPhones)
	}
}

func TestExtractDetail_MissingFieldsTolerant(t *testing.T) {
	// A minimal listing object: an address + a property type, everything else
	// absent. Must still be recognized (ok) with only what's present harvested.
	html := `<html><body><script id="__NEXT_DATA__" type="application/json">` +
		`{"props":{"pageProps":{"componentProps":{"address":{"suburb":"Glenelg"},"propertyType":"Unit"}}}}` +
		`</script></body></html>`
	rec, ok := extractDetail(html, "domain")
	if !ok {
		t.Fatal("a minimal address+type object should still be recognized")
	}
	if rec.PropertyType != "Unit" {
		t.Errorf("property_type = %q", rec.PropertyType)
	}
	if rec.Description != "" || rec.Lat != nil || rec.LandSizeSqm != nil || len(rec.Features) != 0 || rec.ImageCount != nil {
		t.Errorf("absent fields should be empty/nil: %+v", rec)
	}
	if rec.Raw == "" {
		t.Error("raw should never be empty")
	}
}

func TestExtractDetail_NoPayload(t *testing.T) {
	for _, html := range []string{
		"<html><body><p>Access Denied</p></body></html>",
		"<html><body></body></html>",
		`<html><body><script>window.foo = {"unrelated":true};</script></body></html>`,
	} {
		if rec, ok := extractDetail(html, "rea"); ok {
			t.Errorf("expected ok=false for %q, got %+v", html, rec)
		}
	}
}

func TestParseSqm(t *testing.T) {
	cases := []struct {
		in   string
		want float64
		ok   bool
	}{
		{"610m²", 610, true},
		{"610 m²", 610, true},
		{"405m2", 405, true},
		{"1,012 sqm", 1012, true},
		{"0.25 ha", 2500, true},
		{"2 hectares", 20000, true},
		{"", 0, false},
		{"contact agent", 0, false},
	}
	for _, c := range cases {
		got, ok := parseSqm(c.in)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("parseSqm(%q) = %v,%v want %v,%v", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestParseAnyTime(t *testing.T) {
	cases := []struct {
		in string
		ok bool
	}{
		{"2026-08-01T10:00:00Z", true},
		{"2026-08-01T10:00:00", true},
		{"2026-08-01 10:00:00", true},
		{"2026-08-01", true},
		{"not a date", false},
		{"", false},
	}
	for _, c := range cases {
		_, ok := parseAnyTime(c.in)
		if ok != c.ok {
			t.Errorf("parseAnyTime(%q) ok=%v want %v", c.in, ok, c.ok)
		}
	}
}

func TestHarvestFeatures_StringAndObjectShapes(t *testing.T) {
	// Bare-string array (REA) and {name} objects (Domain) must both harvest.
	strShape := harvestFeatures(map[string]any{"features": []any{"Pool", "Study", "Pool"}})
	if len(strShape) != 2 {
		t.Errorf("string features = %v, want 2 deduped", strShape)
	}
	objShape := harvestFeatures(map[string]any{"structuredfeatures": []any{
		map[string]any{"name": "Ducted heating"}, map[string]any{"displaylabel": "Solar"},
	}})
	if len(objShape) != 2 {
		t.Errorf("object features = %v, want 2", objShape)
	}
}
