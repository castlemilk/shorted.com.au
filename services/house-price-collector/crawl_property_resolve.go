package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// property.com.au profile-URL RESOLUTION.
//
// A property profile lives at /{state}/{suburb}-{postcode}/{street-abbrev}/{number}-pid-{PID}/.
// The PID is property.com.au's INTERNAL id, which a constructed slug can NEVER yield.
//
// PRIMARY path — the ADDRESS SEARCH API (resolveViaSearch). property.com.au (REA
// Group) drives its search box off realestate.com.au's public consumer address
// autocomplete:
//
//	GET https://suggest.realestate.com.au/consumer-suggest/suggestions
//	    ?max=8&type=address,suburb,postcode,state,region&src=...&query=<address>
//
// probe-CONFIRMED facts that make this the reliable resolver:
//   - each suggestion carries an `id` that IS the property.com.au profile PID
//     ("19 Badajoz Rd, Ryde NSW 2112" -> id 94337 == canonical .../19-pid-94337/).
//   - the profile URL is BUILDABLE from the suggestion's structured `source`
//     (state/suburb/postcode/streetName/streetNumber) + that id — no street-type
//     abbreviation guessing (source.streetName is already abbreviated, and
//     property.com.au 301-redirects a near-miss slug to canonical by PID anyway).
//   - it resolves UNIT-heavy / zero-padded prod addresses ("033/175 Kelletts Road",
//     "6/45 Wheatley Street") that the street-number traversal can't: we normalize
//     the unit (strip leading zeros) and match the exact unit, or fall back to the
//     base street number. This is why the traversal had ~0 hit-rate on the real
//     corpus and search resolves it directly.
//
// FALLBACK path — index-page TRAVERSAL (resolveViaTraversal), kept for when the
// search API misses/changes: it drills the site's own index pages exactly how a user
// would —
//
//   1. Suburb page  /{state}/{suburb}-{postcode}/            lists every STREET link.
//   2. Street page  /{state}/{suburb}-{postcode}/{street}/   lists every PROPERTY
//      link with its /{number}-pid-{PID}/ path.
//   3. Match our street number against the street page → the profile URL (with PID).

const propertyOrigin = "https://www.property.com.au"

// resolveStatus is the outcome of a profile-URL resolution attempt.
type resolveStatus int

const (
	resolveOK      resolveStatus = iota // profileURL is set
	resolveMiss                         // address genuinely not resolvable to a profile → stamp 'notfound'
	resolveBlocked                      // a resolution fetch was blocked/stubbed → treat as a portal block
	resolveErr                          // a transient fetch error → retry next run, write nothing
)

// streetTypeAbbrev maps a full AU street-type word to property.com.au's URL
// abbreviation. It is BEST-EFFORT ONLY — the abbreviations vary (Lane→"lane",
// Crescent→"cr"/"cres" both seen live), so the suburb-page traversal is
// authoritative and this map is a fallback for when the suburb page is unavailable.
var streetTypeAbbrev = map[string]string{
	"road": "rd", "street": "st", "avenue": "ave", "parade": "pde", "drive": "dr",
	"court": "ct", "place": "pl", "crescent": "cres", "close": "cl", "terrace": "tce",
	"boulevard": "bvd", "highway": "hwy", "lane": "lane", "way": "way", "circuit": "cct",
	"esplanade": "esp", "square": "sq", "grove": "gr", "circle": "cir", "rise": "rise",
	"promenade": "prom", "cove": "cove", "gardens": "gdns", "loop": "loop", "walk": "walk",
	"row": "row", "glade": "gld", "mews": "mews", "parkway": "pwy", "crest": "crst",
}

// streetProperty is one property link parsed off a street page.
type streetProperty struct {
	path      string // normalized /vic/sampleton-3999/example-rd/19-pid-100001/
	numberSeg string // "19", "1-43", "1a"
	pid       string
}

// suburbStreet is one street link parsed off a suburb page.
type suburbStreet struct {
	path string // normalized /vic/sampleton-3999/example-rd/
	slug string // "example-rd"
}

// propertyResolveCaches memoizes suburb/street index-page parses across a run so a
// suburb's many seed addresses share a single suburb-page fetch (and each street a
// single street-page fetch). A present key means "already fetched" (value may be
// empty).
type propertyResolveCaches struct {
	suburb map[string][]suburbStreet
	street map[string][]streetProperty
	// search memoizes the suggest API's parsed suggestions per query string, so the
	// unit-form and (shared) base-street-form queries a suburb's many units emit are
	// each fetched once per run.
	search map[string][]suggestItem
}

