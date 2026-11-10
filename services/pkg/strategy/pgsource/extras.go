package pgsource

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/jackc/pgx/v5"
)

// FundamentalsExtras is one row of the fundamentalsExtras read: everything
// migration 000132 adds for a stock beyond the 000129/000130 reads.
type FundamentalsExtras struct {
	StockCode string

	// The columns appended to mv_fundamentals_growth (plan §2.6); meaningful
	// only when HasGrowthRow.
	HasGrowthRow           bool
	RevenueBasisSource     string
	EPSBasisSource         string
	RevenueLatestPeriodEnd *time.Time
	RevenuePriorPeriodEnd  *time.Time

	// Quality is the mv_fundamentals_quality row (plan §2.7), nil when the
	// stock has none. The financials decision has NOT been applied yet
	// (engine.ApplyQualityRules; it needs the industry).
	Quality *engine.Quality

	// Valuation holds the stock_fundamentals facts valuation needs.
	Valuation engine.ValuationInputs

	// The single-stock read only (GetFundamentalsExtras): the latest close
	// (mv_price_features, else stock_prices), its date, and the industry
	// group ("company-metadata") the financials decision reads. Empty on the
	// universe read, where the candidate carries them.
	Close     *float64
	PriceAsOf *time.Time
	Industry  string
}

// ApplyToGrowth copies the appended growth columns onto g (nil-safe).
func (e *FundamentalsExtras) ApplyToGrowth(g *engine.Growth) {
	if e == nil || g == nil || !e.HasGrowthRow {
		return
	}
	g.RevenueBasisSource = e.RevenueBasisSource
	g.EPSBasisSource = e.EPSBasisSource
	g.RevenueLatestPeriodEnd = e.RevenueLatestPeriodEnd
	g.RevenuePriorPeriodEnd = e.RevenuePriorPeriodEnd
}

// extrasRow holds one scanned row of the fundamentalsExtras query.
type extrasRow struct {
	e          FundamentalsExtras
	q          engine.Quality
	hasQuality bool
}

// extrasColumn is one expression of the fundamentalsExtras select list and
// its scan target. ONE table, so the select list and the scan can never
// drift apart.
type extrasColumn struct {
	expr   string
	target func(r *extrasRow) any
}

