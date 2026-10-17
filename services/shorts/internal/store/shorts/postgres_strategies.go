package shorts

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/strategies"
	"github.com/jackc/pgx/v5"
)

// Stock picker read path (docs/plans/stock-picker.md §2 and §3.2).
//
// Every relation read here is created by migrations 000129 / 000130
// (stock_fundamentals, mv_fundamentals_growth, mv_price_features,
// mv_market_regime). A database without them (dev before `migrate up`, or a
// code-before-DDL deploy) answers 42P01, and every method here turns that
// into an EMPTY result rather than an error, logging it once per method, so
// the API serves an empty universe instead of a 500. Any other error is
// returned: a timeout on a sick view must not masquerade as "no data".

// strategiesQueryTimeout matches the screener's per-query budget.
const strategiesQueryTimeout = 10 * time.Second

// FundamentalsPeriodTypes are the stock_fundamentals.period_type values
// (plan §2.1 CHECK constraint).
var FundamentalsPeriodTypes = map[string]bool{"annual": true, "half": true, "quarter": true, "ttm": true}

// FundamentalsPeriodRow is one row of stock_fundamentals. Nullable figures are
// pointers: nil means the source did not report it.
type FundamentalsPeriodRow struct {
	StockCode         string
	PeriodType        string
	PeriodEnd         time.Time
	FiscalYear        *int32
	Currency          string
	Revenue           *float64
	NetIncome         *float64
	EPSBasic          *float64
	EPSDiluted        *float64
	OperatingCashFlow *float64
	FreeCashFlow      *float64
	SharesOutstanding *float64
	Source            string
	SourceFetchedAt   time.Time

	// The full statements of migration 000132 (plan fundamentals-coverage.md
	// §2.1), in FundamentalsPeriod proto order. All nil on a database without
	// 000132 (GetStockFundamentals falls back to the 000129 column list).
	GrossProfit             *float64
	OperatingIncome         *float64
	EBITDA                  *float64
	NormalizedEBITDA        *float64
	EBIT                    *float64
	InterestExpense         *float64
	PretaxIncome            *float64
	TaxProvision            *float64
	NetInterestIncome       *float64
	CapitalExpenditure      *float64
	DividendsPaid           *float64
	ShareBuybacks           *float64
	TotalAssets             *float64
	TotalLiabilities        *float64
	TotalEquity             *float64
	CashAndEquivalents      *float64
	TotalDebt               *float64
	CapitalLeaseObligations *float64
	NetDebt                 *float64
	CurrentAssets           *float64
	CurrentLiabilities      *float64

	// FieldSources: the fields whose value did not come from Source, mapped
	// to where it came from (plan §2.2). nil when there are none.
	FieldSources map[string]string
	// SourceDocumentURL / SourceDocumentDate: the company filing a
	// filing-sourced row or field came from.
	SourceDocumentURL  string
	SourceDocumentDate *time.Time
}

// fundamentalsDB is the part of *pgxpool.Pool the stock picker and
// fundamentals reads use, so a test can stand in a database that answers
// 42P01 / 42703 (a schema without migration 000132).
type fundamentalsDB interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// missingRelationLog logs a missing strategy relation once per method, so a
// dev database without the migrations does not spam a line per request.
var missingRelationLog sync.Map // method name -> *sync.Once

func logMissingRelationOnce(method string, err error) {
	once, _ := missingRelationLog.LoadOrStore(method, &sync.Once{})
	once.(*sync.Once).Do(func() {
		log.Warnf("%s: a stock-picker relation is missing (migrations 000129/000130 not applied?); serving an empty result: %v", method, err)
	})
}

// finite drops NaN and ±Inf. Postgres happily stores and returns them
// (float8 'NaN', 'Infinity'); encoding/json refuses them, so one bad row
// would fail the whole MCP payload (key_metrics_finite.go has the history).
func finite(v *float64) *float64 {
	if v == nil || math.IsNaN(*v) || math.IsInf(*v, 0) {
		return nil
	}
	return v
}

