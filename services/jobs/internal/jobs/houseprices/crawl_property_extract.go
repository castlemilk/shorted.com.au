package houseprices

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
)

// Per-ADDRESS property-profile extraction for property.com.au (REA Group's
// address-research portal: AVM estimate + sales history + attributes + year built).
//
// REVERSE-ENGINEERED against a captured profile (Phase-0 live probe): there is NO
// __NEXT_DATA__. The property data ships in `window.ArgonautExchange` (the SAME
// container realestate.com.au uses) under URQL_CACHE as a DOUBLE/TRIPLE-stringified
// JSON string (a JSON string inside a JSON string), which our schema-agnostic walk
// descends transparently (walkForProperty, like walkForListingsDepth). The confirmed
// KEY PATHS (snake_case!) — shapes only, no captured values reproduced here:
//
//   - The flat AVM + attributes block is tracking.propertyContext.data
//     (__typename "TrackingData_PropertyContext_Data"), carrying the keys:
//       bedrooms, bathrooms, car_spaces, year_built, property_type,
//       land_size_sq_metres, floor_area, avm_estimated_value (mid), avm_low_range,
//       avm_high_range, avm_confidence, avm_last_updated_date
//   - Geo is propertyMap.coordinates {latitude, longitude, __typename:"Point"} —
//     NOT on the tracking object, so it is harvested from the propertyMap wrapper
//     (deterministic; the page carries many neighbour coordinates, so we never grab
//     "the first lat/lng we see").
//   - Sales history is timelineV4 events (__typename "PropertyPage_TimelineEvent"),
//     each {badgeV3:{text}, titleV2, details} — type from badgeV3.text, price from
//     the titleV2 "$" figure, date+agency parsed from the details string.
//
// Every field is optional; ok is false only when NO recognizable property payload
// (neither a data object nor a timeline event) is present — which is exactly the
// case on a 404 page (no ArgonautExchange, no avm_*), so a not-found page correctly
// extracts nothing.

// saleRecord is one entry in a property's sales/timeline history. Pointer Price is
// nil when the event carries no dollar figure (e.g. a bare "Listed for sale"). json
// tags are lower snake_case so the marshaled sales_history JSONB reads cleanly.
type saleRecord struct {
	Date   string   `json:"date,omitempty"`
	Price  *float64 `json:"price,omitempty"`
	Agency string   `json:"agency,omitempty"`
	Type   string   `json:"type,omitempty"`
}

// propertyProfile is one address's harvested profile fields, before persistence.
// Pointer fields are nil when absent. Raw is the JSON serialization of exactly the
// fields we recognized (never the whole page — that would store proprietary bulk);
// it feeds the raw JSONB column and the content hash.
type propertyProfile struct {
	EstimateLow, EstimateMid, EstimateHigh *float64
	EstimateConfidence                     string
	RentEstimateMid                        *float64
	Bedrooms, Bathrooms, CarSpaces         *int16
	LandSizeSqm, BuildingSizeSqm           *float64
	YearBuilt                              *int16
	PropertyType                           string
	Lat, Lng                               *float64
	SalesHistory                           []saleRecord
	Raw                                    string // JSON of the recognized fields; "{}" when nothing harvested
}

// Real snake_case key aliases (confirmed against the captured profile). Extra
// aliases are defensive fallbacks against shape drift; the FIRST in each list is the
// confirmed live key.
var (
	avmLowKeys    = []string{"avm_low_range", "avm_low", "low_range"}
	avmMidKeys    = []string{"avm_estimated_value", "avm_mid", "estimated_value", "avm_value"}
	avmHighKeys   = []string{"avm_high_range", "avm_high", "high_range"}
	avmConfKeys   = []string{"avm_confidence", "confidence"}
	landKeys      = []string{"land_size_sq_metres", "land_size_sqm", "land_size", "land_area"}
	floorKeys     = []string{"floor_area", "building_size_sqm", "building_size", "floor_size", "internal_area"}
	propTypeKeys  = []string{"property_type", "property_type_formatted", "dwelling_type"}
	bedroomKeys   = []string{"bedrooms", "beds", "num_bedrooms"}
	bathroomKeys  = []string{"bathrooms", "baths", "num_bathrooms"}
	carSpaceKeys  = []string{"car_spaces", "parking", "car_spots", "garages"}
	yearBuiltKeys = []string{"year_built", "built_year", "year_constructed", "construction_year"}
)

