package main

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
)

// Per-listing DETAIL-page extraction. Like the SRP harvester (crawl_listings_extract.go)
// this is schema-AGNOSTIC: realestate.com.au embeds the listing detail in
// window.ArgonautExchange / __PRERENDERED_STATE__ (whose urqlClientCache values are
// DOUBLE-STRINGIFIED JSON — a JSON string inside a JSON string), domain.com.au in
// __NEXT_DATA__ → props.pageProps.componentProps, and both mutate their key paths
// often and serve bot-variant DOM. So we never bind a selector: we walk every JSON
// blob on the page, keep the object that looks most like a single listing, and
// harvest each field through case-insensitive alias lists with a shallow nested
// fallback. Every field is optional; ok is false only when NO recognizable listing
// payload was found at all.
//
// NOTE (Phase 0): no real LDP fixture exists yet — the alias sets + nesting below
// are the EXPECTED shapes (the SRP shapes extended with the detail-only fields:
// description, land/building size, geo, features, image count, inspection/auction
// datetimes, listed date, agent phones). The Phase-0 live probe (10 dry-run
// fetches, gated until the current SRP drain finishes) will confirm/refine them;
// the extractor is written tolerant so a shape drift degrades to "fewer fields
// harvested", never a crash or a false ok=false.

// detailRecord is one listing's harvested detail-page fields, before persistence.
// Pointer fields are nil when absent. Raw is the JSON serialization of exactly the
// fields we recognized (never the whole page — that would store proprietary bulk);
// it feeds the raw JSONB column and the content hash.
type detailRecord struct {
	Description     string
	LandSizeSqm     *float64
	BuildingSizeSqm *float64
	Lat, Lng        *float64
	PropertyType    string
	Features        []string
	ImageCount      *int16
	InspectionNext  *time.Time
	AuctionAt       *time.Time
	ListedAt        *time.Time // stored as a DATE
	AgentPhones     []string
	AgencyName      string
	Raw             string // JSON of the recognized fields; "{}" when nothing harvested
}

// extractDetail walks every <script> JSON blob (including REA's double-stringified
// urqlClientCache chain), picks the richest listing-detail object, and harvests its
// fields. Returns ok=false only when NO recognizable listing payload was found.
func extractDetail(html, source string) (detailRecord, bool) {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(html))
	if err != nil {
		return detailRecord{}, false
	}
	var cands []map[string]any
	doc.Find("script").Each(func(_ int, s *goquery.Selection) {
		for _, blob := range jsonBlobs(s.Text()) {
			var v any
			if json.Unmarshal([]byte(blob), &v) != nil {
				continue
			}
			walkForDetail(v, &cands, 0)
		}
	})
	if len(cands) == 0 {
		return detailRecord{}, false
	}
	best, bestScore := cands[0], detailFieldScore(cands[0])
	for _, c := range cands[1:] {
		if sc := detailFieldScore(c); sc > bestScore {
			best, bestScore = c, sc
		}
	}
	return harvestDetail(best, source), true
}

// walkForDetail recurses through maps, arrays, AND stringified-JSON string values
// (mirrors walkForListingsDepth — REA double-stringifies its listing payload),
// collecting every object that looks like a single listing detail.
func walkForDetail(v any, cands *[]map[string]any, depth int) {
	if depth > 40 {
		return
	}
	switch t := v.(type) {
	case map[string]any:
		lm := lowerKeys(t)
		if isDetailCandidate(lm) {
			*cands = append(*cands, lm)
		}
		for _, child := range t {
			walkForDetail(child, cands, depth+1)
		}
	case []any:
		for _, child := range t {
			walkForDetail(child, cands, depth+1)
		}
	case string:
		if s := strings.TrimSpace(t); len(s) > 2 && (s[0] == '{' || s[0] == '[') {
			var inner any
			if json.Unmarshal([]byte(s), &inner) == nil {
				walkForDetail(inner, cands, depth+1)
			}
		}
	}
}

