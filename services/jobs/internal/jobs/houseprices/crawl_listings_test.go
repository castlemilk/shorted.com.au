package houseprices

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
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
	// Shared-postcode neighbour: same postcode, DIFFERENT suburb. Postcode alone
	// is NOT authoritative — many AU postcodes cover several localities (3182 =
	// St Kilda + St Kilda West; 2026 = Bondi + Tamarama + North Bondi), so a
	// postcode-only match silently pulls neighbouring-suburb stock into the
	// target's corpus. When BOTH fields are present, both must agree.
	if matchesTarget(RawListing{Postcode: "3182", Suburb: "St Kilda West"}, tgt) {
		t.Error("same postcode but different suburb (shared-postcode neighbour) must NOT match")
	}
	// But a postcode match with NO suburb field present still matches — postcode
	// is the best available signal when the portal omits the locality.
	if !matchesTarget(RawListing{Postcode: "3182"}, tgt) {
		t.Error("postcode match with no suburb field should still match (fallback preserved)")
	}
	// Abbreviation tolerance: the ABS-SAL Display and the portal disagree on
	// St/Saint & Mt/Mount forms; both must still match (postcode gates, so this
	// can't conflate distinct suburbs). Without it a whole page-1 of on-target
	// listings fails subOK and the poison gate blocks the entire suburb.
	mtEliza := CrawlTarget{Suburb: "mount-eliza", Display: "Mount Eliza", Postcode: "3930", State: "VIC"}
	if !matchesTarget(RawListing{Postcode: "3930", Suburb: "Mt Eliza"}, mtEliza) {
		t.Error("portal 'Mt Eliza' must match Display 'Mount Eliza' (Mt/Mount abbrev)")
	}
	stLeon := CrawlTarget{Suburb: "st-leonards", Display: "St Leonards", Postcode: "2065", State: "NSW"}
	if !matchesTarget(RawListing{Postcode: "2065", Suburb: "Saint Leonards"}, stLeon) {
		t.Error("portal 'Saint Leonards' must match Display 'St Leonards' (St/Saint abbrev)")
	}
}

func TestPartitionByTarget_SoftMissNotPoison(t *testing.T) {
	// A small suburb in a shared-postcode cluster: page 1 is back-filled with a
	// same-postcode NEIGHBOUR (Tarneit shares 3029 with Truganina). Those rows are
	// not written under Truganina, but they are legitimate nearby stock, NOT bot
	// poison — so the poison ratio must stay 0 and the sweep must not block.
	tgt := CrawlTarget{Suburb: "truganina", Display: "Truganina", Postcode: "3029", State: "VIC"}
	raw := make([]RawListing, 0, 24)
	for i := 0; i < 16; i++ {
		raw = append(raw, RawListing{Postcode: "3029", Suburb: "Truganina"})
	}
	for i := 0; i < 8; i++ {
		raw = append(raw, RawListing{Postcode: "3029", Suburb: "Tarneit"})
	}
	matched, mismatch := partitionByTarget(raw, tgt)
	if len(matched) != 16 {
		t.Errorf("only the 16 on-target Truganina listings should be written, got %d", len(matched))
	}
	if mismatch != 0 {
		t.Errorf("same-postcode neighbours must NOT count toward the poison ratio, got %.3f", mismatch)
	}
}

func TestPartitionByTarget_WrongPostcodeIsPoison(t *testing.T) {
	// Genuinely off-target stock (different postcode) is what the poison gate is
	// for — it must still register as mismatch.
	tgt := CrawlTarget{Suburb: "truganina", Display: "Truganina", Postcode: "3029", State: "VIC"}
	raw := []RawListing{
		{Postcode: "3029", Suburb: "Truganina"},
		{Postcode: "3030", Suburb: "Werribee"},
		{Postcode: "3030", Suburb: "Werribee"},
	}
	if _, mismatch := partitionByTarget(raw, tgt); mismatch < 0.6 {
		t.Errorf("wrong-postcode stock must count as poison, got %.3f", mismatch)
	}
}

