package housingcrawl

import (
	"regexp"
	"strings"
)

// address_key gives the listing crawl a STABLE per-physical-address identity that
// survives a relist (REA and Domain mint a new listing_id each time an agent
// re-lists the same property) and a cross-portal duplicate. Both portals show the
// same physical address, but the display string differs: REA usually appends
// ", Suburb, State Postcode", Domain often shows just the street. We strip the
// suburb suffix and re-append the CANONICAL suburb/state/postcode from the target
// being swept, so both portals converge on one key.

// addrSlugRe matches any run of characters that are NOT lowercase letters or
// digits — collapsed to a single '-' by Slug().
var addrSlugRe = regexp.MustCompile(`[^a-z0-9]+`)

// Slug lowercases s and replaces every run of non-alphanumeric characters
// (whitespace, punctuation, '/') with a single '-', trimming leading/trailing
// dashes. Digits are kept (unit/street numbers are part of the identity).
func Slug(s string) string {
	s = addrSlugRe.ReplaceAllString(strings.ToLower(strings.TrimSpace(s)), "-")
	return strings.Trim(s, "-")
}

// streetPart strips a trailing ", Suburb[, State Postcode]" suffix off a portal
// display address, returning just the unit+street portion. It removes
// everything from the LAST case-insensitive occurrence of suburb onward (a
// display string can legitimately contain the suburb name earlier, e.g. a street
// named after the suburb, so anchoring on the last occurrence is the safer
// heuristic). When suburb doesn't appear in displayAddr at all (common on
// Domain, which often shows only the street), the whole displayAddr is treated
// as the street.
func StreetPart(displayAddr, suburb string) string {
	displayAddr = strings.TrimSpace(displayAddr)
	if displayAddr == "" {
		return ""
	}
	suburb = strings.TrimSpace(suburb)
	if suburb == "" {
		return displayAddr
	}
	idx := strings.LastIndex(strings.ToLower(displayAddr), strings.ToLower(suburb))
	if idx < 0 {
		return displayAddr
	}
	return strings.TrimRight(displayAddr[:idx], " ,\t\n-")
}

// addressKey derives a stable, cross-portal identity for a physical address from
// the listing's display address plus the CANONICAL crawl-target suburb/state/
// postcode (the target's fields, not whatever the portal echoed back — that's
// what makes REA's "1 Centre Road, Brighton, Vic 3186" and Domain's "1 Centre
// Road" (crawled under the same Brighton/VIC/3186 target) resolve to the SAME
// key: 1-centre-road-brighton-vic-3186).
//
// Returns "" when a stable key can't be formed: no street content survives the
// suburb-suffix strip, or suburb/postcode is missing (state is folded in as-is;
// an empty state degrades the key but never blocks it, since every Target
// carries one).
func AddressKey(displayAddr, suburb, state, postcode string) string {
	suburb = strings.TrimSpace(suburb)
	postcode = strings.TrimSpace(postcode)
	if suburb == "" || postcode == "" {
		return ""
	}
	street := Slug(StreetPart(displayAddr, suburb))
	if street == "" {
		return ""
	}
	return strings.Join([]string{street, Slug(suburb), strings.ToLower(strings.TrimSpace(state)), postcode}, "-")
}
