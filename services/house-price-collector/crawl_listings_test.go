package main

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

// These tests are the listing tier's offline proof: the price-string semantics,
// schema-agnostic extraction, target/anti-poison gates, event generation, and —
// most importantly — the delist SAFETY (a partial/blocked sweep never delists)
// are all verified here, never against the live adversarial sites.

func TestParseAUPrice(t *testing.T) {
	f := func(p *float64) float64 {
		if p == nil {
			return -1
		}
		return *p
	}
	cases := []struct {
		in       string
		wantKind string
		wantLow  float64
		wantHigh float64
	}{
		{"$1,200,000", priceFixed, 1_200_000, -1},
		{"$1.2m", priceFixed, 1_200_000, -1},
		{"$985k", priceFixed, 985_000, -1},
		{"Offers over $1.2m", priceOffersOver, 1_200_000, -1},
		{"$1.2m - $1.4m", priceRangeLow, 1_200_000, 1_400_000},
		{"$1,200,000-$1,300,000", priceRangeLow, 1_200_000, 1_300_000},
		{"Auction", priceAuction, -1, -1},
		{"Auction this Saturday", priceAuction, -1, -1},
		{"Contact Agent", pricePOA, -1, -1},
		{"POA", pricePOA, -1, -1},
		{"Price on application", pricePOA, -1, -1},
		{"Under $900k", priceRangeHigh, -1, 900_000},
		{"Guide $2.3m", priceFixed, 2_300_000, -1},
		{"", priceUnknown, -1, -1},
		{"Just listed", pricePOA, -1, -1},
	}
	for _, c := range cases {
		low, high, kind := parseAUPrice(c.in)
		if kind != c.wantKind {
			t.Errorf("parseAUPrice(%q) kind=%q want %q", c.in, kind, c.wantKind)
		}
		if f(low) != c.wantLow || f(high) != c.wantHigh {
			t.Errorf("parseAUPrice(%q) low/high=%v/%v want %v/%v", c.in, f(low), f(high), c.wantLow, c.wantHigh)
		}
	}
}

func TestCanonicalPrice_RangeHighUsesHigh(t *testing.T) {
	low, high, kind := parseAUPrice("Under $900k")
	cp := canonicalPrice(low, high, kind)
	if cp == nil || *cp != 900_000 {
		t.Errorf("range_high canonical should be the high bound 900000, got %v", cp)
	}
}

func TestComparableKinds(t *testing.T) {
	if !comparableKinds(priceFixed, priceOffersOver) {
		t.Error("fixed vs offers_over should be comparable (both single-value asks)")
	}
	if !comparableKinds(priceRangeLow, priceRangeLow) {
		t.Error("range_low vs range_low should be comparable")
	}
	if comparableKinds(priceRangeLow, priceFixed) {
		t.Error("range_low vs fixed must NOT be comparable (avoids phantom moves)")
	}
	if comparableKinds(priceAuction, priceFixed) {
		t.Error("auction vs fixed must NOT be comparable")
	}
}

