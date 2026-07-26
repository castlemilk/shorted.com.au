package houseprices

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

// Per-listing extraction is schema-AGNOSTIC for the same reason the median
// harvester is (crawl_extract.go): domain.com.au embeds its listing array in
// __NEXT_DATA__, realestate.com.au in window.ArgonautExchange, both mutate their
// key paths often, and Kasada serves bot-variant DOM. So we never bind a selector:
// we walk every JSON blob on the page, treat any object that simultaneously
// carries an id + a price + an address as a listing candidate, and harvest its
// fields through case-insensitive alias lists (with a shallow nested fallback for
// address/features/price/geo). Junk is dropped downstream by target-match +
// price-band validation (crawl_listings_validate.go).

// RawListing is one property listing as harvested from a search-results page,
// before validation. Pointer fields are nil when absent.
type RawListing struct {
	Source      string
	ListingID   string
	ListingURL  string
	DisplayAddr string
	Suburb      string
	State       string
	Postcode    string
	// AddressKey is a stable per-physical-address identity, stamped by
	// diffSuburb (crawl_listings_diff.go) from the CANONICAL CrawlTarget
	// suburb/state/postcode via addressKey() — never populated here, since
	// extraction has no CrawlTarget in scope. See crawl_address.go.
	AddressKey   string
	Lat, Lng     *float64
	PropertyType string
	Bedrooms     *int16
	Bathrooms    *int16
	CarSpaces    *int16
	LandSizeSqm  *float64
	PriceDisplay string
	PriceLow     *float64
	PriceHigh    *float64
	PriceKind    string
	Status       string // normalized: for_sale|under_offer|sold|withdrawn
	// Marketing agency + agents, harvested from the same search-results blob
	// (REA listingCompany + listers; Domain advertiser/agencyProfile +
	// contactAgents). Best-effort — empty when the portal omits them.
	AgencyID   string
	AgencyName string
	AgentNames []string
}

// extractListings walks every <script> JSON blob and returns the deduped
// listings found. Dedup keeps the most-populated record per listing_id.
func extractListings(doc *goquery.Document, source string) []RawListing {
	seen := map[string]RawListing{}
	doc.Find("script").Each(func(_ int, s *goquery.Selection) {
		for _, blob := range jsonBlobs(s.Text()) {
			var v any
			if err := json.Unmarshal([]byte(blob), &v); err != nil {
				continue
			}
			walkForListings(v, source, seen)
		}
	})
	out := make([]RawListing, 0, len(seen))
	for _, l := range seen {
		out = append(out, l)
	}
	return out
}

// PageMeta is the portal's OWN pagination signal for one search-results page,
// parsed from the SAME embedded JSON blob extractListings walks. Confirmed key
// paths (Phase-0 discovery, 2026-07-15, against live New Farm SRPs):
//
//   - REA (ArgonautExchange): buySearch.results.totalResultsCount (broadened
//     count) + .pagination.maxPageNumberAvailable (total pages), and — one
//     level deeper, inside the stringified buySearch.resolvedQuery.metadata.
//     savedSearchQuery — .pageSize + .filters.surroundingSuburbs.
//   - Domain (__NEXT_DATA__): componentProps.totalPages/totalListings, and
//     componentProps.pageViewMetadata.searchRequest.pageSize +
//     .locations[].includeSurroundingSuburbs (also
//     .searchResponse.SearchResults.totalResults/totalPages, same values).
//
// CRITICAL: on both portals TotalResults/TotalPages are the BROADENED count —
// suburb + surrounding suburbs once the SRP runs out of on-target inventory —
// NOT the on-target listing count (confirmed live: New Farm reports
// TotalResults≈969(REA)/608(Domain) while on-target inventory is only
// ~54-65). The sweep loop (crawl_listings.go) must never size its page walk
// off TotalResults/TotalPages directly; see sweepSuburbSource's doc comment.
//
// OnTargetResults is REA-only: its SRP blob also carries an exact on-target
// count under "listings_total" (confirmed live, New Farm: 969 broadened −
// 906 surrounding = 63, matching listings_total==63). Domain exposes no
// equivalent field (only the broadened totalListings + a boolean
// includeSurroundingSuburbs), so OnTargetResults is left 0 for Domain and
// callers must keep falling back to the broadened-TotalPages/softCap
// heuristic there.
type PageMeta struct {
	OK                 bool
	TotalResults       int
	TotalPages         int
	PageSize           int
	SurroundingSuburbs bool
	OnTargetResults    int
}

