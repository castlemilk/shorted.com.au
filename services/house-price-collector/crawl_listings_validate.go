package main

import (
	"github.com/castlemilk/shorted.com.au/services/pkg/housingcrawl"
)

// matchesTarget reports whether a harvested listing belongs to the requested suburb.
// The gate itself is housingcrawl.MatchesTarget; ApplySweep applies it again before
// any write.
func matchesTarget(r RawListing, t CrawlTarget) bool {
	return housingcrawl.MatchesTarget(r, t.lib())
}

// clampListingPrice nulls a canonical price outside the trusted band, keeping the
// row. See housingcrawl.ClampListingPrice.
func clampListingPrice(r RawListing) RawListing {
	return housingcrawl.ClampListingPrice(r)
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
