package houseprices

import (
	"context"
	"strings"
	"testing"
)

// All addresses/suburbs/streets/PIDs below are SYNTHETIC (invented) — they exercise
// the URL structure + street-type-abbreviation logic without embedding any captured
// data.

// TestPropertyStubTreatedAsBlock is the #333 regression carried into this tier: an
// anti-bot stub page (200-status, tiny, no payload) must be caught by pageLooksStub
// BEFORE extract — property.com.au is the SAME Kasada tenant as REA.
func TestPropertyStubTreatedAsBlock(t *testing.T) {
	stub := []byte(`<html><body><script>window.kpsdk={};</script>blocked</body></html>`)
	if !pageLooksStub(stub, propertySource) {
		t.Error("a tiny Kasada stub must be detected as a stub (→ block path, not stamped)")
	}
	if _, ok := extractPropertyProfile(string(stub)); ok {
		t.Error("the stub must not extract a payload")
	}
	real := propertyArgonautHTML(sampleProfile()) + strings.Repeat("<!-- padding to clear the 5KB size floor -->", 200)
	if pageLooksStub([]byte(real), propertySource) {
		t.Error("a real property.com.au profile page must not be flagged a stub")
	}
	if _, ok := extractPropertyProfile(real); !ok {
		t.Error("a real profile page must extract cleanly")
	}
}

func TestSplitStreetNumber(t *testing.T) {
	cases := []struct {
		in, num, name string
	}{
		{"19 Example Road", "19", "Example Road"},
		{"5/40 Sample Road", "5/40", "Sample Road"},
		{"1a Test Street", "1a", "Test Street"},
		{"Example Road", "", "Example Road"}, // no leading number
	}
	for _, c := range cases {
		num, name := splitStreetNumber(c.in)
		if num != c.num || name != c.name {
			t.Errorf("splitStreetNumber(%q) = (%q,%q), want (%q,%q)", c.in, num, name, c.num, c.name)
		}
	}
}