func newPropertyResolveCaches() *propertyResolveCaches {
	return &propertyResolveCaches{
		suburb: map[string][]suburbStreet{},
		street: map[string][]streetProperty{},
		search: map[string][]suggestItem{},
	}
}

// resolveProfile turns a seed address into its property.com.au profile URL plus the
// match GRANULARITY ("exact" | "building"). The address SEARCH API is the PRIMARY
// path (resolveViaSearch); the index-page traversal (resolveViaTraversal) is the
// fallback when search misses or errors. A block from either path short-circuits so
// the caller's circuit breaker backs off. throttle paces each NETWORK fetch (cache
// hits neither fetch nor sleep).
func (cr *crawler) resolveProfile(ctx context.Context, t propertyTarget, caches *propertyResolveCaches, throttle func()) (string, string, resolveStatus) {
	url, gran, st := cr.resolveViaSearch(ctx, t, caches, throttle)
	if st == resolveOK {
		return url, gran, resolveOK
	}
	if st == resolveBlocked {
		return "", "", resolveBlocked
	}

	// Search missed (or hit a transient error) — fall back to the index-page traversal.
	turl, tgran, tst := cr.resolveViaTraversal(ctx, t, caches, throttle)
	switch tst {
	case resolveOK:
		return turl, tgran, resolveOK
	case resolveBlocked:
		return "", "", resolveBlocked
	case resolveErr:
		return "", "", resolveErr
	}
	// Both paths missed. Surface a transient search error as retryable; otherwise a
	// definitive miss (→ 'notfound').
	if st == resolveErr {
		return "", "", resolveErr
	}
	return "", "", resolveMiss
}

// resolveViaTraversal is the FALLBACK resolver: it drills the site's suburb → street
// → property index pages. It resolves a specific property link (a specific PID), so a
// hit is "exact". throttle paces each NETWORK fetch (cache hits neither fetch nor
// sleep).
func (cr *crawler) resolveViaTraversal(ctx context.Context, t propertyTarget, caches *propertyResolveCaches, throttle func()) (string, string, resolveStatus) {
	number, name := splitStreetNumber(streetPart(t.displayAddress, t.suburb))
	if number == "" || name == "" || t.suburb == "" || t.stateCode == "" || t.postcode == "" {
		return "", "", resolveMiss // no usable street number/name — not resolvable
	}

	streetURL, st := cr.findStreetURL(ctx, t, name, caches, throttle)
	if st != resolveOK {
		return "", "", st
	}
	if streetURL == "" {
		return "", "", resolveMiss
	}

	props, st := cr.streetProperties(ctx, streetURL, caches, throttle)
	if st != resolveOK {
		return "", "", st
	}
	if path, ok := matchStreetProperty(props, number); ok {
		return propertyOrigin + path, "exact", resolveOK
	}
	return "", "", resolveMiss // street resolved, but our number isn't listed on it
}

// findStreetURL finds the authoritative street-page URL for a street: the suburb
// page's own link (which encodes the real abbreviation), falling back to an
// abbrev-map-constructed URL when the suburb page can't be fetched or doesn't carry
// the street.
func (cr *crawler) findStreetURL(ctx context.Context, t propertyTarget, streetName string, caches *propertyResolveCaches, throttle func()) (string, resolveStatus) {
	suburbURL := buildSuburbURL(t.stateCode, t.suburb, t.postcode)
	streets, st := cr.suburbStreets(ctx, suburbURL, caches, throttle)
	if st == resolveBlocked || st == resolveErr {
		// A block must short-circuit. A transient suburb-page error still lets us try
		// the abbrev fallback below (don't waste the whole address on it).
		if st == resolveBlocked {
			return "", resolveBlocked
		}
	} else if path, ok := matchSuburbStreet(streets, streetName); ok {
		return propertyOrigin + path, resolveOK
	}
	// Fallback: construct via the abbrev map (best-effort; a wrong abbrev yields a
	// street page with no matching properties → resolveMiss downstream).
	if seg := abbreviateStreetType(streetName); seg != "" {
		return buildStreetURL(t.stateCode, t.suburb, t.postcode, streetName), resolveOK
	}
	return "", resolveMiss
}

// suburbStreets fetches + parses (and caches) a suburb page's street links.
func (cr *crawler) suburbStreets(ctx context.Context, url string, caches *propertyResolveCaches, throttle func()) ([]suburbStreet, resolveStatus) {
	if v, ok := caches.suburb[url]; ok {
		return v, resolveOK
	}
	html, _, outcome, _ := cr.fetchPropertyPage(ctx, url, throttle)
	if outcome == outcomeBlocked {
		return nil, resolveBlocked
	}
	if outcome == outcomeError {
		return nil, resolveErr
	}
	streets := parseSuburbStreets(string(html), pathOf(url))
	caches.suburb[url] = streets
	return streets, resolveOK
}