func finiteAll(vs ...**float64) {
	for _, v := range vs {
		*v = finite(*v)
	}
}

// growthColumns selects every mv_fundamentals_growth column (plan §2.2) the
// evaluator reads, in scanGrowth order, from the alias g. Numeric columns are
// cast to float8 so the scan types do not depend on how the view declares
// them. The column list is fixed (never built from input).
const growthColumns = `
	COALESCE(g.basis_period_type::text, ''),
	g.latest_period_end::date,
	g.latest_annual_period_end::date,
	g.revenue_latest::float8,
	g.revenue_prior::float8,
	g.revenue_yoy_pct::float8,
	g.revenue_yoy_prior_pct::float8,
	g.eps_latest::float8,
	g.eps_prior::float8,
	g.eps_yoy_pct::float8,
	g.eps_yoy_prior_pct::float8,
	g.net_income_latest::float8,
	g.net_income_prior::float8,
	g.net_income_positive,
	g.operating_cash_flow_latest::float8,
	g.revenue_ttm::float8,
	g.net_income_ttm::float8,
	g.eps_ttm::float8,
	g.revenue_half_delta::float8,
	g.net_income_half_delta::float8,
	COALESCE(g.currency::text, ''),
	COALESCE(g.periods_available, 0)::int4,
	g.fetched_at::timestamptz,
	COALESCE(g.revenue_basis_period_type::text, ''),
	g.revenue_half_yoy_pct::float8,
	g.net_income_half_yoy_pct::float8,
	g.eps_half_yoy_pct::float8,
	g.half_latest_period_end::date`

// growthScanTargets returns the scan destinations matching growthColumns.
func growthScanTargets(g *strategies.Growth) []any {
	return []any{
		&g.BasisPeriodType,
		&g.LatestPeriodEnd,
		&g.LatestAnnualPeriodEnd,
		&g.RevenueLatest,
		&g.RevenuePrior,
		&g.RevenueYoYPct,
		&g.RevenueYoYPriorPct,
		&g.EPSLatest,
		&g.EPSPrior,
		&g.EPSYoYPct,
		&g.EPSYoYPriorPct,
		&g.NetIncomeLatest,
		&g.NetIncomePrior,
		&g.NetIncomePositive,
		&g.OperatingCashFlowLatest,
		&g.RevenueTTM,
		&g.NetIncomeTTM,
		&g.EPSTTM,
		&g.RevenueHalfDelta,
		&g.NetIncomeHalfDelta,
		&g.Currency,
		&g.PeriodsAvailable,
		&g.FetchedAt,
		&g.RevenueBasisPeriodType,
		&g.RevenueHalfYoYPct,
		&g.NetIncomeHalfYoYPct,
		&g.EPSHalfYoYPct,
		&g.HalfLatestPeriodEnd,
	}
}

func sanitiseGrowth(g *strategies.Growth) {
	finiteAll(
		&g.RevenueLatest, &g.RevenuePrior, &g.RevenueYoYPct, &g.RevenueYoYPriorPct,
		&g.EPSLatest, &g.EPSPrior, &g.EPSYoYPct, &g.EPSYoYPriorPct,
		&g.NetIncomeLatest, &g.NetIncomePrior, &g.OperatingCashFlowLatest,
		&g.RevenueTTM, &g.NetIncomeTTM, &g.EPSTTM,
		&g.RevenueHalfDelta, &g.NetIncomeHalfDelta,
		&g.RevenueHalfYoYPct, &g.NetIncomeHalfYoYPct, &g.EPSHalfYoYPct,
	)
}

