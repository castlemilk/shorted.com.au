package housingcrawl

// Price kinds, as the listing tier stores them in price_kind. The collector's
// string parser produces them; the diff reads them.
const (
	PriceFixed      = "fixed"
	PriceRangeLow   = "range_low"
	PriceRangeHigh  = "range_high"
	PriceOffersOver = "offers_over"
	PriceAuction    = "auction"
	PricePOA        = "poa"
	PriceUnknown    = "unknown"
)

// Trusted price band for a listing or median: $100k to $50M, the same bounds the
// suburb-median crawl trusts.
const (
	MinPlausiblePrice = 100_000.0
	MaxPlausiblePrice = 50_000_000.0
)

// CanonicalPrice is the single numeric used for drop detection: the high bound for
// a range_high (an "under $X" ceiling), else the low bound. auction/POA/unknown
// return nil (their bounds are nil) and are excluded from drop math.
func CanonicalPrice(low, high *float64, kind string) *float64 {
	if kind == PriceRangeHigh {
		return high
	}
	return low
}

// ComparableKinds reports whether two price kinds may be compared for a price
// move. Single-value asks (fixed/offers_over) are interchangeable; range kinds
// only compare like-to-like. Cross-kind flips (e.g. range_low -> fixed) are NOT
// comparable — they route to a status_change, never a phantom drop/rise.
func ComparableKinds(a, b string) bool {
	single := map[string]bool{PriceFixed: true, PriceOffersOver: true}
	if single[a] && single[b] {
		return true
	}
	return a == b && (a == PriceRangeLow || a == PriceRangeHigh)
}
