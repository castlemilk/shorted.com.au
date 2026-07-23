package main

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

// property.com.au profile-URL RESOLUTION (Phase-0 probe-confirmed).
//
// A property profile lives at /{state}/{suburb}-{postcode}/{street-abbrev}/{number}-pid-{PID}/.
// The PID is property.com.au's INTERNAL id, which we do NOT have and a constructed
// slug can NEVER yield — so a pure slug builder (the original scaffold's guess) can't
// reach a profile. Instead we TRAVERSE the site's own index pages, which is exactly
// how a user drills in:
//
//   1. Suburb page  /{state}/{suburb}-{postcode}/            lists every STREET link
//      (/{state}/{suburb}-{postcode}/{street-abbrev}/). This is AUTHORITATIVE for the
//      street-type abbreviation, which is NOT reliably derivable: the live data shows
//      Lane abbreviates to "lane" (not "ln") and Crescent to BOTH "cr" and "cres" on
//      the same suburb page.
//   2. Street page  /{state}/{suburb}-{postcode}/{street}/   lists every PROPERTY
//      link with its /{number}-pid-{PID}/ path.
//   3. Match our street number against the street page → the profile URL (with PID).
//
// So resolution is suburb-page-first (reliable), with a street-abbrev map as a
// best-effort FALLBACK only (used when the suburb page can't be fetched or doesn't
// carry the street). No GraphQL is needed — the street/suburb pages are plain SSR.

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
}

func newPropertyResolveCaches() *propertyResolveCaches {
	return &propertyResolveCaches{
		suburb: map[string][]suburbStreet{},
		street: map[string][]streetProperty{},
	}
}

// resolveProfile turns a seed address into its property.com.au profile URL by
// traversing suburb → street → property index pages. throttle paces each NETWORK
// fetch (cache hits neither fetch nor sleep).
func (cr *crawler) resolveProfile(ctx context.Context, t propertyTarget, caches *propertyResolveCaches, throttle func()) (string, resolveStatus) {
	number, name := splitStreetNumber(streetPart(t.displayAddress, t.suburb))
	if number == "" || name == "" || t.suburb == "" || t.stateCode == "" || t.postcode == "" {
		return "", resolveMiss // no usable street number/name — not resolvable
	}

	streetURL, st := cr.findStreetURL(ctx, t, name, caches, throttle)
	if st != resolveOK {
		return "", st
	}
	if streetURL == "" {
		return "", resolveMiss
	}

	props, st := cr.streetProperties(ctx, streetURL, caches, throttle)
	if st != resolveOK {
		return "", st
	}
	if path, ok := matchStreetProperty(props, number); ok {
		return propertyOrigin + path, resolveOK
	}
	return "", resolveMiss // street resolved, but our number isn't listed on it
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

// resolveViaSearch is a DOCUMENTED FALLBACK hook for property.com.au's address
// search/autocomplete resolution path. The traversal resolver (suburb → street →
// property) is the primary and proved sufficient in the Phase-0 probe, so this is an
// intentional no-op stub; wire it only if a future site change breaks traversal.
func resolveViaSearch(_ propertyTarget) (string, bool) {
	return "", false
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
