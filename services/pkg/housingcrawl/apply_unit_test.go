package housingcrawl

import (
	"testing"
	"unicode/utf8"
)

func TestCanonicalPrice_RangeHighUsesHigh(t *testing.T) {
	cp := CanonicalPrice(nil, new(900_000.0), PriceRangeHigh) // "Under $900k"
	if cp == nil || *cp != 900_000 {
		t.Errorf("range_high canonical should be the high bound 900000, got %v", cp)
	}
}

func TestComparableKinds(t *testing.T) {
	if !ComparableKinds(PriceFixed, PriceOffersOver) {
		t.Error("fixed vs offers_over should be comparable (both single-value asks)")
	}
	if !ComparableKinds(PriceRangeLow, PriceRangeLow) {
		t.Error("range_low vs range_low should be comparable")
	}
	if ComparableKinds(PriceRangeLow, PriceFixed) {
		t.Error("range_low vs fixed must NOT be comparable (avoids phantom moves)")
	}
	if ComparableKinds(PriceAuction, PriceFixed) {
		t.Error("auction vs fixed must NOT be comparable")
	}
}

func TestMatchesTarget(t *testing.T) {
	tgt := Target{Suburb: "st-kilda", Display: "St Kilda", Postcode: "3182", State: "VIC"}
	if !MatchesTarget(RawListing{Postcode: "3182", Suburb: "St Kilda"}, tgt) {
		t.Error("exact postcode should match")
	}
	if MatchesTarget(RawListing{Postcode: "3000", Suburb: "St Kilda"}, tgt) {
		t.Error("wrong postcode must NOT match even with right suburb name")
	}
	if !MatchesTarget(RawListing{Suburb: "ST KILDA"}, tgt) {
		t.Error("suburb-name fallback (no postcode) should match case-insensitively")
	}
	if MatchesTarget(RawListing{}, tgt) {
		t.Error("a listing with neither postcode nor suburb must be rejected")
	}
	// Shared-postcode neighbour: same postcode, DIFFERENT suburb. Postcode alone
	// is NOT authoritative — many AU postcodes cover several localities (3182 =
	// St Kilda + St Kilda West; 2026 = Bondi + Tamarama + North Bondi), so a
	// postcode-only match silently pulls neighbouring-suburb stock into the
	// target's corpus. When BOTH fields are present, both must agree.
	if MatchesTarget(RawListing{Postcode: "3182", Suburb: "St Kilda West"}, tgt) {
		t.Error("same postcode but different suburb (shared-postcode neighbour) must NOT match")
	}
	// But a postcode match with NO suburb field present still matches — postcode
	// is the best available signal when the portal omits the locality.
	if !MatchesTarget(RawListing{Postcode: "3182"}, tgt) {
		t.Error("postcode match with no suburb field should still match (fallback preserved)")
	}
	// Abbreviation tolerance: the ABS-SAL Display and the portal disagree on
	// St/Saint & Mt/Mount forms; both must still match (postcode gates, so this
	// can't conflate distinct suburbs). Without it a whole page-1 of on-target
	// listings fails subOK and the poison gate blocks the entire suburb.
	mtEliza := Target{Suburb: "mount-eliza", Display: "Mount Eliza", Postcode: "3930", State: "VIC"}
	if !MatchesTarget(RawListing{Postcode: "3930", Suburb: "Mt Eliza"}, mtEliza) {
		t.Error("portal 'Mt Eliza' must match Display 'Mount Eliza' (Mt/Mount abbrev)")
	}
	stLeon := Target{Suburb: "st-leonards", Display: "St Leonards", Postcode: "2065", State: "NSW"}
	if !MatchesTarget(RawListing{Postcode: "2065", Suburb: "Saint Leonards"}, stLeon) {
		t.Error("portal 'Saint Leonards' must match Display 'St Leonards' (St/Saint abbrev)")
	}
}