// streetProperties fetches + parses (and caches) a street page's property links.
func (cr *crawler) streetProperties(ctx context.Context, url string, caches *propertyResolveCaches, throttle func()) ([]streetProperty, resolveStatus) {
	if v, ok := caches.street[url]; ok {
		return v, resolveOK
	}
	html, _, outcome, _ := cr.fetchPropertyPage(ctx, url, throttle)
	if outcome == outcomeBlocked {
		return nil, resolveBlocked
	}
	if outcome == outcomeError {
		return nil, resolveErr
	}
	props := parseStreetProperties(string(html), pathOf(url))
	caches.street[url] = props
	return props, resolveOK
}

// fetchPropertyPage fetches one property.com.au page, paces via throttle, and folds
// an anti-bot STUB into a block (200-status, tiny, no payload — the same Kasada
// stub-as-block guard the profile fetch uses). The stub bool lets the profile path
// stat stubs separately.
func (cr *crawler) fetchPropertyPage(ctx context.Context, url string, throttle func()) (html []byte, finalURL string, outcome fetchOutcome, stub bool) {
	throttle()
	html, finalURL, outcome = cr.fetchPage(ctx, url)
	if outcome == outcomeOK && pageLooksStub(html, propertySource) {
		return html, finalURL, outcomeBlocked, true
	}
	return html, finalURL, outcome, false
}

// --- pure, testable URL builders + page parsers ---

func buildSuburbURL(state, suburb, postcode string) string {
	return fmt.Sprintf("%s/%s/%s-%s/", propertyOrigin, strings.ToLower(strings.TrimSpace(state)), slug(suburb), strings.TrimSpace(postcode))
}

// buildStreetURL constructs a street-page URL using the abbrev map. Returns "" when
// no street segment can be formed.
func buildStreetURL(state, suburb, postcode, streetName string) string {
	seg := abbreviateStreetType(streetName)
	if seg == "" {
		return ""
	}
	return fmt.Sprintf("%s/%s/%s-%s/%s/", propertyOrigin, strings.ToLower(strings.TrimSpace(state)), slug(suburb), strings.TrimSpace(postcode), seg)
}

// abbreviateStreetType slugs a street name, abbreviating its final type word via
// streetTypeAbbrev ("Example Road" → "example-rd"). An unknown type is left as-is
// (the suburb-page traversal corrects it).
func abbreviateStreetType(name string) string {
	fields := strings.Fields(strings.TrimSpace(name))
	if len(fields) == 0 {
		return ""
	}
	if len(fields) >= 2 {
		last := strings.ToLower(fields[len(fields)-1])
		if ab, ok := streetTypeAbbrev[last]; ok {
			fields[len(fields)-1] = ab
		}
	}
	return slug(strings.Join(fields, " "))
}

// streetNameNoType drops a trailing recognized type word ("Example Road" →
// "Example", "New Test Road" → "New Test"), so a street can be matched
// abbreviation-agnostically. An unrecognized final word is kept.
func streetNameNoType(name string) string {
	fields := strings.Fields(strings.TrimSpace(name))
	if len(fields) >= 2 {
		if _, ok := streetTypeAbbrev[strings.ToLower(fields[len(fields)-1])]; ok {
			return strings.Join(fields[:len(fields)-1], " ")
		}
	}
	return name
}

// streetSlugNamePart drops the trailing "-<abbrev>" token off a suburb-page street
// slug ("example-rd" → "example", "new-test-rd" → "new-test").
func streetSlugNamePart(s string) string {
	if i := strings.LastIndex(s, "-"); i > 0 {
		return s[:i]
	}
	return s
}

// streetNumberRe captures a leading street number (incl. a unit "5/40" or a suffixed
// "1a") off the unit+street portion of a display address.
var streetNumberRe = regexp.MustCompile(`^\s*(\d+[a-zA-Z]?(?:\s*/\s*\d+[a-zA-Z]?)?)\s+(.+?)\s*$`)

// splitStreetNumber splits "19 Example Road" → ("19","Example Road"),
// "5/40 Terrace Road" → ("5/40","Terrace Road"). When no leading number is present
// the number is "" and the whole input is the name.
func splitStreetNumber(street string) (number, name string) {
	m := streetNumberRe.FindStringSubmatch(street)
	if m == nil {
		return "", strings.TrimSpace(street)
	}
	return strings.TrimSpace(m[1]), strings.TrimSpace(m[2])
}