// isDetailCandidate reports whether a lowercased map looks like a single listing's
// detail object. It is deliberately broader than isListingObject (which needs
// price+address+id): a detail page's main object also carries a description /
// property type / features / land size, and we want to find it even when a portal
// omits one of the SRP-style identity fields. We still accept the SRP-style listing
// object too (isListingObject), since the LDP embeds it as well.
func isDetailCandidate(lm map[string]any) bool {
	if isListingObject(lm) {
		return true
	}
	hasAddr := childMap(lm, "address") != nil || anyKey(lm, "displayaddress", "streetaddress", "fulladdress")
	hasDesc := anyKey(lm, "description", "listingdescription", "propertydescription", "bodytext", "adtext")
	hasType := anyKey(lm, "propertytype", "propertytypeformatted", "dwellingtype", "subtype")
	hasFeat := anyKey(lm, "features", "structuredfeatures", "propertyfeatures", "generalfeatures")
	hasSizes := anyKey(lm, "propertysizes", "landsize", "landarea", "landsizesqm")
	hasBeds := anyKey(lm, "bedrooms", "beds")
	// An address plus any detail signal, OR a rich description with a type/features
	// signal (covers a detail object that omits the address block).
	if hasAddr && (hasDesc || hasType || hasFeat || hasSizes) {
		return true
	}
	return hasDesc && (hasType || hasFeat || hasBeds)
}

// detailFieldScore ranks candidate objects so the richest (the true detail object,
// not a thin nested reference to it) wins.
func detailFieldScore(lm map[string]any) int {
	n := 0
	for _, k := range []string{
		"description", "listingdescription", "propertydescription", "bodytext",
		"propertytype", "propertytypeformatted", "features", "structuredfeatures",
		"propertysizes", "landsize", "landarea", "landsizesqm", "images", "media",
		"photos", "inspections", "inspectiondetails", "auction", "listeddate",
		"listers", "contactagents", "agents", "address", "geolocation", "location",
	} {
		if _, ok := lm[k]; ok {
			n++
		}
	}
	return n
}

// harvestDetail pulls every detail field out of the chosen listing object (and its
// direct child maps), building both the typed record and the raw JSON of exactly
// what was recognized. All fields are best-effort/optional.
func harvestDetail(lm map[string]any, source string) detailRecord {
	maps := gatherMaps(lm)
	raw := map[string]any{"source": source}
	var rec detailRecord

	if d := firstStr(maps, "description", "listingdescription", "propertydescription", "bodytext", "adtext", "summarydescription"); d != "" {
		rec.Description = d
		raw["description"] = d
	}
	if pt := strings.TrimSpace(firstStr(maps, "propertytypeformatted", "propertytype", "dwellingtype", "subtype", "propertycategory")); pt != "" {
		rec.PropertyType = pt
		raw["property_type"] = pt
	}

	// Geo — a geolocation/location/geo sub-object, the address block, or flat; kept
	// only inside the AU bounding box (same gate as the SRP harvester).
	geoMaps := []map[string]any{lm}
	if geo := childMap(lm, "geolocation", "location", "geo", "coordinates", "geocode", "map"); geo != nil {
		geoMaps = append(geoMaps, geo)
	}
	if addr := childMap(lm, "address"); addr != nil {
		geoMaps = append(geoMaps, addr)
	}
	if lat, ok := firstFloat(geoMaps, "latitude", "lat"); ok {
		if lng, ok2 := firstFloat(geoMaps, "longitude", "lng", "lon", "long"); ok2 && lat <= -9 && lat >= -45 && lng >= 110 && lng <= 156 {
			rec.Lat, rec.Lng = f64p(lat), f64p(lng)
			raw["latitude"], raw["longitude"] = lat, lng
		}
	}

	if v := harvestSqm(maps, "land"); v != nil {
		rec.LandSizeSqm = v
		raw["land_size_sqm"] = *v
	}
	if v := harvestSqm(maps, "building"); v != nil {
		rec.BuildingSizeSqm = v
		raw["building_size_sqm"] = *v
	}
	if fs := harvestFeatures(lm); len(fs) > 0 {
		rec.Features = fs
		raw["features"] = fs
	}
	if c := harvestImageCount(lm); c != nil {
		rec.ImageCount = c
		raw["image_count"] = *c
	}
	if tm := harvestDateTime(gatherMaps(lm), inspectionKeys); tm != nil {
		rec.InspectionNext = tm
		raw["inspection_next"] = tm.Format(time.RFC3339)
	}
	if tm := harvestDateTime(maps, auctionKeys); tm != nil {
		rec.AuctionAt = tm
		raw["auction_at"] = tm.Format(time.RFC3339)
	}
	if tm := harvestDate(maps, listedDateKeys); tm != nil {
		rec.ListedAt = tm
		raw["listed_at"] = tm.Format("2006-01-02")
	}
	if ph := harvestAgentPhones(lm); len(ph) > 0 {
		rec.AgentPhones = ph
		raw["agent_phones"] = ph
	}
	if ag := childMap(lm, "listingcompany", "agency", "advertiser", "agencyprofile", "marketingagent"); ag != nil {
		if n := getStr(ag, "name", "agencyname", "companyname", "tradingname", "displayname"); n != "" {
			rec.AgencyName = n
			raw["agency_name"] = n
		}
	}

	if b, err := json.Marshal(raw); err == nil {
		rec.Raw = string(b)
	} else {
		rec.Raw = "{}"
	}
	return rec
}

