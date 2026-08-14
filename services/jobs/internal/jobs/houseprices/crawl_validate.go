package houseprices

import (
	"math"
	"sort"
)

// The crawl tier's trust model: realestate.com.au (Kasada) is known to serve
// DELIBERATELY FALSE data to clients it suspects are bots, and domain.com.au
// (Akamai) blocks outright. So a crawled number is guilty until proven innocent.
// Each candidate must pass TWO drop-gates before it is stored:
//
//  1. Absolute sanity bounds (a suburb median is never < $100k or > $50M).
//  2. Plausibility vs the TRUSTED ABS capital-city median for that market
//     (a real suburb sits within a sane band of its capital's median).
//
// A value that fails either gate is dropped, never stored. A THIRD signal —
// cross-source agreement — is ADVISORY ONLY: crossCheck() logs and counts
// divergence between extractors but does NOT drop the value. In-band poison (a
// false median that still sits inside the capital band) can therefore be
// stored; this is tolerated only because the tier is opt-in and its output is
// gated out of every republished/commercial surface by source_licence. A real
// REA-vs-Domain drop-gate is a TODO.

const (
	minPlausibleMedian       = 100_000.0    // $100k absolute floor
	maxPlausibleMedian       = 50_000_000.0 // $50M absolute ceiling
	minCapitalRatio          = 0.15         // suburb median ≥ 15% of capital median
	maxCapitalRatio          = 8.0          // suburb median ≤ 8× capital median
	maxCrossSourceDivergence = 0.30         // REA vs Domain must agree within 30%
)

type validation struct {
	ok     bool
	reason string
}

// validateMedian applies the absolute + capital-relative checks to one value.
// absCapitalMedian ≤ 0 means "no trusted baseline" → the capital check is skipped
// (the absolute bounds still apply).
func validateMedian(value, absCapitalMedian float64) validation {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return validation{false, "non-finite"}
	}
	if value < minPlausibleMedian || value > maxPlausibleMedian {
		return validation{false, "out-of-absolute-bounds"}
	}
	if absCapitalMedian > 0 {
		r := value / absCapitalMedian
		if r < minCapitalRatio || r > maxCapitalRatio {
			return validation{false, "out-of-capital-band"}
		}
	}
	return validation{true, ""}
}

// robustMedian filters a page's raw candidate medians through validateMedian and
// returns the MEDIAN of the survivors — a central estimate that shrugs off a
// stray poisoned outlier even if it happens to land inside the bounds. Returns
// (0, false) if nothing survives (blocked page / fully poisoned / empty).
func robustMedian(candidates []float64, absCapitalMedian float64) (float64, bool) {
	var ok []float64
	for _, c := range candidates {
		if validateMedian(c, absCapitalMedian).ok {
			ok = append(ok, c)
		}
	}
	if len(ok) == 0 {
		return 0, false
	}
	sort.Float64s(ok)
	n := len(ok)
	if n%2 == 1 {
		return ok[n/2], true
	}
	return (ok[n/2-1] + ok[n/2]) / 2, true
}

// crossSourceAgrees reports whether two independent suburb medians agree within
// the divergence threshold — a strong anti-poisoning signal (a poisoned source
// will rarely match a clean one).
func crossSourceAgrees(a, b float64) bool {
	if a <= 0 || b <= 0 {
		return false
	}
	hi, lo := a, b
	if lo > hi {
		hi, lo = lo, hi
	}
	return (hi-lo)/hi <= maxCrossSourceDivergence
}