// propertyScan accumulates the three distinct things the profile page carries in
// three distinct places: the flat AVM+attribute object(s), the timeline events, and
// the subject geo (from propertyMap). Filled by walkForProperty in one pass.
type propertyScan struct {
	dataCands []map[string]any
	events    []map[string]any
	lat, lng  *float64
}

// extractPropertyProfile walks every <script> JSON blob (including the
// ArgonautExchange/URQL_CACHE double-stringified chain), picks the richest AVM/
// attribute object, and attaches the timeline sales history + subject geo. Returns
// ok=false only when NO recognizable property payload was found (an anti-bot stub, a
// 404 page, or an unrelated blob).
func extractPropertyProfile(html string) (propertyProfile, bool) {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(html))
	if err != nil {
		return propertyProfile{}, false
	}
	scan := &propertyScan{}
	doc.Find("script").Each(func(_ int, s *goquery.Selection) {
		for _, blob := range jsonBlobs(s.Text()) {
			var v any
			if json.Unmarshal([]byte(blob), &v) != nil {
				continue
			}
			walkForProperty(v, scan, 0)
		}
	})
	if len(scan.dataCands) == 0 && len(scan.events) == 0 {
		return propertyProfile{}, false
	}
	var best map[string]any
	if len(scan.dataCands) > 0 {
		best = scan.dataCands[0]
		bestScore := propertyDataScore(best)
		for _, c := range scan.dataCands[1:] {
			if sc := propertyDataScore(c); sc > bestScore {
				best, bestScore = c, sc
			}
		}
	}
	return harvestProperty(best, scan), true
}

// walkForProperty recurses through maps, arrays, AND stringified-JSON string values
// (the ArgonautExchange → URQL_CACHE → data chain is stringified JSON inside
// stringified JSON), filling the scan: AVM/attribute candidates, timeline events,
// and the subject geo (taken deterministically from a propertyMap wrapper, never the
// first stray coordinate — the page carries neighbour coordinates too).
func walkForProperty(v any, scan *propertyScan, depth int) {
	if depth > 40 {
		return
	}
	switch t := v.(type) {
	case map[string]any:
		lm := lowerKeys(t)
		if isPropertyDataObject(lm) {
			scan.dataCands = append(scan.dataCands, lm)
		}
		if isTimelineEvent(lm) {
			scan.events = append(scan.events, lm)
		}
		if scan.lat == nil {
			if pm := childMap(lm, "propertymap", "map", "property_location"); pm != nil {
				if lat, lng, ok := firstAUGeo(pm, 0); ok {
					scan.lat, scan.lng = f64p(lat), f64p(lng)
				}
			}
		}
		for _, child := range t {
			walkForProperty(child, scan, depth+1)
		}
	case []any:
		for _, child := range t {
			walkForProperty(child, scan, depth+1)
		}
	case string:
		if s := strings.TrimSpace(t); len(s) > 2 && (s[0] == '{' || s[0] == '[') {
			var inner any
			if json.Unmarshal([]byte(s), &inner) == nil {
				walkForProperty(inner, scan, depth+1)
			}
		}
	}
}

// isPropertyDataObject reports whether a lowercased map is the flat AVM+attributes
// block. An AVM key is the defining signal; failing that, a property_type plus a
// bed/bath/car count also qualifies (a thin profile with no AVM yet).
func isPropertyDataObject(lm map[string]any) bool {
	if anyKey(lm, "avm_estimated_value", "avm_low_range", "avm_high_range") {
		return true
	}
	if anyKey(lm, "land_size_sq_metres") {
		return true
	}
	return anyKey(lm, propTypeKeys...) && anyKey(lm, "bedrooms", "bathrooms", "car_spaces")
}

// isTimelineEvent reports whether a lowercased map is a single timeline/sales event.
// The __typename is the surest signal; a badgeV3+titleV2/details pair is the
// shape-drift fallback.
func isTimelineEvent(lm map[string]any) bool {
	if tn, ok := lm["__typename"].(string); ok && strings.EqualFold(tn, "PropertyPage_TimelineEvent") {
		return true
	}
	return anyKey(lm, "badgev3") && anyKey(lm, "titlev2", "details")
}