func TestSanitizeListing_StripsNulAndInvalidUTF8(t *testing.T) {
	// A portal  decodes to a real 0x00 in the Go string; left unsanitised it
	// makes upsertListing's INSERT fail with Postgres 22021 and, now that a diff
	// error fails+requeues the suburb, turns it into a re-crawl poison pill.
	got := SanitizeListing(RawListing{
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
	if bad := SanitizeListing(RawListing{DisplayAddr: "caf\xffe"}); !utf8.ValidString(bad.DisplayAddr) {
		t.Errorf("invalid UTF-8 not coerced: %q", bad.DisplayAddr)
	}
}

func TestClampListingPrice(t *testing.T) {
	poison := ClampListingPrice(RawListing{PriceLow: new(float64(60_000_000)), PriceKind: PriceFixed})
	if poison.PriceLow != nil || poison.PriceKind != PriceUnknown {
		t.Errorf("a $60M out-of-band price should be nulled to unknown, got low=%v kind=%s", poison.PriceLow, poison.PriceKind)
	}
	ok := ClampListingPrice(RawListing{PriceLow: new(float64(1_200_000)), PriceKind: PriceFixed})
	if ok.PriceLow == nil || *ok.PriceLow != 1_200_000 {
		t.Errorf("an in-band price should be kept, got %v", ok.PriceLow)
	}
}

func TestEventsFor(t *testing.T) {
	d := testDiffer()
	fixed := func(v float64) RawListing {
		return RawListing{PriceLow: new(v), PriceKind: PriceFixed, Status: "for_sale"}
	}

	// New listing → first_seen, no price move.
	if evs, moved := d.eventsFor(nil, fixed(1_200_000)); len(evs) != 1 || evs[0].EventType != "first_seen" || moved {
		t.Errorf("new listing: got %v moved=%v", evs, moved)
	}

	prev := &storedListing{Price: new(float64(1_200_000)), PriceKind: PriceFixed, Status: "for_sale", IsActive: true}

	// Drop past thresholds.
	evs, moved := d.eventsFor(prev, fixed(1_100_000))
	if !moved || !hasEvent(evs, "price_drop") {
		t.Errorf("expected price_drop+moved, got %v moved=%v", evs, moved)
	}
	// Rise.
	if evs, moved := d.eventsFor(prev, fixed(1_350_000)); !moved || !hasEvent(evs, "price_rise") {
		t.Errorf("expected price_rise, got %v moved=%v", evs, moved)
	}
	// Sub-threshold change (delta $1k < $5k) → no move.
	if evs, moved := d.eventsFor(prev, fixed(1_199_000)); moved || hasEvent(evs, "price_drop") {
		t.Errorf("sub-threshold change must NOT emit a move, got %v moved=%v", evs, moved)
	}
	// Auction now (nil numeric) → no price move (prev numeric, cur nil).
	if _, moved := d.eventsFor(prev, RawListing{PriceKind: PriceAuction, Status: "for_sale"}); moved {
		t.Error("auction (nil price) must not produce a price move")
	}
	// Non-comparable kinds: range_low vs prev fixed → no phantom move.
	if _, moved := d.eventsFor(prev, RawListing{PriceLow: new(float64(1_000_000)), PriceKind: PriceRangeLow, Status: "for_sale"}); moved {
		t.Error("range_low vs prev fixed must NOT be treated as a move")
	}
	// Status change only (same price, for_sale → under_offer).
	evs, _ = d.eventsFor(prev, RawListing{PriceLow: new(float64(1_200_000)), PriceKind: PriceFixed, Status: "under_offer"})
	if !hasEvent(evs, "status_change") || hasEvent(evs, "price_drop") {
		t.Errorf("expected status_change only, got %v", evs)
	}
	// Relisted (prev inactive) + a concurrent drop.
	inactive := &storedListing{Price: new(float64(1_200_000)), PriceKind: PriceFixed, Status: "withdrawn", IsActive: false}
	evs, _ = d.eventsFor(inactive, fixed(1_100_000))
	if !hasEvent(evs, "relisted") || !hasEvent(evs, "price_drop") {
		t.Errorf("expected relisted + price_drop, got %v", evs)
	}
}

// TestAddressPriceMove covers the address-level relist-drop detection
// (diff.go): a brand-new listing_id at a KNOWN address, priced
// against that address's most recent active listing (a DIFFERENT listing_id,
// possibly a different source) — the drop a listing_id-keyed diff alone can
// never see. Same noise/comparable-kind gates as the listing-level diff.
func TestAddressPriceMove(t *testing.T) {
	d := testDiffer()
	addrKey := "1-centre-road-brighton-vic-3186"

	// No known prior at this address -> never fires.
	newL := RawListing{PriceLow: new(float64(1_100_000)), PriceKind: PriceFixed, Status: "for_sale", AddressKey: addrKey}
	if _, ok := d.addressPriceMove(nil, newL); ok {
		t.Error("nil addrPrior must never fire")
	}

	prior := &storedListing{Price: new(float64(1_200_000)), PriceKind: PriceFixed, Status: "for_sale", IsActive: true}

	// A relisted listing_id at the SAME address, priced below the prior active
	// listing -> price_drop, carrying the prior's price as PrevPrice.
	e, ok := d.addressPriceMove(prior, newL)
	if !ok || e.EventType != "price_drop" {
		t.Fatalf("expected price_drop, got ok=%v e=%+v", ok, e)
	}
	if e.PrevPrice == nil || *e.PrevPrice != 1_200_000 {
		t.Errorf("PrevPrice = %v, want 1200000", e.PrevPrice)
	}

	// Rise.
	riseL := RawListing{PriceLow: new(float64(1_350_000)), PriceKind: PriceFixed, Status: "for_sale", AddressKey: addrKey}
	if e, ok := d.addressPriceMove(prior, riseL); !ok || e.EventType != "price_rise" {
		t.Errorf("expected price_rise, got ok=%v e=%+v", ok, e)
	}

	// Genuinely the same price (sub-threshold) -> must NOT fire (the "same
	// listing/price" guard).
	sameL := RawListing{PriceLow: new(float64(1_199_000)), PriceKind: PriceFixed, Status: "for_sale", AddressKey: addrKey}
	if _, ok := d.addressPriceMove(prior, sameL); ok {
		t.Error("sub-threshold move must not fire")
	}

	// Non-comparable kinds -> no phantom move.
	rangeL := RawListing{PriceLow: new(float64(1_000_000)), PriceKind: PriceRangeLow, Status: "for_sale", AddressKey: addrKey}
	if _, ok := d.addressPriceMove(prior, rangeL); ok {
		t.Error("non-comparable price kinds must not fire")
	}

	// A sold listing must never produce a phantom "discount".
	soldL := RawListing{PriceLow: new(float64(900_000)), PriceKind: PriceFixed, Status: "sold", AddressKey: addrKey}
	if _, ok := d.addressPriceMove(prior, soldL); ok {
		t.Error("a sold listing must not fire a price move")
	}
}

func hasEvent(evs []PriceEvent, kind string) bool {
	for _, e := range evs {
		if e.EventType == kind {
			return true
		}
	}
	return false
}

// testDiffer is the diff under the collector's shipped thresholds: $5k and 0.5%
// noise, and a two-sweep delist grace.
func testDiffer() *differ {
	return &differ{cfg: testRules(), res: &Result{}}
}

// A move must clear BOTH the dollar floor and the percentage gate. $10M to $9.994M
// is a $6,000 drop (over the $5,000 floor) but only 0.06% (under the 0.5% gate), so
// it is not a price drop. Removing either gate would make this fire.
func TestEventsFor_PercentGateAndDollarFloorBothRequired(t *testing.T) {
	fixed := func(v float64) RawListing {
		return RawListing{PriceLow: new(v), PriceKind: PriceFixed, Status: "for_sale"}
	}
	prev := func(v float64) *storedListing {
		return &storedListing{Price: new(v), PriceKind: PriceFixed, Status: "for_sale", IsActive: true}
	}
	moves := func(evs []PriceEvent) bool {
		for _, e := range evs {
			if e.EventType == "price_drop" || e.EventType == "price_rise" {
				return true
			}
		}
		return false
	}

	// Clears the $5,000 floor, misses the 0.5% gate: no move, either direction.
	d := testDiffer()
	if evs, moved := d.eventsFor(prev(10_000_000), fixed(9_994_000)); moved || moves(evs) {
		t.Errorf("$6k on $10M (0.06%%) must not move, got %v", evs)
	}
	if evs, moved := d.eventsFor(prev(10_000_000), fixed(10_006_000)); moved || moves(evs) {
		t.Errorf("$6k rise on $10M (0.06%%) must not move, got %v", evs)
	}

	// Clears the 0.5% gate, misses the $5,000 floor: no move.
	if evs, moved := testDiffer().eventsFor(prev(100_000), fixed(99_000)); moved || moves(evs) {
		t.Errorf("$1k on $100k (1%%) is under the dollar floor and must not move, got %v", evs)
	}

	// Positive control: clears both gates, so it does move.
	evs, moved := testDiffer().eventsFor(prev(10_000_000), fixed(9_900_000))
	if !moved || !hasKind(evs, "price_drop") {
		t.Errorf("$100k on $10M (1%%, over the floor) must be a price_drop, got %v moved=%v", evs, moved)
	}
}

func hasKind(evs []PriceEvent, kind string) bool {
	for _, e := range evs {
		if e.EventType == kind {
			return true
		}
	}
	return false
}
