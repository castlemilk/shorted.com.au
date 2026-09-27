// Package strategies holds the named stock-picking strategies behind /picks,
// the StrategyService API and the MCP strategy tools.
//
// It is deliberately free of I/O. Registry() is the single home of every
// strategy's prose (description, rules, evaluation text, caveats, sources),
// and Evaluate() turns a slice of Candidates (one row per stock, read by the
// store from mv_price_features LEFT JOIN mv_fundamentals_growth LEFT JOIN
// mv_screener_data) plus the market Regime (mv_market_regime) into ranked
// Picks. Column names mirror docs/plans/stock-picker.md §2.2-§2.4, which is
// the contract with the data layer.
//
// Every rule resolves to pass, fail or unknown. Unknown means the data is
// missing, never counts as a pass, and a stock cannot reach status
// "triggered" with an unknown core rule.
package strategies

import "time"

// RuleStatus is the outcome of one rule for one stock.
type RuleStatus string

const (
	RulePass    RuleStatus = "pass"
	RuleFail    RuleStatus = "fail"
	RuleUnknown RuleStatus = "unknown"
)

// PickStatus is where a stock sits on the status ladder.
type PickStatus string

const (
	// StatusTriggered: every core rule passes.
	StatusTriggered PickStatus = "triggered"
	// StatusSetup: every core rule passes except the strategy's trigger
	// rules (the breakout, or the new-high / leadership rules), which have
	// not happened yet. This is the watchlist.
	StatusSetup PickStatus = "setup"
	// StatusWatch: at least one rule passes, but the stock is not a setup.
	StatusWatch PickStatus = "watch"
)

// statusRank orders the ladder: lower is better.
func statusRank(s PickStatus) int {
	switch s {
	case StatusTriggered:
		return 0
	case StatusSetup:
		return 1
	default:
		return 2
	}
}

// ValidPickStatus reports whether s is a status a caller may filter on.
func ValidPickStatus(s string) bool {
	switch PickStatus(s) {
	case StatusTriggered, StatusSetup, StatusWatch:
		return true
	}
	return false
}

// Regime labels, as mv_market_regime.regime stores them.
const (
	RegimeUptrend   = "uptrend"
	RegimeNeutral   = "neutral"
	RegimeDowntrend = "downtrend"
)

// DefaultIndexCode is the index the regime is read from (S&P/ASX 200).
const DefaultIndexCode = "XJO"

// LiquidityFloorAUD is the minimum 20-session average daily turnover. It is
// also what excludes sub-cent stocks, whose DECIMAL(10,2) prices are too
// coarse to measure (plan §2.3: applied in the evaluator, not the view).
const LiquidityFloorAUD = 250_000.0

// Growth mirrors one row of mv_fundamentals_growth (plan §2.2). Every numeric
// field is nullable: *_yoy_pct is NULL (not 0) when either side is missing or
// the prior is <= 0.
type Growth struct {
	BasisPeriodType       string // series the EPS growth used: "ttm" or "annual"
	LatestPeriodEnd       *time.Time
	LatestAnnualPeriodEnd *time.Time

	RevenueLatest      *float64
	RevenuePrior       *float64
	RevenueYoYPct      *float64 // latest annual vs prior annual
	RevenueYoYPriorPct *float64

	EPSLatest      *float64
	EPSPrior       *float64
	EPSYoYPct      *float64 // basis_period_type vs the same series a year earlier
	EPSYoYPriorPct *float64

	NetIncomeLatest   *float64
	NetIncomePrior    *float64
	NetIncomePositive *bool

	OperatingCashFlowLatest *float64

	RevenueTTM   *float64
	NetIncomeTTM *float64
	EPSTTM       *float64

	// Latest half minus the same half a year earlier (TTM minus latest full
	// year). Used ONLY as a sign, as supporting evidence.
	RevenueHalfDelta   *float64
	NetIncomeHalfDelta *float64

	Currency         string
	PeriodsAvailable int32
	FetchedAt        *time.Time
}

// HasGrowthData reports whether at least one growth percentage is known.
func (g *Growth) HasGrowthData() bool {
	return g != nil && (g.RevenueYoYPct != nil || g.EPSYoYPct != nil)
}

// Turnaround reports "prior loss, now profit": net_income_prior <= 0 AND
// net_income_positive. Both must be known.
func (g *Growth) Turnaround() bool {
	return g != nil && g.NetIncomePrior != nil && g.NetIncomePositive != nil &&
		*g.NetIncomePrior <= 0 && *g.NetIncomePositive
}

// Candidate is one stock as the evaluator sees it: a row of
// mv_price_features, LEFT JOINed to mv_fundamentals_growth (Growth, nil when
// there is no row) and mv_screener_data (short interest, market cap, names),
// with "company-metadata" as the fallback for names when the stock has no
// screener row. Nullable columns are pointers; nil is unknown.
type Candidate struct {
	// mv_price_features (plan §2.3)
	StockCode         string
	AsOf              time.Time
	Close             float64
	PrevClose         *float64
	SMA10             *float64
	SMA20             *float64
	SMA50             *float64
	SMA150            *float64
	SMA200            *float64
	SMA200_1mAgo      *float64
	High52w           *float64
	Low52w            *float64
	PctOff52wHigh     *float64 // negative or 0
	PctAbove52wLow    *float64
	Volume            *float64
	AvgVolume50d      *float64
	VolumeRatio50d    *float64
	DollarVolume20d   *float64
	BaseHigh          *float64 // the pivot: max(high) over sessions [t-40, t-1]
	BaseLow           *float64
	BaseDepthPct      *float64
	BaseLengthDays    *int32
	BreakoutRecent    *bool
	BreakoutDate      *time.Time
	Ret1mPct          *float64
	Ret3mPct          *float64
	Ret6mPct          *float64
	Ret12mPct         *float64
	RS3mPct           *float64
	RS6mPct           *float64
	SessionsAvailable int32

	// mv_fundamentals_growth (plan §2.2); nil when the stock has no row.
	Growth *Growth

	// mv_screener_data, falling back to "company-metadata" for names.
	CompanyName string
	Industry    string
	LogoURL     string
	ShortPct    *float64 // nil when the stock has no reported short position
	DaysToCover *float64 // nil when there is no volume to divide by
	MarketCap   *float64 // nil when unknown
}

// Regime mirrors one row of mv_market_regime (plan §2.4). Label is empty
// when no row exists (a dev database without the view), which every regime
// rule reads as unknown.
type Regime struct {
	IndexCode     string
	AsOf          *time.Time
	Close         *float64
	SMA50         *float64
	SMA200        *float64
	PctOff52wHigh *float64
	Ret1mPct      *float64
	Ret3mPct      *float64
	Label         string // RegimeUptrend | RegimeNeutral | RegimeDowntrend | ""
}

// Known reports whether the regime row exists and carries a recognised label.
func (r Regime) Known() bool {
	switch r.Label {
	case RegimeUptrend, RegimeNeutral, RegimeDowntrend:
		return true
	}
	return false
}

// RuleResult is the outcome of one rule for one stock.
type RuleResult struct {
	RuleID   string
	Status   RuleStatus
	Detail   string
	Value    float64
	HasValue bool
}

// Pick is one evaluated stock, ranked.
type Pick struct {
	Rank      int // 1-based across the whole evaluated list
	Candidate Candidate
	Status    PickStatus
	Score     float64 // 0-100, orders rows within a status
	Rules     []RuleResult
}