// propertyDataScore ranks AVM/attribute candidates so the subject property's block
// (which carries the full AVM range + every attribute) outranks any thinner
// neighbour object on the page.
func propertyDataScore(lm map[string]any) int {
	n := 0
	for _, k := range []string{
		"avm_estimated_value", "avm_low_range", "avm_high_range", "avm_confidence",
		"avm_last_updated_date", "bedrooms", "bathrooms", "car_spaces", "year_built",
		"property_type", "land_size_sq_metres", "floor_area",
	} {
		if _, ok := lm[k]; ok {
			n++
		}
	}
	return n
}

// harvestProperty pulls every profile field out of the chosen AVM/attribute object
// (best; may be nil when only timeline/geo was found) plus the scan's timeline events
// and subject geo, building both the typed record and the raw JSON of exactly what
// was recognized. All fields best-effort/optional. Every FREE-TEXT value is
// cleanText'd at harvest time so the raw JSON is built from CLEANED values — a stray
// NUL/lone-surrogate from the portal would otherwise survive into the raw JSONB
// column (json.Marshal escapes a 0x00 to a \u0000 escape, which Postgres jsonb
// REJECTS with 22P05, aborting the whole write tx). See also
// upsertPropertyValuation's belt-and-braces guard.
func harvestProperty(best map[string]any, scan *propertyScan) propertyProfile {
	var p propertyProfile
	raw := map[string]any{}

	if best != nil {
		maps := gatherMaps(best)
		if lo, ok := firstFloat(maps, avmLowKeys...); ok && lo > 0 {
			p.EstimateLow = f64p(lo)
			raw["estimate_low"] = lo
		}
		if mid, ok := firstFloat(maps, avmMidKeys...); ok && mid > 0 {
			p.EstimateMid = f64p(mid)
			raw["estimate_mid"] = mid
		}
		if hi, ok := firstFloat(maps, avmHighKeys...); ok && hi > 0 {
			p.EstimateHigh = f64p(hi)
			raw["estimate_high"] = hi
		}
		if c := cleanText(strings.ToLower(firstStr(maps, avmConfKeys...))); c != "" {
			p.EstimateConfidence = c
			raw["estimate_confidence"] = c
		}
		if p.Bedrooms = firstInt16(maps, 0, 60, bedroomKeys...); p.Bedrooms != nil {
			raw["bedrooms"] = *p.Bedrooms
		}
		if p.Bathrooms = firstInt16(maps, 0, 60, bathroomKeys...); p.Bathrooms != nil {
			raw["bathrooms"] = *p.Bathrooms
		}
		if p.CarSpaces = firstInt16(maps, 0, 60, carSpaceKeys...); p.CarSpaces != nil {
			raw["car_spaces"] = *p.CarSpaces
		}
		if v, ok := firstFloat(maps, landKeys...); ok && v > 0 {
			p.LandSizeSqm = f64p(v)
			raw["land_size_sqm"] = v
		}
		if v, ok := firstFloat(maps, floorKeys...); ok && v > 0 {
			p.BuildingSizeSqm = f64p(v)
			raw["building_size_sqm"] = v
		}
		if v := harvestYearBuilt(maps); v != nil {
			p.YearBuilt = v
			raw["year_built"] = *v
		}
		if pt := cleanText(strings.TrimSpace(firstStr(maps, propTypeKeys...))); pt != "" {
			p.PropertyType = pt
			raw["property_type"] = pt
		}
	}

	if scan != nil && scan.lat != nil && scan.lng != nil {
		p.Lat, p.Lng = scan.lat, scan.lng
		raw["latitude"], raw["longitude"] = *scan.lat, *scan.lng
	}
	if scan != nil {
		if sh := eventsToSales(scan.events); len(sh) > 0 {
			p.SalesHistory = sh
			raw["sales_history"] = sh
		}
	}

	if b, err := json.Marshal(raw); err == nil {
		// Belt-and-braces: even though every free-text value was cleanText'd above,
		// strip any \u0000 escape the marshaler might still emit — Postgres jsonb
		// rejects it (22P05) even as an escape sequence.
		p.Raw = stripJSONNul(string(b))
	} else {
		p.Raw = "{}"
	}
	return p
}

// harvestYearBuilt pulls a construction year and bounds it to a plausible range
// (1800..next year) so a stray numeric field can't land a nonsense year. year_built
// is often null on property.com.au, so nil is the common, expected result.
func harvestYearBuilt(maps []map[string]any) *int16 {
	if f, ok := firstFloat(maps, yearBuiltKeys...); ok {
		y := int(f + 0.5)
		if y >= 1800 && y <= time.Now().UTC().Year()+1 {
			v := int16(y)
			return &v
		}
	}
	return nil
}