// matchSuburbStreet finds the street link whose slug matches the target street —
// first by exact slug (abbrev already applied), then abbreviation-agnostically by
// the name part ("example-rd" vs an "example" name).
func matchSuburbStreet(streets []suburbStreet, streetName string) (string, bool) {
	target := abbreviateStreetType(streetName)
	nameOnly := slug(streetNameNoType(streetName))
	for _, s := range streets {
		if s.slug == target {
			return s.path, true
		}
	}
	for _, s := range streets {
		if nameOnly != "" && streetSlugNamePart(s.slug) == nameOnly {
			return s.path, true
		}
	}
	return "", false
}

// matchStreetProperty finds the property link whose number segment matches the
// target street number (slugged, so "5/40" matches the link's "5-40").
func matchStreetProperty(props []streetProperty, number string) (string, bool) {
	seg := slug(number)
	if seg == "" {
		return "", false
	}
	for _, p := range props {
		if p.numberSeg == seg {
			return p.path, true
		}
	}
	return "", false
}

var (
	hrefRe = regexp.MustCompile(`href=["']([^"']+)["']`)
	// pidSegRe matches a property link's final segment "<number>-pid-<PID>".
	pidSegRe = regexp.MustCompile(`^([a-z0-9-]+)-pid-(\d+)$`)
	// streetSegRe matches a plain street slug (letters/digits/hyphens, no pid).
	streetSegRe = regexp.MustCompile(`^[a-z0-9-]+$`)
)

// parseStreetProperties extracts every property link under streetPath from a street
// page, deduped by pid. streetPath is the normalized street-page path
// ("/vic/sampleton-3999/example-rd/") used to scope out cross-street links.
func parseStreetProperties(html, streetPath string) []streetProperty {
	streetPath = ensureTrailingSlash(streetPath)
	seen := map[string]bool{}
	var out []streetProperty
	for _, m := range hrefRe.FindAllStringSubmatch(html, -1) {
		p := pathOf(m[1])
		if !strings.HasPrefix(p, streetPath) {
			continue
		}
		seg := strings.TrimSuffix(strings.TrimPrefix(p, streetPath), "/")
		sm := pidSegRe.FindStringSubmatch(seg)
		if sm == nil || seen[sm[2]] {
			continue
		}
		seen[sm[2]] = true
		out = append(out, streetProperty{path: p, numberSeg: sm[1], pid: sm[2]})
	}
	return out
}

// parseSuburbStreets extracts every street link under suburbPath from a suburb page,
// deduped by slug. suburbPath is the normalized suburb-page path
// ("/vic/sampleton-3999/"). Links carrying a "-pid-" (properties) or extra path segments
// are excluded.
func parseSuburbStreets(html, suburbPath string) []suburbStreet {
	suburbPath = ensureTrailingSlash(suburbPath)
	seen := map[string]bool{}
	var out []suburbStreet
	for _, m := range hrefRe.FindAllStringSubmatch(html, -1) {
		p := pathOf(m[1])
		if !strings.HasPrefix(p, suburbPath) {
			continue
		}
		seg := strings.TrimSuffix(strings.TrimPrefix(p, suburbPath), "/")
		if seg == "" || strings.Contains(seg, "/") || strings.Contains(seg, "-pid-") || !streetSegRe.MatchString(seg) {
			continue
		}
		if seen[seg] {
			continue
		}
		seen[seg] = true
		out = append(out, suburbStreet{path: p, slug: seg})
	}
	return out
}

// pathOf normalizes an href to a lowercased, trailing-slashed absolute path (scheme
// + host + query + fragment stripped).
func pathOf(href string) string {
	href = strings.ToLower(strings.TrimSpace(href))
	if i := strings.Index(href, "://"); i >= 0 {
		if j := strings.IndexByte(href[i+3:], '/'); j >= 0 {
			href = href[i+3+j:]
		} else {
			href = "/"
		}
	}
	if i := strings.IndexAny(href, "?#"); i >= 0 {
		href = href[:i]
	}
	if !strings.HasPrefix(href, "/") {
		href = "/" + href
	}
	return ensureTrailingSlash(href)
}

func ensureTrailingSlash(p string) string {
	if p == "" {
		return "/"
	}
	if !strings.HasSuffix(p, "/") {
		return p + "/"
	}
	return p
}

// --- PRIMARY: address search / autocomplete resolution ---

// suggestEndpoint is realestate.com.au's public consumer address autocomplete —
// the same service property.com.au's search box calls. A suggestion's `id` is the
// property.com.au profile PID (probe-confirmed).
const suggestEndpoint = "https://suggest.realestate.com.au/consumer-suggest/suggestions"

