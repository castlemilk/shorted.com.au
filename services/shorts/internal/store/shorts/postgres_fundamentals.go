package shorts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/strategies"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Fundamentals coverage read path (docs/plans/fundamentals-coverage.md §5.3).
//
// Everything here reads objects migration 000132 creates or extends: the
// columns appended to mv_fundamentals_growth, mv_fundamentals_quality, the
// new stock_fundamentals / stock_fundamentals_sync columns and
// financial_report_extractions.document_meta. Prod does not run `migrate up`,
// so the API can be deployed against a database that lacks any of them. Every
// read treats SQLSTATE 42P01 (undefined table) and 42703 (undefined column)
// alike as "absent": it logs once per method and degrades (nil extras, nil
// quality, coverage status "", no document meta), never a 500. Any other
// error is returned: a timeout on a sick view must not masquerade as "no
// data".

// isUndefinedColumn reports a Postgres undefined_column (42703) error.
func isUndefinedColumn(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42703"
}

// isMissingSchema reports 42P01 or 42703: an object a newer migration adds is
// not there yet.
func isMissingSchema(err error) bool {
	return isUndefinedTable(err) || isUndefinedColumn(err)
}

// missingSchemaLog logs an absent 000132 object once per method.
var missingSchemaLog sync.Map // method name -> *sync.Once

func logMissingSchemaOnce(method string, err error) {
	once, _ := missingSchemaLog.LoadOrStore(method, &sync.Once{})
	once.(*sync.Once).Do(func() {
		log.Warnf("%s: a fundamentals-coverage object is missing (migration 000132 not applied?); degrading to the older read: %v", method, err)
	})
}

// knownFieldSourceKeys are the stock_fundamentals value columns: the only
// keys field_sources may carry through the API.
var knownFieldSourceKeys = func() map[string]bool {
	m := map[string]bool{}
	for _, c := range fundamentalsBaseValueColumns {
		m[c.name] = true
	}
	for _, c := range fundamentalsExtendedColumns {
		m[c.name] = true
	}
	return m
}()

// maxFieldSourceLen bounds one provenance value ("derived:fcf-minus-capex"
// is the longest the contract names).
const maxFieldSourceLen = 64

// parseFieldSources decodes stock_fundamentals.field_sources. Only keys that
// name a value column and non-empty string values of a sane length survive;
// anything else (a malformed document, a stray key) is dropped. nil when
// nothing survives.
func parseFieldSources(raw string) map[string]string {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "{}" || raw == "null" {
		return nil
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil
	}
	var out map[string]string
	for k, v := range decoded {
		s, ok := v.(string)
		s = strings.TrimSpace(s)
		if !ok || s == "" || len(s) > maxFieldSourceLen || !knownFieldSourceKeys[k] {
			continue
		}
		if out == nil {
			out = map[string]string{}
		}
		out[k] = s
	}
	return out
}

// ---------------------------------------------------------------- extras

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
	// (strategies.ApplyQualityRules; it needs the industry).
	Quality *strategies.Quality

	// Valuation holds the stock_fundamentals facts valuation needs.
	Valuation strategies.ValuationInputs

	// The single-stock read only (GetFundamentalsExtras): the latest close
	// (mv_price_features, else stock_prices), its date, and the industry
	// group ("company-metadata") the financials decision reads. Empty on the
	// universe read, where the candidate carries them.
	Close     *float64
	PriceAsOf *time.Time
	Industry  string
}

