package main

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
)

// Per-ADDRESS property-profile extraction for property.com.au (REA Group's
// address-research portal: AVM estimate + sales history + attributes + year built).
// Like the listing SRP/LDP harvesters (crawl_listings_extract.go /
// crawl_details_extract.go) this is schema-AGNOSTIC: property.com.au is a
// React/Next.js app that embeds its state in __NEXT_DATA__ (props.pageProps) and/or
// a window.* blob, REA-family sites DOUBLE-STRINGIFY their caches (a JSON string
// inside a JSON string), and the key paths mutate + serve bot-variant DOM. So we
// never bind a selector: we walk every JSON blob on the page (reusing jsonBlobs +
// the walk helpers), keep the object that looks most like a single property
// profile, and harvest each field through case-insensitive alias lists with a
// shallow nested fallback. Every field is optional; ok is false only when NO
// recognizable property-profile payload was found at all.
//
// NOTE (Phase 0): no real property.com.au profile fixture exists yet (Kasada-blocked
// recon) — every alias set + nesting below is EXPECTED-not-verified. The Phase-0
// live probe (10 dry-run fetches, gated until the current SRP drain frees the warm
// Chrome) will confirm/refine the exact blob (__NEXT_DATA__ vs window.*) and key
// paths. The extractor is written tolerant so a shape drift degrades to "fewer
// fields harvested", never a crash or a false ok=false — refining it is a localized
// edit to the alias lists.

// saleRecord is one entry in a property's sales history. Pointer Price is nil when
// the portal shows a non-numeric result (e.g. "Withdrawn"). json tags are lower
// snake_case so the marshaled sales_history JSONB reads cleanly.
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

// Alias sets (case-insensitive, checked in order) — EXPECTED shapes, Phase-0
// probe-verified. Kept as package vars so refining a path after the probe is a
// one-line edit.
var (
	// estimateObjectKeys: the AVM sub-object holding low/mid/high/confidence.
	estimateObjectKeys = []string{
		"estimate", "priceestimate", "propertyvalueestimate", "valuationestimate",
		"avmestimate", "avm", "valuation", "pricevaluation", "estimatedvalue",
		"displayestimate", "propertyestimate", "valueestimate", "priceguide",
	}
	estimateLowKeys  = []string{"low", "lower", "pricelower", "estimatelow", "min", "minimum", "rangelow", "lowerprice", "from", "lowervalue", "confidencelower"}
	estimateMidKeys  = []string{"mid", "middle", "midpoint", "estimate", "price", "value", "estimatedvalue", "midprice", "displayprice", "point", "central"}
	estimateHighKeys = []string{"high", "upper", "priceupper", "estimatehigh", "max", "maximum", "rangehigh", "upperprice", "to", "uppervalue"}
	estimateConfKeys = []string{"confidence", "confidencelevel", "estimateconfidence", "confidencescore", "fsd", "accuracy"}

	// flat estimate fallbacks (when the portal flattens the AVM onto the profile).
	flatEstimateLowKeys  = []string{"estimatelow", "pricelowestimate", "lowestimate", "estimatedvaluelow"}
	flatEstimateMidKeys  = []string{"estimatemid", "estimatedvalue", "displayestimate", "midestimate", "estimatevalue"}
	flatEstimateHighKeys = []string{"estimatehigh", "pricehighestimate", "highestimate", "estimatedvaluehigh"}

	// rentEstimateObjectKeys / rentMidKeys: the weekly rent AVM.
	rentEstimateObjectKeys = []string{"rentestimate", "rentalestimate", "weeklyrentestimate", "rentvaluation", "rentalvaluation"}
	rentMidKeys            = []string{"mid", "value", "amount", "estimate", "weekly", "perweek", "price", "displayprice"}

	yearBuiltKeys = []string{"yearbuilt", "builtyear", "yearconstructed", "constructionyear", "buildyear", "yearofconstruction"}
	propTypeKeys  = []string{"propertytypeformatted", "propertytype", "dwellingtype", "subtype", "propertycategory", "landuse"}
	bedroomKeys   = []string{"bedrooms", "beds", "bed", "numbedrooms"}
	bathroomKeys  = []string{"bathrooms", "baths", "bath", "numbathrooms"}
	carSpaceKeys  = []string{"carspaces", "parking", "carspots", "car", "numcarspaces", "garages", "carports"}

	// salesHistoryKeys: the array (or wrapper object) of prior sale events.
	salesHistoryKeys = []string{"saleshistory", "salehistory", "transactionhistory", "priorsales", "historicalsales", "soldhistory", "propertyhistory", "salesresults", "timeline"}
	saleDateKeys     = []string{"date", "saledate", "solddate", "contractdate", "eventdate", "transactiondate", "settlementdate", "displaydate"}
	salePriceKeys    = []string{"price", "saleprice", "soldprice", "amount", "value", "pricevalue", "salevalue"}
	saleAgencyKeys   = []string{"agency", "agencyname", "agent", "advertiser", "company", "sellingagency", "brand"}
	saleTypeKeys     = []string{"type", "salemethod", "saletype", "method", "category", "eventtype", "channel"}
)