// strategyCandidatesQuery is ONE query over the evaluator's universe: every
// row of mv_price_features, LEFT JOIN mv_fundamentals_growth (growth), LEFT
// JOIN mv_screener_data (short interest, days to cover, market cap, names),
// LEFT JOIN "company-metadata" for names, industry, logo and market cap when
// the stock has no screener row (unshorted stocks are absent from that MV).
//
// mv_screener_data stores 0 for unknown market cap and for days to cover with
// no volume; those become NULL here so the evaluator reads them as unknown,
// not as a real zero. key_metrics->>'market_cap' is cast only when it is a
// plain number, so one malformed JSONB value cannot fail the whole universe.
var strategyCandidatesQuery = `
	SELECT
		pf.stock_code::text,
		pf.as_of::date,
		pf.close::float8,
		pf.prev_close::float8,
		pf.sma10::float8,
		pf.sma20::float8,
		pf.sma50::float8,
		pf.sma150::float8,
		pf.sma200::float8,
		pf.sma200_1m_ago::float8,
		pf.high_52w::float8,
		pf.low_52w::float8,
		pf.pct_off_52w_high::float8,
		pf.pct_above_52w_low::float8,
		pf.volume::float8,
		pf.avg_volume_50d::float8,
		pf.volume_ratio_50d::float8,
		pf.dollar_volume_20d::float8,
		pf.base_high::float8,
		pf.base_low::float8,
		pf.base_depth_pct::float8,
		pf.base_length_days::int4,
		pf.breakout_recent,
		pf.breakout_date::date,
		pf.ret_1m_pct::float8,
		pf.ret_3m_pct::float8,
		pf.ret_6m_pct::float8,
		pf.ret_12m_pct::float8,
		pf.rs_3m_pct::float8,
		pf.rs_6m_pct::float8,
		COALESCE(pf.sessions_available, 0)::int4,
		(g.stock_code IS NOT NULL) AS has_growth,` + growthColumns + `,
		COALESCE(NULLIF(sd.company_name::text, ''), NULLIF(cm.company_name::text, ''), ''),
		COALESCE(NULLIF(sd.industry::text, ''), NULLIF(cm.industry::text, ''), ''),
		COALESCE(NULLIF(sd.logo_url::text, ''), NULLIF(cm.logo_icon_gcs_url::text, ''), NULLIF(cm.logo_gcs_url::text, ''), ''),
		sd.short_pct::float8,
		CASE WHEN sd.avg_volume_20d > 0 THEN sd.days_to_cover::float8 END,
		COALESCE(
			NULLIF(sd.market_cap::float8, 0),
			CASE WHEN cm.key_metrics ->> 'market_cap' ~ '^[0-9]+(\.[0-9]+)?([eE][+]?[0-9]+)?$'
				THEN NULLIF((cm.key_metrics ->> 'market_cap')::float8, 0)
			END
		)
	FROM mv_price_features pf
	LEFT JOIN mv_fundamentals_growth g ON g.stock_code::text = pf.stock_code::text
	LEFT JOIN mv_screener_data sd ON sd.stock_code::text = pf.stock_code::text
	LEFT JOIN "company-metadata" cm ON cm.stock_code::text = pf.stock_code::text
	ORDER BY pf.stock_code
`

// candidateRow holds one scanned row of strategyCandidatesQuery.
type candidateRow struct {
	c         strategies.Candidate
	g         strategies.Growth
	hasGrowth bool
	// as_of and close are NOT NULL by construction of the view, but a NULL
	// in one row must cost that row's numbers, not the whole universe.
	asOf    *time.Time
	closePx *float64
}

// targets returns the scan destinations in strategyCandidatesQuery's column
// order (TestStrategyQueriesScanEveryColumn pins the count).
func (r *candidateRow) targets() []any {
	c := &r.c
	t := []any{
		&c.StockCode, &r.asOf, &r.closePx, &c.PrevClose,
		&c.SMA10, &c.SMA20, &c.SMA50, &c.SMA150, &c.SMA200, &c.SMA200_1mAgo,
		&c.High52w, &c.Low52w, &c.PctOff52wHigh, &c.PctAbove52wLow,
		&c.Volume, &c.AvgVolume50d, &c.VolumeRatio50d, &c.DollarVolume20d,
		&c.BaseHigh, &c.BaseLow, &c.BaseDepthPct, &c.BaseLengthDays,
		&c.BreakoutRecent, &c.BreakoutDate,
		&c.Ret1mPct, &c.Ret3mPct, &c.Ret6mPct, &c.Ret12mPct,
		&c.RS3mPct, &c.RS6mPct, &c.SessionsAvailable,
		&r.hasGrowth,
	}
	t = append(t, growthScanTargets(&r.g)...)
	return append(t, &c.CompanyName, &c.Industry, &c.LogoURL, &c.ShortPct, &c.DaysToCover, &c.MarketCap)
}