// gatherMaps returns the object itself plus each of its DIRECT child objects
// (lowercased) — one level of nesting, which is where portals stash the
// address/propertySizes/listingSummary sub-objects a detail field may live in.
func gatherMaps(lm map[string]any) []map[string]any {
	maps := []map[string]any{lm}
	for _, v := range lm {
		if m, ok := v.(map[string]any); ok {
			maps = append(maps, lowerKeys(m))
		}
	}
	return maps
}

// sqmRe matches a size number with an optional area unit ("610m²", "610 sqm",
// "0.25 ha", "610m2").
var sqmRe = regexp.MustCompile(`([0-9][0-9,]*(?:\.[0-9]+)?)\s*(ha|hectares?|m²|sqm|m2|sq\s?m)?`)

// parseSqm parses an area display string into square metres. Hectares are scaled
// (1ha = 10,000m²). Returns false when no plausible number is found.
func parseSqm(s string) (float64, bool) {
	m := sqmRe.FindStringSubmatch(strings.ToLower(strings.TrimSpace(s)))
	if m == nil {
		return 0, false
	}
	num, err := strconv.ParseFloat(strings.ReplaceAll(m[1], ",", ""), 64)
	if err != nil || num <= 0 {
		return 0, false
	}
	switch {
	case strings.HasPrefix(m[2], "ha") || strings.HasPrefix(m[2], "hectare"):
		num *= 10_000
	}
	return num, true
}

// harvestSqm pulls a land/building size (in m²) from numeric keys, display strings,
// or a propertySizes.{land,building}.{value,displayValue} sub-object.
func harvestSqm(maps []map[string]any, kind string) *float64 {
	if f, ok := firstFloat(maps, kind+"sizesqm", kind+"area", kind+"size", kind+"areasqm"); ok && f > 0 {
		return f64p(f)
	}
	if s := firstStr(maps, kind+"sizedisplay", kind+"size", kind+"area", kind+"sizedescription"); s != "" {
		if v, ok := parseSqm(s); ok {
			return f64p(v)
		}
	}
	for _, m := range maps {
		if ps := childMap(m, "propertysizes", "sizes", "landdetails"); ps != nil {
			if km := childMap(ps, kind); km != nil {
				if f, ok := firstFloat([]map[string]any{km}, "value", "size", "sizeinsqm", "sqm"); ok && f > 0 {
					return f64p(f)
				}
				if s := getStr(km, "displayvalue", "display", "label", "text"); s != "" {
					if v, ok := parseSqm(s); ok {
						return f64p(v)
					}
				}
			}
		}
	}
	return nil
}

