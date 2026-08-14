package houseprices

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
// suburb, deciding whether the row is WRITTEN under this suburb. When BOTH
// postcode and suburb are present they must BOTH agree: postcode alone is not
// authoritative because many AU postcodes span several localities (3182 = St
// Kilda + St Kilda West; 2026 = Bondi + Tamarama + North Bondi), so a
// postcode-only match silently pulls neighbouring-suburb stock into the target's
// corpus. When only one field is present it's used as the sole signal (postcode
// preferred); a listing with neither is rejected. Note this is only the WRITE
// gate — the poison ratio (partitionByTarget) deliberately does NOT treat a
// same-postcode-different-suburb neighbour as a miss, so tightening here doesn't
// wrongly trip the poison gate on a small shared-postcode-cluster suburb.
func matchesTarget(r RawListing, t CrawlTarget) bool {
	havePostcode := r.Postcode != ""
	haveSuburb := r.Suburb != ""
	pcOK := havePostcode && r.Postcode == t.Postcode
	subOK := haveSuburb && suburbMatchesTarget(r.Suburb, t)
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

// suburbMatchesTarget compares a portal suburb name to the target, tolerant of
// the St/Saint & Mt/Mount abbreviation forms that the ABS-SAL catalog (Display/
// Suburb) and the portals sometimes disagree on, and comparing against BOTH the
// Display name and the slug form. Without this, a Display of "Mount Eliza"
// against a portal "Mt Eliza" fails subOK for EVERY on-target listing, which the
// poison gate would then amplify into a suburb-wide block (each per-listing
// mismatch is multiplied by the >0.30 gate into zero collected data).
func suburbMatchesTarget(portalSuburb string, t CrawlTarget) bool {
	p := canonAbbrev(normSuburb(portalSuburb))
	return p == canonAbbrev(normSuburb(t.Display)) || p == canonAbbrev(normSuburb(t.Suburb))
}

// canonAbbrev folds the two suburb-name abbreviation pairs at the leading token
// (normSuburb has already removed spaces/punctuation): saint->st, mount->mt. No
// AU suburb beginning "St"/"Mt" is anything but Saint/Mount, so this can't
// conflate distinct suburbs, and postcode still gates every comparison.
func canonAbbrev(s string) string {
	switch {
	case strings.HasPrefix(s, "saint"):
		return "st" + s[len("saint"):]
	case strings.HasPrefix(s, "mount"):
		return "mt" + s[len("mount"):]
	}
	return s
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
// clamped survivors and reports the poison ratio — the fraction of the page that
// is genuinely OFF-TARGET stock (bot-variant / broadened different-postcode), the
// signal the sweep uses to treat a page as poisoned (soft block).
//
// Crucially, the poison ratio counts only HARD misses (wrong/absent postcode). A
// same-postcode-different-suburb listing is a SOFT miss: it is not written (it
// belongs to a neighbouring suburb) but it is NOT bot poison — a shared-postcode
// cluster legitimately back-fills page 1 with adjacent stock (3029 = Tarneit +
// Hoppers Crossing + Truganina; 3030 = Point Cook + Werribee). Counting soft
// misses as poison would trip the page-1 gate on a small cluster suburb and
// discard its real on-target listings, so they are excluded from the ratio.
func partitionByTarget(raw []RawListing, t CrawlTarget) (matched []RawListing, mismatchRatio float64) {
	if len(raw) == 0 {
		return nil, 0
	}
	hardMiss := 0
	for _, r := range raw {
		switch {
		case matchesTarget(r, t):
			matched = append(matched, clampListingPrice(r))
		case r.Postcode != "" && r.Postcode == t.Postcode:
			// Soft miss: same postcode, different suburb — a legitimate neighbour,
			// not written and not poison. Excluded from the ratio.
		default:
			// Hard miss: wrong/absent postcode = genuinely off-target stock, the
			// signal the poison gate exists for.
			hardMiss++
		}
	}
	return matched, float64(hardMiss) / float64(len(raw))
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