// ListStrategyCandidates returns the evaluator's universe, one Candidate per
// stock in mv_price_features, ordered by stock code. A missing relation
// yields an empty universe, never an error.
//
// The quality row, the appended growth columns and the valuation inputs of
// migration 000132 come from ONE separate query (fundamentalsExtras) merged
// by stock code, so strategyCandidatesQuery keeps its 000129/000130 column
// list and a database without 000132 still serves the whole universe, with
// nil extras (plan fundamentals-coverage.md §5.3).
func (s *postgresStore) ListStrategyCandidates(ctx context.Context) ([]strategies.Candidate, error) {
	return listStrategyCandidates(ctx, s.db)
}

func listStrategyCandidates(ctx context.Context, db fundamentalsDB) ([]strategies.Candidate, error) {
	out, err := queryStrategyCandidates(ctx, db)
	if err != nil || len(out) == 0 {
		return out, err
	}
	extras, err := listFundamentalsExtras(ctx, db)
	if err != nil {
		return nil, err
	}
	mergeFundamentalsExtras(out, extras)
	return out, nil
}

func queryStrategyCandidates(ctx context.Context, db fundamentalsDB) ([]strategies.Candidate, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	rows, err := db.Query(ctx, strategyCandidatesQuery)
	if err != nil {
		if isUndefinedTable(err) {
			logMissingRelationOnce("ListStrategyCandidates", err)
			return []strategies.Candidate{}, nil
		}
		return nil, fmt.Errorf("failed to query strategy candidates: %w", err)
	}
	defer rows.Close()

	out := make([]strategies.Candidate, 0, 2048)
	for rows.Next() {
		var (
			row  candidateRow
			c    = &row.c
			grow = &row.g
		)
		if err := rows.Scan(row.targets()...); err != nil {
			return nil, fmt.Errorf("failed to scan strategy candidate: %w", err)
		}
		if row.asOf != nil {
			c.AsOf = *row.asOf
		}
		if row.closePx != nil {
			c.Close = *row.closePx
		}
		sanitiseCandidate(c)
		if row.hasGrowth {
			sanitiseGrowth(grow)
			c.Growth = grow
		}
		out = append(out, *c)
	}
	if err := rows.Err(); err != nil {
		if isUndefinedTable(err) {
			logMissingRelationOnce("ListStrategyCandidates", err)
			return []strategies.Candidate{}, nil
		}
		return nil, fmt.Errorf("error iterating strategy candidates: %w", err)
	}
	return out, nil
}

func sanitiseCandidate(c *strategies.Candidate) {
	if math.IsNaN(c.Close) || math.IsInf(c.Close, 0) {
		c.Close = 0
	}
	finiteAll(
		&c.PrevClose, &c.SMA10, &c.SMA20, &c.SMA50, &c.SMA150, &c.SMA200, &c.SMA200_1mAgo,
		&c.High52w, &c.Low52w, &c.PctOff52wHigh, &c.PctAbove52wLow,
		&c.Volume, &c.AvgVolume50d, &c.VolumeRatio50d, &c.DollarVolume20d,
		&c.BaseHigh, &c.BaseLow, &c.BaseDepthPct,
		&c.Ret1mPct, &c.Ret3mPct, &c.Ret6mPct, &c.Ret12mPct, &c.RS3mPct, &c.RS6mPct,
		&c.ShortPct, &c.DaysToCover, &c.MarketCap,
	)
}