var fundamentalsExtrasColumns = []extrasColumn{
	{`k.stock_code`, func(r *extrasRow) any { return &r.e.StockCode }},

	// mv_fundamentals_growth, appended columns (000132 §2.6).
	{`(g.stock_code IS NOT NULL)`, func(r *extrasRow) any { return &r.e.HasGrowthRow }},
	{`COALESCE(g.revenue_basis_source::text, '')`, func(r *extrasRow) any { return &r.e.RevenueBasisSource }},
	{`COALESCE(g.eps_basis_source::text, '')`, func(r *extrasRow) any { return &r.e.EPSBasisSource }},
	{`g.revenue_latest_period_end::date`, func(r *extrasRow) any { return &r.e.RevenueLatestPeriodEnd }},
	{`g.revenue_prior_period_end::date`, func(r *extrasRow) any { return &r.e.RevenuePriorPeriodEnd }},

	// mv_fundamentals_quality (000132 §2.7). The view has a row for every
	// stock with any flow field, but its flow basis needs revenue AND net
	// income: an EPS-only stock (an FX-converted code whose monetary fields
	// were rejected, a vendor that publishes EPS alone) gets a row whose every
	// column but stock_code is NULL, the balance basis included (it is keyed on
	// the flow row's currency). That row holds nothing to compute a ratio
	// from, so it is no quality row: counting it would overstate quality
	// coverage and send an empty quality object to every surface.
	{`(q.stock_code IS NOT NULL AND q.basis_period_end IS NOT NULL)`, func(r *extrasRow) any { return &r.hasQuality }},
	{`COALESCE(q.basis_period_type::text, '')`, func(r *extrasRow) any { return &r.q.BasisPeriodType }},
	{`q.basis_period_end::date`, func(r *extrasRow) any { return &r.q.BasisPeriodEnd }},
	{`COALESCE(q.currency::text, '')`, func(r *extrasRow) any { return &r.q.Currency }},
	{`COALESCE(q.source::text, '')`, func(r *extrasRow) any { return &r.q.Source }},
	{`q.fetched_at::timestamptz`, func(r *extrasRow) any { return &r.q.FetchedAt }},
	{`q.revenue::float8`, func(r *extrasRow) any { return &r.q.Revenue }},
	{`q.gross_profit::float8`, func(r *extrasRow) any { return &r.q.GrossProfit }},
	{`q.operating_income::float8`, func(r *extrasRow) any { return &r.q.OperatingIncome }},
	{`q.ebitda::float8`, func(r *extrasRow) any { return &r.q.EBITDA }},
	{`q.normalized_ebitda::float8`, func(r *extrasRow) any { return &r.q.NormalizedEBITDA }},
	{`q.ebit::float8`, func(r *extrasRow) any { return &r.q.EBIT }},
	{`q.net_income::float8`, func(r *extrasRow) any { return &r.q.NetIncome }},
	{`q.operating_cash_flow::float8`, func(r *extrasRow) any { return &r.q.OperatingCashFlow }},
	{`COALESCE(q.operating_cash_flow_derived, false)`, func(r *extrasRow) any { return &r.q.OperatingCashFlowDerived }},
	{`q.free_cash_flow::float8`, func(r *extrasRow) any { return &r.q.FreeCashFlow }},
	{`q.capital_expenditure::float8`, func(r *extrasRow) any { return &r.q.CapitalExpenditure }},
	{`q.dividends_paid::float8`, func(r *extrasRow) any { return &r.q.DividendsPaid }},
	{`q.interest_expense::float8`, func(r *extrasRow) any { return &r.q.InterestExpense }},
	{`q.shares_outstanding::float8`, func(r *extrasRow) any { return &r.q.SharesOutstanding }},
	{`nii.net_interest_income::float8`, func(r *extrasRow) any { return &r.q.NetInterestIncome }},
	{`q.balance_period_end::date`, func(r *extrasRow) any { return &r.q.BalancePeriodEnd }},
	{`COALESCE(q.balance_period_type::text, '')`, func(r *extrasRow) any { return &r.q.BalancePeriodType }},
	{`COALESCE(q.balance_currency::text, '')`, func(r *extrasRow) any { return &r.q.BalanceCurrency }},
	{`q.balance_lag_months::int4`, func(r *extrasRow) any { return &r.q.BalanceLagMonths }},
	{`q.total_assets::float8`, func(r *extrasRow) any { return &r.q.TotalAssets }},
	{`q.total_assets_prior::float8`, func(r *extrasRow) any { return &r.q.TotalAssetsPrior }},
	{`q.total_liabilities::float8`, func(r *extrasRow) any { return &r.q.TotalLiabilities }},
	{`q.total_equity::float8`, func(r *extrasRow) any { return &r.q.TotalEquity }},
	{`q.total_equity_prior::float8`, func(r *extrasRow) any { return &r.q.TotalEquityPrior }},
	{`q.cash_and_equivalents::float8`, func(r *extrasRow) any { return &r.q.CashAndEquivalents }},
	{`q.total_debt::float8`, func(r *extrasRow) any { return &r.q.TotalDebt }},
	{`q.capital_lease_obligations::float8`, func(r *extrasRow) any { return &r.q.CapitalLeaseObligations }},
	{`q.net_debt::float8`, func(r *extrasRow) any { return &r.q.NetDebt }},
	{`q.current_assets::float8`, func(r *extrasRow) any { return &r.q.CurrentAssets }},
	{`q.current_liabilities::float8`, func(r *extrasRow) any { return &r.q.CurrentLiabilities }},
	{`q.gross_margin_pct::float8`, func(r *extrasRow) any { return &r.q.GrossMarginPct }},
	{`q.operating_margin_pct::float8`, func(r *extrasRow) any { return &r.q.OperatingMarginPct }},
	{`q.net_margin_pct::float8`, func(r *extrasRow) any { return &r.q.NetMarginPct }},
	{`q.fcf_margin_pct::float8`, func(r *extrasRow) any { return &r.q.FCFMarginPct }},
	{`q.fcf_conversion::float8`, func(r *extrasRow) any { return &r.q.FCFConversion }},
	{`q.roe_pct::float8`, func(r *extrasRow) any { return &r.q.ROEPct }},
	{`q.roa_pct::float8`, func(r *extrasRow) any { return &r.q.ROAPct }},
	{`q.net_debt_to_ebitda::float8`, func(r *extrasRow) any { return &r.q.NetDebtToEBITDA }},
	{`q.net_debt_to_equity::float8`, func(r *extrasRow) any { return &r.q.NetDebtToEquity }},
	{`q.current_ratio::float8`, func(r *extrasRow) any { return &r.q.CurrentRatio }},
	{`q.interest_cover::float8`, func(r *extrasRow) any { return &r.q.InterestCover }},
	{`q.payout_ratio_pct::float8`, func(r *extrasRow) any { return &r.q.PayoutRatioPct }},
	{`COALESCE(q.statement_is_financial, false)`, func(r *extrasRow) any { return &r.q.StatementIsFinancial }},

	// Valuation inputs (plan §5.3) from stock_fundamentals and the sync row.
	{`sh.shares_outstanding::float8`, func(r *extrasRow) any { return &r.e.Valuation.Shares }},
	{`sh.period_end::date`, func(r *extrasRow) any { return &r.e.Valuation.SharesPeriodEnd }},
	{`sy.median_k::float8`, func(r *extrasRow) any { return &r.e.Valuation.MedianK }},
	{`COALESCE(kk.n, 0)::int4`, func(r *extrasRow) any { return &r.e.Valuation.KPeriods }},
	{`COALESCE(kk.all_ok, false)`, func(r *extrasRow) any { return &r.e.Valuation.KConsistent }},
	{`COALESCE(kk.any_far, false)`, func(r *extrasRow) any { return &r.e.Valuation.KFarFromOne }},
	// The job's measured verdict when there is one; NULL (not yet measured
	// since 000132) is NOT "not converted": rows written before the job
	// measured it carry Yahoo's converted values, so a fractional vendor
	// revenue or net income marks the code, as the job's own gate would.
	{`COALESCE(sy.fx_converted, kk.fractional, false)`, func(r *extrasRow) any { return &r.e.Valuation.FXConverted }},
	{`ep.eps_diluted::float8`, func(r *extrasRow) any { return &r.e.Valuation.EPSDiluted }},
	{`ep.eps_basic::float8`, func(r *extrasRow) any { return &r.e.Valuation.EPSBasic }},
	{`ep.period_end::date`, func(r *extrasRow) any { return &r.e.Valuation.EPSPeriodEnd }},
	{`COALESCE(ep.currency::text, '')`, func(r *extrasRow) any { return &r.e.Valuation.EPSCurrency }},

	// The price and industry (single-stock read; NULL / '' on the universe).
	{`px.close_px::float8`, func(r *extrasRow) any { return &r.e.Close }},
	{`px.price_as_of::date`, func(r *extrasRow) any { return &r.e.PriceAsOf }},
	{`COALESCE(px.industry::text, '')`, func(r *extrasRow) any { return &r.e.Industry }},
}