// pageMetaTotalKeys/pageMetaPagesKeys/... are case-insensitive alias lists,
// checked in order, mirroring the alias-list pattern extractListings/
// harvestListing already use for schema drift resilience.
var (
	pageMetaTotalKeys    = []string{"totalresultscount", "totalresults", "totallistings"}
	pageMetaPagesKeys    = []string{"maxpagenumberavailable", "totalpages"}
	pageMetaSizeKeys     = []string{"pagesize"}
	pageMetaSurroundKeys = []string{"surroundingsuburbs", "includesurroundingsuburbs", "initialsurroundingsuburbs"}
	// pageMetaOnTargetKeys: REA-only exact on-target count (Domain has no
	// equivalent field — see PageMeta's doc comment).
	pageMetaOnTargetKeys = []string{"listings_total"}
)

// extractPageMeta walks every <script> JSON blob on a search-results page (the
// same blobs extractListings walks — including REA's triple-nested
// stringified JSON) looking for the portal's own pagination fields. OK is true
// only when BOTH a total-result count and a page size were found (the minimum
// needed to derive anything); an unrecognized/blocked/empty page returns
// PageMeta{} (OK:false), and callers must fall back to today's behaviour.
// TotalPages prefers the portal's own field when present, else is computed as
// ceil(TotalResults/PageSize).
func extractPageMeta(doc *goquery.Document, source string) PageMeta {
	_ = source // the confirmed key-alias set is shared across both portals; kept for symmetry with extractListings(doc, source)
	var m PageMeta
	doc.Find("script").Each(func(_ int, s *goquery.Selection) {
		for _, blob := range jsonBlobs(s.Text()) {
			var v any
			if err := json.Unmarshal([]byte(blob), &v); err != nil {
				continue
			}
			walkForPageMeta(v, &m, 0)
		}
	})
	m.OK = m.TotalResults > 0 && m.PageSize > 0
	if m.OK && m.TotalPages <= 0 {
		m.TotalPages = int(math.Ceil(float64(m.TotalResults) / float64(m.PageSize)))
	}
	return m
}

// walkForPageMeta recurses through maps, arrays, AND stringified-JSON string
// values (mirrors walkForListingsDepth, including REA's double-stringified
// urqlClientCache -> data -> savedSearchQuery chain), filling in each PageMeta
// field the first time it's found. The confirmed fixtures repeat the same
// value at every call-site on a page, so first-found-wins never conflicts.
func walkForPageMeta(v any, m *PageMeta, depth int) {
	if depth > 40 {
		return
	}
	switch t := v.(type) {
	case map[string]any:
		lm := lowerKeys(t)
		if m.TotalResults == 0 {
			if f, ok := firstFloat([]map[string]any{lm}, pageMetaTotalKeys...); ok && f > 0 {
				m.TotalResults = int(f)
			}
		}
		if m.TotalPages == 0 {
			if f, ok := firstFloat([]map[string]any{lm}, pageMetaPagesKeys...); ok && f > 0 {
				m.TotalPages = int(f)
			}
		}
		if m.PageSize == 0 {
			if f, ok := firstFloat([]map[string]any{lm}, pageMetaSizeKeys...); ok && f > 0 {
				m.PageSize = int(f)
			}
		}
		if m.OnTargetResults == 0 {
			if f, ok := firstFloat([]map[string]any{lm}, pageMetaOnTargetKeys...); ok && f > 0 {
				m.OnTargetResults = int(f)
			}
		}
		if !m.SurroundingSuburbs {
			for _, k := range pageMetaSurroundKeys {
				if b, ok := lm[k].(bool); ok && b {
					m.SurroundingSuburbs = true
					break
				}
			}
		}
		for _, child := range t {
			walkForPageMeta(child, m, depth+1)
		}
	case []any:
		for _, child := range t {
			walkForPageMeta(child, m, depth+1)
		}
	case string:
		if s := strings.TrimSpace(t); len(s) > 2 && (s[0] == '{' || s[0] == '[') {
			var inner any
			if json.Unmarshal([]byte(s), &inner) == nil {
				walkForPageMeta(inner, m, depth+1)
			}
		}
	}
}