// harvestFeatures collects listing feature labels from the first present feature
// array (REA/Domain use different key names + element shapes: bare strings, or
// {name}/{displayLabel} objects). Deduped, order-preserving; nil when none.
func harvestFeatures(lm map[string]any) []string {
	for _, key := range []string{"structuredfeatures", "features", "propertyfeatures", "additionalfeatures", "outdoorfeatures", "indoorfeatures"} {
		arr, ok := lm[key].([]any)
		if !ok {
			continue
		}
		var out []string
		seen := map[string]bool{}
		for _, e := range arr {
			var label string
			switch v := e.(type) {
			case string:
				label = strings.TrimSpace(v)
			case map[string]any:
				label = getStr(lowerKeys(v), "name", "displaylabel", "label", "feature", "text", "value")
			}
			if label != "" && !seen[label] {
				seen[label] = true
				out = append(out, label)
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	return nil
}

// harvestImageCount returns the number of listing images: the length of the first
// present media array, else a numeric image-count field. Bounded to int16.
func harvestImageCount(lm map[string]any) *int16 {
	for _, key := range []string{"images", "media", "photos", "gallery", "imagelist"} {
		if arr, ok := lm[key].([]any); ok && len(arr) > 0 {
			return boundedInt16p(len(arr))
		}
	}
	if f, ok := firstFloat([]map[string]any{lm}, "imagecount", "photocount", "totalimages", "numberofimages", "mediacount"); ok && f > 0 {
		return boundedInt16p(int(f))
	}
	return nil
}

var (
	// Datetime alias sets. inspection/auction values may be a bare ISO string, or a
	// {startTime|dateTime|...} object, possibly inside an array of such objects.
	inspectionKeys = []string{"inspections", "inspectiondetails", "openhomes", "inspectiontimes", "nextinspection", "inspectionsandauctions"}
	auctionKeys    = []string{"auction", "auctiondetails", "auctiondate", "auctiondatetime", "auctionat"}
	listedDateKeys = []string{"listeddate", "datelisted", "firstlisteddate", "createddate", "dateavailable", "publisheddate"}
)

// harvestDateTime finds the earliest parseable datetime under any of the given
// keys, descending into arrays and {startTime|dateTime|...} wrapper objects.
func harvestDateTime(maps []map[string]any, keys []string) *time.Time {
	var best *time.Time
	consider := func(v any) {
		if tm, ok := anyDateTime(v); ok {
			if best == nil || tm.Before(*best) {
				t := tm
				best = &t
			}
		}
	}
	for _, m := range maps {
		for _, k := range keys {
			if v, ok := m[k]; ok {
				consider(v)
			}
		}
	}
	return best
}

// anyDateTime coerces a value (string, {startTime|dateTime|...} object, or an array
// of those) into the earliest parseable time.
func anyDateTime(v any) (time.Time, bool) {
	switch t := v.(type) {
	case string:
		return parseAnyTime(t)
	case map[string]any:
		lm := lowerKeys(t)
		if s := getStr(lm, "starttime", "starttimeutc", "datetime", "date", "start", "time", "displaydate"); s != "" {
			return parseAnyTime(s)
		}
	case []any:
		var best time.Time
		found := false
		for _, e := range t {
			if tm, ok := anyDateTime(e); ok && (!found || tm.Before(best)) {
				best, found = tm, true
			}
		}
		return best, found
	}
	return time.Time{}, false
}

// harvestDate finds the first parseable date (day granularity) under any of the
// given keys.
func harvestDate(maps []map[string]any, keys []string) *time.Time {
	if s := firstStr(maps, keys...); s != "" {
		if tm, ok := parseAnyTime(s); ok {
			d := time.Date(tm.Year(), tm.Month(), tm.Day(), 0, 0, 0, 0, time.UTC)
			return &d
		}
	}
	return nil
}

var dateTimeLayouts = []string{
	time.RFC3339,
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05",
	"2006-01-02T15:04",
	"2006-01-02",
	"02/01/2006",
	"01/02/2006",
}

// parseAnyTime tries the common portal datetime/date layouts. Returns UTC.
func parseAnyTime(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	for _, layout := range dateTimeLayouts {
		if tm, err := time.Parse(layout, s); err == nil {
			return tm.UTC(), true
		}
	}
	return time.Time{}, false
}

// harvestAgentPhones pulls contact phone numbers from the first present agent array
// (REA "listers", Domain "contactAgents"/"agents"). Deduped; nil when none.
func harvestAgentPhones(lm map[string]any) []string {
	for _, key := range []string{"listers", "contactagents", "agents", "agent", "advertiserlisters"} {
		arr, ok := lm[key].([]any)
		if !ok {
			continue
		}
		var out []string
		seen := map[string]bool{}
		for _, e := range arr {
			am, ok := e.(map[string]any)
			if !ok {
				continue
			}
			p := getStr(lowerKeys(am), "phonenumber", "phone", "mobile", "businessphone", "contactnumber", "telephone", "mobilephone")
			if p != "" && !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	return nil
}

func boundedInt16p(n int) *int16 {
	if n < 0 {
		n = 0
	}
	if n > 32767 {
		n = 32767
	}
	v := int16(n)
	return &v
}