func TestExtractListings_DomainNextData(t *testing.T) {
	// Mirrors the REAL Domain search-page shape (verified 2026-07-12): listings are
	// a MAP keyed by id under componentProps.listingsMap.<id>.listingModel (the
	// object itself has NO id — it's recovered from the url); recent sales are an
	// ARRAY under UPVSoldListings tagged sold; "project" cards have no price.
	html := `<html><body><script id="__NEXT_DATA__" type="application/json">
	{"props":{"pageProps":{"componentProps":{
	  "listingsMap":{
	    "2019015084":{"listingModel":{"url":"/9-285-295-bondi-road-bondi-nsw-2026-2019015084","price":"For Sale $2.1m","features":{"beds":2,"baths":2,"parking":1,"propertyType":"ApartmentUnitFlat","landSize":0},"address":{"street":"9/285-295 Bondi Road","suburb":"Bondi","state":"NSW","postcode":"2026","lat":-33.895,"lng":151.269}}},
	    "2020346264":{"listingModel":{"url":"/6-1-7-andrews-avenue-bondi-nsw-2026-2020346264","price":"Contact Agent","features":{"beds":1,"baths":1},"address":{"street":"6/1-7 Andrews Avenue","suburb":"Bondi","state":"NSW","postcode":"2026"}}},
	    "6823":{"listingModel":{"url":"/project/6823/halcyon-bondi-nsw/","projectName":"Halcyon","displayAddress":"Halcyon, Bondi","address":{"suburb":"Bondi","postcode":"2026"}}}
	  },
	  "UPVSoldListings":[
	    {"listingModel":{"url":"/12-18-20-wellington-street-bondi-nsw-2026-2020524930","price":"$2,205,000","features":{"beds":3,"baths":2,"parking":1,"propertyType":"ApartmentUnitFlat","landSize":138},"address":{"street":"12/18-20 Wellington Street","suburb":"Bondi","state":"NSW","postcode":"2026"},"tags":{"tagText":"Sold","tagClassName":"is-sold"}}}
	  ]
	}}}}
	</script></body></html>`
	got := extractListings(docFrom(html), "domain")
	byID := map[string]RawListing{}
	for _, l := range got {
		byID[l.ListingID] = l
	}
	// 2 for-sale + 1 sold; the project (no price) is skipped.
	if len(got) != 3 {
		t.Fatalf("expected 3 listings (2 for-sale + 1 sold, project skipped), got %d: %+v", len(got), byID)
	}
	if _, ok := byID["6823"]; ok {
		t.Error("project card (no price) must be skipped")
	}

	a := byID["2019015084"]
	if a.ListingURL != "https://www.domain.com.au/9-285-295-bondi-road-bondi-nsw-2026-2019015084" {
		t.Errorf("url not absolutized: %q", a.ListingURL)
	}
	if a.PriceKind != priceFixed || a.PriceLow == nil || *a.PriceLow != 2_100_000 {
		t.Errorf("for-sale price wrong: kind=%s low=%v", a.PriceKind, a.PriceLow)
	}
	if a.Bedrooms == nil || *a.Bedrooms != 2 { // nested features.beds
		t.Errorf("for-sale beds wrong: %v", a.Bedrooms)
	}
	if a.CarSpaces == nil || *a.CarSpaces != 1 { // features.parking
		t.Errorf("for-sale car wrong: %v", a.CarSpaces)
	}
	if a.PropertyType != "ApartmentUnitFlat" { // features.propertyType
		t.Errorf("for-sale property type wrong: %q", a.PropertyType)
	}
	if a.Lat == nil || a.Lng == nil { // lat/lng under address
		t.Errorf("for-sale geo (from address) not captured: %v %v", a.Lat, a.Lng)
	}
	if a.Status != "for_sale" {
		t.Errorf("for-sale status wrong: %q", a.Status)
	}

	b := byID["2020346264"]
	if b.PriceKind != pricePOA || b.PriceLow != nil {
		t.Errorf("'Contact Agent' should be poa with nil price: kind=%s low=%v", b.PriceKind, b.PriceLow)
	}

	sold := byID["2020524930"]
	if sold.Status != "sold" {
		t.Errorf("UPVSoldListings entry should be status=sold (from tags): %q", sold.Status)
	}
	if sold.PriceKind != priceFixed || sold.PriceLow == nil || *sold.PriceLow != 2_205_000 {
		t.Errorf("sold price wrong: kind=%s low=%v", sold.PriceKind, sold.PriceLow)
	}
	if sold.Bedrooms == nil || *sold.Bedrooms != 3 {
		t.Errorf("sold beds wrong: %v", sold.Bedrooms)
	}
}

func TestExtractListings_REAArgonaut(t *testing.T) {
	// REA-style: window assignment, price as an object, url under _links.canonical,
	// features as {value: N} wrappers.
	html := `<html><body><script>
	window.ArgonautExchange = {"results":{"exchangeState":{"resolvedListings":[
	  {"id":"146500000","_links":{"canonical":{"href":"https://www.realestate.com.au/property/9-argo-st-bondi"}},"price":{"display":"$4.1m"},"generalFeatures":{"bedrooms":{"value":5},"bathrooms":{"value":3}},"address":{"suburb":"Bondi","state":"NSW","postcode":"2026","display":{"fullAddress":"9 Argo St, Bondi"}}}
	]}}};
	</script></body></html>`
	got := extractListings(docFrom(html), "rea")
	if len(got) != 1 {
		t.Fatalf("expected 1 REA listing, got %d (%v)", len(got), got)
	}
	l := got[0]
	if l.ListingURL != "https://www.realestate.com.au/property/9-argo-st-bondi" {
		t.Errorf("REA canonical url wrong: %q", l.ListingURL)
	}
	if l.PriceKind != priceFixed || l.PriceLow == nil || *l.PriceLow != 4_100_000 {
		got := "nil"
		if l.PriceLow != nil {
			got = fmt.Sprintf("%.2f", *l.PriceLow)
		}
		t.Errorf("REA price object not parsed: kind=%s low=%s", l.PriceKind, got)
	}
	if l.Bedrooms == nil || *l.Bedrooms != 5 {
		t.Errorf("REA {value} beds not resolved: %v", l.Bedrooms)
	}
	if l.DisplayAddr != "9 Argo St, Bondi" {
		t.Errorf("REA nested display address not resolved: %q", l.DisplayAddr)
	}
}