func walkForListings(v any, source string, seen map[string]RawListing) {
	walkForListingsDepth(v, source, seen, 0)
}

// walkForListingsDepth recurses through maps, arrays, AND stringified-JSON string
// values. The latter is essential: REA double-stringifies its listing payload
// (ArgonautExchange → urqlClientCache is a JSON string → each query's `data` is
// another JSON string → the listings), and some sites embed escaped JSON blobs.
// A depth cap guards against pathological nesting.
func walkForListingsDepth(v any, source string, seen map[string]RawListing, depth int) {
	if depth > 40 {
		return
	}
	switch t := v.(type) {
	case map[string]any:
		lm := lowerKeys(t)
		if isListingObject(lm) {
			if l, ok := harvestListing(lm, source); ok {
				if prev, exists := seen[l.ListingID]; !exists || fieldScore(l) > fieldScore(prev) {
					seen[l.ListingID] = l
				}
			}
		}
		for _, child := range t {
			walkForListingsDepth(child, source, seen, depth+1)
		}
	case []any:
		for _, child := range t {
			walkForListingsDepth(child, source, seen, depth+1)
		}
	case string:
		if s := strings.TrimSpace(t); len(s) > 2 && (s[0] == '{' || s[0] == '[') {
			var inner any
			if json.Unmarshal([]byte(s), &inner) == nil {
				walkForListingsDepth(inner, source, seen, depth+1)
			}
		}
	}
}

// isListingObject reports whether a lowercased map looks like an individual
// listing: it must carry a price signal, an address signal, AND something to
// derive an identity from (an id field OR a url — Domain keys listings by the map
// key, so the object itself has no id and we fall back to the url's trailing id).
// Requiring price + address keeps agents/media/agency/project sub-objects out
// (Domain "project" cards have an address but no price).
func isListingObject(lm map[string]any) bool {
	hasPrice := anyKey(lm, "price", "pricedisplay", "displayprice", "pricetext", "pricelabel", "pricedetails", "pricefrom")
	hasAddr := childMap(lm, "address") != nil || anyKey(lm, "displayaddress", "streetaddress", "fulladdress")
	hasIdentity := anyKey(lm, "id", "listingid", "advertid", "adid") ||
		anyKey(lm, "listingurl", "url", "seourl", "canonicalurl", "href", "slug")
	return hasPrice && hasAddr && hasIdentity
}

// trailingIDRe matches a portal listing id embedded in a URL (Domain/REA ids are
// long numbers, e.g. .../bondi-nsw-2026-2020524930). ≥6 digits excludes postcodes.
var trailingIDRe = regexp.MustCompile(`\d{6,}`)

// listingIDFromURL recovers a stable listing id from the URL's trailing number —
// the fallback when the object has no id field (Domain keys by the map key).
func listingIDFromURL(u string) string {
	ms := trailingIDRe.FindAllString(u, -1)
	if len(ms) == 0 {
		return ""
	}
	return ms[len(ms)-1]
}

