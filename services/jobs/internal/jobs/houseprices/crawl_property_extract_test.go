package houseprices

import (
	"encoding/json"
	"strings"
	"testing"
)

// These fixtures are SYNTHETIC — invented values, no data copied from any captured
// page — but they mirror the STRUCTURE the extractor was verified against: the data
// ships in window.ArgonautExchange → URQL_CACHE as DOUBLE-stringified JSON (a JSON
// string inside a JSON string), the AVM+attributes sit in a flat snake_case
// tracking.propertyContext.data object, geo is propertyMap.coordinates, and sales
// history is timelineV4 events (badgeV3.text / titleV2 / details). They lock in the
// tolerant walk + the real key paths.

// propertyArgonautHTML wraps a propertyPageBySlugV3 profile in the ArgonautExchange
// → URQL_CACHE → data double-stringified chain.
func propertyArgonautHTML(profile map[string]any) string {
	data, _ := json.Marshal(map[string]any{"propertyPageBySlugV3": profile})                                // {"propertyPageBySlugV3":{...}}
	cache, _ := json.Marshal(map[string]any{"100": map[string]any{"hasNext": false, "data": string(data)}}) // data is a STRING
	arg, _ := json.Marshal(map[string]any{"property-com-au_pca-property-mfe": map[string]any{"URQL_CACHE": string(cache)}})
	return `<html><body><script>window.ArgonautExchange=` + string(arg) + `;</script></body></html>`
}

// sampleProfile is a fully-synthetic profile in the confirmed tracking/timeline/
// propertyMap layout (invented numbers/addresses).
func sampleProfile() map[string]any {
	return map[string]any{
		"__typename": "PropertyPage_Page",
		"id":         "100000",
		"tracking": map[string]any{"propertyContext": map[string]any{"data": map[string]any{
			"__typename":            "TrackingData_PropertyContext_Data",
			"state":                 "VIC",
			"suburb":                "Sampleton",
			"postcode":              "3999",
			"bedrooms":              4,
			"bathrooms":             2,
			"car_spaces":            1,
			"year_built":            nil,
			"property_type":         "house",
			"land_size_sq_metres":   500,
			"floor_area":            nil,
			"avm_estimated_value":   1350000,
			"avm_low_range":         1200000,
			"avm_high_range":        1500000,
			"avm_confidence":        "HIGH",
			"avm_last_updated_date": "2026-01-15",
		}}},
		"propertyMap": map[string]any{"coordinates": map[string]any{"latitude": -33.5, "longitude": 150.5, "__typename": "Point"}},
		"timelineV4": map[string]any{"eventGroups": []any{map[string]any{"events": []any{
			map[string]any{"__typename": "PropertyPage_TimelineEvent", "badgeV3": map[string]any{"text": "Sold"}, "titleV2": "$1,350,000", "details": "6 Mar 2024 by Sample Realty  - Test Region"},
			map[string]any{"__typename": "PropertyPage_TimelineEvent", "badgeV3": map[string]any{"text": "Listed for sale"}, "titleV2": nil, "details": nil},
			map[string]any{"__typename": "PropertyPage_TimelineEvent", "badgeV3": map[string]any{"text": "Sold"}, "titleV2": "$980,000", "details": "Sold 2 Feb 2015"},
		}}}},
	}
}

