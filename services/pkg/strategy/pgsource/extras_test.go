package pgsource

import (
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
)

func TestFundamentalsExtrasQueryShape(t *testing.T) {
	var r extrasRow
	if got, want := len(r.targets()), len(fundamentalsExtrasColumns); got != want {
		t.Fatalf("targets %d != columns %d", got, want)
	}
	for _, q := range []string{ExtrasUniverseQuery, ExtrasSingleQuery} {
		if got := len(selectList(t, q)); got != len(fundamentalsExtrasColumns) {
			t.Errorf("extras query selects %d columns, scans %d", got, len(fundamentalsExtrasColumns))
		}
		for _, frag := range []string{
			"LEFT JOIN mv_fundamentals_growth g", "LEFT JOIN mv_fundamentals_quality q", "LEFT JOIN stock_fundamentals_sync sy",
			"sy.median_k", "sy.fx_converted", "f.source <> 'asx-filing-extraction'", "BETWEEN 0.8 AND 1.25",
			"bool_or(v.kv > 0 AND (v.kv * 3 < 1 OR v.kv > 3)) AS any_far",
			// Without a median, only a k outside [1/3, 3] contradicts the listing.
			"COALESCE(kk.any_far, false)",
			// fx_converted NULL is not "not converted": a fractional non-Markit
			// vendor revenue or net income decides until the job has measured it.
			"COALESCE(sy.fx_converted, kk.fractional, false)", "v.source <> 'markit-key-statistics'",
			"abs(v.revenue - round(v.revenue)) > 0.001", "abs(v.net_income - round(v.net_income)) > 0.001",
		} {
			if !strings.Contains(q, frag) {
				t.Errorf("extras query is missing %q", frag)
			}
		}
	}
	if strings.Contains(ExtrasUniverseQuery, "$1") || !strings.Contains(ExtrasSingleQuery, "$1::text") {
		t.Error("only the single-stock read takes a code")
	}
	if !strings.Contains(ExtrasSingleQuery, "FROM mv_price_features p") || !strings.Contains(ExtrasSingleQuery, "FROM stock_prices s2") {
		t.Error("the single-stock read must take the close from mv_price_features, else stock_prices")
	}
	if !strings.Contains(ExtrasSingleQuery, "s2.date >= COALESCE((SELECT max(p2.as_of) FROM mv_price_features p2), CURRENT_DATE) - 45") {
		t.Error("the stock_prices fallback must be bounded to recent sessions: a stale close is not a valuation")
	}
	// Every contract column of mv_fundamentals_quality (plan §2.7) is read.
	for _, col := range []string{
		"basis_period_type", "basis_period_end", "currency", "source", "fetched_at", "revenue", "gross_profit",
		"operating_income", "ebitda", "normalized_ebitda", "ebit", "net_income", "operating_cash_flow",
		"operating_cash_flow_derived", "free_cash_flow", "capital_expenditure", "dividends_paid", "interest_expense",
		"shares_outstanding", "balance_period_end", "balance_period_type", "balance_currency", "balance_lag_months",
		"total_assets", "total_assets_prior", "total_liabilities", "total_equity", "total_equity_prior",
		"cash_and_equivalents", "total_debt", "capital_lease_obligations", "net_debt", "current_assets",
		"current_liabilities", "gross_margin_pct", "operating_margin_pct", "net_margin_pct", "fcf_margin_pct",
		"fcf_conversion", "roe_pct", "roa_pct", "net_debt_to_ebitda", "net_debt_to_equity", "current_ratio",
		"interest_cover", "payout_ratio_pct", "statement_is_financial",
	} {
		if !strings.Contains(ExtrasUniverseQuery, "q."+col) {
			t.Errorf("extras query does not read mv_fundamentals_quality.%s", col)
		}
	}
	// The four appended growth columns (plan §2.6).
	for _, col := range []string{"revenue_basis_source", "eps_basis_source", "revenue_latest_period_end", "revenue_prior_period_end"} {
		if !strings.Contains(ExtrasUniverseQuery, "g."+col) {
			t.Errorf("extras query does not read mv_fundamentals_growth.%s", col)
		}
	}
}

// FundamentalsExtras.ApplyToGrowth only copies from a real growth row.
func TestApplyToGrowth(t *testing.T) {
	g := &engine.Growth{}
	(&FundamentalsExtras{RevenueBasisSource: "filing"}).ApplyToGrowth(g)
	if g.RevenueBasisSource != "" {
		t.Error("no growth row: nothing to copy")
	}
	(&FundamentalsExtras{HasGrowthRow: true, RevenueBasisSource: "filing"}).ApplyToGrowth(g)
	if g.RevenueBasisSource != "filing" {
		t.Error("copy")
	}
	(*FundamentalsExtras)(nil).ApplyToGrowth(g)
	(&FundamentalsExtras{HasGrowthRow: true}).ApplyToGrowth(nil)
}

// A quality row with no flow basis is no quality row: the EPS-only stock's
// all-NULL row must not be read as one.
func TestExtrasQualityRowNeedsAFlowBasis(t *testing.T) {
	var r extrasRow
	for _, c := range fundamentalsExtrasColumns {
		if c.target(&r) == any(&r.hasQuality) {
			if c.expr != `(q.stock_code IS NOT NULL AND q.basis_period_end IS NOT NULL)` {
				t.Errorf("hasQuality reads %q", c.expr)
			}
			return
		}
	}
	t.Fatal("no extras column scans into hasQuality")
}

// MergeExtras attaches the appended growth columns, the quality row and the
// valuation inputs by code, and a nil map changes nothing.
func TestMergeExtrasAttachesByCode(t *testing.T) {
	growth := &engine.Growth{}
	cands := []engine.Candidate{
		{StockCode: "BHP", Growth: growth},
		{StockCode: "CBA"},
	}
	MergeExtras(cands, nil)
	if cands[0].ValuationInputs != nil || cands[0].Quality != nil {
		t.Fatal("a nil extras map must change nothing")
	}
	when := time.Date(2026, 6, 30, 0, 0, 0, 0, time.UTC)
	one := 1.0
	q := &engine.Quality{BasisPeriodType: "annual", BasisPeriodEnd: &when}
	extras := map[string]*FundamentalsExtras{
		"BHP": {
			StockCode:          "BHP",
			HasGrowthRow:       true,
			RevenueBasisSource: "filing",
			Quality:            q,
			Valuation:          engine.ValuationInputs{MedianK: &one},
		},
	}
	MergeExtras(cands, extras)
	if cands[0].Growth.RevenueBasisSource != "filing" || cands[0].Quality != q {
		t.Errorf("BHP did not take its growth basis and quality row: %+v", cands[0].Growth)
	}
	if cands[0].ValuationInputs == nil || cands[0].ValuationInputs.MedianK == nil || *cands[0].ValuationInputs.MedianK != 1 {
		t.Errorf("BHP valuation inputs = %+v", cands[0].ValuationInputs)
	}
	if cands[1].Quality != nil || cands[1].ValuationInputs != nil {
		t.Error("CBA has no extras and must keep none")
	}
}