func harvestListing(lm map[string]any, source string) (RawListing, bool) {
	l := RawListing{Source: source}

	// URL first — top-level aliases, or the REA _links.canonical.href shape.
	l.ListingURL = getStr(lm, "listingurl", "url", "seourl", "canonicalurl", "href", "slug")
	if l.ListingURL == "" {
		if links := childMap(lm, "_links", "links"); links != nil {
			if canon := childMap(links, "canonical", "self"); canon != nil {
				l.ListingURL = getStr(canon, "href", "url")
			}
		}
	}
	l.ListingURL = absolutizeURL(l.ListingURL, source)

	// Identity — an explicit id field, else the url's trailing id (Domain keys
	// listings by the map key, so the object itself carries no id).
	l.ListingID = getStr(lm, "id", "listingid", "advertid", "adid")
	if l.ListingID == "" {
		l.ListingID = listingIDFromURL(l.ListingURL)
	}
	if l.ListingID == "" {
		return RawListing{}, false
	}

	// Address — nested "address" (with a possible "display" sub-object) or flat.
	addr := childMap(lm, "address")
	addrMaps := []map[string]any{lm}
	if addr != nil {
		addrMaps = append([]map[string]any{addr}, addrMaps...)
		if disp := childMap(addr, "display"); disp != nil {
			addrMaps = append([]map[string]any{disp}, addrMaps...)
		}
	}
	l.DisplayAddr = firstStr(addrMaps, "displayaddress", "fulladdress", "streetaddress", "street", "shortaddress")
	l.Suburb = firstStr(addrMaps, "suburb", "locality", "suburbname")
	l.State = strings.ToUpper(firstStr(addrMaps, "state", "statecode"))
	l.Postcode = firstStr(addrMaps, "postcode", "postalcode", "postcode4")

	// Beds / baths / car — top-level or under a features sub-object; values may be
	// bare numbers or REA-style {value: N} objects (toFloat handles both).
	feat := childMap(lm, "features", "generalfeatures", "general", "propertyfeatures")
	featMaps := []map[string]any{lm}
	if feat != nil {
		featMaps = append([]map[string]any{feat}, featMaps...)
	}
	l.Bedrooms = firstInt16(featMaps, 0, 60, "bedrooms", "beds", "bed", "numbedrooms")
	l.Bathrooms = firstInt16(featMaps, 0, 60, "bathrooms", "baths", "bath", "numbathrooms")
	l.CarSpaces = firstInt16(featMaps, 0, 60, "carspaces", "parking", "carspots", "car", "numcarspaces")
	if v, ok := firstFloat(featMaps, "landsize", "landarea", "propertysize", "landsizesqm"); ok && v > 0 {
		l.LandSizeSqm = f64p(v)
	}

	// Property type — top-level, a propertyTypes array, or under features
	// (Domain's features.propertyType / propertyTypeFormatted).
	l.PropertyType = strings.TrimSpace(firstStr(featMaps, "propertytypeformatted", "propertytype", "dwellingtype", "subtype"))
	if l.PropertyType == "" {
		if pts, ok := lm["propertytypes"].([]any); ok && len(pts) > 0 {
			l.PropertyType = strings.TrimSpace(toStr(pts[0]))
		}
	}

	// Geo — under a geo sub-object, the address (Domain), or flat; kept only inside
	// the AU bounding box.
	geoMaps := []map[string]any{lm}
	if geo := childMap(lm, "geolocation", "location", "geo", "coordinates", "geocode"); geo != nil {
		geoMaps = append(geoMaps, geo)
	}
	if addr != nil {
		geoMaps = append(geoMaps, addr)
	}
	lat, latOK := firstFloat(geoMaps, "latitude", "lat")
	lng, lngOK := firstFloat(geoMaps, "longitude", "lng", "lon", "long")
	if latOK && lngOK && lat <= -9 && lat >= -45 && lng >= 110 && lng <= 156 {
		l.Lat, l.Lng = f64p(lat), f64p(lng)
	}

	// Price.
	l.PriceDisplay, l.PriceLow, l.PriceHigh, l.PriceKind = harvestPrice(lm)

	// Status — a status field, overridden to "sold" when the card is tagged sold
	// (Domain's UPVSoldListings mark sale via tags rather than a status field).
	l.Status = listingStatus(getStr(lm, "status", "listingstatus", "salemode", "channel", "lifecycle", "liststatus"))
	if tagsContainSold(lm["tags"]) {
		l.Status = "sold"
	}

	// Marketing agency + agents — REA's listingCompany {id,name} + listers[{name}];
	// Domain's advertiser/agencyProfile + contactAgents. All best-effort.
	if lc := childMap(lm, "listingcompany", "agency", "advertiser", "agencyprofile", "marketingagent"); lc != nil {
		l.AgencyID = getStr(lc, "id", "agencyid", "advertiserid", "profileid")
		l.AgencyName = getStr(lc, "name", "agencyname", "companyname", "tradingname", "displayname")
	}
	l.AgentNames = harvestAgentNames(lm)

	return l, true
}

