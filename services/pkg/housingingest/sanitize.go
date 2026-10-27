package housingingest

import (
	"math"
	"strings"
	"unicode/utf8"

	"google.golang.org/protobuf/proto"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
)

// TruncateRunes cuts s to at most max bytes, backing up to a rune boundary so the
// result is still valid UTF-8. A string already within max is returned unchanged.
func TruncateRunes(s string, max int) string {
	if len(s) <= max {
		return s
	}
	for n := max; n > 0; n-- {
		if utf8.RuneStart(s[n]) {
			return s[:n]
		}
	}
	return ""
}

// SanitizeListings returns the listings the server will accept, built from in, plus
// how many were dropped and whether the sweep ran past MaxListingsPerSweep.
//
//   - Source is set to src, the sweep's own source.
//   - Out-of-range or non-finite numbers become nil (unknown), never zero.
//   - Over-cap optional strings are truncated at a rune boundary. Unknown status and
//     price-kind values become "" (unknown). Agent names are capped in count and length.
//   - Only identity drops a listing: an empty or over-cap listing_id. Every other
//     over-cap field is blanked (unknown) and the listing is kept. A dropped listing is
//     read as delisted, so one long URL or a full state name must not cost a suburb its
//     COMPLETE status.
//   - A repeated listing_id keeps its first copy, and the rest are dropped.
//   - Past MaxListingsPerSweep, the rest are dropped and overflow is true.
//
// The input is not modified. Every returned listing passes ValidateListing.
// Callers must not send a COMPLETE sweep when skipped > 0 or overflow is true: a
// dropped listing is an absent listing, and absence delists.
func SanitizeListings(in []*pb.Listing, src string) (kept []*pb.Listing, skipped int, overflow bool) {
	seen := make(map[string]bool, len(in))
	for _, l := range in {
		if len(kept) >= MaxListingsPerSweep {
			overflow = true
			skipped++
			continue
		}
		c := sanitizeListing(l, src)
		if c == nil || seen[c.GetListingId()] || ValidateListing("", c, src) != nil {
			skipped++
			continue
		}
		seen[c.GetListingId()] = true
		kept = append(kept, c)
	}
	return kept, skipped, overflow
}

// sanitizeListing returns a sanitised copy of l, or nil when its identity is unusable.
func sanitizeListing(in *pb.Listing, src string) *pb.Listing {
	if in == nil {
		return nil
	}
	l := proto.Clone(in).(*pb.Listing)
	l.Source = src
	if strings.TrimSpace(l.ListingId) == "" || len(l.ListingId) > MaxListingIDBytes {
		return nil
	}
	// Non-identity fields are blanked, never a reason to drop the listing. The store
	// stores a blank URL, state, suburb or postcode, and matches a listing on postcode and
	// suburb, so a blank one is simply a listing that does not match (a miss, not a drop).
	if len(l.ListingUrl) > MaxURLBytes {
		l.ListingUrl = ""
	}
	if len(l.Suburb) > MaxSuburbBytes {
		l.Suburb = ""
	}
	if len(l.State) > MaxStateBytes {
		l.State = ""
	}
	if len(l.Postcode) > MaxPostcodeBytes {
		l.Postcode = ""
	}
	l.DisplayAddr = TruncateRunes(l.DisplayAddr, MaxAddressBytes)
	l.AddressKey = TruncateRunes(l.AddressKey, MaxAddressBytes)
	l.PropertyType = TruncateRunes(l.PropertyType, MaxPropertyBytes)
	l.PriceDisplay = TruncateRunes(l.PriceDisplay, MaxPriceTextBytes)
	l.AgencyId = TruncateRunes(l.AgencyId, MaxAgencyIDBytes)
	l.AgencyName = TruncateRunes(l.AgencyName, MaxAgencyNameBytes)
	if !ValidPriceKind[l.PriceKind] {
		l.PriceKind = ""
	}
	if !ValidListingStatus[l.Status] {
		l.Status = ""
	}
	names := l.AgentNames
	if len(names) > MaxAgentNames {
		names = names[:MaxAgentNames]
	}
	out := make([]string, 0, len(names))
	for _, n := range names {
		out = append(out, TruncateRunes(n, MaxAgentNameBytes))
	}
	l.AgentNames = out
	l.Lat = bounded(l.Lat, -90, 90)
	l.Lng = bounded(l.Lng, -180, 180)
	l.LandSizeSqm = bounded(l.LandSizeSqm, 0, MaxLandSizeSqm)
	l.PriceLow = bounded(l.PriceLow, 0, math.MaxFloat64)
	l.PriceHigh = bounded(l.PriceHigh, 0, math.MaxFloat64)
	for _, p := range []**int32{&l.Bedrooms, &l.Bathrooms, &l.CarSpaces} {
		if *p != nil && (**p < 0 || **p > MaxBedroomsValue) {
			*p = nil
		}
	}
	return l
}

// bounded returns p when it is finite and within [lo, hi], and nil otherwise.
func bounded(p *float64, lo, hi float64) *float64 {
	if p == nil {
		return nil
	}
	v := *p
	if math.IsNaN(v) || math.IsInf(v, 0) || v < lo || v > hi {
		return nil
	}
	return p
}
