package picks

// columnUnit is what a stock_fundamentals value column measures.
type columnUnit int

const (
	// unitMonetary: an amount in the row's REPORTING currency, whole units.
	// The per-field currency gate (plan fundamentals-coverage.md §3.4) and the
	// identity / scale-break gates (§3.5) act on these.
	unitMonetary columnUnit = iota + 1
	// unitPerShare: reporting currency per share (EPS). Ignores currencyCode
	// for the row check (§3.4) and is kept when an identity outlier rejects
	// the period's monetary fields (§3.5).
	unitPerShare
	// unitCount: a number of shares. Currency-free.
	unitCount
)

// columnTiming is whether a column accumulates over the period or is a
// position at its end.
type columnTiming int

const (
	// timingFlow: accumulated over the period (income statement, cash flow).
	// Carried by annual, ttm and half rows; always nil on a 'quarter'
	// balance snapshot. The TTM-at-FYE copy (§3.6) moves only these.
	timingFlow columnTiming = iota + 1
	// timingBalance: a point-in-time position at period_end (balance sheet,
	// and the share count). The only columns a 'quarter' snapshot row carries
	// (§2.1, §3.3).
	timingBalance
)

// fundamentalsColumn is one stock_fundamentals value column and its field on
// PeriodRow.
type fundamentalsColumn struct {
	// name is the stock_fundamentals column, which is also the
	// PeriodRow.FieldSources / Rejected key and the FundamentalsPeriod proto
	// field name.
	name   string
	unit   columnUnit
	timing columnTiming
	// nonPositive: an outflow under Yahoo's sign convention, which must be
	// <= 0; a positive value is a sign_violation (§3.5).
	nonPositive bool
	// field returns the address of the column's field on r: the getter and the
	// setter in one (see get and set).
	field func(r *PeriodRow) **float64
}

// get returns r's value for the column (nil: not held).
func (c fundamentalsColumn) get(r *PeriodRow) *float64 { return *c.field(r) }

// set stores v as r's value for the column (nil clears it).
func (c fundamentalsColumn) set(r *PeriodRow, v *float64) { *c.field(r) = v }

func (c fundamentalsColumn) isMonetary() bool { return c.unit == unitMonetary }
func (c fundamentalsColumn) isFlow() bool     { return c.timing == timingFlow }
func (c fundamentalsColumn) isBalance() bool  { return c.timing == timingBalance }