// harvestAgentNames pulls listing agent display names from the first present of
// the known array fields (REA "listers", Domain "contactAgents"/"agents"). Each
// element is a map with a name field; blanks/dups are dropped. Returns nil when
// no agents are present.
func harvestAgentNames(lm map[string]any) []string {
	for _, key := range []string{"listers", "contactagents", "agents", "agent", "advertiserlisters"} {
		arr, ok := lm[key].([]any)
		if !ok {
			continue
		}
		var names []string
		seen := map[string]bool{}
		for _, a := range arr {
			am, ok := a.(map[string]any)
			if !ok {
				continue
			}
			n := getStr(lowerKeys(am), "name", "fullname", "agentname", "displayname")
			if n != "" && !seen[n] {
				seen[n] = true
				names = append(names, n)
			}
		}
		if len(names) > 0 {
			return names
		}
	}
	return nil
}

// tagsContainSold reports whether a listing's "tags" value marks it sold. Domain
// tags are an object {tagText, tagClassName} or an array thereof.
func tagsContainSold(tags any) bool {
	return strings.Contains(strings.ToLower(flattenTagText(tags)), "sold")
}

func flattenTagText(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case map[string]any:
		var b strings.Builder
		for _, val := range t {
			b.WriteString(toStr(val))
			b.WriteByte(' ')
		}
		return b.String()
	case []any:
		var b strings.Builder
		for _, c := range t {
			b.WriteString(flattenTagText(c))
			b.WriteByte(' ')
		}
		return b.String()
	}
	return ""
}

// harvestPrice returns the display string + parsed bounds + kind. It prefers a
// display string (auction/POA/range strings only survive there); if only a
// numeric price is present it is treated as a fixed ask.
func harvestPrice(lm map[string]any) (display string, low, high *float64, kind string) {
	display = getStr(lm, "pricedisplay", "displayprice", "pricetext", "pricelabel", "pricefrom")
	if display == "" {
		if pm := childMap(lm, "price", "pricedetails"); pm != nil {
			display = getStr(pm, "display", "displayprice", "label", "text")
			if display == "" {
				if v, ok := firstFloat([]map[string]any{pm}, "value", "amount", "from", "displayprice"); ok && v > 0 {
					low = f64p(v)
					return numericDisplay(v), low, nil, priceFixed
				}
			}
		}
	}
	// A bare string "price" (very common on Domain).
	if display == "" {
		if s, ok := lm["price"].(string); ok {
			display = s
		}
	}
	if display == "" {
		// Last resort: a numeric top-level "price".
		if v, ok := firstFloat([]map[string]any{lm}, "price", "pricefrom"); ok && v > 0 {
			return numericDisplay(v), f64p(v), nil, priceFixed
		}
		return "", nil, nil, priceUnknown
	}
	low, high, kind = parseAUPrice(display)
	return display, low, high, kind
}