func (r *extrasRow) targets() []any {
	out := make([]any, len(fundamentalsExtrasColumns))
	for i, c := range fundamentalsExtrasColumns {
		out[i] = c.target(r)
	}
	return out
}

// Key sets for the extras read: every stock with a growth or quality row
// (the universe), or the one code asked for.
const (
	extrasUniverseKeys = `(
		SELECT g0.stock_code::text AS stock_code FROM mv_fundamentals_growth g0
		UNION
		SELECT q0.stock_code::text FROM mv_fundamentals_quality q0
	) k`
	extrasSingleKey = `(SELECT $1::text AS stock_code) k`

	// The universe does not need the price or industry: the candidate
	// carries both, from the same views the evaluator ranks on.
	extrasUniversePrice = `
	CROSS JOIN (SELECT NULL::float8 AS close_px, NULL::date AS price_as_of, ''::text AS industry) px`
	// The stock page reads the same close the picks use (mv_price_features),
	// else the latest stock_prices close for a stock outside the universe,
	// but only one within 45 days of the market's latest session: a suspended
	// or delisted code's last close times a newer share count is not a
	// market cap (valuation says "no-price" instead).
	extrasSinglePrice = `
	LEFT JOIN LATERAL (
		SELECT
			COALESCE(pf.close_px, sp.close::float8) AS close_px,
			CASE WHEN pf.close_px IS NOT NULL THEN pf.as_of ELSE sp.date::date END AS price_as_of,
			(SELECT cm.industry::text FROM "company-metadata" cm WHERE cm.stock_code::text = k.stock_code LIMIT 1) AS industry
		FROM (SELECT 1) AS one
		LEFT JOIN LATERAL (
			SELECT p.close::float8 AS close_px, p.as_of::date AS as_of
			FROM mv_price_features p
			WHERE p.stock_code::text = k.stock_code AND p.close > 0
			LIMIT 1
		) pf ON true
		LEFT JOIN LATERAL (
			SELECT s2.close, s2.date
			FROM stock_prices s2
			WHERE s2.stock_code = k.stock_code AND s2.close > 0
			  AND s2.date >= COALESCE((SELECT max(p2.as_of) FROM mv_price_features p2), CURRENT_DATE) - 45
			ORDER BY s2.date DESC
			LIMIT 1
		) sp ON true
	) px ON true`

	// The joins every extras read shares. Each LATERAL is a primary-key or
	// index range probe on stock_fundamentals (stock_code, period_type,
	// period_end).
	extrasJoins = `
	LEFT JOIN mv_fundamentals_growth g ON g.stock_code::text = k.stock_code
	LEFT JOIN mv_fundamentals_quality q ON q.stock_code::text = k.stock_code
	LEFT JOIN stock_fundamentals_sync sy ON sy.stock_code::text = k.stock_code
	-- Net interest income of the flow basis row: the financials test needs
	-- it and the view does not carry it.
	LEFT JOIN LATERAL (
		SELECT f.net_interest_income
		FROM stock_fundamentals f
		WHERE f.stock_code = k.stock_code AND f.period_type = q.basis_period_type AND f.period_end = q.basis_period_end
		LIMIT 1
	) nii ON true
	-- The newest VENDOR share count (annual, ttm or a quarter snapshot).
	LEFT JOIN LATERAL (
		SELECT f.shares_outstanding, f.period_end
		FROM stock_fundamentals f
		WHERE f.stock_code = k.stock_code AND f.period_type IN ('annual', 'ttm', 'quarter')
		  AND f.source <> 'asx-filing-extraction' AND f.shares_outstanding > 0
		ORDER BY f.period_end DESC
		LIMIT 1
	) sh ON true
	-- Over the vendor annual / TTM rows (filing rows excluded):
	--   the listed-unit evidence when the sync row has no median_k, from
	--   every k = net income / (EPS x shares) a row allows: how many (n),
	--   whether all are within [0.8, 1.25] (all_ok) and whether any
	--   positive k is outside [1/3, 3] (any_far; engine.Valuate reads a
	--   k between the bands as no evidence either way, and so is a k <= 0:
	--   net income and EPS of opposite signs say nothing about the unit);
	--   the FX-converted guess for a code the job has not measured
	--   (fractional): a non-Markit revenue or net income with a fractional
	--   part above 0.001, the mark the job's gate reads (plan §3.4).
	LEFT JOIN LATERAL (
		SELECT count(v.kv)::int AS n,
		       bool_and(v.kv BETWEEN 0.8 AND 1.25) AS all_ok,
		       bool_or(v.kv > 0 AND (v.kv * 3 < 1 OR v.kv > 3)) AS any_far,
		       bool_or(v.source <> 'markit-key-statistics'
		               AND (abs(v.revenue - round(v.revenue)) > 0.001 OR abs(v.net_income - round(v.net_income)) > 0.001)) AS fractional
		FROM (
			SELECT f.source, f.revenue, f.net_income,
			       CASE WHEN f.net_income IS NOT NULL AND COALESCE(f.eps_basic, f.eps_diluted) <> 0 AND f.shares_outstanding > 0
			            THEN f.net_income / (COALESCE(f.eps_basic, f.eps_diluted) * f.shares_outstanding) END AS kv
			FROM stock_fundamentals f
			WHERE f.stock_code = k.stock_code AND f.period_type IN ('annual', 'ttm')
			  AND f.source <> 'asx-filing-extraction'
		) v
	) kk ON true
	-- The newest 12-month EPS across annual and TTM rows (annual first on a
	-- tie: the statutory figure).
	LEFT JOIN LATERAL (
		SELECT f.eps_diluted, f.eps_basic, f.period_end, f.currency
		FROM stock_fundamentals f
		WHERE f.stock_code = k.stock_code AND f.period_type IN ('annual', 'ttm')
		  AND (f.eps_diluted IS NOT NULL OR f.eps_basic IS NOT NULL)
		ORDER BY f.period_end DESC, (f.period_type = 'annual') DESC
		LIMIT 1
	) ep ON true`
)