// fundamentalsColumns is the ONE list of stock_fundamentals value columns:
// the seven of migration 000129 first, then the full statements of 000132
// (plan fundamentals-coverage.md §2.1) in the plan's order. Every per-column
// pass iterates it instead of hand-listing fields: the write funnel
// (sanitizeRows, via PeriodRow.values), and the upsert SQL builder, the sanity
// gates, the Markit fill and the TTM-at-FYE copy that build on it.
//
// Listing a column here does NOT make a statement write it: upsertSQL and
// filingUpsertSQL name their columns explicitly, so a column is only written
// once the migration that adds it is applied everywhere those run.
var fundamentalsColumns = []fundamentalsColumn{
	// 000129.
	{name: "revenue", unit: unitMonetary, timing: timingFlow, field: func(r *PeriodRow) **float64 { return &r.Revenue }},
	{name: "net_income", unit: unitMonetary, timing: timingFlow, field: func(r *PeriodRow) **float64 { return &r.NetIncome }},
	{name: "eps_basic", unit: unitPerShare, timing: timingFlow, field: func(r *PeriodRow) **float64 { return &r.EPSBasic }},
	{name: "eps_diluted", unit: unitPerShare, timing: timingFlow, field: func(r *PeriodRow) **float64 { return &r.EPSDiluted }},
	{name: "operating_cash_flow", unit: unitMonetary, timing: timingFlow, field: func(r *PeriodRow) **float64 { return &r.OperatingCashFlow }},
	{name: "free_cash_flow", unit: unitMonetary, timing: timingFlow, field: func(r *PeriodRow) **float64 { return &r.FreeCashFlow }},
	{name: "shares_outstanding", unit: unitCount, timing: timingBalance, field: func(r *PeriodRow) **float64 { return &r.SharesOutstanding }},

	// 000132: income statement and cash flow.
	{name: "gross_profit", unit: unitMonetary, timing: timingFlow, field: func(r *PeriodRow) **float64 { return &r.GrossProfit }},
	{name: "operating_income", unit: unitMonetary, timing: timingFlow, field: func(r *PeriodRow) **float64 { return &r.OperatingIncome }},
	{name: "ebitda", unit: unitMonetary, timing: timingFlow, field: func(r *PeriodRow) **float64 { return &r.EBITDA }},
	{name: "normalized_ebitda", unit: unitMonetary, timing: timingFlow, field: func(r *PeriodRow) **float64 { return &r.NormalizedEBITDA }},
	{name: "ebit", unit: unitMonetary, timing: timingFlow, field: func(r *PeriodRow) **float64 { return &r.EBIT }},
	{name: "interest_expense", unit: unitMonetary, timing: timingFlow, field: func(r *PeriodRow) **float64 { return &r.InterestExpense }},
	{name: "pretax_income", unit: unitMonetary, timing: timingFlow, field: func(r *PeriodRow) **float64 { return &r.PretaxIncome }},
	{name: "tax_provision", unit: unitMonetary, timing: timingFlow, field: func(r *PeriodRow) **float64 { return &r.TaxProvision }},
	{name: "net_interest_income", unit: unitMonetary, timing: timingFlow, field: func(r *PeriodRow) **float64 { return &r.NetInterestIncome }},
	{name: "capital_expenditure", unit: unitMonetary, timing: timingFlow, nonPositive: true, field: func(r *PeriodRow) **float64 { return &r.CapitalExpenditure }},
	{name: "dividends_paid", unit: unitMonetary, timing: timingFlow, nonPositive: true, field: func(r *PeriodRow) **float64 { return &r.DividendsPaid }},
	{name: "share_buybacks", unit: unitMonetary, timing: timingFlow, nonPositive: true, field: func(r *PeriodRow) **float64 { return &r.ShareBuybacks }},

	// 000132: balance sheet.
	{name: "total_assets", unit: unitMonetary, timing: timingBalance, field: func(r *PeriodRow) **float64 { return &r.TotalAssets }},
	{name: "total_liabilities", unit: unitMonetary, timing: timingBalance, field: func(r *PeriodRow) **float64 { return &r.TotalLiabilities }},
	{name: "total_equity", unit: unitMonetary, timing: timingBalance, field: func(r *PeriodRow) **float64 { return &r.TotalEquity }},
	{name: "cash_and_equivalents", unit: unitMonetary, timing: timingBalance, field: func(r *PeriodRow) **float64 { return &r.CashAndEquivalents }},
	{name: "total_debt", unit: unitMonetary, timing: timingBalance, field: func(r *PeriodRow) **float64 { return &r.TotalDebt }},
	{name: "capital_lease_obligations", unit: unitMonetary, timing: timingBalance, field: func(r *PeriodRow) **float64 { return &r.CapitalLeaseObligations }},
	{name: "net_debt", unit: unitMonetary, timing: timingBalance, field: func(r *PeriodRow) **float64 { return &r.NetDebt }},
	{name: "current_assets", unit: unitMonetary, timing: timingBalance, field: func(r *PeriodRow) **float64 { return &r.CurrentAssets }},
	{name: "current_liabilities", unit: unitMonetary, timing: timingBalance, field: func(r *PeriodRow) **float64 { return &r.CurrentLiabilities }},
}

// columnsByName indexes fundamentalsColumns (FieldSources and Rejected keys,
// the filing rebuild's per-field purge).
var columnsByName = func() map[string]fundamentalsColumn {
	m := make(map[string]fundamentalsColumn, len(fundamentalsColumns))
	for _, c := range fundamentalsColumns {
		m[c.name] = c
	}
	return m
}()

// columnNamed returns the column called name, false when there is none.
func columnNamed(name string) (fundamentalsColumn, bool) {
	c, ok := columnsByName[name]
	return c, ok
}
