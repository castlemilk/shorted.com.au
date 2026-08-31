package shorts

// Liquidity band thresholds, in AUD of average daily traded value.
//
// The bands are about TRADABILITY, not company size, which is why they key off
// traded value rather than market capitalisation: a large company whose free
// float rarely turns over is, for the purpose of deciding whether a position
// can be built or exited, a small one.
//
// The boundaries are round numbers on a roughly ten-fold ladder. They are a
// coarse instrument on purpose — a caller who needs a precise floor should use
// average_daily_value_20d directly. The band exists because it stays useful
// where the underlying value is missing or stale, and because "exclude micro"
// is what a caller filtering a universe usually means.
const (
	megaLiquidityFloor  = 100_000_000 // $100m+/day: the top of the ASX
	largeLiquidityFloor = 10_000_000  // $10m+/day
	midLiquidityFloor   = 1_000_000   // $1m+/day
	smallLiquidityFloor = 100_000     // $100k+/day; below this is micro
)

// liquidityBand buckets an average daily traded value. An unknown or
// non-positive value returns "" rather than "micro": we do not know that the
// stock is illiquid, only that we cannot say, and a caller filtering out
// "micro" should not silently also drop everything unmeasured.
func liquidityBand(averageDailyValue float64) string {
	switch {
	case averageDailyValue <= 0:
		return ""
	case averageDailyValue >= megaLiquidityFloor:
		return "mega"
	case averageDailyValue >= largeLiquidityFloor:
		return "large"
	case averageDailyValue >= midLiquidityFloor:
		return "mid"
	case averageDailyValue >= smallLiquidityFloor:
		return "small"
	default:
		return "micro"
	}
}

// daysToCover expresses a short position in sessions of average traded volume:
// how long the short side would take to buy back at the recent run rate.
//
// It is the other standard measure of short interest, and the more useful one
// for a squeeze: percent-of-issue says how much of the register is short,
// days-to-cover says how trapped it is. 5% short against 2% daily turnover
// unwinds in 2.5 days; 5% against 0.1% takes 50, and only the second is a
// squeeze.
//
// This agrees with the definition mv_screener_data and mv_top_shorts use
// (short positions over 20-day average volume, 0 when volume is unknown), and
// deliberately shares its volume>0 filter and its five-session floor — two
// implementations of a published metric that disagree is worse than either.
//
// They are not identical, and the difference matters in one direction. The
// materialised views window on CURRENT_DATE - 35 days, so their avg_volume_20d
// and days_to_cover silently fall to 0 whenever the price feed lags more than
// 35 days. These read the last 20 stored sessions relative to the date being
// asked about, which is what a point-in-time universe requires: a 2015 query
// must see 2015's turnover, and anchoring on today would return nothing at all.
//
// Returns 0 when it cannot be computed rather than an infinity or a very large
// number. A name with no recent volume is exactly the illiquid case where a
// huge days-to-cover looks most dramatic and means least — it would sort
// straight to the top of a squeeze screen on the strength of missing data.
func daysToCover(shortPositions, averageDailyVolume float64) float64 {
	if shortPositions <= 0 || averageDailyVolume <= 0 {
		return 0
	}
	return shortPositions / averageDailyVolume
}