// extractPropertyProfile walks every <script> JSON blob (including REA's
// double-stringified caches), picks the richest property-profile object, and
// harvests its fields. Returns ok=false only when NO recognizable property-profile
// payload was found (an anti-bot stub, an error page, or an unrelated blob).
func extractPropertyProfile(html string) (propertyProfile, bool) {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(html))
	if err != nil {
		return propertyProfile{}, false
	}
	var cands []map[string]any
	doc.Find("script").Each(func(_ int, s *goquery.Selection) {
		for _, blob := range jsonBlobs(s.Text()) {
			var v any
			if json.Unmarshal([]byte(blob), &v) != nil {
				continue
			}
			walkForProperty(v, &cands, 0)
		}
	})
	if len(cands) == 0 {
		return propertyProfile{}, false
	}
	best, bestScore := cands[0], propertyFieldScore(cands[0])
	for _, c := range cands[1:] {
		if sc := propertyFieldScore(c); sc > bestScore {
			best, bestScore = c, sc
		}
	}
	return harvestProperty(best), true
}

// walkForProperty recurses through maps, arrays, AND stringified-JSON string values
// (mirrors walkForListingsDepth / walkForDetail — REA-family sites double-stringify
// their state), collecting every object that looks like a single property profile.
func walkForProperty(v any, cands *[]map[string]any, depth int) {
	if depth > 40 {
		return
	}
	switch t := v.(type) {
	case map[string]any:
		lm := lowerKeys(t)
		if isPropertyCandidate(lm) {
			*cands = append(*cands, lm)
		}
		for _, child := range t {
			walkForProperty(child, cands, depth+1)
		}
	case []any:
		for _, child := range t {
			walkForProperty(child, cands, depth+1)
		}
	case string:
		if s := strings.TrimSpace(t); len(s) > 2 && (s[0] == '{' || s[0] == '[') {
			var inner any
			if json.Unmarshal([]byte(s), &inner) == nil {
				walkForProperty(inner, cands, depth+1)
			}
		}
	}
}

// isPropertyCandidate reports whether a lowercased map looks like a single
// property's research profile. The defining signals are an AVM estimate OR a sales
// history (this tier's whole reason to exist); failing those, an address block plus
// a physical attribute (beds/land/year/type) is enough to recognize a thin profile.
func isPropertyCandidate(lm map[string]any) bool {
	hasEstimate := childMap(lm, estimateObjectKeys...) != nil ||
		anyKey(lm, flatEstimateMidKeys...) || anyKey(lm, flatEstimateLowKeys...) || anyKey(lm, flatEstimateHighKeys...)
	hasSales := salesArrayOf(firstValue(lm, salesHistoryKeys...)) != nil
	hasAddr := childMap(lm, "address") != nil || anyKey(lm, "displayaddress", "streetaddress", "fulladdress")
	hasAttrs := anyKey(lm, "bedrooms", "beds", "bathrooms", "baths", "landsize", "landarea", "yearbuilt", "propertytype")
	if hasEstimate || hasSales {
		return true
	}
	return hasAddr && hasAttrs
}

// propertyFieldScore ranks candidate objects so the richest (the true profile, not
// a thin nested reference to it) wins.
func propertyFieldScore(lm map[string]any) int {
	n := 0
	for _, k := range []string{
		"estimate", "priceestimate", "valuation", "avm", "estimatedvalue", "displayestimate",
		"rentestimate", "rentalestimate", "saleshistory", "salehistory", "transactionhistory",
		"propertyhistory", "yearbuilt", "landsize", "landarea", "buildingsize", "floorarea",
		"propertytype", "bedrooms", "bathrooms", "carspaces", "address", "geolocation", "location",
	} {
		if _, ok := lm[k]; ok {
			n++
		}
	}
	return n
}

