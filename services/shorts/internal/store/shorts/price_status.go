package shorts

// The three price states a universe row can be in (#576).
//
// has_price_history is a boolean and answers "can I price this". A caller
// building a survivorship-free backtest has a second question it cannot answer:
// whether an empty row is empty for good, or merely not filled in yet.
const (
	// A usable close exists on or before the requested date.
	PriceStatusPriced = "priced"

	// No price, and no provider has ever been asked for this code. The gap may
	// still close; a backtest should not treat it as permanent.
	PriceStatusUnattempted = "unattempted"

	// No price, and a provider WAS asked and had nothing. As final as current
	// sources make it.
	PriceStatusUnavailable = "unavailable"
)

// priceStatus collapses "do we hold a price" and "did we ever ask" into the one
// answer a caller acts on.
//
// The two inputs were previously only available as one, and that is exactly how
// 936 of 1,941 codes sat unexamined: every stock list the backfill used was
// derived from stock_prices itself, so a code with no prices was never
// requested, and "unattempted" was indistinguishable from "unavailable" in
// every response. The standing explanation for the gap survived as long as it
// did because nothing could tell them apart.
//
// attempted is read from stock_price_backfill_attempts, which holds one row per
// code once the backfill has reached it. A row's mere existence is the signal
// here; its outcome column carries the detail, and is deliberately not surfaced
// on this message — a universe row should not grow a provider error string.
func priceStatus(hasPriceHistory, attempted bool) string {
	switch {
	case hasPriceHistory:
		return PriceStatusPriced
	case attempted:
		return PriceStatusUnavailable
	default:
		return PriceStatusUnattempted
	}
}