func TestMatchesTarget(t *testing.T) {
	tgt := CrawlTarget{Suburb: "st-kilda", Display: "St Kilda", Postcode: "3182", State: "VIC", Capital: "2GMEL"}
	if !matchesTarget(RawListing{Postcode: "3182", Suburb: "St Kilda"}, tgt) {
		t.Error("exact postcode should match")
	}
	if matchesTarget(RawListing{Postcode: "3000", Suburb: "St Kilda"}, tgt) {
		t.Error("wrong postcode must NOT match even with right suburb name")
	}
	if !matchesTarget(RawListing{Suburb: "ST KILDA"}, tgt) {
		t.Error("suburb-name fallback (no postcode) should match case-insensitively")
	}
	if matchesTarget(RawListing{}, tgt) {
		t.Error("a listing with neither postcode nor suburb must be rejected")
	}
}

func TestClampListingPrice(t *testing.T) {
	poison := clampListingPrice(RawListing{PriceLow: f64p(60_000_000), PriceKind: priceFixed})
	if poison.PriceLow != nil || poison.PriceKind != priceUnknown {
		t.Errorf("a $60M out-of-band price should be nulled to unknown, got low=%v kind=%s", poison.PriceLow, poison.PriceKind)
	}
	ok := clampListingPrice(RawListing{PriceLow: f64p(1_200_000), PriceKind: priceFixed})
	if ok.PriceLow == nil || *ok.PriceLow != 1_200_000 {
		t.Errorf("an in-band price should be kept, got %v", ok.PriceLow)
	}
}

func testLC() *listingsCrawler {
	return &listingsCrawler{cfg: listingsConfig{
		crawlConfig: crawlConfig{maxConsecBlocks: 3},
		maxPages:    5,
		minPerPage:  5,
		noiseAbs:    5000,
		noisePct:    0.005,
		delistGrace: 2,
	}}
}

func TestEventsFor(t *testing.T) {
	lc := testLC()
	fixed := func(v float64) RawListing {
		return RawListing{PriceLow: f64p(v), PriceKind: priceFixed, Status: "for_sale"}
	}

	// New listing → first_seen, no price move.
	if evs, moved := lc.eventsFor(nil, fixed(1_200_000)); len(evs) != 1 || evs[0].EventType != "first_seen" || moved {
		t.Errorf("new listing: got %v moved=%v", evs, moved)
	}

	prev := &storedListing{Price: f64p(1_200_000), PriceKind: priceFixed, Status: "for_sale", IsActive: true}

	// Drop past thresholds.
	evs, moved := lc.eventsFor(prev, fixed(1_100_000))
	if !moved || !hasEvent(evs, "price_drop") {
		t.Errorf("expected price_drop+moved, got %v moved=%v", evs, moved)
	}
	// Rise.
	if evs, moved := lc.eventsFor(prev, fixed(1_350_000)); !moved || !hasEvent(evs, "price_rise") {
		t.Errorf("expected price_rise, got %v moved=%v", evs, moved)
	}
	// Sub-threshold change (delta $1k < $5k) → no move.
	if evs, moved := lc.eventsFor(prev, fixed(1_199_000)); moved || hasEvent(evs, "price_drop") {
		t.Errorf("sub-threshold change must NOT emit a move, got %v moved=%v", evs, moved)
	}
	// Auction now (nil numeric) → no price move (prev numeric, cur nil).
	if _, moved := lc.eventsFor(prev, RawListing{PriceKind: priceAuction, Status: "for_sale"}); moved {
		t.Error("auction (nil price) must not produce a price move")
	}
	// Non-comparable kinds: range_low vs prev fixed → no phantom move.
	if _, moved := lc.eventsFor(prev, RawListing{PriceLow: f64p(1_000_000), PriceKind: priceRangeLow, Status: "for_sale"}); moved {
		t.Error("range_low vs prev fixed must NOT be treated as a move")
	}
	// Status change only (same price, for_sale → under_offer).
	evs, _ = lc.eventsFor(prev, RawListing{PriceLow: f64p(1_200_000), PriceKind: priceFixed, Status: "under_offer"})
	if !hasEvent(evs, "status_change") || hasEvent(evs, "price_drop") {
		t.Errorf("expected status_change only, got %v", evs)
	}
	// Relisted (prev inactive) + a concurrent drop.
	inactive := &storedListing{Price: f64p(1_200_000), PriceKind: priceFixed, Status: "withdrawn", IsActive: false}
	evs, _ = lc.eventsFor(inactive, fixed(1_100_000))
	if !hasEvent(evs, "relisted") || !hasEvent(evs, "price_drop") {
		t.Errorf("expected relisted + price_drop, got %v", evs)
	}
}

