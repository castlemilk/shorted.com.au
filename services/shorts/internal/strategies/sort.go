package strategies

import "sort"

// GetStrategyPicks orderings (sort_by; plan fundamentals-coverage.md §5.2).
// A closed set: anything else is refused by the handler.
const (
	SortScore      = "score" // the default: the evaluator's own rank order
	SortRevenueYoY = "revenue_yoy"
	SortEPSYoY     = "eps_yoy"
	SortROE        = "roe"
	SortNetMargin  = "net_margin"
	SortFCFMargin  = "fcf_margin"
	SortPE         = "pe" // ascending: the cheapest first
	SortMarketCap  = "market_cap"
)

var sortKeys = []string{SortScore, SortRevenueYoY, SortEPSYoY, SortROE, SortNetMargin, SortFCFMargin, SortPE, SortMarketCap}

// SortKeys returns every valid sort_by value, in documentation order.
func SortKeys() []string { return append([]string(nil), sortKeys...) }

// ValidSortBy reports whether s is a sort_by value (exact, lower case).
func ValidSortBy(s string) bool {
	for _, k := range sortKeys {
		if s == k {
			return true
		}
	}
	return false
}

// Growth figures outside this range sort after every measured figure and
// before unknowns: +900% off a tiny base, or -99% into a loss, is a real
// number but not a comparable one (the web shows them as n/m).
const (
	growthSortCeilingPct = 500.0
	growthSortFloorPct   = -95.0
)

// sortBucket orders the groups a sorted list falls into.
type sortBucket int

const (
	bucketMeasured sortBucket = iota
	bucketOutOfRange
	bucketUnknown
)

// sortValue is the figure a pick sorts on under by, and its bucket. The
// figures are the ones the pick row carries: growth from Growth, ratios from
// the (financials-decided) Quality, P/E from Valuation and the resolved market
// cap, so a not-meaningful ratio is an unknown here too.
func sortValue(p *Pick, by string) (float64, sortBucket) {
	c := &p.Candidate
	var v *float64
	growth := false
	switch by {
	case SortScore:
		return p.Score, bucketMeasured
	case SortRevenueYoY:
		growth = true
		if c.Growth != nil {
			v = c.Growth.RevenueYoYPct
		}
	case SortEPSYoY:
		growth = true
		if c.Growth != nil {
			v = c.Growth.EPSYoYPct
		}
	case SortROE:
		if c.Quality != nil {
			v = c.Quality.ROEPct
		}
	case SortNetMargin:
		if c.Quality != nil {
			v = c.Quality.NetMarginPct
		}
	case SortFCFMargin:
		if c.Quality != nil {
			v = c.Quality.FCFMarginPct
		}
	case SortPE:
		v = c.Valuation.PERatio
	case SortMarketCap:
		v = c.ResolvedMarketCap()
	}
	if v == nil || !isFinite(*v) {
		return 0, bucketUnknown
	}
	if growth && (*v > growthSortCeilingPct || *v < growthSortFloorPct) {
		return *v, bucketOutOfRange
	}
	return *v, bucketMeasured
}

// SortPicks orders picks by `by` and NEVER mutates its input (the cached,
// shared pick list): "" and "score" return picks itself, already in rank
// order; any other key returns a sorted copy.
//
// Order: measured figures (descending, except "pe" ascending), then growth
// figures outside [-95%, +500%], then unknowns. Ties, and every row within the
// out-of-range and unknown groups, keep rank order (sort.SliceStable over a
// rank-ordered input). Rank itself is untouched: it stays the evaluator's.
func SortPicks(picks []Pick, by string) []Pick {
	if by == "" || by == SortScore || !ValidSortBy(by) {
		return picks
	}
	type key struct {
		v float64
		b sortBucket
	}
	keys := make([]key, len(picks))
	order := make([]int, len(picks))
	for i := range picks {
		v, b := sortValue(&picks[i], by)
		keys[i], order[i] = key{v, b}, i
	}
	ascending := by == SortPE
	sort.SliceStable(order, func(a, b int) bool {
		ka, kb := keys[order[a]], keys[order[b]]
		if ka.b != kb.b {
			return ka.b < kb.b
		}
		if ka.b != bucketMeasured || ka.v == kb.v {
			return false
		}
		if ascending {
			return ka.v < kb.v
		}
		return ka.v > kb.v
	})
	out := make([]Pick, len(picks))
	for i, j := range order {
		out[i] = picks[j]
	}
	return out
}
