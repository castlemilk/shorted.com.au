package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// property.com.au profile fixtures are SYNTHETIC (no real profile-page capture
// exists yet — Kasada-blocked recon, Phase 0). They're hand-built to the EXPECTED
// shapes the extractor targets: a Next.js __NEXT_DATA__ profile with an AVM estimate
// range + sales history + attributes, plus a REA-family double-stringified variant.
// The Phase-0 live probe will confirm/refine the exact blob + key paths; until then
// these lock in the tolerant walk + all the harvest helpers.

// propertyNextDataHTML is a property.com.au __NEXT_DATA__ profile page: the profile
// lives under props.pageProps.property with the estimate/sizes/sales split across
// sub-objects.
func propertyNextDataHTML() string {
	payload := map[string]any{
		"props": map[string]any{"pageProps": map[string]any{"property": map[string]any{
			"address":      map[string]any{"streetAddress": "12 Smith Street", "suburb": "Bondi", "state": "NSW", "postcode": "2026"},
			"propertyType": "House",
			"bedrooms":     3,
			"bathrooms":    2,
			"carSpaces":    1,
			"yearBuilt":    1998,
			"geoLocation":  map[string]any{"latitude": -33.891, "longitude": 151.276},
			"propertySizes": map[string]any{
				"land":     map[string]any{"displayValue": "610 m²", "value": 610},
				"building": map[string]any{"displayValue": "220 m²"},
			},
			"estimate":     map[string]any{"low": 2100000, "mid": 2350000, "high": 2600000, "confidence": "high"},
			"rentEstimate": map[string]any{"mid": 1450},
			"salesHistory": []any{
				map[string]any{"date": "2018-05-01", "price": 1650000, "agency": "Ray White Bondi", "type": "Private Treaty"},
				map[string]any{"date": "2009-03-14", "price": 980000, "type": "Auction"},
			},
		}}},
	}
	b, _ := json.Marshal(payload)
	return `<html><body><script id="__NEXT_DATA__" type="application/json">` + string(b) + `</script></body></html>`
}