func hasEvent(evs []priceEvent, kind string) bool {
	for _, e := range evs {
		if e.EventType == kind {
			return true
		}
	}
	return false
}

// --- sweep classification (the delist-safety linchpin) ---
// NOTE: `bondi` (a CrawlTarget) is declared package-wide in crawl_brandbrain_test.go.

// pagedFetcher is an EXACT-url-keyed htmlFetcher (unlike the substring-matched
// fakeFetcher) so per-page bodies can be scripted precisely.
type pagedFetcher struct{ pages map[string]string }

func (f *pagedFetcher) fetch(_ context.Context, url string) ([]byte, string, error) {
	if h, ok := f.pages[url]; ok {
		return []byte(h), url, nil
	}
	return []byte(`<html><body></body></html>`), url, nil // unknown url -> empty page
}
func (f *pagedFetcher) Close() {}

func domainPageHTML(ids []string, postcode string) string {
	items := make([]string, 0, len(ids))
	for _, id := range ids {
		items = append(items, fmt.Sprintf(
			`{"id":"%s","listingUrl":"/p/%s","price":"$1,200,000","bedrooms":3,"address":{"suburb":"Bondi","state":"NSW","postcode":"%s","displayAddress":"%s Test St"}}`,
			id, id, postcode, id))
	}
	return `<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"listings":[` +
		strings.Join(items, ",") + `]}}}</script></body></html>`
}

func sweepWith(pages map[string]string) suburbSweep {
	lc := testLC()
	lc.fetcher = &pagedFetcher{pages: pages}
	blocks := 0
	return lc.sweepSuburbSource(context.Background(), bondi, "domain", bondi.domainSearchURL, &blocks)
}

func TestSweep_CompleteOnEmptyPage(t *testing.T) {
	sw := sweepWith(map[string]string{
		bondi.domainSearchURL(1): domainPageHTML([]string{"a", "b", "c", "d", "e"}, "2026"),
		// page 2 is the default empty page -> ran out -> complete
	})
	if sw.status != sweepComplete {
		t.Errorf("empty second page should mark the sweep complete, got %s", sw.status)
	}
	if len(sw.listings) != 5 {
		t.Errorf("expected 5 collected listings, got %d", len(sw.listings))
	}
}

func TestSweep_DuplicatePageIsComplete(t *testing.T) {
	page := domainPageHTML([]string{"a", "b", "c", "d", "e"}, "2026")
	sw := sweepWith(map[string]string{
		bondi.domainSearchURL(1): page,
		bondi.domainSearchURL(2): page, // portal clamps over-range page -> duplicate -> complete
	})
	if sw.status != sweepComplete {
		t.Errorf("a duplicate page should mark the sweep complete, got %s", sw.status)
	}
}

func TestSweep_BlockedPage1(t *testing.T) {
	sw := sweepWith(map[string]string{
		bondi.domainSearchURL(1): `<html><body>kasada challenge</body></html>`,
	})
	if sw.status != sweepBlocked {
		t.Errorf("a blocked page 1 must be blocked (no delist), got %s", sw.status)
	}
}

func TestSweep_ThinPage1IsBlocked(t *testing.T) {
	sw := sweepWith(map[string]string{
		bondi.domainSearchURL(1): domainPageHTML([]string{"a", "b"}, "2026"), // < minPerPage
	})
	if sw.status != sweepBlocked {
		t.Errorf("a thin page 1 (<minPerPage) must be blocked (empty/poison), got %s", sw.status)
	}
}