// fundamentalsExtrasQuery builds the extras read over the universe or one
// code. The select list and joins are the same in both, so one scan serves
// both.
func fundamentalsExtrasQuery(single bool) string {
	exprs := make([]string, len(fundamentalsExtrasColumns))
	for i, c := range fundamentalsExtrasColumns {
		exprs[i] = c.expr
	}
	keys, price := extrasUniverseKeys, extrasUniversePrice
	if single {
		keys, price = extrasSingleKey, extrasSinglePrice
	}
	return "\n\tSELECT\n\t\t" + strings.Join(exprs, ",\n\t\t") + "\n\tFROM " + keys + extrasJoins + price + "\n"
}

var (
	ExtrasUniverseQuery = fundamentalsExtrasQuery(false)
	ExtrasSingleQuery   = fundamentalsExtrasQuery(true)
)

// scanExtras reads one extras row and sanitises it.
func scanExtras(row pgx.Row) (*FundamentalsExtras, error) {
	var r extrasRow
	if err := row.Scan(r.targets()...); err != nil {
		return nil, err
	}
	e := r.e
	if r.hasQuality {
		q := r.q
		sanitiseQuality(&q)
		e.Quality = &q
	}
	finiteAll(&e.Valuation.Shares, &e.Valuation.MedianK, &e.Valuation.EPSDiluted, &e.Valuation.EPSBasic, &e.Close)
	return &e, nil
}