const marketRegimeQuery = `
	SELECT
		index_code::text,
		as_of::date,
		close::float8,
		sma50::float8,
		sma200::float8,
		pct_off_52w_high::float8,
		ret_1m_pct::float8,
		ret_3m_pct::float8,
		COALESCE(regime::text, '')
	FROM mv_market_regime
	WHERE index_code = $1
`

// GetMarketRegime returns the mv_market_regime row for indexCode. A missing
// row or relation yields a Regime with an empty Label (read as unknown by
// every regime rule), never an error.
func (s *postgresStore) GetMarketRegime(ctx context.Context, indexCode string) (strategies.Regime, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	code := strings.ToUpper(strings.TrimSpace(indexCode))
	r := strategies.Regime{IndexCode: code}
	err := s.db.QueryRow(ctx, marketRegimeQuery, code).Scan(
		&r.IndexCode, &r.AsOf, &r.Close, &r.SMA50, &r.SMA200, &r.PctOff52wHigh, &r.Ret1mPct, &r.Ret3mPct, &r.Label,
	)
	switch {
	case err == nil:
		finiteAll(&r.Close, &r.SMA50, &r.SMA200, &r.PctOff52wHigh, &r.Ret1mPct, &r.Ret3mPct)
		return r, nil
	case errors.Is(err, pgx.ErrNoRows):
		return strategies.Regime{IndexCode: code}, nil
	case isUndefinedTable(err):
		logMissingRelationOnce("GetMarketRegime", err)
		return strategies.Regime{IndexCode: code}, nil
	default:
		return strategies.Regime{}, fmt.Errorf("failed to query market regime: %w", err)
	}
}

// fundamentalsBaseColumns is the 000129 select list of stock_fundamentals, in
// readFundamentalsPeriods' scan order.
const fundamentalsBaseColumns = `
		stock_code::text,
		period_type::text,
		period_end::date,
		fiscal_year::int4,
		COALESCE(currency::text, ''),
		revenue::float8,
		net_income::float8,
		eps_basic::float8,
		eps_diluted::float8,
		operating_cash_flow::float8,
		free_cash_flow::float8,
		shares_outstanding::float8,
		COALESCE(source::text, ''),
		source_fetched_at::timestamptz`

// fundamentalsColumn is one value column of stock_fundamentals and its field.
type fundamentalsColumn struct {
	name  string
	field func(r *FundamentalsPeriodRow) **float64
}

// fundamentalsBaseValueColumns are the value columns of 000129 (field_sources
// keys may name them too).
var fundamentalsBaseValueColumns = []fundamentalsColumn{
	{"revenue", func(r *FundamentalsPeriodRow) **float64 { return &r.Revenue }},
	{"net_income", func(r *FundamentalsPeriodRow) **float64 { return &r.NetIncome }},
	{"eps_basic", func(r *FundamentalsPeriodRow) **float64 { return &r.EPSBasic }},
	{"eps_diluted", func(r *FundamentalsPeriodRow) **float64 { return &r.EPSDiluted }},
	{"operating_cash_flow", func(r *FundamentalsPeriodRow) **float64 { return &r.OperatingCashFlow }},
	{"free_cash_flow", func(r *FundamentalsPeriodRow) **float64 { return &r.FreeCashFlow }},
	{"shares_outstanding", func(r *FundamentalsPeriodRow) **float64 { return &r.SharesOutstanding }},
}