// ApplyToGrowth copies the appended growth columns onto g (nil-safe).
func (e *FundamentalsExtras) ApplyToGrowth(g *strategies.Growth) {
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
	q          strategies.Quality
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

	// mv_fundamentals_quality (000132 §2.7).
	{`(q.stock_code IS NOT NULL)`, func(r *extrasRow) any { return &r.hasQuality }},
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
	// else the latest stock_prices close for a stock outside the universe.
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
	-- The listed-unit evidence when the sync row has no median_k: every
	-- vendor annual / TTM k = net income / (EPS x shares).
	LEFT JOIN LATERAL (
		SELECT count(*)::int AS n,
		       bool_and(f.net_income / (COALESCE(f.eps_basic, f.eps_diluted) * f.shares_outstanding) BETWEEN 0.8 AND 1.25) AS all_ok
		FROM stock_fundamentals f
		WHERE f.stock_code = k.stock_code AND f.period_type IN ('annual', 'ttm')
		  AND f.source <> 'asx-filing-extraction'
		  AND f.net_income IS NOT NULL AND COALESCE(f.eps_basic, f.eps_diluted) <> 0 AND f.shares_outstanding > 0
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
	fundamentalsExtrasUniverseQuery = fundamentalsExtrasQuery(false)
	fundamentalsExtrasSingleQuery   = fundamentalsExtrasQuery(true)
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

func sanitiseQuality(q *strategies.Quality) {
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

// listFundamentalsExtras reads the extras of every stock with a growth or
// quality row, keyed by stock code. nil (and no error) when 000132 is absent.
func listFundamentalsExtras(ctx context.Context, db fundamentalsDB) (map[string]*FundamentalsExtras, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	out, err := func() (map[string]*FundamentalsExtras, error) {
		rows, err := db.Query(ctx, fundamentalsExtrasUniverseQuery)
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

// mergeFundamentalsExtras attaches each candidate's extras: the appended
// growth columns onto its Growth, its quality row and its valuation inputs.
// A nil map (000132 absent) changes nothing.
func mergeFundamentalsExtras(cands []strategies.Candidate, extras map[string]*FundamentalsExtras) {
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

// GetFundamentalsExtras returns the 000132 extras of one stock (the stock
// page's GetStockFundamentals): the appended growth columns, the quality row,
// the valuation inputs, the latest close and the industry. nil (and no error)
// when 000132 is absent.
func (s *postgresStore) GetFundamentalsExtras(ctx context.Context, code string) (*FundamentalsExtras, error) {
	return getFundamentalsExtras(ctx, s.db, code)
}

func getFundamentalsExtras(ctx context.Context, db fundamentalsDB, code string) (*FundamentalsExtras, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	e, err := scanExtras(db.QueryRow(ctx, fundamentalsExtrasSingleQuery, code))
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

// ---------------------------------------------------------------- coverage

// FundamentalsCoverageRow is what we know about collecting a stock's
// fundamentals: the sources of the rows held and its stock_fundamentals_sync
// row.
type FundamentalsCoverageRow struct {
	Sources       []string // sources of the rows held, sorted
	HasSyncRow    bool     // the job has attempted the code at least once
	LastAttemptAt *time.Time
	LastSuccessAt *time.Time
	LastOutcome   string // "loaded" | "empty" | "failed"; "" when NULL
	// OutcomeKnown is false when stock_fundamentals_sync.last_outcome does
	// not exist (a database without 000132): the status is then unknown.
	OutcomeKnown bool
}

const fundamentalsCoverageSelect = `
	SELECT
		COALESCE((SELECT array_agg(DISTINCT f.source::text ORDER BY f.source::text)
		          FROM stock_fundamentals f WHERE f.stock_code = $1), '{}'::text[]),
		(s.stock_code IS NOT NULL),
		s.last_attempt_at::timestamptz,
		s.last_success_at::timestamptz,
		%s
	FROM (SELECT 1) AS one
	LEFT JOIN stock_fundamentals_sync s ON s.stock_code = $1
`

var (
	fundamentalsCoverageQuery       = fmt.Sprintf(fundamentalsCoverageSelect, `COALESCE(s.last_outcome::text, '')`)
	fundamentalsCoverageLegacyQuery = fmt.Sprintf(fundamentalsCoverageSelect, `''::text`)
)

// GetFundamentalsCoverage returns the coverage facts for one stock. nil (and
// no error) when the tables are absent; OutcomeKnown false when only the
// 000132 column is.
func (s *postgresStore) GetFundamentalsCoverage(ctx context.Context, code string) (*FundamentalsCoverageRow, error) {
	return getFundamentalsCoverage(ctx, s.db, code)
}

func getFundamentalsCoverage(ctx context.Context, db fundamentalsDB, code string) (*FundamentalsCoverageRow, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	scan := func(query string) (*FundamentalsCoverageRow, error) {
		var r FundamentalsCoverageRow
		if err := db.QueryRow(ctx, query, code).Scan(&r.Sources, &r.HasSyncRow, &r.LastAttemptAt, &r.LastSuccessAt, &r.LastOutcome); err != nil {
			return nil, err
		}
		sort.Strings(r.Sources)
		return &r, nil
	}
	r, err := scan(fundamentalsCoverageQuery)
	if err == nil {
		r.OutcomeKnown = true
		return r, nil
	}
	if isUndefinedColumn(err) {
		logMissingSchemaOnce("GetFundamentalsCoverage", err)
		r, err = scan(fundamentalsCoverageLegacyQuery)
		if err == nil {
			return r, nil
		}
	}
	if isMissingSchema(err) {
		logMissingSchemaOnce("GetFundamentalsCoverage", err)
		return nil, nil
	}
	return nil, fmt.Errorf("failed to query fundamentals coverage: %w", err)
}

// ---------------------------------------------------------------- latest filing

// FilingCandidateRow is one extraction that could be the stock's latest
// filing summary (plan §5.1): newest first, digest_confidence >= 0.6 and a
// digest present already enforced by the query.
type FilingCandidateRow struct {
	ReportURL        string
	Title            string
	ReportDate       *time.Time
	Digest           string
	DigestConfidence *float64
	// DocumentMeta is the parsed document_meta (the zero value when absent,
	// malformed or before 000132).
	DocumentMeta extractiontrust.DocumentMeta
}

// LatestFilingInputs is everything the latest-filing selection reads.
type LatestFilingInputs struct {
	// NewestFlowPeriodEnd is the end of the newest annual, half or TTM row
	// carrying a flow figure: the period the summary must describe.
	NewestFlowPeriodEnd *time.Time
	// LatestAnnualPeriodEnd places the company's balance date (the own-period
	// resolver of plan §4.2 gate 4).
	LatestAnnualPeriodEnd *time.Time
	// CompanyName is "company-metadata".company_name, for the entity check.
	CompanyName string
	Candidates  []FilingCandidateRow
}

const latestFilingContextQuery = `
	SELECT
		(SELECT max(f.period_end)::date FROM stock_fundamentals f
		 WHERE f.stock_code = $1 AND f.period_type IN ('annual', 'half', 'ttm')
		   AND (f.revenue IS NOT NULL OR f.net_income IS NOT NULL OR f.eps_basic IS NOT NULL
		        OR f.eps_diluted IS NOT NULL OR f.operating_cash_flow IS NOT NULL OR f.free_cash_flow IS NOT NULL)),
		(SELECT max(f.period_end)::date FROM stock_fundamentals f
		 WHERE f.stock_code = $1 AND f.period_type = 'annual'),
		COALESCE((SELECT cm.company_name::text FROM "company-metadata" cm WHERE cm.stock_code = $1 LIMIT 1), '')
`

// latestFilingCandidatesLimit bounds how far back the selection looks: a
// company files a handful of extracted documents per period.
const latestFilingCandidatesLimit = 20

const latestFilingCandidatesSelect = `
	SELECT
		e.report_url::text,
		COALESCE(e.report_title::text, ''),
		e.report_date::date,
		COALESCE(e.digest::text, ''),
		e.digest_confidence::float8,
		%s
	FROM financial_report_extractions e
	WHERE e.stock_code = $1
	  AND e.report_date IS NOT NULL
	  AND e.digest_confidence >= 0.6
	  AND COALESCE(btrim(e.digest), '') <> ''
	ORDER BY e.report_date DESC, e.extracted_at DESC
	LIMIT %d
`

var (
	latestFilingCandidatesQuery       = fmt.Sprintf(latestFilingCandidatesSelect, `COALESCE(e.document_meta::text, '')`, latestFilingCandidatesLimit)
	latestFilingCandidatesLegacyQuery = fmt.Sprintf(latestFilingCandidatesSelect, `''::text`, latestFilingCandidatesLimit)
)

// GetLatestFilingInputs reads what the latest-filing selection needs.
// document_meta is read with 42703 tolerance (the zero meta before 000132);
// a missing table yields no candidates. nil (and no error) only when
// stock_fundamentals itself is absent.
func (s *postgresStore) GetLatestFilingInputs(ctx context.Context, code string) (*LatestFilingInputs, error) {
	return getLatestFilingInputs(ctx, s.db, code)
}

func getLatestFilingInputs(ctx context.Context, db fundamentalsDB, code string) (*LatestFilingInputs, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	var in LatestFilingInputs
	if err := db.QueryRow(ctx, latestFilingContextQuery, code).Scan(&in.NewestFlowPeriodEnd, &in.LatestAnnualPeriodEnd, &in.CompanyName); err != nil {
		if isMissingSchema(err) {
			logMissingRelationOnce("GetLatestFilingInputs", err)
			return nil, nil
		}
		return nil, fmt.Errorf("failed to query latest filing context: %w", err)
	}
	if in.NewestFlowPeriodEnd == nil {
		return &in, nil // nothing to describe: no need to read the filings
	}

	cands, err := readFilingCandidates(ctx, db, latestFilingCandidatesQuery, code)
	if err != nil && isUndefinedColumn(err) {
		logMissingSchemaOnce("GetLatestFilingInputs", err)
		cands, err = readFilingCandidates(ctx, db, latestFilingCandidatesLegacyQuery, code)
	}
	if err != nil {
		if isMissingSchema(err) {
			logMissingSchemaOnce("GetLatestFilingInputs.extractions", err)
			return &in, nil
		}
		return nil, fmt.Errorf("failed to query latest filing candidates: %w", err)
	}
	in.Candidates = cands
	return &in, nil
}

func readFilingCandidates(ctx context.Context, db fundamentalsDB, query, code string) ([]FilingCandidateRow, error) {
	rows, err := db.Query(ctx, query, code)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []FilingCandidateRow
	for rows.Next() {
		var (
			r    FilingCandidateRow
			meta string
		)
		if err := rows.Scan(&r.ReportURL, &r.Title, &r.ReportDate, &r.Digest, &r.DigestConfidence, &meta); err != nil {
			return nil, err
		}
		r.DigestConfidence = finite(r.DigestConfidence)
		if parsed, err := extractiontrust.ParseDocumentMeta([]byte(meta)); err == nil {
			r.DocumentMeta = parsed
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
