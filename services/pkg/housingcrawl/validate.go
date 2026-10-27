package housingcrawl

import "strings"

// Listing-level anti-poisoning, applied before any listing is written. Two gates:
//
//  1. MatchesTarget: the listing must belong to the suburb the sweep asked for.
//     Kasada's bot-variant DOM often serves generic or nearby stock; a postcode
//     or suburb-name mismatch drops the row.
//  2. ClampListingPrice: an out-of-band canonical price ($100k-$50M, the band the
//     median crawl trusts) is nulled rather than dropped, so a genuine "Contact
//     Agent" listing with a garbage embedded number still tracks as a priceless
//     active listing instead of vanishing.

// MatchesTarget reports whether a harvested listing belongs to the requested
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
func MatchesTarget(r RawListing, t Target) bool {
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
func suburbMatchesTarget(portalSuburb string, t Target) bool {
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

// ClampListingPrice nulls a canonical price that falls outside the trusted band
// (reusing the median crawl's $100k–$50M bounds), keeping the row.
func ClampListingPrice(r RawListing) RawListing {
	if cp := CanonicalPrice(r.PriceLow, r.PriceHigh, r.PriceKind); cp != nil {
		if *cp < MinPlausiblePrice || *cp > MaxPlausiblePrice {
			r.PriceLow, r.PriceHigh, r.PriceKind = nil, nil, PriceUnknown
		}
	}
	return r
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
