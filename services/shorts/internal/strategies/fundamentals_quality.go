package strategies

import (
	"strings"
	"time"
)

// Quality mirrors one row of mv_fundamentals_quality (migration 000132; plan
// docs/plans/fundamentals-coverage.md §2.7), plus the flow basis row's net
// interest income (read beside it: the financials test needs it and the view
// does not carry it), plus the financials decision Go makes over it.
//
// Every figure is in the flow row's reporting currency (the view only aligns
// a balance row of the same currency). Every numeric field is nullable: nil is
// unknown, never zero. The ratios are the view's; Go withholds the ones that
// are not meaningful (ApplyQualityRules) and computes one: return on equity
// for a financial, which the view withholds below 10% equity to assets and
// every major bank sits under (financialROE).
type Quality struct {
	BasisPeriodType string // "annual" | "ttm"
	BasisPeriodEnd  *time.Time
	Currency        string
	Source          string
	FetchedAt       *time.Time

	// The flow row: one period's income statement and cash flow.
	Revenue                  *float64
	GrossProfit              *float64
	OperatingIncome          *float64
	EBITDA                   *float64
	NormalizedEBITDA         *float64
	EBIT                     *float64
	NetIncome                *float64
	OperatingCashFlow        *float64
	OperatingCashFlowDerived bool // operating cash flow = free cash flow minus capex
	FreeCashFlow             *float64
	CapitalExpenditure       *float64
	DividendsPaid            *float64
	InterestExpense          *float64
	SharesOutstanding        *float64
	NetInterestIncome        *float64

	// The balance row aligned to the flow row (same currency, at or up to 6
	// months before it); every field nil when none qualifies.
	BalancePeriodEnd        *time.Time
	BalancePeriodType       string
	BalanceCurrency         string
	BalanceLagMonths        *int32
	TotalAssets             *float64
	TotalAssetsPrior        *float64
	TotalLiabilities        *float64
	TotalEquity             *float64
	TotalEquityPrior        *float64
	CashAndEquivalents      *float64
	TotalDebt               *float64
	CapitalLeaseObligations *float64
	NetDebt                 *float64 // excludes leases; negative is net cash
	CurrentAssets           *float64
	CurrentLiabilities      *float64

	// Ratios, as the view defines them.
	GrossMarginPct     *float64
	OperatingMarginPct *float64
	NetMarginPct       *float64
	FCFMarginPct       *float64
	FCFConversion      *float64 // free cash flow / net profit: a ratio, not a percentage
	ROEPct             *float64
	ROAPct             *float64
	NetDebtToEBITDA    *float64
	NetDebtToEquity    *float64
	CurrentRatio       *float64
	InterestCover      *float64
	PayoutRatioPct     *float64

	// StatementIsFinancial: the newest full Yahoo income statement (the
	// view's statement-shape row, not the flow row) carries neither operating
	// income nor EBITDA, the shape of a bank's or an insurer's. False when no
	// such statement is held (NULL in the view): the industry then decides.
	StatementIsFinancial bool

	// Decided in Go by ApplyQualityRules; never read from the database.
	IsFinancial   bool
	IsProperty    bool
	NotMeaningful []string
}

// Ratio names, spelled as the FundamentalsQuality proto names its fields.
const (
	RatioGrossMarginPct     = "gross_margin_pct"
	RatioOperatingMarginPct = "operating_margin_pct"
	RatioFCFMarginPct       = "fcf_margin_pct"
	RatioFCFConversion      = "fcf_conversion"
	RatioNetDebt            = "net_debt"
	RatioNetDebtToEBITDA    = "net_debt_to_ebitda"
	RatioNetDebtToEquity    = "net_debt_to_equity"
	RatioCurrentRatio       = "current_ratio"
	RatioInterestCover      = "interest_cover"
)

// notMeaningfulForFinancials is THE list (plan §2.7): the ratios withheld and
// marked not meaningful for a bank, insurer or other financial. A lender's
// "debt" is the funding of its business and its cash flows are its customers'
// money, so margins below the top line, cash conversion, net debt, leverage,
// the current ratio and interest cover describe nothing. ROE, ROA, net margin
// and payout stay (ROE computed without the view's leverage guard; see
// financialROE).
var notMeaningfulForFinancials = []string{
	RatioGrossMarginPct,
	RatioOperatingMarginPct,
	RatioFCFMarginPct,
	RatioFCFConversion,
	RatioNetDebt,
	RatioNetDebtToEBITDA,
	RatioNetDebtToEquity,
	RatioCurrentRatio,
	RatioInterestCover,
}

// NotMeaningfulForFinancials returns the ratio names withheld for financials,
// as a fresh copy. It is the ONE list the stock page, the picker, MCP and the
// quality rules all read.
func NotMeaningfulForFinancials() []string {
	return append([]string(nil), notMeaningfulForFinancials...)
}

// IsNotMeaningful reports whether ratio is withheld for this quality row.
func (q *Quality) IsNotMeaningful(ratio string) bool {
	if q == nil {
		return false
	}
	for _, r := range q.NotMeaningful {
		if r == ratio {
			return true
		}
	}
	return false
}