// eventDateRe matches a "6 Jun 2026" style date embedded in an event's details.
var eventDateRe = regexp.MustCompile(`(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})`)

// dollarNumberRe matches the leading "$2,340,000" figure in an event title.
var dollarNumberRe = regexp.MustCompile(`\$\s*([\d,]+)`)

var eventDateLayouts = []string{"2 Jan 2006", "02 Jan 2006", "2 January 2006", "02 January 2006"}

// eventsToSales maps timeline events to sale records: type from badgeV3.text, price
// from the titleV2 dollar figure, and date+agency parsed out of the free-text
// details ("6 Jun 2026 by Sample Realty - Test Region"). Deduped on (type,date,price)
// — the ArgonautExchange cache can carry the payload twice.
func eventsToSales(events []map[string]any) []saleRecord {
	var out []saleRecord
	seen := map[string]bool{}
	for _, e := range events {
		var sr saleRecord
		if b := childMap(e, "badgev3"); b != nil {
			sr.Type = cleanText(getStr(b, "text", "label"))
		}
		if pr, ok := parseDollarNumber(getStr(e, "titlev2", "title")); ok {
			sr.Price = f64p(pr)
		}
		details := getStr(e, "details", "subtitle")
		sr.Date = parseEventDate(details)
		sr.Agency = cleanText(parseEventAgency(details))
		if sr.Date == "" && sr.Price == nil && sr.Type == "" {
			continue
		}
		key := sr.Type + "|" + sr.Date + "|"
		if sr.Price != nil {
			key += strconv.FormatFloat(*sr.Price, 'f', 0, 64)
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, sr)
	}
	return out
}

// parseDollarNumber pulls the leading dollar figure out of a title like
// "$2,340,000" or "$1,200 per week". Returns false when there is no figure (e.g. a
// bare "Listed for sale" with a null title).
func parseDollarNumber(s string) (float64, bool) {
	m := dollarNumberRe.FindStringSubmatch(s)
	if m == nil {
		return 0, false
	}
	f, err := strconv.ParseFloat(strings.ReplaceAll(m[1], ",", ""), 64)
	if err != nil || f <= 0 {
		return 0, false
	}
	return f, true
}

// parseEventDate extracts and normalizes the "6 Jun 2026" date from an event's
// details string to an ISO "2006-01-02" date, or "" when none is present.
func parseEventDate(details string) string {
	m := eventDateRe.FindString(details)
	if m == "" {
		return ""
	}
	for _, layout := range eventDateLayouts {
		if tm, err := time.Parse(layout, m); err == nil {
			return tm.Format("2006-01-02")
		}
	}
	return ""
}

// parseEventAgency pulls the agency name out of an event's details ("... by Sample
// Realty  - Test Region" → "Sample Realty - Test Region", the doubled space
// collapsed); "" when the details carry no "by <agency>" clause.
func parseEventAgency(details string) string {
	i := strings.Index(strings.ToLower(details), " by ")
	if i < 0 {
		return ""
	}
	ag := strings.TrimSpace(details[i+4:])
	return strings.Join(strings.Fields(ag), " ") // collapse the doubled spaces
}

// firstAUGeo recursively finds the first object carrying a latitude+longitude pair
// inside the Australian bounding box. Used only on a propertyMap wrapper (the
// subject's map), so it returns the subject property's coordinates, not a
// neighbour's.
func firstAUGeo(v any, depth int) (lat, lng float64, ok bool) {
	if depth > 20 {
		return 0, 0, false
	}
	switch t := v.(type) {
	case map[string]any:
		lm := lowerKeys(t)
		if la, ok1 := firstFloat([]map[string]any{lm}, "latitude", "lat"); ok1 {
			if lo, ok2 := firstFloat([]map[string]any{lm}, "longitude", "lng", "lon", "long"); ok2 &&
				la <= -9 && la >= -45 && lo >= 110 && lo <= 156 {
				return la, lo, true
			}
		}
		for _, child := range t {
			if la, lo, found := firstAUGeo(child, depth+1); found {
				return la, lo, true
			}
		}
	case []any:
		for _, child := range t {
			if la, lo, found := firstAUGeo(child, depth+1); found {
				return la, lo, true
			}
		}
	}
	return 0, 0, false
}