// fundamentalsExtendedColumns are the value columns migration 000132 adds
// (plan fundamentals-coverage.md §2.1), in FundamentalsPeriod proto order. ONE
// list: the extended select list, its scan targets and the finite pass all
// iterate it.
var fundamentalsExtendedColumns = []fundamentalsColumn{
	{"gross_profit", func(r *FundamentalsPeriodRow) **float64 { return &r.GrossProfit }},
	{"operating_income", func(r *FundamentalsPeriodRow) **float64 { return &r.OperatingIncome }},
	{"ebitda", func(r *FundamentalsPeriodRow) **float64 { return &r.EBITDA }},
	{"normalized_ebitda", func(r *FundamentalsPeriodRow) **float64 { return &r.NormalizedEBITDA }},
	{"ebit", func(r *FundamentalsPeriodRow) **float64 { return &r.EBIT }},
	{"interest_expense", func(r *FundamentalsPeriodRow) **float64 { return &r.InterestExpense }},
	{"pretax_income", func(r *FundamentalsPeriodRow) **float64 { return &r.PretaxIncome }},
	{"tax_provision", func(r *FundamentalsPeriodRow) **float64 { return &r.TaxProvision }},
	{"net_interest_income", func(r *FundamentalsPeriodRow) **float64 { return &r.NetInterestIncome }},
	{"capital_expenditure", func(r *FundamentalsPeriodRow) **float64 { return &r.CapitalExpenditure }},
	{"dividends_paid", func(r *FundamentalsPeriodRow) **float64 { return &r.DividendsPaid }},
	{"share_buybacks", func(r *FundamentalsPeriodRow) **float64 { return &r.ShareBuybacks }},
	{"total_assets", func(r *FundamentalsPeriodRow) **float64 { return &r.TotalAssets }},
	{"total_liabilities", func(r *FundamentalsPeriodRow) **float64 { return &r.TotalLiabilities }},
	{"total_equity", func(r *FundamentalsPeriodRow) **float64 { return &r.TotalEquity }},
	{"cash_and_equivalents", func(r *FundamentalsPeriodRow) **float64 { return &r.CashAndEquivalents }},
	{"total_debt", func(r *FundamentalsPeriodRow) **float64 { return &r.TotalDebt }},
	{"capital_lease_obligations", func(r *FundamentalsPeriodRow) **float64 { return &r.CapitalLeaseObligations }},
	{"net_debt", func(r *FundamentalsPeriodRow) **float64 { return &r.NetDebt }},
	{"current_assets", func(r *FundamentalsPeriodRow) **float64 { return &r.CurrentAssets }},
	{"current_liabilities", func(r *FundamentalsPeriodRow) **float64 { return &r.CurrentLiabilities }},
}

// fundamentalsExtendedSelect is the 000132 select list: the base columns, the
// full statements, then field_sources and the source document.
var fundamentalsExtendedSelect = func() string {
	var b strings.Builder
	b.WriteString(fundamentalsBaseColumns)
	for _, c := range fundamentalsExtendedColumns {
		b.WriteString(",\n\t\t" + c.name + "::float8")
	}
	b.WriteString(",\n\t\tCOALESCE(field_sources::text, '{}')")
	b.WriteString(",\n\t\tCOALESCE(source_document_url::text, '')")
	b.WriteString(",\n\t\tsource_document_date::date")
	return b.String()
}()

// buildFundamentalsQuery returns the 000129 stock_fundamentals query and its
// args (the fallback on a database without 000132's columns). Placeholders are
// contiguous: $1 code, then $2 period_type when filtered, then the LIMIT.
// periodType must already be validated against FundamentalsPeriodTypes (an
// unknown value is ignored, never interpolated).
func buildFundamentalsQuery(code, periodType string, limit int32) (string, []any) {
	return buildFundamentalsQueryWith(fundamentalsBaseColumns, code, periodType, limit)
}

// buildFundamentalsQueryExtended is buildFundamentalsQuery over every column
// migration 000132 adds.
func buildFundamentalsQueryExtended(code, periodType string, limit int32) (string, []any) {
	return buildFundamentalsQueryWith(fundamentalsExtendedSelect, code, periodType, limit)
}

func buildFundamentalsQueryWith(columns, code, periodType string, limit int32) (string, []any) {
	args := []any{code}
	where := "stock_code = $1"
	if FundamentalsPeriodTypes[periodType] {
		args = append(args, periodType)
		where += fmt.Sprintf(" AND period_type = $%d", len(args))
	}
	args = append(args, limit)
	query := fmt.Sprintf(`
	SELECT%s
	FROM stock_fundamentals
	WHERE %s
	ORDER BY period_end DESC, period_type ASC
	LIMIT $%d
`, columns, where, len(args))
	return query, args
}