// ratioField returns the field a not-meaningful ratio name refers to.
func (q *Quality) ratioField(name string) **float64 {
	switch name {
	case RatioGrossMarginPct:
		return &q.GrossMarginPct
	case RatioOperatingMarginPct:
		return &q.OperatingMarginPct
	case RatioFCFMarginPct:
		return &q.FCFMarginPct
	case RatioFCFConversion:
		return &q.FCFConversion
	case RatioNetDebt:
		return &q.NetDebt
	case RatioNetDebtToEBITDA:
		return &q.NetDebtToEBITDA
	case RatioNetDebtToEquity:
		return &q.NetDebtToEquity
	case RatioCurrentRatio:
		return &q.CurrentRatio
	case RatioInterestCover:
		return &q.InterestCover
	}
	return nil
}

// Industry groups. "company-metadata".industry holds GICS industry GROUP
// names (store/shorts/gics.go); compared case-insensitively and with runs of
// whitespace collapsed. "Diversified Financials" is the pre-2023 name of the
// group now called "Financial Services".
var (
	financialIndustryGroups = map[string]bool{
		"banks":     true,
		"insurance": true,
	}
	diversifiedFinancialIndustryGroups = map[string]bool{
		"financial services":     true,
		"diversified financials": true,
	}
	propertyIndustryGroups = map[string]bool{
		"equity real estate investment trusts (reits)": true,
		"real estate management & development":         true,
	}
)

// A Financial Services company is read as a lender when its debt is at least
// half its assets, or its net interest income is over a quarter of revenue.
const (
	lenderDebtToAssets = 0.5
	lenderNIIToRevenue = 0.25
)

func normaliseIndustry(s string) string {
	return strings.Join(strings.Fields(strings.ToLower(s)), " ")
}

// IsFinancial decides, once, whether a company is a bank, insurer or other
// financial (plan §2.7):
//
//   - its newest full Yahoo income statement carries neither operating
//     income nor EBITDA (statement_is_financial; a legacy, Markit, filing or
//     FX-refused row never decides it); or
//   - its industry group is Banks or Insurance; or
//   - its industry group is Financial Services (Diversified Financials before
//     2023) AND it lends: total debt at least 0.5 x total assets, or net
//     interest income above 0.25 x revenue.
//
// q may be nil, when the industry alone decides. net_interest_income is NOT a
// classifier on its own: Yahoo populates it as minus interest expense for
// every company.
func IsFinancial(q *Quality, industry string) bool {
	if q != nil && q.StatementIsFinancial {
		return true
	}
	group := normaliseIndustry(industry)
	if financialIndustryGroups[group] {
		return true
	}
	if !diversifiedFinancialIndustryGroups[group] || q == nil {
		return false
	}
	if q.TotalDebt != nil && q.TotalAssets != nil && *q.TotalAssets > 0 &&
		*q.TotalDebt >= lenderDebtToAssets**q.TotalAssets {
		return true
	}
	return q.NetInterestIncome != nil && q.Revenue != nil && *q.Revenue > 0 &&
		*q.NetInterestIncome > lenderNIIToRevenue**q.Revenue
}

// IsProperty reports a property trust or developer (plan §2.7), whose profit
// and EBITDA include revaluations of its properties.
func IsProperty(industry string) bool {
	return propertyIndustryGroups[normaliseIndustry(industry)]
}

// FinancialFlags is the financials decision for a stock that may have no
// quality row (q nil): whether it is a financial, whether it is a property
// trust, and the ratio names withheld (the full list for a financial, nil
// otherwise).
func FinancialFlags(q *Quality, industry string) (isFinancial, isProperty bool, notMeaningful []string) {
	isFinancial = IsFinancial(q, industry)
	if isFinancial {
		notMeaningful = NotMeaningfulForFinancials()
	}
	return isFinancial, IsProperty(industry), notMeaningful
}

// ApplyQualityRules records the financials decision on q and, for a
// financial, nulls every not-meaningful ratio before anything leaves the API
// or any rule reads it (plan §2.7). Statement lines (total debt, cash and so
// on) are kept; only ratios are withheld. A financial whose roe_pct the view
// withheld gets it from financialROE, so the stock page, the picker's sort,
// the quality-compounders ROE rule and MCP all read the same figure.
// Idempotent; nil is a no-op.
func ApplyQualityRules(q *Quality, industry string) {
	if q == nil {
		return
	}
	q.IsFinancial, q.IsProperty, q.NotMeaningful = FinancialFlags(q, industry)
	if !q.IsFinancial {
		return
	}
	for _, name := range notMeaningfulForFinancials {
		*q.ratioField(name) = nil
	}
	if q.ROEPct == nil {
		q.ROEPct = financialROE(q)
	}
}

// financialROE is return on equity exactly as mv_fundamentals_quality
// computes roe_pct, less its leverage guard: the flow basis row's net income
// over the average of the aligned balance row's equity and the equity 10 to
// 14 months before it (the view's total_equity and total_equity_prior, same
// currency as the flow row), both > 0, as a percentage. The view also
// withholds ROE when average equity is under 10% of average assets (or the
// assets are unknown), because for an ordinary company that much leverage
// makes the ratio describe borrowing rather than quality. A bank's balance
// sheet is leverage by design (CBA: about 6% equity to assets), so for a
// financial that guard withholds the headline ratio from every major bank
// for no reason a reader could be given. nil when an input is missing or the
// result is not finite.
func financialROE(q *Quality) *float64 {
	if q.NetIncome == nil || q.TotalEquity == nil || q.TotalEquityPrior == nil ||
		!(*q.TotalEquity > 0) || !(*q.TotalEquityPrior > 0) {
		return nil
	}
	avgEquity := (*q.TotalEquity + *q.TotalEquityPrior) / 2
	roe := *q.NetIncome / avgEquity * 100
	if !isFinite(roe) {
		return nil
	}
	return &roe
}