// listingStatus normalizes a portal status string to our enum.
func listingStatus(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	switch {
	case s == "":
		return "for_sale"
	case strings.Contains(s, "sold"):
		return "sold"
	case strings.Contains(s, "under") || strings.Contains(s, "offer") || strings.Contains(s, "contract"):
		return "under_offer"
	case strings.Contains(s, "withdraw") || strings.Contains(s, "leased") || strings.Contains(s, "off"):
		return "withdrawn"
	default:
		return "for_sale"
	}
}

func fieldScore(l RawListing) int {
	n := 0
	for _, s := range []string{l.ListingURL, l.DisplayAddr, l.Suburb, l.State, l.Postcode, l.PropertyType, l.PriceDisplay} {
		if s != "" {
			n++
		}
	}
	for _, p := range []*float64{l.PriceLow, l.PriceHigh, l.Lat, l.LandSizeSqm} {
		if p != nil {
			n++
		}
	}
	for _, p := range []*int16{l.Bedrooms, l.Bathrooms, l.CarSpaces} {
		if p != nil {
			n++
		}
	}
	return n
}

// --- generic JSON-map helpers (operate on lowercased-key maps) ---

func lowerKeys(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[strings.ToLower(k)] = v
	}
	return out
}

func anyKey(lm map[string]any, keys ...string) bool {
	for _, k := range keys {
		if _, ok := lm[k]; ok {
			return true
		}
	}
	return false
}

// childMap returns the first alias whose value is an object, lowercased.
func childMap(lm map[string]any, aliases ...string) map[string]any {
	for _, a := range aliases {
		if v, ok := lm[a]; ok {
			if m, ok := v.(map[string]any); ok {
				return lowerKeys(m)
			}
		}
	}
	return nil
}

func getStr(lm map[string]any, aliases ...string) string {
	for _, a := range aliases {
		if v, ok := lm[a]; ok {
			if s := strings.TrimSpace(toStr(v)); s != "" {
				return s
			}
		}
	}
	return ""
}

func firstStr(maps []map[string]any, aliases ...string) string {
	for _, m := range maps {
		if s := getStr(m, aliases...); s != "" {
			return s
		}
	}
	return ""
}

func firstFloat(maps []map[string]any, aliases ...string) (float64, bool) {
	for _, m := range maps {
		for _, a := range aliases {
			if v, ok := m[a]; ok {
				if f, ok := toFloat(v); ok {
					return f, true
				}
			}
		}
	}
	return 0, false
}

func firstInt16(maps []map[string]any, lo, hi int16, aliases ...string) *int16 {
	if f, ok := firstFloat(maps, aliases...); ok {
		n := int16(f + 0.5)
		if n >= lo && n <= hi {
			return &n
		}
	}
	return nil
}

func toStr(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case json.Number:
		return t.String()
	case bool:
		return strconv.FormatBool(t)
	}
	return ""
}

// toFloat parses a number, a numeric string, or a {value: N} wrapper object.
func toFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case json.Number:
		f, err := t.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(strings.ReplaceAll(strings.TrimSpace(t), ",", ""), 64)
		return f, err == nil
	case map[string]any:
		lm := lowerKeys(t)
		for _, k := range []string{"value", "amount"} {
			if inner, ok := lm[k]; ok {
				return toFloat(inner)
			}
		}
	}
	return 0, false
}

func numericDisplay(v float64) string {
	return "$" + strconv.FormatFloat(v, 'f', 0, 64)
}

func absolutizeURL(u, source string) string {
	u = strings.TrimSpace(u)
	if u == "" {
		return ""
	}
	if strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://") {
		return u
	}
	if strings.HasPrefix(u, "/") {
		return portalOrigin(source) + u
	}
	return portalOrigin(source) + "/" + u
}