// GetStockFundamentals returns up to limit reported periods for a stock,
// newest first, optionally filtered to one period type, with every column of
// migration 000132 (full statements, field_sources, the source document). On
// a database without those columns (42703) it logs once and falls back to the
// 000129 column list; a missing table yields no rows. Never an error for
// either.
func (s *postgresStore) GetStockFundamentals(ctx context.Context, code, periodType string, limit int32) ([]FundamentalsPeriodRow, error) {
	return getStockFundamentals(ctx, s.db, code, periodType, limit)
}

func getStockFundamentals(ctx context.Context, db fundamentalsDB, code, periodType string, limit int32) ([]FundamentalsPeriodRow, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	query, args := buildFundamentalsQueryExtended(code, periodType, limit)
	out, err := readFundamentalsPeriods(ctx, db, query, args, true)
	if err != nil && isUndefinedColumn(err) {
		logMissingSchemaOnce("GetStockFundamentals", err)
		query, args = buildFundamentalsQuery(code, periodType, limit)
		out, err = readFundamentalsPeriods(ctx, db, query, args, false)
	}
	if err != nil {
		if isUndefinedTable(err) {
			logMissingRelationOnce("GetStockFundamentals", err)
			return []FundamentalsPeriodRow{}, nil
		}
		return nil, fmt.Errorf("failed to query stock fundamentals: %w", err)
	}
	return out, nil
}

// readFundamentalsPeriods runs one stock_fundamentals query and scans it; the
// error (at Query, Scan or Rows.Err) is returned unwrapped so the caller can
// classify it.
func readFundamentalsPeriods(ctx context.Context, db fundamentalsDB, query string, args []any, extended bool) ([]FundamentalsPeriodRow, error) {
	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []FundamentalsPeriodRow{}
	for rows.Next() {
		var (
			r            FundamentalsPeriodRow
			fetched      *time.Time
			fieldSources string
		)
		targets := []any{
			&r.StockCode, &r.PeriodType, &r.PeriodEnd, &r.FiscalYear, &r.Currency,
			&r.Revenue, &r.NetIncome, &r.EPSBasic, &r.EPSDiluted,
			&r.OperatingCashFlow, &r.FreeCashFlow, &r.SharesOutstanding,
			&r.Source, &fetched,
		}
		if extended {
			for _, c := range fundamentalsExtendedColumns {
				targets = append(targets, c.field(&r))
			}
			targets = append(targets, &fieldSources, &r.SourceDocumentURL, &r.SourceDocumentDate)
		}
		if err := rows.Scan(targets...); err != nil {
			return nil, err
		}
		if fetched != nil {
			r.SourceFetchedAt = *fetched
		}
		for _, c := range fundamentalsBaseValueColumns {
			p := c.field(&r)
			*p = finite(*p)
		}
		for _, c := range fundamentalsExtendedColumns {
			p := c.field(&r)
			*p = finite(*p)
		}
		r.FieldSources = parseFieldSources(fieldSources)
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

var fundamentalsGrowthQuery = `
	SELECT` + growthColumns + `
	FROM mv_fundamentals_growth g
	WHERE g.stock_code = $1
`

// GetFundamentalsGrowth returns the mv_fundamentals_growth row for a stock,
// or nil when there is none (or the view does not exist yet).
func (s *postgresStore) GetFundamentalsGrowth(ctx context.Context, code string) (*strategies.Growth, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	var g strategies.Growth
	err := s.db.QueryRow(ctx, fundamentalsGrowthQuery, code).Scan(growthScanTargets(&g)...)
	switch {
	case err == nil:
		sanitiseGrowth(&g)
		return &g, nil
	case errors.Is(err, pgx.ErrNoRows):
		return nil, nil
	case isUndefinedTable(err):
		logMissingRelationOnce("GetFundamentalsGrowth", err)
		return nil, nil
	default:
		return nil, fmt.Errorf("failed to query fundamentals growth: %w", err)
	}
}