func TestExtractProperty_RealShapeAllFields(t *testing.T) {
	p, ok := extractPropertyProfile(propertyArgonautHTML(sampleProfile()))
	if !ok {
		t.Fatal("expected a recognizable property.com.au profile payload")
	}
	if p.EstimateLow == nil || *p.EstimateLow != 1200000 {
		t.Errorf("estimate_low = %v, want 1200000 (avm_low_range)", p.EstimateLow)
	}
	if p.EstimateMid == nil || *p.EstimateMid != 1350000 {
		t.Errorf("estimate_mid = %v, want 1350000 (avm_estimated_value)", p.EstimateMid)
	}
	if p.EstimateHigh == nil || *p.EstimateHigh != 1500000 {
		t.Errorf("estimate_high = %v, want 1500000 (avm_high_range)", p.EstimateHigh)
	}
	if p.EstimateConfidence != "high" { // lowercased from "HIGH"
		t.Errorf("estimate_confidence = %q, want high", p.EstimateConfidence)
	}
	if p.Bedrooms == nil || *p.Bedrooms != 4 || p.Bathrooms == nil || *p.Bathrooms != 2 || p.CarSpaces == nil || *p.CarSpaces != 1 {
		t.Errorf("beds/baths/car = %v/%v/%v", p.Bedrooms, p.Bathrooms, p.CarSpaces)
	}
	if p.LandSizeSqm == nil || *p.LandSizeSqm != 500 { // land_size_sq_metres
		t.Errorf("land = %v, want 500", p.LandSizeSqm)
	}
	if p.YearBuilt != nil { // year_built is null in the fixture
		t.Errorf("year_built = %v, want nil", *p.YearBuilt)
	}
	if p.PropertyType != "house" {
		t.Errorf("property_type = %q", p.PropertyType)
	}
	if p.Lat == nil || p.Lng == nil || *p.Lat != -33.5 || *p.Lng != 150.5 { // from propertyMap.coordinates
		t.Errorf("geo = %v,%v", p.Lat, p.Lng)
	}
	// Timeline → sales: 2 Sold + 1 "Listed for sale" (type only) = 3.
	if len(p.SalesHistory) != 3 {
		t.Fatalf("sales_history = %d entries, want 3: %+v", len(p.SalesHistory), p.SalesHistory)
	}
	if p.SalesHistory[0].Type != "Sold" || p.SalesHistory[0].Date != "2024-03-06" || p.SalesHistory[0].Price == nil || *p.SalesHistory[0].Price != 1350000 {
		t.Errorf("sale[0] = %+v (want Sold 2024-03-06 $1,350,000)", p.SalesHistory[0])
	}
	if p.SalesHistory[0].Agency != "Sample Realty - Test Region" { // doubled space collapsed
		t.Errorf("sale[0] agency = %q", p.SalesHistory[0].Agency)
	}
	if p.SalesHistory[2].Type != "Sold" || p.SalesHistory[2].Date != "2015-02-02" || p.SalesHistory[2].Price == nil || *p.SalesHistory[2].Price != 980000 {
		t.Errorf("sale[2] = %+v (want Sold 2015-02-02 $980,000)", p.SalesHistory[2])
	}
	// raw must be valid JSON carrying the recognized fields.
	var raw map[string]any
	if err := json.Unmarshal([]byte(p.Raw), &raw); err != nil {
		t.Fatalf("raw is not valid JSON: %v (%s)", err, p.Raw)
	}
	if raw["estimate_mid"] == nil || raw["property_type"] != "house" || raw["sales_history"] == nil {
		t.Errorf("raw missing recognized fields: %v", raw)
	}
}

func TestExtractProperty_ThinProfileNoAVM(t *testing.T) {
	// A property_type + attributes with NO avm block must still be recognized (a
	// profile that has no estimate yet).
	profile := map[string]any{
		"tracking": map[string]any{"propertyContext": map[string]any{"data": map[string]any{
			"property_type": "unit", "bedrooms": 2, "bathrooms": 1,
		}}},
	}
	p, ok := extractPropertyProfile(propertyArgonautHTML(profile))
	if !ok {
		t.Fatal("a thin attributes-only profile should be recognized")
	}
	if p.PropertyType != "unit" || p.Bedrooms == nil || *p.Bedrooms != 2 {
		t.Errorf("thin profile = %+v", p)
	}
	if p.EstimateMid != nil || len(p.SalesHistory) != 0 || p.Lat != nil {
		t.Errorf("absent fields should be nil/empty: %+v", p)
	}
}

func TestExtractProperty_TimelineOnly(t *testing.T) {
	// Only a timeline (no AVM/attribute object) is still a recognizable payload.
	profile := map[string]any{
		"timelineV4": map[string]any{"eventGroups": []any{map[string]any{"events": []any{
			map[string]any{"__typename": "PropertyPage_TimelineEvent", "badgeV3": map[string]any{"text": "Sold"}, "titleV2": "$900,000", "details": "1 Feb 2020"},
		}}}},
	}
	p, ok := extractPropertyProfile(propertyArgonautHTML(profile))
	if !ok {
		t.Fatal("a timeline-only payload should be recognized")
	}
	if len(p.SalesHistory) != 1 || p.SalesHistory[0].Price == nil || *p.SalesHistory[0].Price != 900000 {
		t.Errorf("sales = %+v", p.SalesHistory)
	}
	if p.EstimateMid != nil {
		t.Errorf("no AVM expected: %v", *p.EstimateMid)
	}
}

func TestExtractProperty_NoPayload(t *testing.T) {
	// A 404 page carries no ArgonautExchange / avm_* — these stand in.
	for _, html := range []string{
		"<html><body><h1>Page not found</h1></body></html>",
		"<html><body></body></html>",
		`<html><body><script>window.foo={"nav":["home","about"],"unrelated":true};</script></body></html>`,
	} {
		if p, ok := extractPropertyProfile(html); ok {
			t.Errorf("expected ok=false for %q, got %+v", html, p)
		}
	}
}