// suggestSource is the structured address on each suggestion. The fields we use are
// enough to BUILD the property.com.au profile URL directly.
type suggestSource struct {
	UnitNumber       string `json:"unitNumber"`       // "33" (unit) or "" (house)
	StreetNumber     string `json:"streetNumber"`     // "33/175" (unit) or "79" (house)
	StreetNumberFrom string `json:"streetNumberFrom"` // "175" — the base street number
	StreetName       string `json:"streetName"`       // "Kelletts Rd" (type already abbreviated)
	Suburb           string `json:"suburb"`
	State            string `json:"state"`
	Postcode         string `json:"postcode"`
}

// suggestItem is one autocomplete result. Type is one of
// address|suburb|postcode|state|region; we only resolve `address`. ID IS the
// property.com.au profile PID.
type suggestItem struct {
	ID     string        `json:"id"`
	Type   string        `json:"type"`
	Source suggestSource `json:"source"`
}

// suggestResponse is the HAL-shaped envelope the suggest service returns.
type suggestResponse struct {
	Embedded struct {
		Suggestions []suggestItem `json:"suggestions"`
	} `json:"_embedded"`
}

// addressParts is the unit / street-number / street-name decomposition of a portal
// display address, normalized for the suggest query + strict matching.
type addressParts struct {
	unit    string // normalized: leading zeros stripped ("033" -> "33"); "" if none
	number  string // street number, range collapsed to "N-M" ("51-53"); "" if none
	numFrom string // low end of a range, or the number itself ("51"); "" if none
	name    string // street name incl. its type word ("Kelletts Road")
}

var (
	// propNumberRe captures a leading street number (with an optional letter suffix
	// and an optional "-" range) then the street name.
	propNumberRe = regexp.MustCompile(`^(\d+[a-zA-Z]?(?:\s*-\s*\d+[a-zA-Z]?)?)\s+(.+)$`)
	rangeSepRe   = regexp.MustCompile(`\s*-\s*`)
)

// normUnit strips leading zeros off a unit token ("033" -> "33", "09 Ambrose" ->
// "9 Ambrose"), keeping a lone "0". Zero-padding is exactly what makes the raw prod
// unit prefixes ("033/", "06/") fail the suggest query, so we always normalize.
func normUnit(s string) string {
	s = strings.TrimSpace(s)
	t := strings.TrimLeft(s, "0")
	if t == "" && s != "" {
		return "0"
	}
	return t
}

// parseAddressParts decomposes the unit+street portion of a display address (i.e.
// the streetPart(), suburb suffix already stripped) into its unit / number / name.
// Handles unit prefixes ("033/175 Kelletts Road"), padded/spaced units
// ("06/ 88 Menser Street"), and street-number ranges ("1/51-53 Sheffield Street").
func parseAddressParts(streetPortion string) addressParts {
	s := strings.Join(strings.Fields(streetPortion), " ") // collapse all whitespace
	var unit, rest string
	if i := strings.IndexByte(s, '/'); i >= 0 {
		unit = normUnit(s[:i])
		rest = strings.TrimSpace(s[i+1:])
	} else {
		rest = s
	}
	m := propNumberRe.FindStringSubmatch(rest)
	if m == nil {
		return addressParts{unit: unit, name: strings.TrimSpace(rest)}
	}
	number := rangeSepRe.ReplaceAllString(strings.TrimSpace(m[1]), "-")
	numFrom := number
	if i := strings.IndexByte(numFrom, '-'); i >= 0 {
		numFrom = numFrom[:i]
	}
	return addressParts{unit: unit, number: number, numFrom: numFrom, name: strings.TrimSpace(m[2])}
}

// buildSuggestQuery forms the free-text address query the suggest service parses.
// withUnit=true prepends the (normalized) unit so the exact unit ranks first;
// withUnit=false is the base-street / house form.
func buildSuggestQuery(p addressParts, suburb, state, postcode string, withUnit bool) string {
	var street string
	switch {
	case withUnit && p.unit != "" && p.number != "":
		street = p.unit + "/" + p.number + " " + p.name
	case p.number != "":
		street = p.number + " " + p.name
	default:
		street = p.name
	}
	q := strings.TrimSpace(street)
	if suburb != "" {
		q += ", " + strings.TrimSpace(suburb)
	}
	if state != "" {
		q += " " + strings.ToUpper(strings.TrimSpace(state))
	}
	if postcode != "" {
		q += " " + strings.TrimSpace(postcode)
	}
	return strings.Join(strings.Fields(q), " ")
}