func TestAbbreviateStreetType(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"Example Road", "example-rd"},
		{"Test Street", "test-st"},
		{"Sample Avenue", "sample-ave"},
		{"Sample Crescent", "sample-cres"},
		{"Sample Lane", "sample-lane"}, // confirmed live: Lane→"lane", NOT "ln"
		{"New Test Road", "new-test-rd"},
		{"Foo Unknowntype", "foo-unknowntype"}, // unknown type kept, suburb traversal corrects
	}
	for _, c := range cases {
		if got := abbreviateStreetType(c.in); got != c.want {
			t.Errorf("abbreviateStreetType(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestBuildURLs(t *testing.T) {
	if got := buildSuburbURL("VIC", "Sampleton", "3999"); got != "https://www.property.com.au/vic/sampleton-3999/" {
		t.Errorf("suburb URL = %q", got)
	}
	if got := buildStreetURL("VIC", "Sampleton", "3999", "Example Road"); got != "https://www.property.com.au/vic/sampleton-3999/example-rd/" {
		t.Errorf("street URL = %q", got)
	}
	if got := buildStreetURL("QLD", "New Testville", "4999", "Sample Road"); got != "https://www.property.com.au/qld/new-testville-4999/sample-rd/" {
		t.Errorf("multi-word suburb street URL = %q", got)
	}
}

// synthetic street page mirroring the link shape /{...}/{num}-pid-{PID}/.
func streetPageHTML() string {
	links := []string{
		"/vic/sampleton-3999/example-rd/19-pid-100001/",
		"/vic/sampleton-3999/example-rd/1a-pid-100002/",
		"/vic/sampleton-3999/example-rd/1-43-pid-100003/",                                // unit 1/43
		"https://www.property.com.au/vic/sampleton-3999/example-rd/10-pid-100004/?utm=x", // absolute + query
		"/vic/sampleton-3999/example-rd/19-pid-100001/",                                  // dup pid — collapsed
		"/vic/othertown-1234/other-rd/5-pid-100099/",                                     // different street — excluded by scope
	}
	var b strings.Builder
	b.WriteString("<html><body>")
	for _, l := range links {
		b.WriteString(`<a href="` + l + `">x</a>`)
	}
	b.WriteString("</body></html>")
	return b.String()
}

func TestParseStreetProperties(t *testing.T) {
	props := parseStreetProperties(streetPageHTML(), "/vic/sampleton-3999/example-rd/")
	if len(props) != 4 { // 19, 1a, 1-43, 10 (dup collapsed, cross-street excluded)
		t.Fatalf("parsed %d street properties, want 4: %+v", len(props), props)
	}
	if path, ok := matchStreetProperty(props, "19"); !ok || path != "/vic/sampleton-3999/example-rd/19-pid-100001/" {
		t.Errorf("match 19 = %q ok=%v", path, ok)
	}
	if path, ok := matchStreetProperty(props, "5/40"); ok {
		t.Errorf("match 5/40 should fail (not on street), got %q", path)
	}
	if path, ok := matchStreetProperty(props, "1/43"); !ok || path != "/vic/sampleton-3999/example-rd/1-43-pid-100003/" {
		t.Errorf("match unit 1/43 = %q ok=%v (want the 1-43 link)", path, ok)
	}
}

// synthetic suburb page mirroring the street-link shape /{state}/{suburb}-{pc}/{street}/.
func suburbPageHTML() string {
	links := []string{
		"/vic/sampleton-3999/example-rd/",
		"/vic/sampleton-3999/sample-lane/",              // Lane→lane
		"/vic/sampleton-3999/test-cr/",                  // Crescent→cr (the other variant)
		"/vic/sampleton-3999/example-rd/19-pid-100001/", // a property link — excluded
		"/vic/sampleton-3999/",                          // the suburb itself — excluded (no street segment)
		"/vic/othertown-1234/foo-st/",                   // different suburb — excluded by scope
	}
	var b strings.Builder
	b.WriteString("<html><body>")
	for _, l := range links {
		b.WriteString(`<a href="` + l + `">x</a>`)
	}
	b.WriteString("</body></html>")
	return b.String()
}

func TestParseSuburbStreets(t *testing.T) {
	streets := parseSuburbStreets(suburbPageHTML(), "/vic/sampleton-3999/")
	if len(streets) != 3 { // example-rd, sample-lane, test-cr
		t.Fatalf("parsed %d suburb streets, want 3: %+v", len(streets), streets)
	}
	// Exact-slug match.
	if path, ok := matchSuburbStreet(streets, "Example Road"); !ok || path != "/vic/sampleton-3999/example-rd/" {
		t.Errorf("match Example Road = %q ok=%v", path, ok)
	}
	// Lane→lane: exact via abbrev map.
	if path, ok := matchSuburbStreet(streets, "Sample Lane"); !ok || path != "/vic/sampleton-3999/sample-lane/" {
		t.Errorf("match Sample Lane = %q ok=%v", path, ok)
	}
	// Crescent→"cr" on the page but our abbrev map yields "cres" → name-part fallback
	// matches abbreviation-agnostically. This is the real cr/cres inconsistency.
	if path, ok := matchSuburbStreet(streets, "Test Crescent"); !ok || path != "/vic/sampleton-3999/test-cr/" {
		t.Errorf("match Test Crescent (cr/cres variance) = %q ok=%v", path, ok)
	}
}

// --- address SEARCH resolver (PRIMARY path) ---
// All addresses/units/PIDs below are SYNTHETIC; they exercise the parse/query/match/
// URL-build logic against the confirmed suggest response SHAPE without embedding any
// captured portal data.

func TestParseAddressParts(t *testing.T) {
	cases := []struct {
		in, unit, number, numFrom, name string
	}{
		{"033/175 Kelletts Road", "33", "175", "175", "Kelletts Road"},       // zero-padded unit
		{"6/45 Wheatley Street", "6", "45", "45", "Wheatley Street"},         // plain unit
		{"06/ 88 Menser Street", "6", "88", "88", "Menser Street"},           // space after slash
		{"06/6  Josling Street", "6", "6", "6", "Josling Street"},            // double space
		{"1/51-53 Sheffield Street", "1", "51-53", "51", "Sheffield Street"}, // street-number range
		{"19 Badajoz Road", "", "19", "19", "Badajoz Road"},                  // house, no unit
		{"1a Test Street", "", "1a", "1a", "Test Street"},                    // letter suffix
		{"Example Road", "", "", "", "Example Road"},                         // no number
	}
	for _, c := range cases {
		p := parseAddressParts(c.in)
		if p.unit != c.unit || p.number != c.number || p.numFrom != c.numFrom || p.name != c.name {
			t.Errorf("parseAddressParts(%q) = {unit:%q number:%q numFrom:%q name:%q}, want {unit:%q number:%q numFrom:%q name:%q}",
				c.in, p.unit, p.number, p.numFrom, p.name, c.unit, c.number, c.numFrom, c.name)
		}
	}
}

func TestNormUnit(t *testing.T) {
	cases := []struct{ in, want string }{
		{"033", "33"}, {"06", "6"}, {"0", "0"}, {"00", "0"}, {"7", "7"}, {"100", "100"}, {"09 Ambrose", "9 Ambrose"},
	}
	for _, c := range cases {
		if got := normUnit(c.in); got != c.want {
			t.Errorf("normUnit(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestBuildSuggestQuery(t *testing.T) {
	p := parseAddressParts("033/175 Kelletts Road")
	if got := buildSuggestQuery(p, "Rowville", "vic", "3178", true); got != "33/175 Kelletts Road, Rowville VIC 3178" {
		t.Errorf("unit query = %q", got)
	}
	if got := buildSuggestQuery(p, "Rowville", "vic", "3178", false); got != "175 Kelletts Road, Rowville VIC 3178" {
		t.Errorf("street query = %q", got)
	}
	house := parseAddressParts("19 Badajoz Road")
	if got := buildSuggestQuery(house, "Ryde", "NSW", "2112", true); got != "19 Badajoz Road, Ryde NSW 2112" {
		t.Errorf("house query (withUnit, no unit) = %q", got)
	}
}

func TestBuildSuggestURL(t *testing.T) {
	got := buildSuggestURL("33/175 Kelletts Road, Rowville VIC 3178")
	for _, want := range []string{
		suggestEndpoint + "?",
		"max=8",
		"type=address%2Csuburb%2Cpostcode%2Cstate%2Cregion",
		"query=33%2F175+Kelletts+Road%2C+Rowville+VIC+3178",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("suggest URL %q missing %q", got, want)
		}
	}
}

func TestBuildProfileURLFromSource(t *testing.T) {
	// house
	s := suggestSource{StreetNumber: "19", StreetName: "Badajoz Rd", Suburb: "Ryde", State: "NSW", Postcode: "2112"}
	if got := buildProfileURLFromSource(s, "94337"); got != "https://www.property.com.au/nsw/ryde-2112/badajoz-rd/19-pid-94337/" {
		t.Errorf("house profile URL = %q", got)
	}
	// unit — streetNumber "33/175" slugs to "33-175"
	u := suggestSource{UnitNumber: "33", StreetNumber: "33/175", StreetNumberFrom: "175", StreetName: "Kelletts Rd", Suburb: "Rowville", State: "VIC", Postcode: "3178"}
	if got := buildProfileURLFromSource(u, "6535276"); got != "https://www.property.com.au/vic/rowville-3178/kelletts-rd/33-175-pid-6535276/" {
		t.Errorf("unit profile URL = %q", got)
	}
	// missing component → ""
	if got := buildProfileURLFromSource(suggestSource{StreetNumber: "1", StreetName: "Foo St", Suburb: "Bar", State: "VIC"}, "1"); got != "" {
		t.Errorf("missing postcode should yield empty URL, got %q", got)
	}
	if got := buildProfileURLFromSource(s, ""); got != "" {
		t.Errorf("missing id should yield empty URL, got %q", got)
	}
}

// at builds an addressTarget from a display street portion + canonical suburb/state/
// postcode — the shape matchSuggestion verifies against.
func at(display, suburb, state, postcode string) addressTarget {
	return addressTarget{parts: parseAddressParts(display), suburb: suburb, state: state, postcode: postcode}
}

// syntheticSuggestJSON builds a suggest-shaped response for a street-number query at
// "175 Kelletts Rd, Rowville VIC 3178": the base street property + the exact unit,
// plus THREE nearest-neighbour decoys the fuzzy suggester really returns — a
// different STREET-NUMBER ("33/191"), a same-number different STREET ("175 Blaxland
// Rd"), and a same-street/number in a different SUBURB/postcode ("175 Kelletts Rd,
// Lysterfield 3179"). Each must be rejected.
func syntheticSuggestJSON() string {
	return `{"_embedded":{"suggestions":[
		{"id":"5000001","type":"address","source":{"streetNumber":"175","streetNumberFrom":"175","streetName":"Kelletts Rd","suburb":"Rowville","state":"VIC","postcode":"3178"}},
		{"id":"5000002","type":"address","source":{"unitNumber":"33","streetNumber":"33/175","streetNumberFrom":"175","streetName":"Kelletts Rd","suburb":"Rowville","state":"VIC","postcode":"3178"}},
		{"id":"5000003","type":"address","source":{"unitNumber":"33","streetNumber":"33/191","streetNumberFrom":"191","streetName":"Kelletts Rd","suburb":"Rowville","state":"VIC","postcode":"3178"}},
		{"id":"5000005","type":"address","source":{"streetNumber":"175","streetNumberFrom":"175","streetName":"Blaxland Rd","suburb":"Rowville","state":"VIC","postcode":"3178"}},
		{"id":"5000006","type":"address","source":{"streetNumber":"175","streetNumberFrom":"175","streetName":"Kelletts Rd","suburb":"Lysterfield","state":"VIC","postcode":"3179"}},
		{"id":"5000004","type":"suburb","source":{"suburb":"Rowville","state":"VIC","postcode":"3178"}}
	]}}`
}

func TestParseSuggestResponse(t *testing.T) {
	items, ok := parseSuggestResponse([]byte(syntheticSuggestJSON()))
	if !ok || len(items) != 6 {
		t.Fatalf("parse bare JSON: ok=%v items=%d", ok, len(items))
	}
	// browser-navigated JSON is wrapped in <pre>...</pre>; extraction must still work.
	wrapped := `<html><head><meta charset="utf-8"></head><body><pre>` + syntheticSuggestJSON() + `</pre></body></html>`
	items2, ok2 := parseSuggestResponse([]byte(wrapped))
	if !ok2 || len(items2) != 6 {
		t.Fatalf("parse <pre>-wrapped JSON: ok=%v items=%d", ok2, len(items2))
	}
	if _, ok := parseSuggestResponse([]byte("<html><body>not json</body></html>")); ok {
		t.Error("non-JSON page must not parse as a suggest response")
	}
}

func TestNormStreetName(t *testing.T) {
	// full word and abbreviation canonicalize equal…
	if normStreetName("Kelletts Road") != normStreetName("Kelletts Rd") {
		t.Error("Kelletts Road / Kelletts Rd must canonicalize equal")
	}
	// …but different TYPES stay distinct (Road vs Street).
	if normStreetName("Park Road") == normStreetName("Park Street") {
		t.Error("Park Road / Park Street must NOT collide")
	}
	// different NAMES stay distinct.
	if normStreetName("Kelletts Rd") == normStreetName("Blaxland Rd") {
		t.Error("Kelletts / Blaxland must not collide")
	}
}

func TestSuggestionAddressAgrees(t *testing.T) {
	kelletts := suggestItem{Type: "address", Source: suggestSource{StreetName: "Kelletts Rd", Suburb: "Rowville", State: "VIC", Postcode: "3178"}}
	tgt := at("175 Kelletts Road", "Rowville", "VIC", "3178")
	if !suggestionAddressAgrees(kelletts, tgt) {
		t.Error("same address on every axis must agree")
	}
	// street name differs
	if suggestionAddressAgrees(suggestItem{Type: "address", Source: suggestSource{StreetName: "Blaxland Rd", Suburb: "Rowville", State: "VIC", Postcode: "3178"}}, tgt) {
		t.Error("different street must not agree")
	}
	// suburb differs
	if suggestionAddressAgrees(suggestItem{Type: "address", Source: suggestSource{StreetName: "Kelletts Rd", Suburb: "Lysterfield", State: "VIC", Postcode: "3178"}}, tgt) {
		t.Error("different suburb must not agree")
	}
	// postcode differs
	if suggestionAddressAgrees(suggestItem{Type: "address", Source: suggestSource{StreetName: "Kelletts Rd", Suburb: "Rowville", State: "VIC", Postcode: "3179"}}, tgt) {
		t.Error("different postcode must not agree")
	}
	// non-address type
	if suggestionAddressAgrees(suggestItem{Type: "suburb", Source: kelletts.Source}, tgt) {
		t.Error("a non-address suggestion must not agree")
	}
}

func TestMatchGranularity(t *testing.T) {
	if matchGranularity("exact-unit", true) != "exact" {
		t.Error("exact unit → exact")
	}
	if matchGranularity("base-street", false) != "exact" {
		t.Error("house on base street → exact")
	}
	if matchGranularity("base-street", true) != "building" {
		t.Error("unit fell back to base building → building")
	}
}

func TestMatchSuggestion(t *testing.T) {
	items, _ := parseSuggestResponse([]byte(syntheticSuggestJSON()))

	// exact unit 33 at streetNumberFrom 175 → id 5000002 (NOT the 33/191 decoy).
	if it, how, ok := matchSuggestion(items, at("033/175 Kelletts Road", "Rowville", "VIC", "3178")); !ok || it.ID != "5000002" || how != "exact-unit" {
		t.Errorf("exact-unit match = id %q how %q ok %v, want 5000002/exact-unit", it.ID, how, ok)
	}

	// a unit NOT indexed (unit 99) falls back to the base street property → id 5000001
	// (NOT the Blaxland-Rd or Lysterfield decoys — those fail the address guard).
	if it, how, ok := matchSuggestion(items, at("099/175 Kelletts Road", "Rowville", "VIC", "3178")); !ok || it.ID != "5000001" || how != "base-street" {
		t.Errorf("base-street fallback = id %q how %q ok %v, want 5000001/base-street", it.ID, how, ok)
	}

	// a plain house at 175 → base street property.
	if it, _, ok := matchSuggestion(items, at("175 Kelletts Road", "Rowville", "VIC", "3178")); !ok || it.ID != "5000001" {
		t.Errorf("house match = id %q ok %v, want 5000001", it.ID, ok)
	}

	// fuzzy-street-number guard: a unit whose ONLY suggestion is a different street
	// number (191 when we want 200) must NOT match.
	numberDecoy := []suggestItem{{ID: "9", Type: "address", Source: suggestSource{UnitNumber: "33", StreetNumber: "33/191", StreetNumberFrom: "191", StreetName: "Kelletts Rd", Suburb: "Rowville", State: "VIC", Postcode: "3178"}}}
	if _, _, ok := matchSuggestion(numberDecoy, at("33/200 Kelletts Road", "Rowville", "VIC", "3178")); ok {
		t.Error("a different streetNumberFrom must be rejected (fuzzy near-number guard)")
	}

	// WRONG-PROPERTY guard: a same-NUMBER suggestion on a DIFFERENT STREET must NOT
	// match (19 Blaxland Rd is not 19 Badajoz Rd).
	streetDecoy := []suggestItem{{ID: "9", Type: "address", Source: suggestSource{StreetNumber: "19", StreetNumberFrom: "19", StreetName: "Blaxland Rd", Suburb: "Ryde", State: "NSW", Postcode: "2112"}}}
	if _, _, ok := matchSuggestion(streetDecoy, at("19 Badajoz Road", "Ryde", "NSW", "2112")); ok {
		t.Error("a same-number different-STREET suggestion must be rejected (wrong-property guard)")
	}

	// WRONG-PROPERTY guard: a same-street/number in a DIFFERENT SUBURB/postcode must
	// NOT match (175 Kelletts Rd, Lysterfield 3179 ≠ Rowville 3178).
	suburbDecoy := []suggestItem{{ID: "9", Type: "address", Source: suggestSource{StreetNumber: "175", StreetNumberFrom: "175", StreetName: "Kelletts Rd", Suburb: "Lysterfield", State: "VIC", Postcode: "3179"}}}
	if _, _, ok := matchSuggestion(suburbDecoy, at("175 Kelletts Road", "Rowville", "VIC", "3178")); ok {
		t.Error("a same-street different-SUBURB/postcode suggestion must be rejected (wrong-property guard)")
	}
}

func TestProfileAddressMatchesTarget(t *testing.T) {
	tgt := propertyTarget{suburb: "Rowville", stateCode: "VIC", postcode: "3178"}
	// canonical final URL matches the target
	if !profileAddressMatchesTarget("https://www.property.com.au/vic/rowville-3178/kelletts-rd/33-175-pid-6535276/", "", tgt) {
		t.Error("matching canonical must pass")
	}
	// final URL in a DIFFERENT suburb/postcode → reject (wrong property)
	if profileAddressMatchesTarget("https://www.property.com.au/vic/lysterfield-3179/kelletts-rd/175-pid-9/", "", tgt) {
		t.Error("a different suburb/postcode canonical must be rejected")
	}
	// different STATE → reject
	if profileAddressMatchesTarget("https://www.property.com.au/nsw/rowville-3178/kelletts-rd/175-pid-9/", "", tgt) {
		t.Error("a different state canonical must be rejected")
	}
	// unparseable / non-profile URL → cannot disprove, must pass (guard already ran)
	if !profileAddressMatchesTarget("https://www.property.com.au/", "", tgt) {
		t.Error("a non-profile URL must not reject (can't disprove)")
	}
	// falls back to the built URL when finalURL isn't a profile path
	if !profileAddressMatchesTarget("", "https://www.property.com.au/vic/rowville-3178/kelletts-rd/33-175-pid-6535276/", tgt) {
		t.Error("must verify the built URL when finalURL is empty")
	}
}

// unitKellettsTarget is the SYNTHETIC unit-heavy prod-shaped address used by the
// search-flow tests (matches syntheticSuggestJSON's exact unit 33 at 175).
var unitKellettsTarget = propertyTarget{displayAddress: "033/175 Kelletts Road", suburb: "Rowville", stateCode: "VIC", postcode: "3178"}

// TestResolveViaSearch_Flow drives the search resolver end-to-end through the fake
// htmlFetcher: the <pre>-wrapped suggest JSON resolves the zero-padded unit "033/175"
// straight to its pid-bearing profile URL, and a repeat query is served from cache.
func TestResolveViaSearch_Flow(t *testing.T) {
	ff := &fakeFetcher{html: map[string]string{
		"consumer-suggest": `<html><body><pre>` + syntheticSuggestJSON() + `</pre></body></html>`,
	}}
	cr := newTestCrawler(ff, "")
	caches := newPropertyResolveCaches()
	noop := func() {}

	url, gran, st := cr.resolveViaSearch(context.Background(), unitKellettsTarget, caches, noop)
	if st != resolveOK || url != "https://www.property.com.au/vic/rowville-3178/kelletts-rd/33-175-pid-5000002/" {
		t.Fatalf("resolveViaSearch = %q %v, want the 33-175-pid-5000002 profile", url, st)
	}
	if gran != "exact" {
		t.Errorf("exact-unit resolution granularity = %q, want exact", gran)
	}
	before := len(ff.calls)
	if _, _, st := cr.resolveViaSearch(context.Background(), unitKellettsTarget, caches, noop); st != resolveOK {
		t.Fatalf("second resolveViaSearch status = %v", st)
	}
	if len(ff.calls) != before {
		t.Errorf("expected per-run cache hit (no new fetch), calls went %d -> %d", before, len(ff.calls))
	}
}

// TestResolveProfile_SearchIsPrimary proves search is the PRIMARY path: when it
// resolves, the traversal index pages are never fetched.
func TestResolveProfile_SearchIsPrimary(t *testing.T) {
	ff := &fakeFetcher{html: map[string]string{"consumer-suggest": syntheticSuggestJSON()}}
	cr := newTestCrawler(ff, "")

	url, _, st := cr.resolveProfile(context.Background(), unitKellettsTarget, newPropertyResolveCaches(), func() {})
	if st != resolveOK || !strings.Contains(url, "-pid-5000002/") {
		t.Fatalf("resolveProfile (search primary) = %q %v", url, st)
	}
	for _, c := range ff.calls {
		if !strings.Contains(c, "consumer-suggest") {
			t.Errorf("traversal fetched %q — it must not run when search resolves", c)
		}
	}
}

// TestResolveProfile_BlockShortCircuits ensures a blocked suggest fetch surfaces as a
// block (so the circuit breaker backs off) instead of silently falling to traversal.
func TestResolveProfile_BlockShortCircuits(t *testing.T) {
	ff := &fakeFetcher{blockOn: map[string]bool{"consumer-suggest": true}}
	cr := newTestCrawler(ff, "")
	if _, _, st := cr.resolveViaSearch(context.Background(), unitKellettsTarget, newPropertyResolveCaches(), func() {}); st != resolveBlocked {
		t.Errorf("blocked suggest fetch must yield resolveBlocked, got %v", st)
	}
	if _, _, st := cr.resolveProfile(context.Background(), unitKellettsTarget, newPropertyResolveCaches(), func() {}); st != resolveBlocked {
		t.Errorf("resolveProfile must surface the block, got %v", st)
	}
}

// TestResolveProfile_SearchMissTriesTraversal proves the traversal fallback is
// ATTEMPTED when the search API returns no match (a suburb-page fetch happens after
// the suggest fetch). The traversal PARSERS themselves are covered by
// TestParseSuburbStreets / TestParseStreetProperties.
func TestResolveProfile_SearchMissTriesTraversal(t *testing.T) {
	ff := &fakeFetcher{html: map[string]string{
		"consumer-suggest": `{"_embedded":{"suggestions":[]}}`, // search finds nothing
	}}
	cr := newTestCrawler(ff, "")
	tgt := propertyTarget{displayAddress: "19 Example Road", suburb: "Sampleton", stateCode: "VIC", postcode: "3999"}
	cr.resolveProfile(context.Background(), tgt, newPropertyResolveCaches(), func() {})

	sawSuggest, sawSuburb := false, false
	for _, c := range ff.calls {
		if strings.Contains(c, "consumer-suggest") {
			sawSuggest = true
		} else if strings.Contains(c, "/vic/sampleton-3999/") {
			sawSuburb = true
		}
	}
	if !sawSuggest {
		t.Error("search (suggest) must be tried first")
	}
	if !sawSuburb {
		t.Error("a search miss must fall back to the suburb-page traversal")
	}
}

func TestIsProfileNotFound(t *testing.T) {
	notFound := []byte("<html><body><h1>Page not found</h1><p>We can’t find that page for you - it has possibly been misplaced...</p></body></html>")
	healthy := []byte("<html><body>3 bed house, estimated value $1.35m</body></html>")

	cases := []struct {
		name     string
		finalURL string
		html     []byte
		want     bool
	}{
		{"real 404 markers", "", notFound, true},
		{"healthy profile, empty url", "", healthy, false},
		{"redirect to /find", "https://www.property.com.au/find?q=x", healthy, true},
		{"not-found path", "https://www.property.com.au/property-not-found", healthy, true},
		{"live profile url", "https://www.property.com.au/vic/sampleton-3999/example-rd/19-pid-100001/", healthy, false},
		{"non-property host", "https://example.com/anything", healthy, false},
	}
	for _, c := range cases {
		if got := isProfileNotFound(c.finalURL, c.html); got != c.want {
			t.Errorf("%s: isProfileNotFound(%q) = %v, want %v", c.name, c.finalURL, got, c.want)
		}
	}
}

func TestPreviewProperty(t *testing.T) {
	p := propertyProfile{
		EstimateLow:        f64p(1200000),
		EstimateMid:        f64p(1350000),
		EstimateHigh:       f64p(1500000),
		EstimateConfidence: "high",
		PropertyType:       "house",
		Bedrooms:           int16p(4),
		SalesHistory:       []saleRecord{{Date: "2024-03-06"}, {Date: "2015-02-02"}},
	}
	got := previewProperty(p)
	for _, want := range []string{"est=", "conf=high", "sales=2", "type=house", "beds=4"} {
		if !strings.Contains(got, want) {
			t.Errorf("preview %q missing %q", got, want)
		}
	}
	if previewProperty(propertyProfile{}) != "(no fields harvested)" {
		t.Errorf("empty preview = %q", previewProperty(propertyProfile{}))
	}
}

func TestNeedsRewarmStreak(t *testing.T) {
	if !needsRewarmStreak(2, 2) {
		t.Error("streak==threshold should signal rewarm")
	}
	if needsRewarmStreak(2, 1) {
		t.Error("streak below threshold should not signal")
	}
	if needsRewarmStreak(0, 5) {
		t.Error("a disabled breaker (maxConsec<=0) must never signal")
	}
}

func TestLoadPropertyConfig_Defaults(t *testing.T) {
	t.Setenv("CRAWL_DRY_RUN", "")
	t.Setenv("CRAWL_PROPERTY_MAX", "")
	t.Setenv("CRAWL_PROPERTY_TTL_DAYS", "")
	cfg := loadPropertyConfig()
	if !cfg.dryRun {
		t.Error("dryRun must default to true")
	}
	if cfg.maxItems != 200 {
		t.Errorf("maxItems = %d, want 200", cfg.maxItems)
	}
	if cfg.ttlDays != 90 {
		t.Errorf("ttlDays = %d, want 90", cfg.ttlDays)
	}
}