func sanitiseQuality(q *engine.Quality) {
	finiteAll(
		&q.Revenue, &q.GrossProfit, &q.OperatingIncome, &q.EBITDA, &q.NormalizedEBITDA, &q.EBIT, &q.NetIncome,
		&q.OperatingCashFlow, &q.FreeCashFlow, &q.CapitalExpenditure, &q.DividendsPaid, &q.InterestExpense,
		&q.SharesOutstanding, &q.NetInterestIncome,
		&q.TotalAssets, &q.TotalAssetsPrior, &q.TotalLiabilities, &q.TotalEquity, &q.TotalEquityPrior,
		&q.CashAndEquivalents, &q.TotalDebt, &q.CapitalLeaseObligations, &q.NetDebt, &q.CurrentAssets, &q.CurrentLiabilities,
		&q.GrossMarginPct, &q.OperatingMarginPct, &q.NetMarginPct, &q.FCFMarginPct, &q.FCFConversion,
		&q.ROEPct, &q.ROAPct, &q.NetDebtToEBITDA, &q.NetDebtToEquity, &q.CurrentRatio, &q.InterestCover, &q.PayoutRatioPct,
	)
}

// ListExtras reads the extras of every stock with a growth or
// quality row, keyed by stock code. nil (and no error) when 000132 is absent.
func ListExtras(ctx context.Context, db DB) (map[string]*FundamentalsExtras, error) {
	ctx, cancel := queryContext(ctx)
	defer cancel()

	out, err := func() (map[string]*FundamentalsExtras, error) {
		rows, err := db.Query(ctx, ExtrasUniverseQuery)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := map[string]*FundamentalsExtras{}
		for rows.Next() {
			e, err := scanExtras(rows)
			if err != nil {
				return nil, err
			}
			out[strings.ToUpper(e.StockCode)] = e
		}
		return out, rows.Err()
	}()
	if err != nil {
		if isMissingSchema(err) {
			logMissingSchemaOnce("ListStrategyCandidates.fundamentalsExtras", err)
			return nil, nil
		}
		return nil, fmt.Errorf("failed to query fundamentals extras: %w", err)
	}
	return out, nil
}

