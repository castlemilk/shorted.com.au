package pgsource

import (
	"context"
	"errors"
	"fmt"
	"math"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/jackc/pgx/v5"
)

// finite drops NaN and ±Inf. Postgres happily stores and returns them
// (float8 'NaN', 'Infinity'); encoding/json refuses them, so one bad row
// would fail the whole MCP payload (services/pkg/keymetrics/finite.go has the history).
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

// GrowthColumns selects every mv_fundamentals_growth column (plan §2.2) the
// evaluator reads, in scanGrowth order, from the alias g. Numeric columns are
// cast to float8 so the scan types do not depend on how the view declares
// them. The column list is fixed (never built from input).
const GrowthColumns = `
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

// GrowthScanTargets returns the scan destinations matching GrowthColumns.
func GrowthScanTargets(g *engine.Growth) []any {
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

func SanitiseGrowth(g *engine.Growth) {
	finiteAll(
		&g.RevenueLatest, &g.RevenuePrior, &g.RevenueYoYPct, &g.RevenueYoYPriorPct,
		&g.EPSLatest, &g.EPSPrior, &g.EPSYoYPct, &g.EPSYoYPriorPct,
		&g.NetIncomeLatest, &g.NetIncomePrior, &g.OperatingCashFlowLatest,
		&g.RevenueTTM, &g.NetIncomeTTM, &g.EPSTTM,
		&g.RevenueHalfDelta, &g.NetIncomeHalfDelta,
		&g.RevenueHalfYoYPct, &g.NetIncomeHalfYoYPct, &g.EPSHalfYoYPct,
	)
}

var GrowthQuery = `
	SELECT` + GrowthColumns + `
	FROM mv_fundamentals_growth g
	WHERE g.stock_code = $1
`

// GetGrowth returns the mv_fundamentals_growth row for a stock, or nil when
// there is none (or the view does not exist yet).
func GetGrowth(ctx context.Context, db DB, code string) (*engine.Growth, error) {
	ctx, cancel := context.WithTimeout(ctx, strategiesQueryTimeout)
	defer cancel()

	var g engine.Growth
	err := db.QueryRow(ctx, GrowthQuery, code).Scan(GrowthScanTargets(&g)...)
	switch {
	case err == nil:
		SanitiseGrowth(&g)
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
