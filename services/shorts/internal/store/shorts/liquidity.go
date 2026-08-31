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