// harvestProperty pulls every profile field out of the chosen object (and its
// direct child maps), building both the typed record and the raw JSON of exactly
// what was recognized. All fields are best-effort/optional. Every FREE-TEXT value
// is run through cleanText at harvest time so the raw JSON is built from CLEANED
// values — a stray NUL/lone-surrogate from the portal would otherwise survive into
// the raw JSONB column (json.Marshal escapes a 0x00 to a \u0000 escape, which
// REJECTS with 22P05, aborting the whole write tx). See also
// upsertPropertyValuation's belt-and-braces guard.
func harvestProperty(lm map[string]any) propertyProfile {
	maps := gatherMaps(lm)
	raw := map[string]any{}
	var p propertyProfile

	// AVM estimate — a nested {low,mid,high,confidence} sub-object (possibly one
	// extra wrapper level deep, e.g. valuation.estimate.*), else flat fields.
	if est := resolveEstimateObject(lm); est != nil {
		estMaps := []map[string]any{est}
		if lo, ok := firstFloat(estMaps, estimateLowKeys...); ok && lo > 0 {
			p.EstimateLow = f64p(lo)
		}
		if mid, ok := firstFloat(estMaps, estimateMidKeys...); ok && mid > 0 {
			p.EstimateMid = f64p(mid)
		}
		if hi, ok := firstFloat(estMaps, estimateHighKeys...); ok && hi > 0 {
			p.EstimateHigh = f64p(hi)
		}
		if c := cleanText(getStr(est, estimateConfKeys...)); c != "" {
			p.EstimateConfidence = c
		}
	}
	// Flat estimate fallbacks fill any gap the nested object didn't.
	if p.EstimateLow == nil {
		if lo, ok := firstFloat(maps, flatEstimateLowKeys...); ok && lo > 0 {
			p.EstimateLow = f64p(lo)
		}
	}
	if p.EstimateMid == nil {
		if mid, ok := firstFloat(maps, flatEstimateMidKeys...); ok && mid > 0 {
			p.EstimateMid = f64p(mid)
		}
	}
	if p.EstimateHigh == nil {
		if hi, ok := firstFloat(maps, flatEstimateHighKeys...); ok && hi > 0 {
			p.EstimateHigh = f64p(hi)
		}
	}
	if p.EstimateConfidence == "" {
		if c := cleanText(getStr(lm, estimateConfKeys...)); c != "" {
			p.EstimateConfidence = c
		}
	}
	if p.EstimateLow != nil {
		raw["estimate_low"] = *p.EstimateLow
	}
	if p.EstimateMid != nil {
		raw["estimate_mid"] = *p.EstimateMid
	}
	if p.EstimateHigh != nil {
		raw["estimate_high"] = *p.EstimateHigh
	}
	if p.EstimateConfidence != "" {
		raw["estimate_confidence"] = p.EstimateConfidence
	}

	// Weekly rent estimate — nested sub-object or flat.
	if rent := childMap(lm, rentEstimateObjectKeys...); rent != nil {
		if v, ok := firstFloat([]map[string]any{rent}, rentMidKeys...); ok && v > 0 {
			p.RentEstimateMid = f64p(v)
		}
	}
	if p.RentEstimateMid == nil {
		if v, ok := firstFloat(maps, "rentestimatemid", "weeklyrent", "rentperweek", "estimatedrent"); ok && v > 0 {
			p.RentEstimateMid = f64p(v)
		}
	}
	if p.RentEstimateMid != nil {
		raw["rent_estimate_mid"] = *p.RentEstimateMid
	}

	// Attributes.
	if p.Bedrooms = firstInt16(maps, 0, 60, bedroomKeys...); p.Bedrooms != nil {
		raw["bedrooms"] = *p.Bedrooms
	}
	if p.Bathrooms = firstInt16(maps, 0, 60, bathroomKeys...); p.Bathrooms != nil {
		raw["bathrooms"] = *p.Bathrooms
	}
	if p.CarSpaces = firstInt16(maps, 0, 60, carSpaceKeys...); p.CarSpaces != nil {
		raw["car_spaces"] = *p.CarSpaces
	}
	if v := harvestSqm(maps, "land"); v != nil {
		p.LandSizeSqm = v
		raw["land_size_sqm"] = *v
	}
	if v := harvestSqm(maps, "building"); v != nil {
		p.BuildingSizeSqm = v
		raw["building_size_sqm"] = *v
	}
	if v := harvestYearBuilt(maps); v != nil {
		p.YearBuilt = v
		raw["year_built"] = *v
	}
	if pt := cleanText(strings.TrimSpace(firstStr(maps, propTypeKeys...))); pt != "" {
		p.PropertyType = pt
		raw["property_type"] = pt
	}

	// Geo — a geolocation/location sub-object, the address block, or flat; kept only
	// inside the AU bounding box (same gate as the listing harvesters).
	geoMaps := []map[string]any{lm}
	if geo := childMap(lm, "geolocation", "location", "geo", "coordinates", "geocode", "map"); geo != nil {
		geoMaps = append(geoMaps, geo)
	}
	if addr := childMap(lm, "address"); addr != nil {
		geoMaps = append(geoMaps, addr)
	}
	if lat, ok := firstFloat(geoMaps, "latitude", "lat"); ok {
		if lng, ok2 := firstFloat(geoMaps, "longitude", "lng", "lon", "long"); ok2 && lat <= -9 && lat >= -45 && lng >= 110 && lng <= 156 {
			p.Lat, p.Lng = f64p(lat), f64p(lng)
			raw["latitude"], raw["longitude"] = lat, lng
		}
	}

	// Sales history — the full array of prior sale events.
	if sh := harvestSalesHistory(lm); len(sh) > 0 {
		p.SalesHistory = sh
		raw["sales_history"] = sh
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

// resolveEstimateObject returns the object that actually holds the AVM bounds. The
// estimate normally sits directly under an estimate-alias child (property.estimate),
// but some shapes wrap it one extra level (a "valuation" object whose "estimate"
// child holds low/mid/high). When the first-level object under an estimate alias
// doesn't itself carry numeric bounds, we descend once more into its own
// estimate-alias child. Returns nil when no estimate object is present. It searches
// ONLY inside a recognized estimate object (never the whole profile) so a generic
// numeric field elsewhere — e.g. propertySizes.land.value — can't be mistaken for a
// price estimate.
func resolveEstimateObject(lm map[string]any) map[string]any {
	est := childMap(lm, estimateObjectKeys...)
	if est == nil {
		return nil
	}
	if hasEstimateBounds(est) {
		return est
	}
	if inner := childMap(est, estimateObjectKeys...); inner != nil && hasEstimateBounds(inner) {
		return inner
	}
	return est
}

// hasEstimateBounds reports whether a map carries at least one parseable low/mid/high
// AVM number (so a bare {estimate:{…}} wrapper, whose only key is a nested object,
// is correctly seen as NOT holding the bounds itself).
func hasEstimateBounds(m map[string]any) bool {
	one := []map[string]any{m}
	if _, ok := firstFloat(one, estimateLowKeys...); ok {
		return true
	}
	if _, ok := firstFloat(one, estimateMidKeys...); ok {
		return true
	}
	if _, ok := firstFloat(one, estimateHighKeys...); ok {
		return true
	}
	return false
}

// harvestYearBuilt pulls a construction year and bounds it to a plausible range
// (1800..next year) so a stray numeric field can't land a nonsense year.
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

// harvestSalesHistory collects prior sale events from the first present sales array
// (a bare array, or an array wrapped in a {sales|events|results|...} sub-object —
// salesArrayOf handles both). Each element is mapped date+price(+agency+type);
// entries with neither a date nor a price are dropped. Order-preserving; nil when
// none.
func harvestSalesHistory(lm map[string]any) []saleRecord {
	for _, key := range salesHistoryKeys {
		v, ok := lm[key]
		if !ok {
			continue
		}
		arr := salesArrayOf(v)
		if arr == nil {
			continue
		}
		var out []saleRecord
		for _, e := range arr {
			em, ok := e.(map[string]any)
			if !ok {
				continue
			}
			lem := lowerKeys(em)
			var sr saleRecord
			sr.Date = cleanText(getStr(lem, saleDateKeys...))
			if f, ok := firstFloat([]map[string]any{lem}, salePriceKeys...); ok && f > 0 {
				sr.Price = f64p(f)
			}
			sr.Agency = cleanText(getStr(lem, saleAgencyKeys...))
			sr.Type = cleanText(getStr(lem, saleTypeKeys...))
			if sr.Date != "" || sr.Price != nil {
				out = append(out, sr)
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	return nil
}

// salesArrayOf coerces a sales-history value into its element array: either a bare
// array, or an array nested one level under a common wrapper key.
func salesArrayOf(v any) []any {
	switch t := v.(type) {
	case []any:
		return t
	case map[string]any:
		lm := lowerKeys(t)
		for _, k := range []string{"sales", "events", "results", "items", "history", "transactions", "records", "list"} {
			if a, ok := lm[k].([]any); ok {
				return a
			}
		}
	}
	return nil
}

// firstValue returns the first present alias's raw value (used to peek for a
// sales-history array before committing to harvesting it).
func firstValue(lm map[string]any, aliases ...string) any {
	for _, a := range aliases {
		if v, ok := lm[a]; ok {
			return v
		}
	}
	return nil
}