// TestExtractProperty_RawSurvivesNulByte is the poison-pill regression (#333): a
// portal free-text field carrying a literal NUL must NOT survive into the raw JSON —
// json.Marshal escapes a 0x00 to a 6-char backslash-u-0000, which Postgres jsonb
// rejects (22P05), aborting the whole write tx.
func TestExtractProperty_RawSurvivesNulByte(t *testing.T) {
	nulEscape := "\\u0000"
	profile := map[string]any{
		"tracking": map[string]any{"propertyContext": map[string]any{"data": map[string]any{
			"property_type": "hou\x00se", "bedrooms": 3, "avm_estimated_value": 800000,
		}}},
		"timelineV4": map[string]any{"eventGroups": []any{map[string]any{"events": []any{
			map[string]any{"__typename": "PropertyPage_TimelineEvent", "badgeV3": map[string]any{"text": "Sold"}, "titleV2": "$800,000", "details": "1 Jan 2020 by Bad\x00Agency"},
		}}}},
	}
	p, ok := extractPropertyProfile(propertyArgonautHTML(profile))
	if !ok {
		t.Fatal("expected the profile to be recognized")
	}
	if strings.ContainsRune(p.PropertyType, 0) || p.PropertyType != "house" {
		t.Errorf("property_type = %q, want the NUL stripped", p.PropertyType)
	}
	if strings.ContainsRune(p.Raw, 0) || strings.Contains(p.Raw, nulEscape) {
		t.Errorf("raw carries a NUL / backslash-u-0000 (jsonb 22P05): %q", p.Raw)
	}
	if len(p.SalesHistory) != 1 || strings.ContainsRune(p.SalesHistory[0].Agency, 0) {
		t.Errorf("sale agency still has a NUL: %+v", p.SalesHistory)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(p.Raw), &m); err != nil {
		t.Fatalf("raw is not valid JSON: %v (%s)", err, p.Raw)
	}
}

func TestEventsToSales_ParsingAndDedup(t *testing.T) {
	events := []map[string]any{
		lowerKeys(map[string]any{"badgeV3": map[string]any{"text": "Sold"}, "titleV2": "$1,200,000", "details": "6 Jun 2024 by Sample  Realty"}),
		lowerKeys(map[string]any{"badgeV3": map[string]any{"text": "Sold"}, "titleV2": "$1,200,000", "details": "6 Jun 2024 by Sample  Realty"}), // dup — collapsed
		lowerKeys(map[string]any{"badgeV3": map[string]any{"text": "For rent"}, "titleV2": "$1,200 per week", "details": "Listed 13 Jul 2024"}),
		lowerKeys(map[string]any{"badgeV3": map[string]any{"text": "Listed for sale"}, "titleV2": nil, "details": nil}), // type only, kept
	}
	got := eventsToSales(events)
	if len(got) != 3 {
		t.Fatalf("sales = %d, want 3 (one dup collapsed): %+v", len(got), got)
	}
	if got[0].Date != "2024-06-06" || got[0].Price == nil || *got[0].Price != 1200000 || got[0].Agency != "Sample Realty" {
		t.Errorf("sale[0] = %+v", got[0])
	}
	if got[1].Type != "For rent" || got[1].Price == nil || *got[1].Price != 1200 || got[1].Date != "2024-07-13" {
		t.Errorf("sale[1] (rent) = %+v", got[1])
	}
}

func TestParseEventDate(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"6 Jun 2024 by Sample", "2024-06-06"},
		{"Sold 7 Aug 2018", "2018-08-07"},
		{"Listed 13 July 2024 by X", "2024-07-13"},
		{"no date here", ""},
		{"", ""},
	}
	for _, c := range cases {
		if got := parseEventDate(c.in); got != c.want {
			t.Errorf("parseEventDate(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestParseDollarNumber(t *testing.T) {
	cases := []struct {
		in   string
		want float64
		ok   bool
	}{
		{"$2,340,000", 2340000, true},
		{"$1,200 per week", 1200, true},
		{"Contact agent", 0, false},
		{"", 0, false},
	}
	for _, c := range cases {
		got, ok := parseDollarNumber(c.in)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("parseDollarNumber(%q) = %v,%v want %v,%v", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestHarvestYearBuilt_Bounds(t *testing.T) {
	// Numbers are float64 (as encoding/json delivers every JSON number).
	cases := []struct {
		in   any
		want int16
		ok   bool
	}{
		{float64(1998), 1998, true},
		{"1975", 1975, true},
		{float64(1700), 0, false},
		{float64(3000), 0, false},
		{nil, 0, false},
	}
	for _, c := range cases {
		got := harvestYearBuilt([]map[string]any{{"year_built": c.in}})
		if c.ok {
			if got == nil || *got != c.want {
				t.Errorf("harvestYearBuilt(%v) = %v, want %d", c.in, got, c.want)
			}
		} else if got != nil {
			t.Errorf("harvestYearBuilt(%v) = %v, want nil", c.in, *got)
		}
	}
}
