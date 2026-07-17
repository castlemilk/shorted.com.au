package main

import "strings"

// Listing-level anti-poisoning, layered on top of the raw-HTML looksBlocked /
// circuit-breaker path (crawl.go/crawl_playwright.go, which run first). Two gates:
//
//  1. matchesTarget — the listing must belong to the suburb we asked for. Kasada's
//     bot-variant DOM often serves generic/nearby stock; a postcode or suburb-name
//     mismatch drops the row (and, in bulk, flags the whole page as poisoned).
//  2. clampListingPrice — an out-of-band canonical price ($100k–$50M, the same
//     bounds the median crawl trusts) is nulled rather than dropped, so a genuine
//     "Contact Agent" listing with a garbage embedded number still tracks as a
//     priceless active listing instead of vanishing.

// matchesTarget reports whether a harvested listing belongs to the requested
// suburb. When BOTH postcode and suburb are present they must BOTH agree:
// postcode alone is not authoritative because many AU postcodes span several
// localities (3182 = St Kilda + St Kilda West; 2026 = Bondi + Tamarama + North
// Bondi), so a postcode-only match silently pulls neighbouring-suburb stock into
// the target's corpus. When only one field is present it's used as the sole
// signal (postcode preferred); a listing with neither is rejected. Tightening
// this also sharpens partitionByTarget's mismatchRatio: genuine shared-postcode
// neighbours now count as misses, so a page that has broadened into the surrounds
// reads as more mismatched — the delist-safe direction (poison/partial, never a
// wrongful complete sweep).
func matchesTarget(r RawListing, t CrawlTarget) bool {
	havePostcode := r.Postcode != ""
	haveSuburb := r.Suburb != ""
	pcOK := havePostcode && r.Postcode == t.Postcode
	subOK := haveSuburb && normSuburb(r.Suburb) == normSuburb(t.Display)
	switch {
	case havePostcode && haveSuburb:
		return pcOK && subOK
	case havePostcode:
		return pcOK
	case haveSuburb:
		return subOK
	default:
		return false
	}
}

// clampListingPrice nulls a canonical price that falls outside the trusted band
// (reusing the median crawl's $100k–$50M bounds), keeping the row.
func clampListingPrice(r RawListing) RawListing {
	if cp := canonicalPrice(r.PriceLow, r.PriceHigh, r.PriceKind); cp != nil {
		if *cp < minPlausibleMedian || *cp > maxPlausibleMedian {
			r.PriceLow, r.PriceHigh, r.PriceKind = nil, nil, priceUnknown
		}
	}
	return r
}

// partitionByTarget splits a page's raw listings into the target-matched, price-
// clamped survivors and reports the fraction that failed the target match — the
// signal the sweep uses to treat a page as poisoned (soft block).
func partitionByTarget(raw []RawListing, t CrawlTarget) (matched []RawListing, mismatchRatio float64) {
	if len(raw) == 0 {
		return nil, 0
	}
	miss := 0
	for _, r := range raw {
		if matchesTarget(r, t) {
			matched = append(matched, clampListingPrice(r))
		} else {
			miss++
		}
	}
	return matched, float64(miss) / float64(len(raw))
}

// normSuburb lowercases and strips everything but [a-z0-9] so "St Kilda",
// "st-kilda" and "ST KILDA" all compare equal.
func normSuburb(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}