// propertyDoubleStringifiedHTML wraps a profile object in a REA-family
// double-stringified window.* cache (a JSON string inside a JSON string), which the
// walk must transparently descend — proving the property crawl inherits the same
// resilience the REA listing crawl needs.
func propertyDoubleStringifiedHTML(profile map[string]any) string {
	inner, _ := json.Marshal(map[string]any{"data": mustJSON(profile)})               // query result: {"data":"<profile>"}
	cache, _ := json.Marshal(map[string]any{"propertyResolver:12345": string(inner)}) // cache keyed by query
	blob, _ := json.Marshal(map[string]any{"clientCache": string(cache)})             // window state
	return `<html><body><script>window.__PROPERTY_STATE__ = ` + string(blob) + `;</script></body></html>`
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func TestExtractProperty_NextDataAllFields(t *testing.T) {
	p, ok := extractPropertyProfile(propertyNextDataHTML())
	if !ok {
		t.Fatal("expected a recognizable property.com.au profile payload")
	}
	if p.EstimateLow == nil || *p.EstimateLow != 2100000 {
		t.Errorf("estimate_low = %v, want 2100000", p.EstimateLow)
	}
	if p.EstimateMid == nil || *p.EstimateMid != 2350000 {
		t.Errorf("estimate_mid = %v, want 2350000", p.EstimateMid)
	}
	if p.EstimateHigh == nil || *p.EstimateHigh != 2600000 {
		t.Errorf("estimate_high = %v, want 2600000", p.EstimateHigh)
	}
	if p.EstimateConfidence != "high" {
		t.Errorf("estimate_confidence = %q, want high", p.EstimateConfidence)
	}
	if p.RentEstimateMid == nil || *p.RentEstimateMid != 1450 {
		t.Errorf("rent_estimate_mid = %v, want 1450", p.RentEstimateMid)
	}
	if p.Bedrooms == nil || *p.Bedrooms != 3 {
		t.Errorf("bedrooms = %v, want 3", p.Bedrooms)
	}
	if p.Bathrooms == nil || *p.Bathrooms != 2 {
		t.Errorf("bathrooms = %v, want 2", p.Bathrooms)
	}
	if p.CarSpaces == nil || *p.CarSpaces != 1 {
		t.Errorf("car_spaces = %v, want 1", p.CarSpaces)
	}
	if p.LandSizeSqm == nil || *p.LandSizeSqm != 610 {
		t.Errorf("land = %v, want 610", p.LandSizeSqm)
	}
	if p.BuildingSizeSqm == nil || *p.BuildingSizeSqm != 220 {
		t.Errorf("building = %v, want 220", p.BuildingSizeSqm)
	}
	if p.YearBuilt == nil || *p.YearBuilt != 1998 {
		t.Errorf("year_built = %v, want 1998", p.YearBuilt)
	}
	if p.PropertyType != "House" {
		t.Errorf("property_type = %q", p.PropertyType)
	}
	if p.Lat == nil || p.Lng == nil || *p.Lat != -33.891 || *p.Lng != 151.276 {
		t.Errorf("geo = %v,%v", p.Lat, p.Lng)
	}
	if len(p.SalesHistory) != 2 {
		t.Fatalf("sales_history = %v, want 2 entries", p.SalesHistory)
	}
	if p.SalesHistory[0].Date != "2018-05-01" || p.SalesHistory[0].Price == nil || *p.SalesHistory[0].Price != 1650000 {
		t.Errorf("sales[0] = %+v", p.SalesHistory[0])
	}
	if p.SalesHistory[0].Agency != "Ray White Bondi" || p.SalesHistory[0].Type != "Private Treaty" {
		t.Errorf("sales[0] agency/type = %q/%q", p.SalesHistory[0].Agency, p.SalesHistory[0].Type)
	}
	// raw must be valid JSON carrying the recognized fields (feeds the JSONB column +
	// content hash).
	var raw map[string]any
	if err := json.Unmarshal([]byte(p.Raw), &raw); err != nil {
		t.Fatalf("raw is not valid JSON: %v (%s)", err, p.Raw)
	}
	if raw["estimate_mid"] == nil || raw["property_type"] != "House" {
		t.Errorf("raw missing recognized fields: %v", raw)
	}
	if raw["sales_history"] == nil {
		t.Errorf("raw missing sales_history: %v", raw)
	}
}

func TestExtractProperty_DoubleStringified(t *testing.T) {
	profile := map[string]any{
		"address":      map[string]any{"suburb": "New Farm", "state": "QLD", "postcode": "4005"},
		"propertyType": "House",
		"estimate":     map[string]any{"lower": 1800000, "estimate": 1950000, "upper": 2100000},
		"salesHistory": []any{map[string]any{"date": "2021-11-02", "price": 1725000}},
		"landSize":     405,
	}
	p, ok := extractPropertyProfile(propertyDoubleStringifiedHTML(profile))
	if !ok {
		t.Fatal("expected the double-stringified property profile to be recognized")
	}
	if p.EstimateLow == nil || *p.EstimateLow != 1800000 {
		t.Errorf("estimate_low = %v, want 1800000 (from alias 'lower')", p.EstimateLow)
	}
	if p.EstimateMid == nil || *p.EstimateMid != 1950000 {
		t.Errorf("estimate_mid = %v, want 1950000 (from alias 'estimate')", p.EstimateMid)
	}
	if p.EstimateHigh == nil || *p.EstimateHigh != 2100000 {
		t.Errorf("estimate_high = %v, want 2100000 (from alias 'upper')", p.EstimateHigh)
	}
	if p.LandSizeSqm == nil || *p.LandSizeSqm != 405 {
		t.Errorf("land = %v, want 405", p.LandSizeSqm)
	}
	if len(p.SalesHistory) != 1 || p.SalesHistory[0].Price == nil || *p.SalesHistory[0].Price != 1725000 {
		t.Errorf("sales_history = %+v", p.SalesHistory)
	}
}

func TestExtractProperty_MissingFieldsTolerant(t *testing.T) {
	// A minimal profile object: an address + a property type + a single sale, every
	// estimate/attribute absent. Must still be recognized with only what's present.
	html := `<html><body><script id="__NEXT_DATA__" type="application/json">` +
		`{"props":{"pageProps":{"property":{"address":{"suburb":"Glenelg"},"propertyType":"Unit","salesHistory":[{"date":"2020-01-01","price":540000}]}}}}` +
		`</script></body></html>`
	p, ok := extractPropertyProfile(html)
	if !ok {
		t.Fatal("a minimal address+type+sale object should still be recognized")
	}
	if p.PropertyType != "Unit" {
		t.Errorf("property_type = %q", p.PropertyType)
	}
	if len(p.SalesHistory) != 1 {
		t.Errorf("sales_history = %v, want 1", p.SalesHistory)
	}
	if p.EstimateMid != nil || p.EstimateLow != nil || p.Bedrooms != nil || p.LandSizeSqm != nil || p.YearBuilt != nil {
		t.Errorf("absent fields should be nil: %+v", p)
	}
	if p.Raw == "" {
		t.Error("raw should never be empty")
	}
}

func TestExtractProperty_EstimateOnly(t *testing.T) {
	// The AVM estimate ALONE (no address block) is enough to recognize a profile —
	// it's this tier's whole reason to exist.
	html := `<html><body><script id="__NEXT_DATA__" type="application/json">` +
		`{"props":{"pageProps":{"valuation":{"estimate":{"low":700000,"mid":760000,"high":820000,"confidence":"medium"}}}}}` +
		`</script></body></html>`
	p, ok := extractPropertyProfile(html)
	if !ok {
		t.Fatal("an estimate-only object should be recognized")
	}
	if p.EstimateMid == nil || *p.EstimateMid != 760000 || p.EstimateConfidence != "medium" {
		t.Errorf("estimate = %v conf=%q", p.EstimateMid, p.EstimateConfidence)
	}
}

func TestExtractProperty_NoPayload(t *testing.T) {
	for _, html := range []string{
		"<html><body><p>Access Denied</p></body></html>",
		"<html><body></body></html>",
		`<html><body><script>window.foo = {"unrelated":true,"nav":["home","about"]};</script></body></html>`,
	} {
		if p, ok := extractPropertyProfile(html); ok {
			t.Errorf("expected ok=false for %q, got %+v", html, p)
		}
	}
}

func TestHarvestYearBuilt_Bounds(t *testing.T) {
	// Numbers are passed as float64 because that's what encoding/json produces for
	// every JSON number (the only way this helper is fed in production); a string
	// year exercises the numeric-string path.
	cases := []struct {
		in   any
		want int16
		ok   bool
	}{
		{float64(1998), 1998, true},
		{"1975", 1975, true},
		{float64(1700), 0, false}, // implausibly old
		{float64(3000), 0, false}, // implausibly future
		{float64(0), 0, false},
	}
	for _, c := range cases {
		got := harvestYearBuilt([]map[string]any{{"yearbuilt": c.in}})
		if c.ok {
			if got == nil || *got != c.want {
				t.Errorf("harvestYearBuilt(%v) = %v, want %d", c.in, got, c.want)
			}
		} else if got != nil {
			t.Errorf("harvestYearBuilt(%v) = %v, want nil", c.in, *got)
		}
	}
}

func TestHarvestSalesHistory_WrappedArray(t *testing.T) {
	// A sales history nested one level under a {sales:[...]} wrapper object must still
	// be found (salesArrayOf descends one level).
	// soldPrice is float64 (as encoding/json delivers every JSON number).
	lm := map[string]any{"propertyhistory": map[string]any{"sales": []any{
		map[string]any{"soldDate": "2022-06-01", "soldPrice": float64(900000)},
		map[string]any{"date": "no-price-entry"}, // date only, still kept
		map[string]any{"agency": "orphan"},       // neither date nor price → dropped
	}}}
	got := harvestSalesHistory(lm)
	if len(got) != 2 {
		t.Fatalf("sales = %+v, want 2 (the agency-only entry dropped)", got)
	}
	if got[0].Price == nil || *got[0].Price != 900000 || got[0].Date != "2022-06-01" {
		t.Errorf("sales[0] = %+v (soldDate/soldPrice aliases)", got[0])
	}
}

// TestExtractProperty_RawSurvivesNulByte is the poison-pill regression (the #333
// bug): a portal free-text field carrying a literal NUL must NOT survive into the
// raw JSON payload — json.Marshal escapes a 0x00 to a 6-char \u0000 escape, which
// Postgres jsonb rejects (22P05), aborting the whole write tx.
func TestExtractProperty_RawSurvivesNulByte(t *testing.T) {
	nulEscape := "\\u0000" // the 6-char sequence json.Marshal emits for a 0x00
	payload := map[string]any{
		"props": map[string]any{"pageProps": map[string]any{"property": map[string]any{
			"address":      map[string]any{"suburb": "Bondi"},
			"propertyType": "Ho\x00use", // NUL in a free-text field
			"estimate":     map[string]any{"mid": 800000},
			"salesHistory": []any{map[string]any{"date": "2020-01-01", "price": 500000, "agency": "Bad\x00Agency"}},
		}}},
	}
	b, _ := json.Marshal(payload)
	html := `<html><body><script id="__NEXT_DATA__" type="application/json">` + string(b) + `</script></body></html>`

	p, ok := extractPropertyProfile(html)
	if !ok {
		t.Fatal("expected the profile to be recognized")
	}
	if strings.ContainsRune(p.PropertyType, 0) || p.PropertyType != "House" {
		t.Errorf("property_type = %q, want the NUL stripped", p.PropertyType)
	}
	if strings.ContainsRune(p.Raw, 0) {
		t.Errorf("raw contains a literal NUL byte: %q", p.Raw)
	}
	if strings.Contains(p.Raw, nulEscape) {
		t.Errorf("raw contains a \\u0000 escape (jsonb 22P05): %q", p.Raw)
	}
	// The sales_history free-text (agency) must be clean too — it rides its own JSONB
	// column and is stripped at store time, but harvest cleans it up front.
	if len(p.SalesHistory) != 1 || strings.ContainsRune(p.SalesHistory[0].Agency, 0) {
		t.Errorf("sales agency still has a NUL: %+v", p.SalesHistory)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(p.Raw), &m); err != nil {
		t.Fatalf("raw is not valid JSON: %v (%s)", err, p.Raw)
	}
}