// ExtrasRow returns one row of the universe extras read, in the column order
// its scan targets take, built from a stock's extras and quality row (nil when
// it has none). A caller that stands in for the database answers the read with
// it, so a test of a store method can check the merge the method makes.
func ExtrasRow(e FundamentalsExtras, q *engine.Quality) []any {
	r := extrasRow{e: e}
	if q != nil {
		r.hasQuality = true
		r.q = *q
	}
	targets := r.targets()
	out := make([]any, len(targets))
	for i, t := range targets {
		v := reflect.ValueOf(t).Elem()
		switch {
		case v.Kind() == reflect.Pointer && v.IsNil():
			out[i] = nil
		case v.Kind() == reflect.Pointer:
			out[i] = v.Elem().Interface()
		default:
			out[i] = v.Interface()
		}
	}
	return out
}

// MergeExtras attaches each candidate's extras: the appended
// growth columns onto its Growth, its quality row and its valuation inputs.
// A nil map (000132 absent) changes nothing.
func MergeExtras(cands []engine.Candidate, extras map[string]*FundamentalsExtras) {
	if extras == nil {
		return
	}
	for i := range cands {
		e := extras[strings.ToUpper(cands[i].StockCode)]
		if e == nil {
			continue
		}
		c := &cands[i]
		e.ApplyToGrowth(c.Growth)
		c.Quality = e.Quality
		inputs := e.Valuation
		c.ValuationInputs = &inputs
	}
}

// GetExtras returns the 000132 extras of one stock (the stock page's
// GetStockFundamentals): the appended growth columns, the quality row, the
// valuation inputs, the latest close and the industry. nil (and no error)
// when 000132 is absent.
func GetExtras(ctx context.Context, db DB, code string) (*FundamentalsExtras, error) {
	ctx, cancel := queryContext(ctx)
	defer cancel()

	e, err := scanExtras(db.QueryRow(ctx, ExtrasSingleQuery, code))
	switch {
	case err == nil:
		return e, nil
	case errors.Is(err, pgx.ErrNoRows):
		return nil, nil
	case isMissingSchema(err):
		logMissingSchemaOnce("GetFundamentalsExtras", err)
		return nil, nil
	default:
		return nil, fmt.Errorf("failed to query fundamentals extras: %w", err)
	}
}