// buildSuggestURL encodes a suggest request for a query (comma in `type` -> %2C,
// spaces in `query` -> +, exactly as the site emits).
func buildSuggestURL(query string) string {
	v := url.Values{}
	v.Set("max", "8")
	v.Set("type", "address,suburb,postcode,state,region")
	v.Set("src", "reax-multi-intent-search-modal")
	v.Set("query", query)
	return suggestEndpoint + "?" + v.Encode()
}

// addressTarget is the FULL target address a suggestion must agree with — not just
// the unit + street number, but the street NAME, suburb, postcode and state too. The
// suggest API is fuzzy and its NEAREST-NEIGHBOUR fallback (fired exactly when the
// exact address isn't indexed) will happily return a same-number property on a
// DIFFERENT street or in a DIFFERENT suburb/postcode. Matching on the number alone
// would then attribute the WRONG property's valuation to this target, so every axis
// is checked.
type addressTarget struct {
	parts    addressParts // unit / number / numFrom / street name
	suburb   string
	state    string
	postcode string
}

// streetTypeCanon maps every street-type token (both the full word and its URL
// abbreviation) to a single canonical form, so "Kelletts Road" and "Kelletts Rd"
// normalize equal — while "Park Road" and "Park Street" stay DISTINCT (they
// canonicalize to different types). Built from streetTypeAbbrev (full -> abbrev).
var streetTypeCanon = func() map[string]string {
	m := make(map[string]string, len(streetTypeAbbrev)*2)
	for full, ab := range streetTypeAbbrev {
		m[full] = ab
		m[ab] = ab
	}
	return m
}()

// normStreetName canonicalizes a street name for comparison: lower-case, slug, with
// the trailing type token folded to its canonical form (full<->abbrev). An unknown
// final token is kept as-is, so two truly-different streets never collide.
func normStreetName(name string) string {
	fields := strings.Fields(strings.ToLower(strings.TrimSpace(name)))
	if len(fields) == 0 {
		return ""
	}
	if canon, ok := streetTypeCanon[fields[len(fields)-1]]; ok {
		fields[len(fields)-1] = canon
	}
	return slug(strings.Join(fields, " "))
}

// suggestionAddressAgrees reports whether an address suggestion is the SAME physical
// street address as the target on every non-number axis: street name (abbrev-
// normalized), suburb, postcode and state. This is the wrong-property guard — a
// number-only agreement is NEVER sufficient.
func suggestionAddressAgrees(it suggestItem, tgt addressTarget) bool {
	if it.Type != "address" {
		return false
	}
	if normStreetName(it.Source.StreetName) != normStreetName(tgt.parts.name) {
		return false
	}
	if slug(it.Source.Suburb) != slug(tgt.suburb) {
		return false
	}
	if strings.TrimSpace(it.Source.Postcode) != strings.TrimSpace(tgt.postcode) {
		return false
	}
	if !strings.EqualFold(strings.TrimSpace(it.Source.State), strings.TrimSpace(tgt.state)) {
		return false
	}
	return true
}

// matchSuggestion picks the best address suggestion for the target. Beyond the base
// street number agreeing (streetNumberFrom == numFrom — the fuzzy near-number
// guard), it REQUIRES the full address to agree (suggestionAddressAgrees: street
// name AND suburb AND postcode AND state) so a nearest-neighbour on a different
// street/suburb can never match. Suggestions are already RANKED, so the first
// agreeing match is the top-ranked one. Preference: exact unit, then the base street
// number (a unit-less property at that number — the exact property for a plain
// house, or the building-level fallback for a unit whose exact number isn't indexed).
// The returned how is "exact-unit" | "base-street"; matchGranularity maps it to the
// stored granularity.
func matchSuggestion(items []suggestItem, tgt addressTarget) (suggestItem, string, bool) {
	p := tgt.parts
	if p.numFrom == "" {
		return suggestItem{}, "", false
	}
	if p.unit != "" {
		for _, it := range items {
			if !suggestionAddressAgrees(it, tgt) {
				continue
			}
			if normUnit(it.Source.UnitNumber) == p.unit && it.Source.StreetNumberFrom == p.numFrom {
				return it, "exact-unit", true
			}
		}
	}
	for _, it := range items {
		if !suggestionAddressAgrees(it, tgt) || it.Source.UnitNumber != "" {
			continue
		}
		if it.Source.StreetNumberFrom == p.numFrom || it.Source.StreetNumber == p.number {
			return it, "base-street", true
		}
	}
	return suggestItem{}, "", false
}