func TestSanitizeListing_StripsNulAndInvalidUTF8(t *testing.T) {
	// A portal  decodes to a real 0x00 in the Go string; left unsanitised it
	// makes upsertListing's INSERT fail with Postgres 22021 and, now that a diff
	// error fails+requeues the suburb, turns it into a re-crawl poison pill.
	got := sanitizeListing(RawListing{
		ListingID:    "abc\x00123",
		DisplayAddr:  "12 Smith St\x00",
		PriceDisplay: "For Sale $1.2m",
		AgentNames:   []string{"Jane\x00Doe", "ok"},
	})
	if got.ListingID != "abc123" || got.DisplayAddr != "12 Smith St" {
		t.Errorf("NUL not stripped: id=%q addr=%q", got.ListingID, got.DisplayAddr)
	}
	if got.PriceDisplay != "For Sale $1.2m" {
		t.Errorf("clean text should be untouched, got %q", got.PriceDisplay)
	}
	if got.AgentNames[0] != "JaneDoe" || got.AgentNames[1] != "ok" {
		t.Errorf("agent NUL not stripped: %q", got.AgentNames)
	}
	// A lone invalid byte (0xff) is coerced away rather than left to break the write.
	if bad := sanitizeListing(RawListing{DisplayAddr: "caf\xffe"}); !utf8.ValidString(bad.DisplayAddr) {
		t.Errorf("invalid UTF-8 not coerced: %q", bad.DisplayAddr)
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
		crawlConfig:   crawlConfig{maxConsecBlocks: 3},
		maxPages:      5,
		minPerPage:    5,
		minNewPerPage: 1,
		noiseAbs:      5000,
		noisePct:      0.005,
		delistGrace:   2,
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

// TestAddressPriceMove covers the address-level relist-drop detection
// (crawl_listings_diff.go): a brand-new listing_id at a KNOWN address, priced
// against that address's most recent active listing (a DIFFERENT listing_id,
// possibly a different source) — the drop a listing_id-keyed diff alone can
// never see. Same noise/comparable-kind gates as the listing-level diff.
func TestAddressPriceMove(t *testing.T) {
	lc := testLC()
	addrKey := "1-centre-road-brighton-vic-3186"

	// No known prior at this address -> never fires.
	newL := RawListing{PriceLow: f64p(1_100_000), PriceKind: priceFixed, Status: "for_sale", AddressKey: addrKey}
	if _, ok := lc.addressPriceMove(nil, newL); ok {
		t.Error("nil addrPrior must never fire")
	}

	prior := &storedListing{Price: f64p(1_200_000), PriceKind: priceFixed, Status: "for_sale", IsActive: true}

	// A relisted listing_id at the SAME address, priced below the prior active
	// listing -> price_drop, carrying the prior's price as PrevPrice.
	e, ok := lc.addressPriceMove(prior, newL)
	if !ok || e.EventType != "price_drop" {
		t.Fatalf("expected price_drop, got ok=%v e=%+v", ok, e)
	}
	if e.PrevPrice == nil || *e.PrevPrice != 1_200_000 {
		t.Errorf("PrevPrice = %v, want 1200000", e.PrevPrice)
	}

	// Rise.
	riseL := RawListing{PriceLow: f64p(1_350_000), PriceKind: priceFixed, Status: "for_sale", AddressKey: addrKey}
	if e, ok := lc.addressPriceMove(prior, riseL); !ok || e.EventType != "price_rise" {
		t.Errorf("expected price_rise, got ok=%v e=%+v", ok, e)
	}

	// Genuinely the same price (sub-threshold) -> must NOT fire (the "same
	// listing/price" guard).
	sameL := RawListing{PriceLow: f64p(1_199_000), PriceKind: priceFixed, Status: "for_sale", AddressKey: addrKey}
	if _, ok := lc.addressPriceMove(prior, sameL); ok {
		t.Error("sub-threshold move must not fire")
	}

	// Non-comparable kinds -> no phantom move.
	rangeL := RawListing{PriceLow: f64p(1_000_000), PriceKind: priceRangeLow, Status: "for_sale", AddressKey: addrKey}
	if _, ok := lc.addressPriceMove(prior, rangeL); ok {
		t.Error("non-comparable price kinds must not fire")
	}

	// A sold listing must never produce a phantom "discount".
	soldL := RawListing{PriceLow: f64p(900_000), PriceKind: priceFixed, Status: "sold", AddressKey: addrKey}
	if _, ok := lc.addressPriceMove(prior, soldL); ok {
		t.Error("a sold listing must not fire a price move")
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
	// A REAL "ran out" page: the portal still serves its full SRP shell (data
	// container present) with zero listings — NOT an anti-bot stub. Carries both
	// portals' containers so pageLooksStub treats it as a legit natural end
	// (source-agnostic here); a container-less page is the stub case (below/tests).
	return []byte(`<html><body><script>window.ArgonautExchange={"results":{"exchangeState":{"resolvedListings":[]}}};</script><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"listings":[]}}}</script></body></html>`), url, nil
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

// domainPageWithMeta is domainPageHTML plus the portal's own pagination signal
// (totalResults/pageSize) in the SAME __NEXT_DATA__ blob — mirroring the real
// Domain shape where componentProps carries both listingsMap and
// totalPages/pageSize side by side (confirmed Phase-0, 2026-07-15).
func domainPageWithMeta(ids []string, postcode string, total, pageSize int) string {
	items := make([]string, 0, len(ids))
	for _, id := range ids {
		items = append(items, fmt.Sprintf(
			`{"id":"%s","listingUrl":"/p/%s","price":"$1,200,000","bedrooms":3,"address":{"suburb":"Bondi","state":"NSW","postcode":"%s","displayAddress":"%s Test St"}}`,
			id, id, postcode, id))
	}
	return fmt.Sprintf(`<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"totalResults":%d,"pageSize":%d,"listings":[%s]}}}</script></body></html>`,
		total, pageSize, strings.Join(items, ","))
}

// reaPageWithMeta builds a REA-style search-results page carrying both a
// listing set and the portal's own pagination signal in the SAME blob: the
// BROADENED totalResultsCount, PageSize, and — REA-only — the exact
// on-target listings_total (see PageMeta's doc comment in
// crawl_listings_extract.go). Mirrors domainPageWithMeta's role for the
// Domain shape.
func reaPageWithMeta(ids []string, postcode string, totalResults, onTarget, pageSize int) string {
	items := make([]string, 0, len(ids))
	for _, id := range ids {
		items = append(items, fmt.Sprintf(
			`{"id":"%s","_links":{"canonical":{"href":"https://www.realestate.com.au/property/%s"}},"price":{"display":"$1,200,000"},"address":{"suburb":"Bondi","state":"NSW","postcode":"%s","display":{"fullAddress":"%s Test St"}}}`,
			id, id, postcode, id))
	}
	return fmt.Sprintf(`<html><body><script>window.ArgonautExchange = {"results":{"exchangeState":{"resolvedListings":[%s]}},"totalResultsCount":%d,"listings_total":%d,"pageSize":%d};</script></body></html>`,
		strings.Join(items, ","), totalResults, onTarget, pageSize)
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

// TestSweep_StubOnLaterPageIsNotComplete pins the critical fix: an anti-bot stub
// (Kasada KPSDK / Akamai) on a LATER page — which extracts 0 listings and carries
// no data container — must NOT be read as "ran out" → sweepComplete (that would
// run the delist path over the suburb's real pages-2+ listings). It's a block:
// sweepPartial (page-1 listings kept, delist NOTHING), and it trips the breaker.
func TestSweep_StubOnLaterPageIsNotComplete(t *testing.T) {
	// A realistic anti-bot stub: no listing container (no __NEXT_DATA__ blob).
	stub := `<html><head><script>window.KPSDK={cd:true};</script></head><body>Pardon the interruption</body></html>`
	sw := sweepWith(map[string]string{
		// total=10/pageSize=5 → the portal says there's a 2nd page, so the sweep
		// fetches it and hits the stub (rather than stopping at page 1).
		bondi.domainSearchURL(1): domainPageWithMeta([]string{"a", "b", "c", "d", "e"}, "2026", 10, 5),
		bondi.domainSearchURL(2): stub, // anti-bot stub, not a real "ran out" page
	})
	if sw.status == sweepComplete {
		t.Fatalf("a stub second page must NOT mark the sweep complete (would wrongly delist real listings); got %s", sw.status)
	}
	if sw.status != sweepPartial {
		t.Fatalf("expected sweepPartial (page-1 kept, delist nothing), got %s", sw.status)
	}
	if len(sw.listings) != 5 {
		t.Fatalf("page-1 listings must be kept, got %d", len(sw.listings))
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

// --- PageMeta-informed sizing + delist-safe classification (Task 3) ---

func TestSweep_TotalCountSizesAndCompletes(t *testing.T) {
	p1 := domainPageWithMeta([]string{"a", "b", "c", "d", "e"}, "2026" /*total*/, 5 /*pageSize*/, 20)
	sw := sweepWith(map[string]string{bondi.domainSearchURL(1): p1}) // page 2 is the default empty page
	if sw.status != sweepComplete {
		t.Fatalf("1-page suburb must be complete, got %s", sw.status)
	}
	if sw.pages != 1 {
		t.Fatalf("must fetch exactly 1 page, got %d", sw.pages)
	}
	if len(sw.listings) != 5 {
		t.Fatalf("expected 5 collected listings, got %d", len(sw.listings))
	}
}

// TestSweep_OnTargetResultsSizesAndCompletes proves the REA on-target-count
// fix: PageMeta carries BOTH a large BROADENED totalResultsCount (969, which
// alone would size wantPages up to softCap) and the exact on-target
// listings_total (5, pageSize 25 -> ceil(5/25)=1). Sizing must use the
// on-target count, so the sweep fetches exactly ONE page and — reaching that
// PageMeta-sized bound with no natural-end signal — is delist-safe complete,
// even though the broadened total would otherwise never shrink the walk
// (broadened TotalPages ceil(969/25)=39 >= softCap, a no-op clamp).
func TestSweep_OnTargetResultsSizesAndCompletes(t *testing.T) {
	p1 := reaPageWithMeta([]string{"a", "b", "c", "d", "e"}, "2026", 969, 5, 25)
	lc := testLC()
	lc.fetcher = &pagedFetcher{pages: map[string]string{
		bondi.reaSearchURL(1): p1,
		// page 2 deliberately left unscripted: if sizing mistakenly used the
		// broadened total instead of the on-target one, the loop bound would be
		// far above 1 and the sweep would fetch it (falling into the default
		// empty-page fixture) — asserting pages==1 (not just status) proves the
		// walk never got that far.
	}}
	blocks := 0
	sw := lc.sweepSuburbSource(context.Background(), bondi, "rea", bondi.reaSearchURL, &blocks)
	if sw.pages != 1 {
		t.Fatalf("on-target sizing should size wantPages=1 (ceil(5/25)), fetched %d pages", sw.pages)
	}
	if sw.status != sweepComplete {
		t.Errorf("reaching a PageMeta-sized bound (on-target) with no natural-end signal should be capped-complete, got %s", sw.status)
	}
	if len(sw.listings) != 5 {
		t.Errorf("expected 5 collected listings, got %d", len(sw.listings))
	}
}

func TestSweep_TotalCountNeverExtendsBeyondMaxPages(t *testing.T) {
	// A BROADENED total (say 900 results / 25 per page -> 36 pages) must never
	// grow the walk past the hard cfg.maxPages ceiling — PageMeta can only
	// shrink the loop bound, never grow it.
	lc := testLC()
	lc.cfg.maxPages = 2
	p1 := domainPageWithMeta([]string{"a", "b", "c", "d", "e"}, "2026" /*total*/, 900 /*pageSize*/, 25)
	p2 := domainPageHTML([]string{"f", "g", "h", "i", "j"}, "2026")
	lc.fetcher = &pagedFetcher{pages: map[string]string{
		bondi.domainSearchURL(1): p1,
		bondi.domainSearchURL(2): p2,
	}}
	blocks := 0
	sw := lc.sweepSuburbSource(context.Background(), bondi, "domain", bondi.domainSearchURL, &blocks)
	if sw.pages != 2 {
		t.Fatalf("must stay capped at maxPages=2 despite a large broadened total, got %d pages", sw.pages)
	}
	// wantPages(36) clamped to maxPages(2) == maxPages -> NOT capped-complete: a
	// large broadened total offers no delist-safety guarantee at the hard cap.
	if sw.status != sweepPartial {
		t.Fatalf("hitting the hard cap under a still-larger broadened total must stay partial, got %s", sw.status)
	}
}

func TestSweep_BroadenedLatePageCompletesWhenPageMetaConfirms(t *testing.T) {
	// Same shape as TestSweep_BroadenedLatePageIsPartial, but this time page 1
	// carries PageMeta reporting a broadened total far beyond where we stopped
	// (pages=2 < wantPages) — confirming the on-target suburb was fully seen
	// before the surrounds began. That must upgrade partial -> complete
	// (delist-safe), unlike the no-PageMeta case.
	p1 := domainPageWithMeta([]string{"a", "b", "c", "d", "e"}, "2026" /*total*/, 900 /*pageSize*/, 25) // wantPages=36, clamped to maxPages=5
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
	if sw.status != sweepComplete {
		t.Errorf("a broadened late page confirmed short of PageMeta's own extent must be delist-safe complete, got %s", sw.status)
	}
	if len(sw.listings) != 5 {
		t.Errorf("must keep the 5 confirmed page-1 listings, got %d", len(sw.listings))
	}
}

// --- yield-decay stop (Task 4) ---

// TestSweep_StopsOnZeroNewIDs is adapted from the plan's literal example (page
// 2 = page 1's ids REORDERED). That exact scenario does NOT exercise the new
// code: pageSignature sorts ids before joining, so a reordered-but-identical
// id set already produces the SAME signature as page 1 and is already caught
// by the pre-existing "duplicate page" check (sig == prevSig), independent of
// this task. To actually exercise yield decay, page 2 here returns a SUBSET of
// page 1's ids (4 of 5) — real content, a genuinely different signature (the
// dup-page check misses it), but zero NEW ids.
func TestSweep_StopsOnZeroNewIDs(t *testing.T) {
	p1 := domainPageHTML([]string{"a", "b", "c", "d", "e"}, "2026")
	p2 := domainPageHTML([]string{"a", "b", "c", "d"}, "2026") // same 4 ids, no new ones, different signature than p1
	sw := sweepWith(map[string]string{
		bondi.domainSearchURL(1): p1,
		bondi.domainSearchURL(2): p2,
	})
	if len(sw.listings) != 5 {
		t.Fatalf("must not lose or double-count, got %d", len(sw.listings))
	}
	if sw.status == sweepBlocked {
		t.Fatalf("a zero-yield overlap page is not a block")
	}
	if sw.pages != 2 {
		t.Fatalf("expected the sweep to stop right after the zero-yield page, got %d pages", sw.pages)
	}
}

func TestSweep_YieldDecayCompletesWhenPageMetaConfirms(t *testing.T) {
	// Same shape as TestSweep_StopsOnZeroNewIDs, but page 1 carries PageMeta
	// confirming we stopped well short of the portal's own reported (broadened)
	// extent -- the same delist-safety upgrade the broadening branch gets.
	p1 := domainPageWithMeta([]string{"a", "b", "c", "d", "e"}, "2026" /*total*/, 900 /*pageSize*/, 25) // wantPages=36, clamped to maxPages=5
	p2 := domainPageHTML([]string{"a", "b", "c", "d"}, "2026")
	sw := sweepWith(map[string]string{
		bondi.domainSearchURL(1): p1,
		bondi.domainSearchURL(2): p2,
	})
	if sw.status != sweepComplete {
		t.Errorf("a yield-decay stop confirmed short of PageMeta's own extent must be delist-safe complete, got %s", sw.status)
	}
	if len(sw.listings) != 5 {
		t.Errorf("expected 5 collected listings, got %d", len(sw.listings))
	}
}

// --- cross-page dedup: fieldScore-max merge (Task 5) ---

// TestSweep_CrossPageDedupKeepsRicherRecord: listing "z" appears thin (price +
// address only, no beds/baths) on page 1, then richer (+ beds/baths) on page
// 2 for the SAME id. The merged record must keep the richer page-2 fields, not
// silently freeze on whichever page happened to see it first.
func TestSweep_CrossPageDedupKeepsRicherRecord(t *testing.T) {
	p1 := `<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"listings":[` +
		`{"id":"z","listingUrl":"/p/z","price":"$1,200,000","address":{"suburb":"Bondi","postcode":"2026","displayAddress":"z Test St"}},` +
		`{"id":"a","listingUrl":"/p/a","price":"$1,200,000","address":{"suburb":"Bondi","postcode":"2026","displayAddress":"a Test St"}},` +
		`{"id":"b","listingUrl":"/p/b","price":"$1,200,000","address":{"suburb":"Bondi","postcode":"2026","displayAddress":"b Test St"}},` +
		`{"id":"c","listingUrl":"/p/c","price":"$1,200,000","address":{"suburb":"Bondi","postcode":"2026","displayAddress":"c Test St"}},` +
		`{"id":"d","listingUrl":"/p/d","price":"$1,200,000","address":{"suburb":"Bondi","postcode":"2026","displayAddress":"d Test St"}}` +
		`]}}}</script></body></html>`
	p2 := `<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"listings":[` +
		`{"id":"z","listingUrl":"/p/z","price":"$1,200,000","bedrooms":3,"bathrooms":2,"address":{"suburb":"Bondi","postcode":"2026","displayAddress":"z Test St"}},` +
		`{"id":"f","listingUrl":"/p/f","price":"$1,200,000","address":{"suburb":"Bondi","postcode":"2026","displayAddress":"f Test St"}}` +
		`]}}}</script></body></html>` // "f" is genuinely new so this page isn't itself a yield-decay stop
	sw := sweepWith(map[string]string{
		bondi.domainSearchURL(1): p1,
		bondi.domainSearchURL(2): p2,
		// page 3 is the default empty page -> natural end -> complete
	})
	if sw.status == sweepBlocked {
		t.Fatalf("must not block, got %s", sw.status)
	}
	if len(sw.listings) != 6 {
		t.Fatalf("expected 6 distinct listings (z,a,b,c,d,f), got %d", len(sw.listings))
	}
	var z *RawListing
	for i := range sw.listings {
		if sw.listings[i].ListingID == "z" {
			z = &sw.listings[i]
		}
	}
	if z == nil {
		t.Fatalf("listing z missing from the merged set")
	}
	if z.Bedrooms == nil || *z.Bedrooms != 3 {
		t.Errorf("merged z should keep the richer page-2 bedrooms, got %v", z.Bedrooms)
	}
	if z.Bathrooms == nil || *z.Bathrooms != 2 {
		t.Errorf("merged z should keep the richer page-2 bathrooms, got %v", z.Bathrooms)
	}
	if z.DisplayAddr != "z Test St" {
		t.Errorf("merged z should still carry the address seen on both pages, got %q", z.DisplayAddr)
	}
}

func TestMergeListing(t *testing.T) {
	thin := RawListing{ListingID: "z", PriceDisplay: "$1.2m"}
	rich := RawListing{ListingID: "z", PriceDisplay: "$1.2m", DisplayAddr: "1 Test St", Bedrooms: int16p(3)}
	if got := mergeListing(thin, rich); got.Bedrooms == nil || *got.Bedrooms != 3 {
		t.Errorf("mergeListing(thin, rich) should keep the richer incoming record, got %+v", got)
	}
	if got := mergeListing(rich, thin); got.Bedrooms == nil || *got.Bedrooms != 3 {
		t.Errorf("mergeListing(rich, thin) should keep the richer existing record, got %+v", got)
	}
	// A tie keeps `existing` (no churn).
	same := RawListing{ListingID: "z", PriceDisplay: "$1.2m"}
	if got := mergeListing(thin, same); got.PriceDisplay != thin.PriceDisplay {
		t.Errorf("a tie should keep existing, got %+v", got)
	}
}

func int16p(v int16) *int16 { return &v }

// --- adaptive page cap by suburb size (Task 6) ---

func TestSoftPageCap(t *testing.T) {
	const def = 5
	if got := softPageCap(0, 20, def); got != def {
		t.Errorf("unknown dwellings (0) should use the default cap, got %d want %d", got, def)
	}
	large := softPageCap(25_000, 20, def)
	if large <= def {
		t.Errorf("a large suburb should get a soft cap ABOVE the default, got %d", large)
	}
	if large > 20 {
		t.Errorf("the soft cap must never exceed the hard ceiling, got %d", large)
	}
	tiny := softPageCap(1_000, 20, def)
	if tiny >= def {
		t.Errorf("a tiny suburb should get a soft cap BELOW the default, got %d", tiny)
	}
	if tiny < 1 {
		t.Errorf("the soft cap must never go below 1, got %d", tiny)
	}
	// A low hard ceiling always wins, even for a huge suburb.
	if got := softPageCap(1_000_000, 3, def); got != 3 {
		t.Errorf("hard ceiling must always win, got %d want 3", got)
	}
	// hardCeiling<=0 is "no override" (defensive default for a caller that
	// didn't set one), not an implicit re-widening.
	if got := softPageCap(25_000, 0, def); got != def*2 {
		t.Errorf("hardCeiling<=0 should not override the derived cap, got %d want %d", got, def*2)
	}
}

// TestSweep_SoftPageCapSizesTheWalkWhenPageMetaUnusable proves softPageCap is
// actually wired into the sweep loop, not just unit-tested in isolation: a
// suburb tagged with a small Dwellings hint gets fewer pages than the
// configured default when the portal's own PageMeta can't be read.
func TestSweep_SoftPageCapSizesTheWalkWhenPageMetaUnusable(t *testing.T) {
	tiny := bondi
	tiny.Dwellings = 500 // < 2000 -> softCap = default(5) - 2 = 3

	lc := testLC()
	// Every page is full and clean -- with no cap, the walk would run to
	// maxPages(5). With the Dwellings hint, it must stop at softCap(3).
	pages := map[string]string{}
	ids := []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o"}
	for i := 0; i < 3; i++ {
		pages[tiny.domainSearchURL(i+1)] = domainPageHTML(ids[i*5:i*5+5], "2026")
	}
	lc.fetcher = &pagedFetcher{pages: pages}
	blocks := 0
	sw := lc.sweepSuburbSource(context.Background(), tiny, "domain", tiny.domainSearchURL, &blocks)
	if sw.pages != 3 {
		t.Fatalf("expected the Dwellings hint to cap the walk at 3 pages, got %d", sw.pages)
	}
	if sw.status != sweepPartial {
		t.Fatalf("hitting the soft cap with no PageMeta confirmation must stay partial, got %s", sw.status)
	}
}

// --- adaptive pacing under block-risk (Task 7) ---

func TestPaceBounds(t *testing.T) {
	base := paceRange{lo: 8 * time.Second, hi: 20 * time.Second}

	if got := paceBounds(0, 0, base); got != base {
		t.Errorf("a clean page (no blocks, no mismatch) should keep the base bounds, got %+v", got)
	}
	if got := paceBounds(0, 0.10, base); got != base {
		t.Errorf("a low mismatch (<=30%%) should keep the base bounds, got %+v", got)
	}

	blocked := paceBounds(2, 0, base)
	if blocked.lo <= base.lo || blocked.hi <= base.hi {
		t.Errorf("consecutive blocks should widen the bounds, got %+v vs base %+v", blocked, base)
	}

	mismatched := paceBounds(0, 0.80, base)
	if mismatched.lo <= base.lo || mismatched.hi <= base.hi {
		t.Errorf("a high-mismatch (>30%%) page should widen the bounds, got %+v vs base %+v", mismatched, base)
	}

	// The widen factor must never blow out unbounded.
	extreme := paceBounds(50, 1.0, base)
	maxLo := time.Duration(float64(base.lo) * paceWidenFactorMax)
	maxHi := time.Duration(float64(base.hi) * paceWidenFactorMax)
	if extreme.lo != maxLo || extreme.hi != maxHi {
		t.Errorf("an extreme risk signal should cap at %vx base, got %+v want lo=%v hi=%v", paceWidenFactorMax, extreme, maxLo, maxHi)
	}
}