func TestSweep_MismatchPoisonIsBlocked(t *testing.T) {
	// 5 listings, 3 with the WRONG postcode -> 60% mismatch -> poison -> blocked.
	html := `<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"listings":[` +
		`{"id":"a","listingUrl":"/p/a","price":"$1,200,000","address":{"suburb":"Bondi","postcode":"2026","displayAddress":"a"}},` +
		`{"id":"b","listingUrl":"/p/b","price":"$1,200,000","address":{"suburb":"Bondi","postcode":"2026","displayAddress":"b"}},` +
		`{"id":"c","listingUrl":"/p/c","price":"$1,200,000","address":{"suburb":"Nowhere","postcode":"9999","displayAddress":"c"}},` +
		`{"id":"d","listingUrl":"/p/d","price":"$1,200,000","address":{"suburb":"Nowhere","postcode":"9999","displayAddress":"d"}},` +
		`{"id":"e","listingUrl":"/p/e","price":"$1,200,000","address":{"suburb":"Nowhere","postcode":"9999","displayAddress":"e"}}` +
		`]}}}</script></body></html>`
	sw := sweepWith(map[string]string{bondi.domainSearchURL(1): html})
	if sw.status != sweepBlocked {
		t.Errorf(">30%% target mismatch must be treated as poison/blocked, got %s", sw.status)
	}
}

func TestSweepPoisonVerdict(t *testing.T) {
	cases := []struct {
		name      string
		page      int
		collected int
		minPer    int
		want      sweepStatus
	}{
		{"page1 poison", 1, 0, 5, sweepBlocked},
		{"page2 thin prior collection", 2, 3, 5, sweepBlocked}, // conservative: no healthy set yet
		{"page2 after full page1", 2, 5, 5, sweepPartial},      // broadened past a small suburb
		{"page3 after healthy set", 3, 54, 5, sweepPartial},    // New Farm REA broadening
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sweepPoisonVerdict(tc.page, tc.collected, tc.minPer); got != tc.want {
				t.Fatalf("sweepPoisonVerdict(%d,%d,%d)=%s want %s", tc.page, tc.collected, tc.minPer, got, tc.want)
			}
		})
	}
}

func TestSweep_BroadenedLatePageIsPartial(t *testing.T) {
	// A healthy on-target page 1, then a page 2 that is mostly nearby stock (the
	// portal broadening past a small suburb's real inventory — New Farm 4005 →
	// Newstead/Fortitude Valley). The late broadening must NOT discard the
	// confirmed page-1 listings: it's a partial sweep (write events, delist
	// nothing), not a poison block.
	p1 := domainPageHTML([]string{"a", "b", "c", "d", "e"}, "2026") // 5 on-target
	p2 := `<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"listings":[` +
		`{"id":"f","listingUrl":"/p/f","price":"$1,200,000","address":{"suburb":"Bondi","postcode":"2026","displayAddress":"f"}},` +
		`{"id":"g","listingUrl":"/p/g","price":"$1,200,000","address":{"suburb":"Tamarama","postcode":"2026x","displayAddress":"g"}},` +
		`{"id":"h","listingUrl":"/p/h","price":"$1,200,000","address":{"suburb":"Bronte","postcode":"2024","displayAddress":"h"}},` +
		`{"id":"i","listingUrl":"/p/i","price":"$1,200,000","address":{"suburb":"Waverley","postcode":"2024","displayAddress":"i"}},` +
		`{"id":"j","listingUrl":"/p/j","price":"$1,200,000","address":{"suburb":"Clovelly","postcode":"2031","displayAddress":"j"}}` +
		`]}}}</script></body></html>` // 1 on-target + 4 nearby -> 80% mismatch
	sw := sweepWith(map[string]string{
		bondi.domainSearchURL(1): p1,
		bondi.domainSearchURL(2): p2,
	})
	if sw.status != sweepPartial {
		t.Errorf("a broadened late page after a healthy set must be partial, got %s", sw.status)
	}
	if len(sw.listings) != 5 {
		t.Errorf("must keep the 5 confirmed page-1 listings (drop the broadened page), got %d", len(sw.listings))
	}
}

func TestSweep_PageCapIsPartial(t *testing.T) {
	lc := testLC()
	lc.cfg.maxPages = 2
	lc.fetcher = &pagedFetcher{pages: map[string]string{
		bondi.domainSearchURL(1): domainPageHTML([]string{"a", "b", "c", "d", "e"}, "2026"),
		bondi.domainSearchURL(2): domainPageHTML([]string{"f", "g", "h", "i", "j"}, "2026"),
	}}
	blocks := 0
	sw := lc.sweepSuburbSource(context.Background(), bondi, "domain", bondi.domainSearchURL, &blocks)
	if sw.status != sweepPartial {
		t.Errorf("hitting the page cap with full pages must be partial (no delist), got %s", sw.status)
	}
	if len(sw.listings) != 10 {
		t.Errorf("expected 10 collected across 2 pages, got %d", len(sw.listings))
	}
}