// matchGranularity maps a matchSuggestion `how` + whether the target named a unit to
// the stored valuation_granularity: "building" when a UNIT target fell back to the
// base building (a whole-building AVM, NOT unit-precise — must never be consumed as
// unit-precise), else "exact" (a house resolved to its own profile, or a unit
// resolved to its exact unit profile).
func matchGranularity(how string, targetHasUnit bool) string {
	if how == "base-street" && targetHasUnit {
		return "building"
	}
	return "exact"
}

// buildProfileURLFromSource constructs the property.com.au profile URL from a
// suggestion's structured source + its id (the PID). streetName is already
// type-abbreviated ("Kelletts Rd" -> "kelletts-rd"); a slight mismatch would still
// 301 to canonical by PID, but we build it right. Returns "" if any component is
// missing.
func buildProfileURLFromSource(s suggestSource, id string) string {
	state := slug(s.State)
	suburb := slug(s.Suburb)
	postcode := strings.TrimSpace(s.Postcode)
	street := slug(s.StreetName)
	number := slug(s.StreetNumber)
	if state == "" || suburb == "" || postcode == "" || street == "" || number == "" || strings.TrimSpace(id) == "" {
		return ""
	}
	return fmt.Sprintf("%s/%s/%s-%s/%s/%s-pid-%s/", propertyOrigin, state, suburb, postcode, street, number, strings.TrimSpace(id))
}

// extractSuggestJSON pulls the JSON body out of a fetched suggest response. When the
// browser NAVIGATES to a JSON endpoint it wraps the body in <pre>...</pre>; a raw
// fixture file is already bare JSON. Slicing first '{' .. last '}' handles both, and
// the response has no other braces before the payload.
func extractSuggestJSON(html []byte) []byte {
	i := bytes.IndexByte(html, '{')
	j := bytes.LastIndexByte(html, '}')
	if i < 0 || j <= i {
		return nil
	}
	return html[i : j+1]
}

// parseSuggestResponse extracts + unmarshals the suggest JSON. ok=false when no JSON
// body was present or it didn't parse (treated as a soft miss, not a block).
func parseSuggestResponse(html []byte) ([]suggestItem, bool) {
	body := extractSuggestJSON(html)
	if body == nil {
		return nil, false
	}
	var r suggestResponse
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, false
	}
	return r.Embedded.Suggestions, true
}

// fetchSuggestions fetches + parses (and caches) the suggest response for a query.
// It routes through cr.fetchPage (NOT fetchPropertyPage): a suggest response is a
// few KB of JSON — below the profile stub SIZE FLOOR (reaWarmMinBytes) — so the
// profile stub-as-block guard would false-flag it. looksBlocked (challenge markers)
// still applies, so a real Kasada interstitial is still caught as a block.
func (cr *crawler) fetchSuggestions(ctx context.Context, query string, caches *propertyResolveCaches, throttle func()) ([]suggestItem, resolveStatus) {
	if query == "" {
		return nil, resolveMiss
	}
	if v, ok := caches.search[query]; ok {
		return v, resolveOK
	}
	throttle()
	html, _, outcome := cr.fetchPage(ctx, buildSuggestURL(query))
	switch outcome {
	case outcomeBlocked:
		return nil, resolveBlocked
	case outcomeError:
		return nil, resolveErr
	}
	items, ok := parseSuggestResponse(html)
	if !ok {
		return nil, resolveMiss // a 200 that isn't the expected JSON: soft miss, don't trip the breaker
	}
	caches.search[query] = items
	return items, resolveOK
}

// resolveViaSearch is the PRIMARY resolver: it resolves an arbitrary (often
// unit-heavy / zero-padded) display address straight to its property.com.au profile
// URL via the address autocomplete. It emits at most two suggest fetches: the
// unit-form query (when the address has a unit) for an exact-unit match, then the
// base-street-form query as the fallback (and the sole query for a plain house). It
// returns the resolved URL, the match GRANULARITY ("exact" | "building"), and the
// status. Every match is verified against the FULL target address (street name +
// suburb + postcode + state), so a fuzzy nearest-neighbour is never accepted.
func (cr *crawler) resolveViaSearch(ctx context.Context, t propertyTarget, caches *propertyResolveCaches, throttle func()) (string, string, resolveStatus) {
	if t.suburb == "" || t.stateCode == "" || t.postcode == "" {
		return "", "", resolveMiss
	}
	tgt := addressTarget{
		parts:    parseAddressParts(streetPart(t.displayAddress, t.suburb)),
		suburb:   t.suburb,
		state:    t.stateCode,
		postcode: t.postcode,
	}
	if tgt.parts.numFrom == "" {
		return "", "", resolveMiss // no usable street number → search can't disambiguate
	}

	sawErr := false
	resolve := func(withUnit bool) (string, string, resolveStatus, bool) {
		items, st := cr.fetchSuggestions(ctx, buildSuggestQuery(tgt.parts, t.suburb, t.stateCode, t.postcode, withUnit), caches, throttle)
		switch st {
		case resolveBlocked:
			return "", "", resolveBlocked, true
		case resolveErr:
			sawErr = true
			return "", "", resolveErr, false
		}
		if it, how, ok := matchSuggestion(items, tgt); ok {
			if u := buildProfileURLFromSource(it.Source, it.ID); u != "" {
				return u, matchGranularity(how, tgt.parts.unit != ""), resolveOK, true
			}
		}
		return "", "", resolveMiss, false
	}

	// Query 1: unit form — surfaces the exact unit as the top suggestion.
	if tgt.parts.unit != "" {
		if u, gran, st, done := resolve(true); done {
			return u, gran, st
		}
	}

	// Query 2: street-number form — base-building fallback (also the primary query
	// for a plain house, and the catch for a spurious "unit" on a house).
	if u, gran, st, done := resolve(false); done {
		return u, gran, st
	}

	// No match. A transient fetch error is retryable; otherwise let the caller try
	// the traversal fallback on a clean miss.
	if sawErr {
		return "", "", resolveErr
	}
	return "", "", resolveMiss
}

// propertyNotFoundMarkers are phrases confirmed on the REAL property.com.au 404 page
// (~93KB, no ArgonautExchange). Conservative: a false positive only stamps a
// 'notfound' row (re-tried after the TTL), never corrupts a real estimate.
var propertyNotFoundMarkers = []string{
	"page not found",
	"can't find that page for you", // straight apostrophe
	"can’t find that page for you", // curly apostrophe (the live wording)
}

// isProfileNotFound reports whether a fetched profile page is NOT a real profile: it
// carries a 404 marker, or its final URL bounced to a not-found/search path. A
// missing final URL trusts ONLY the page markers.
func isProfileNotFound(finalURL string, html []byte) bool {
	lower := strings.ToLower(string(html))
	for _, m := range propertyNotFoundMarkers {
		if strings.Contains(lower, m) {
			return true
		}
	}
	u := strings.ToLower(strings.TrimSpace(finalURL))
	if u == "" {
		return false
	}
	if strings.Contains(u, "property-not-found") || strings.Contains(u, "/not-found") || strings.Contains(u, "/404") {
		return true
	}
	if isPropertyURL(u) && (strings.Contains(u, "/find") || strings.Contains(u, "/search") || strings.Contains(u, "?q=")) {
		return true
	}
	return false
}

func isPropertyURL(u string) bool {
	return strings.Contains(u, "property.com.au")
}

// profileAddressMatchesTarget is the DEFENCE-IN-DEPTH check run after a profile is
// fetched, before its valuation is stored: it confirms the profile URL's
// /{state}/{suburb}-{postcode}/ segment actually equals the target's. Even though
// matchSuggestion already verifies the suggestion's address, a PID whose canonical
// property.com.au address disagrees with the suggestion (a data inconsistency, or a
// 301 that landed elsewhere) is caught here — so a mismatched valuation is NEVER
// attributed to the target. It prefers the post-redirect finalURL (the canonical),
// falling back to the URL we built. An unparseable/non-profile URL returns true (it
// can't disprove the match — the suggest guard already verified the address), so this
// only ever REJECTS a CLEAR state/suburb/postcode mismatch.
func profileAddressMatchesTarget(finalURL, builtURL string, t propertyTarget) bool {
	want := slug(t.stateCode) + "/" + slug(t.suburb) + "-" + strings.TrimSpace(t.postcode)
	for _, u := range []string{finalURL, builtURL} {
		if !isPropertyURL(strings.ToLower(u)) {
			continue
		}
		state, subPc, ok := profileURLStateSuburb(u)
		if !ok {
			continue // not a parseable profile path — can't disprove
		}
		return state+"/"+subPc == want
	}
	return true // no parseable profile URL to check against — trust the suggest guard
}

// profileURLStateSuburb pulls the leading {state}/{suburb-postcode} out of a
// property.com.au profile URL path. ok=false when the path isn't the expected
// profile shape.
func profileURLStateSuburb(profileURL string) (state, suburbPostcode string, ok bool) {
	segs := strings.Split(strings.Trim(pathOf(profileURL), "/"), "/")
	if len(segs) < 4 || segs[0] == "" || segs[1] == "" {
		return "", "", false // want at least {state}/{suburb-pc}/{street}/{number-pid-…}
	}
	return segs[0], segs[1], true
}
