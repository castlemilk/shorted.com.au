package shorts

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/strategies"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The fundamentals reads (plan docs/plans/fundamentals-coverage.md §5.3)
// against the REAL migrations, not stand-ins. postgres_fundamentals_pg_test.go
// builds 000132's objects from the contract's column lists; this test applies
// the migration files themselves (000132 included), seeds a small realistic
// data set, runs refresh_strategy_views() and exercises every read the API
// makes of them, plus the strategy evaluation and valuation over the result.
// It is the check that the stand-ins match the real views' names and types.
// It then replays the migrations the way the deploy allowlist does (in the
// order .github/workflows/terraform-deploy.yml lists them) and asserts the
// replays are no-ops: same objects, same data, same view contents, same owner
// and grants.
//
// Only mv_screener_data stays a stand-in: its real definition reads shorts,
// director trades, news and dividends, none of which 000132 touches.
//
// Env-gated like its sibling (an admin DSN to a DISPOSABLE server; it creates
// an isolated database and drops it afterwards):
//
//	SHORTS_TEST_POSTGRES_URL='postgres://postgres@127.0.0.1:55432/postgres?sslmode=disable' \
//	  GOWORK=off go test ./shorts/internal/store/shorts/ -run TestFundamentalsReadsAgainstMigratedPostgres -v

const migratedMigrationsDir = "../../../../migrations"

// migratedWorkflow is the deploy workflow whose prod allowlist decides the
// replay order.
const migratedWorkflow = "../../../../../.github/workflows/terraform-deploy.yml"

// migratedBase: every file the reads depend on, in version order. 000001,
// 000003, 000005 and 000011 build "company-metadata" as the store reads it.
var migratedBase = []string{
	"000001_initial_schema.up.sql",
	"000002_stock_prices.up.sql",
	"000003_add_enrichment_fields.up.sql",
	"000005_add_key_metrics.up.sql",
	"000011_add_logo_icon_url.up.sql",
	"000045_formalize_financial_report_extractions.up.sql",
	"000117_add_index_prices.up.sql",
	"000129_add_stock_fundamentals.up.sql",
	"000130_add_price_features.up.sql",
	"000131_widen_stock_price_precision.up.sql",
	"000132_extend_fundamentals.up.sql",
}

// migratedReplayRelevant: the allowlisted files that touch the objects this
// test reads (000095 redefines a refresh function the picker's must be
// ordered after).
var migratedReplayRelevant = map[string]bool{
	"000095_harden_mv_refresh.up.sql":           true,
	"000117_add_index_prices.up.sql":            true,
	"000129_add_stock_fundamentals.up.sql":      true,
	"000130_add_price_features.up.sql":          true,
	"000131_widen_stock_price_precision.up.sql": true,
	"000132_extend_fundamentals.up.sql":         true,
}

// mv_screener_data's real definition (000080) needs shorts, director_trades,
// news_articles and dividend_history; the candidates query reads only these
// columns of it.
const migratedScreenerStandIn = `
CREATE TABLE mv_screener_data (
	stock_code varchar(10), company_name text, industry text, logo_url text,
	short_pct numeric, days_to_cover numeric, avg_volume_20d numeric, market_cap numeric
);`

func TestFundamentalsReadsAgainstMigratedPostgres(t *testing.T) {
	adminURL := os.Getenv("SHORTS_TEST_POSTGRES_URL")
	if adminURL == "" {
		t.Skip("SHORTS_TEST_POSTGRES_URL not set; skipping the real-migration fundamentals test")
	}
	for _, shared := range []string{"supabase", "pooler", ":6543"} {
		if strings.Contains(adminURL, shared) {
			t.Fatalf("refusing a shared or pooled database (%q): this test creates and drops databases", shared)
		}
	}
	ctx := context.Background()
	pool := fundamentalsTestDatabase(t, ctx, adminURL)
	db := &migratedDB{t: t, ctx: ctx, pool: pool}

	for _, f := range migratedBase {
		db.apply(f)
	}
	db.exec(migratedScreenerStandIn)

	// Dates. mv_price_features reads the last 400 days before CURRENT_DATE, so
	// prices are seeded relative to the server's date, and so are the
	// fundamentals (valuation only uses a share count or an EPS dated within
	// 12 months of the close). E is a month end 45-76 days ago: the latest
	// TTM / half / balance date; the fiscal year ended six months before it.
	var today time.Time
	db.scalar(&today, `SELECT CURRENT_DATE`)
	d := today.AddDate(0, 0, -45)
	E := time.Date(d.Year(), d.Month(), 0, 0, 0, 0, 0, time.UTC)
	me := func(n int) time.Time { return migratedMonthEnd(E, n) }
	ds := func(t time.Time) string { return t.Format("2006-01-02") }
	fy, fyPrior, fyPrior2 := me(-6), me(-18), me(-30)
	filed := E.AddDate(0, 0, 40)

	// Prices: weekday sessions over the last 380 days, a straight line from
	// p0 to p1. OLD traded only long ago (outside mv_price_features).
	db.exec(`
		INSERT INTO stock_prices (stock_code, date, open, high, low, close, adjusted_close, volume)
		SELECT s.code, g.d::date, px.p, round(px.p * 1.01, 4), round(px.p * 0.99, 4), px.p, px.p, s.vol
		FROM (VALUES ('QCO', 10.0, 15.0, 1000000, 380, 1),
		             ('BNK', 30.0, 32.0, 2000000, 380, 1),
		             ('USX', 44.0, 36.0,  800000, 380, 1),
		             ('FXC',  5.0,  5.5, 1000000, 380, 1),
		             ('PLN',  2.0,  2.2, 1000000, 380, 1),
		             ('OLD',  1.0,  1.2,  100000, 800, 500)) AS s(code, p0, p1, vol, first_ago, last_ago)
		CROSS JOIN LATERAL (
			SELECT x.d, row_number() OVER (ORDER BY x.d) AS i, count(*) OVER () AS n
			FROM generate_series(CURRENT_DATE - s.first_ago, CURRENT_DATE - s.last_ago, interval '1 day') AS x(d)
			WHERE extract(isodow FROM x.d) < 6
		) g
		CROSS JOIN LATERAL (SELECT round((s.p0 + (s.p1 - s.p0) * (g.i - 1) / (g.n - 1))::numeric, 4) AS p) px`)
	db.exec(`
		INSERT INTO index_prices (index_code, date, open, high, low, close, volume)
		SELECT 'XJO', x.d::date, 7000 + g.i, 7010 + g.i, 6990 + g.i, 7000 + g.i, 0
		FROM generate_series(CURRENT_DATE - 380, CURRENT_DATE - 1, interval '1 day') AS x(d)
		CROSS JOIN LATERAL (SELECT (x.d::date - (CURRENT_DATE - 380))::float8 AS i) g
		WHERE extract(isodow FROM x.d) < 6`)
	var asOf time.Time
	db.scalar(&asOf, `SELECT max(date) FROM stock_prices WHERE stock_code = 'QCO'`)

	db.exec(`INSERT INTO "company-metadata" (stock_code, company_name, industry, key_metrics) VALUES
		('QCO', 'QUOKKA COMPOUNDERS LIMITED', 'Capital Goods', '{}'),
		('BNK', 'KOALA BANKING CORPORATION', 'Banks', '{}'),
		('USX', 'WOMBAT RESOURCES LIMITED', 'Materials', '{}'),
		('FXC', 'PLATYPUS SOFTWARE LIMITED', 'Software & Services', '{}'),
		('PLN', 'NUMBAT HOLDINGS LIMITED', 'Capital Goods', '{"market_cap": 440000000}'),
		('OLD', 'BILBY MINING LIMITED', 'Materials', '{}'),
		('EMP', 'QUOLL INVESTMENTS LIMITED', 'Financial Services', '{}'),
		('PEN', 'DINGO LIMITED', 'Capital Goods', '{}')`)
	db.exec(`INSERT INTO mv_screener_data (stock_code, company_name, industry, short_pct, days_to_cover, avg_volume_20d, market_cap) VALUES
		('QCO', 'QUOKKA COMPOUNDERS LIMITED', 'Capital Goods', 1.2, 0.8, 1000000, 999),
		('PLN', 'NUMBAT HOLDINGS LIMITED', 'Capital Goods', 0.1, 0.1, 1000000, 0)`)

	y, fil, mk := "yahoo-timeseries", "asx-filing-extraction", "markit-key-statistics"
	qcoDoc := "https://www.asx.com.au/asxpdf/qco-appendix-4d.pdf"

	// QCO: an AUD compounder. TTM flow at E (fresher than the FY), balance
	// snapshots at E and a year before, filing halves at E and a year before.
	qcoTTM := map[string]any{
		"revenue": 500e6, "gross_profit": 200e6, "operating_income": 120e6, "ebitda": 140e6, "normalized_ebitda": 138e6,
		"ebit": 118e6, "interest_expense": 5e6, "pretax_income": 113e6, "tax_provision": 33e6, "net_income": 80e6,
		"net_interest_income": -5e6, "operating_cash_flow": 110e6, "capital_expenditure": -20e6, "free_cash_flow": 90e6,
		"dividends_paid": -40e6, "share_buybacks": -5e6, "eps_basic": 0.40, "eps_diluted": 0.395, "shares_outstanding": 200e6,
	}
	qcoSnap := map[string]any{
		"total_assets": 700e6, "total_liabilities": 280e6, "total_equity": 420e6, "cash_and_equivalents": 150e6,
		"total_debt": 90e6, "capital_lease_obligations": 30e6, "current_assets": 300e6, "current_liabilities": 150e6,
		"shares_outstanding": 200e6,
	}
	db.seed("QCO", "ttm", E, "AUD", y, qcoTTM)
	db.seed("QCO", "ttm", me(-12), "AUD", y, map[string]any{"revenue": 450e6, "net_income": 70e6, "eps_basic": 0.35, "eps_diluted": 0.35, "shares_outstanding": 200e6})
	db.seed("QCO", "annual", fy, "AUD", y, map[string]any{
		"revenue": 470e6, "net_income": 75e6, "eps_basic": 0.375, "eps_diluted": 0.37, "shares_outstanding": 200e6,
		"operating_cash_flow": 100e6, "capital_expenditure": -16e6, "free_cash_flow": 84e6,
		"total_equity": 400e6, "total_assets": 680e6, "field_sources": `{"revenue": "` + mk + `"}`,
	})
	db.seed("QCO", "annual", fyPrior, "AUD", y, map[string]any{"revenue": 430e6, "net_income": 66e6, "eps_basic": 0.33, "eps_diluted": 0.325, "shares_outstanding": 200e6})
	db.seed("QCO", "annual", fyPrior2, "AUD", y, map[string]any{"revenue": 400e6, "net_income": 60e6, "eps_basic": 0.30, "eps_diluted": 0.295, "shares_outstanding": 200e6})
	db.seed("QCO", "quarter", E, "AUD", y, qcoSnap)
	db.seed("QCO", "quarter", me(-12), "AUD", y, map[string]any{"total_assets": 650e6, "total_equity": 380e6})
	db.seed("QCO", "half", E, "AUD", fil, map[string]any{
		"revenue": 260e6, "net_income": 42e6, "eps_basic": 0.21,
		"source_document_url": qcoDoc, "source_document_date": ds(filed),
	})
	db.seed("QCO", "half", me(-12), "AUD", fil, map[string]any{"revenue": 235e6, "net_income": 37e6, "eps_basic": 0.185})

	// BNK: a bank (no operating income, no EBITDA; equity 6% of assets).
	db.seed("BNK", "annual", fy, "AUD", y, map[string]any{
		"revenue": 27e9, "net_income": 10e9, "net_interest_income": 23e9, "eps_basic": 6.0, "eps_diluted": 5.95,
		"shares_outstanding": 1.67e9, "total_assets": 1.3e12, "total_equity": 78e9, "total_debt": 9e11, "cash_and_equivalents": 50e9,
	})
	db.seed("BNK", "annual", fyPrior, "AUD", y, map[string]any{
		"revenue": 26e9, "net_income": 9.5e9, "eps_basic": 5.7, "eps_diluted": 5.65, "shares_outstanding": 1.67e9,
		"total_assets": 1.25e12, "total_equity": 75e9,
	})

	// USX: USD statements, a derived operating cash flow, a falling price.
	db.seed("USX", "annual", fy, "USD", y, map[string]any{
		"revenue": 5.5e9, "net_income": 1.1e9, "eps_basic": 2.17, "eps_diluted": 2.16, "shares_outstanding": 5.07e8,
		"operating_income": 2.2e9, "ebitda": 2.6e9, "free_cash_flow": 0.9e9, "capital_expenditure": -0.5e9,
		"operating_cash_flow": 1.4e9, "total_equity": 4.9e9, "total_assets": 9e9, "total_debt": 1.5e9,
		"capital_lease_obligations": 0.1e9, "cash_and_equivalents": 0.3e9, "net_debt": 1.1e9,
		"field_sources": `{"operating_cash_flow": "derived:fcf-minus-capex"}`,
	})
	db.seed("USX", "annual", fyPrior, "USD", y, map[string]any{
		"revenue": 5.6e9, "net_income": 0.9e9, "eps_basic": 1.77, "eps_diluted": 1.76, "shares_outstanding": 5.07e8,
		"total_equity": 4.5e9, "total_assets": 8.6e9,
	})

	// FXC: FX-converted (monetary fields rejected): EPS and shares only.
	db.seed("FXC", "annual", fy, "AUD", y, map[string]any{"eps_basic": 0.9, "eps_diluted": 0.89, "shares_outstanding": 1.5e8})

	// OLD: no recent prices, no share count.
	db.seed("OLD", "annual", fy, "AUD", y, map[string]any{"revenue": 20e6, "net_income": 2e6})

	db.exec(`INSERT INTO stock_fundamentals_sync (stock_code, last_attempt_at, last_success_at, last_error, periods_loaded,
			last_outcome, consecutive_empty, median_k, fx_converted, native_currency) VALUES
		('QCO', now(), now(), NULL, 7, 'loaded', 0, 1.0, false, NULL),
		('BNK', now(), now(), NULL, 2, 'loaded', 0, 0.998, false, NULL),
		('USX', now(), now(), NULL, 2, 'loaded', 0, 1.0, false, NULL),
		('FXC', now(), now(), NULL, 1, 'loaded', 0, 1.02, true, 'NZD'),
		('EMP', now(), NULL, 'no fundamentals published: yahoo: none', 0, 'empty', 2, NULL, NULL, NULL)`)

	// Extractions: the half's Appendix 4D (the latest filing), a newer
	// presentation (not a results document), the FY's 4E, and a
	// low-confidence digest the query never returns.
	db.exec(fmt.Sprintf(`INSERT INTO financial_report_extractions
			(stock_code, report_url, report_type, report_title, report_date, metrics, digest, digest_confidence, document_meta) VALUES
		('QCO', '%[1]s', 'half_year', 'Appendix 4D and Half Year Report', '%[2]s',
		 '{"revenue": [{"value": "260", "unit": "AUD_millions", "alignment": "match_exact"}]}',
		 'Quokka lifted half-year revenue 11%% on the prior half.', 0.82,
		 '{"currency": "AUD", "units": "millions", "entity": "Quokka Compounders Limited", "period_end": "%[3]s", "period_type": "half", "report_kind": "appendix_4d"}'),
		('QCO', 'https://www.asx.com.au/asxpdf/qco-presentation.pdf', 'presentation', 'Half Year Results Presentation', '%[4]s',
		 '{}', 'Slides for the half-year result.', 0.9, '{"report_kind": "other"}'),
		('QCO', 'https://www.asx.com.au/asxpdf/qco-appendix-4e.pdf', 'annual', 'Appendix 4E and Annual Report', '%[5]s',
		 '{}', 'Quokka full-year result.', 0.85,
		 '{"currency": "AUD", "period_end": "%[6]s", "period_type": "annual", "report_kind": "appendix_4e", "units": "lots"}'),
		('QCO', 'https://www.asx.com.au/asxpdf/qco-low.pdf', 'annual', 'Annual Report', '%[5]s', '{}', 'Unsure.', 0.4, NULL)`,
		qcoDoc, ds(filed), ds(E), ds(filed.AddDate(0, 0, 1)), ds(fy.AddDate(0, 0, 50)), ds(fy)))

	db.refresh()

	t.Run("the real views are populated and their columns are what the store reads", func(t *testing.T) {
		for _, mv := range []string{"mv_market_regime", "mv_fundamentals_growth", "mv_fundamentals_quality", "mv_price_features"} {
			var populated bool
			db.scalar(&populated, `SELECT ispopulated FROM pg_matviews WHERE matviewname = $1`, mv)
			assert.True(t, populated, mv)
		}
		// Every column the store names exists on the real relation. (The
		// reads below would fail with 42703 otherwise; this names the column.)
		for rel, cols := range map[string][]string{
			"mv_fundamentals_growth": migratedGrowthColumnsRead(),
			"mv_fundamentals_quality": {"stock_code", "basis_period_type", "basis_period_end", "currency", "source", "fetched_at",
				"revenue", "gross_profit", "operating_income", "ebitda", "normalized_ebitda", "ebit", "net_income",
				"operating_cash_flow", "operating_cash_flow_derived", "free_cash_flow", "capital_expenditure", "dividends_paid",
				"interest_expense", "shares_outstanding", "balance_period_end", "balance_period_type", "balance_currency",
				"balance_lag_months", "total_assets", "total_assets_prior", "total_liabilities", "total_equity",
				"total_equity_prior", "cash_and_equivalents", "total_debt", "capital_lease_obligations", "net_debt",
				"current_assets", "current_liabilities", "gross_margin_pct", "operating_margin_pct", "net_margin_pct",
				"fcf_margin_pct", "fcf_conversion", "roe_pct", "roa_pct", "net_debt_to_ebitda", "net_debt_to_equity",
				"current_ratio", "interest_cover", "payout_ratio_pct", "statement_is_financial"},
			"stock_fundamentals_sync": {"stock_code", "last_attempt_at", "last_success_at", "last_outcome", "median_k", "fx_converted", "native_currency"},
			"financial_report_extractions": {"stock_code", "report_url", "report_title", "report_date", "digest",
				"digest_confidence", "extracted_at", "document_meta"},
		} {
			have := db.columnSet(rel)
			for _, c := range cols {
				assert.True(t, have[c], "%s.%s is read by the store but the real relation lacks it", rel, c)
			}
		}
		have := db.columnSet("stock_fundamentals")
		for _, c := range append(append([]fundamentalsColumn{}, fundamentalsBaseValueColumns...), fundamentalsExtendedColumns...) {
			assert.True(t, have[c.name], "stock_fundamentals.%s", c.name)
		}
	})

	t.Run("ListStrategyCandidates over the real views", func(t *testing.T) {
		cands, err := listStrategyCandidates(ctx, pool)
		require.NoError(t, err)
		require.Len(t, cands, 5, "every stock with recent prices: BNK FXC PLN QCO USX")
		byCode := migratedByCode(cands)
		for _, code := range []string{"BNK", "FXC", "PLN", "QCO", "USX"} {
			require.Contains(t, byCode, code)
		}

		q := byCode["QCO"]
		assert.InDelta(t, 15.0, q.Close, 1e-9)
		assert.True(t, q.AsOf.Equal(asOf), "as_of %s, want %s", q.AsOf, asOf)
		require.NotNil(t, q.SMA200)
		assert.Less(t, *q.SMA200, 15.0)
		require.NotNil(t, q.DollarVolume20d)
		assert.Greater(t, *q.DollarVolume20d, strategies.LiquidityFloorAUD)
		assert.GreaterOrEqual(t, q.SessionsAvailable, int32(260))
		assert.Equal(t, "Capital Goods", q.Industry)
		require.NotNil(t, q.ShortPct)
		assert.InDelta(t, 1.2, *q.ShortPct, 1e-9)

		g := q.Growth
		require.NotNil(t, g)
		assert.Equal(t, "ttm", g.BasisPeriodType, "the TTM EPS pair is as fresh as the FY")
		assert.Equal(t, "ttm", g.RevenueBasisPeriodType, "the TTM revenue point is newer than the FY; the half on the same date does not win")
		migratedDate(t, g.LatestPeriodEnd, E, "latest_period_end")
		migratedDate(t, g.LatestAnnualPeriodEnd, fy, "latest_annual_period_end")
		migratedNum(t, g.RevenueLatest, 500e6, "revenue_latest")
		migratedNum(t, g.RevenuePrior, 450e6, "revenue_prior")
		migratedNum(t, g.RevenueYoYPct, (500.0-450)/450*100, "revenue_yoy_pct")
		assert.Nil(t, g.RevenueYoYPriorPct, "no point 12 months before the comparator")
		migratedNum(t, g.EPSLatest, 0.395, "eps_latest")
		migratedNum(t, g.EPSPrior, 0.35, "eps_prior")
		migratedNum(t, g.EPSYoYPct, (0.395-0.35)/0.35*100, "eps_yoy_pct")
		migratedNum(t, g.NetIncomeLatest, 75e6, "net_income_latest")
		migratedNum(t, g.NetIncomePrior, 66e6, "net_income_prior")
		require.NotNil(t, g.NetIncomePositive)
		assert.True(t, *g.NetIncomePositive)
		migratedNum(t, g.OperatingCashFlowLatest, 100e6, "operating_cash_flow_latest")
		migratedNum(t, g.RevenueTTM, 500e6, "revenue_ttm")
		migratedNum(t, g.NetIncomeTTM, 80e6, "net_income_ttm")
		migratedNum(t, g.EPSTTM, 0.395, "eps_ttm")
		migratedNum(t, g.RevenueHalfDelta, 30e6, "revenue_half_delta")
		migratedNum(t, g.NetIncomeHalfDelta, 5e6, "net_income_half_delta")
		migratedNum(t, g.RevenueHalfYoYPct, (260.0-235)/235*100, "revenue_half_yoy_pct")
		migratedNum(t, g.NetIncomeHalfYoYPct, (42.0-37)/37*100, "net_income_half_yoy_pct")
		migratedNum(t, g.EPSHalfYoYPct, (0.21-0.185)/0.185*100, "eps_half_yoy_pct")
		migratedDate(t, g.HalfLatestPeriodEnd, E, "half_latest_period_end")
		assert.Equal(t, "AUD", g.Currency)
		assert.Equal(t, int32(7), g.PeriodsAvailable, "the two balance snapshots are not flow rows")
		require.NotNil(t, g.FetchedAt)
		// The appended columns (the separate extras query).
		assert.Equal(t, "vendor", g.RevenueBasisSource)
		assert.Equal(t, "vendor", g.EPSBasisSource)
		migratedDate(t, g.RevenueLatestPeriodEnd, E, "revenue_latest_period_end")
		migratedDate(t, g.RevenuePriorPeriodEnd, me(-12), "revenue_prior_period_end")

		qq := q.Quality
		require.NotNil(t, qq)
		assert.Equal(t, "ttm", qq.BasisPeriodType)
		migratedDate(t, qq.BasisPeriodEnd, E, "basis_period_end")
		assert.Equal(t, "AUD", qq.Currency)
		assert.Equal(t, y, qq.Source)
		require.NotNil(t, qq.FetchedAt)
		assert.Equal(t, "quarter", qq.BalancePeriodType)
		migratedDate(t, qq.BalancePeriodEnd, E, "balance_period_end")
		assert.Equal(t, "AUD", qq.BalanceCurrency)
		require.NotNil(t, qq.BalanceLagMonths)
		assert.Equal(t, int32(0), *qq.BalanceLagMonths)
		for name, c := range map[string]struct {
			got  *float64
			want float64
		}{
			"revenue": {qq.Revenue, 500e6}, "gross_profit": {qq.GrossProfit, 200e6}, "operating_income": {qq.OperatingIncome, 120e6},
			"ebitda": {qq.EBITDA, 140e6}, "normalized_ebitda": {qq.NormalizedEBITDA, 138e6}, "ebit": {qq.EBIT, 118e6},
			"net_income": {qq.NetIncome, 80e6}, "operating_cash_flow": {qq.OperatingCashFlow, 110e6},
			"free_cash_flow": {qq.FreeCashFlow, 90e6}, "capital_expenditure": {qq.CapitalExpenditure, -20e6},
			"dividends_paid": {qq.DividendsPaid, -40e6}, "interest_expense": {qq.InterestExpense, 5e6},
			"shares_outstanding": {qq.SharesOutstanding, 200e6}, "net_interest_income": {qq.NetInterestIncome, -5e6},
			"total_assets": {qq.TotalAssets, 700e6}, "total_assets_prior": {qq.TotalAssetsPrior, 650e6},
			"total_liabilities": {qq.TotalLiabilities, 280e6}, "total_equity": {qq.TotalEquity, 420e6},
			"total_equity_prior": {qq.TotalEquityPrior, 380e6}, "cash_and_equivalents": {qq.CashAndEquivalents, 150e6},
			"total_debt": {qq.TotalDebt, 90e6}, "capital_lease_obligations": {qq.CapitalLeaseObligations, 30e6},
			"net_debt": {qq.NetDebt, 90e6 - 30e6 - 150e6}, "current_assets": {qq.CurrentAssets, 300e6},
			"current_liabilities": {qq.CurrentLiabilities, 150e6},
			"gross_margin_pct":    {qq.GrossMarginPct, 40}, "operating_margin_pct": {qq.OperatingMarginPct, 24},
			"net_margin_pct": {qq.NetMarginPct, 16}, "fcf_margin_pct": {qq.FCFMarginPct, 18},
			"fcf_conversion": {qq.FCFConversion, 90.0 / 80}, "roe_pct": {qq.ROEPct, 80.0 / 400 * 100},
			"roa_pct": {qq.ROAPct, 80.0 / 675 * 100}, "net_debt_to_ebitda": {qq.NetDebtToEBITDA, -90.0 / 138},
			"net_debt_to_equity": {qq.NetDebtToEquity, -90.0 / 420}, "current_ratio": {qq.CurrentRatio, 2},
			"interest_cover": {qq.InterestCover, 24}, "payout_ratio_pct": {qq.PayoutRatioPct, 50},
		} {
			migratedNum(t, c.got, c.want, name)
		}
		assert.False(t, qq.OperatingCashFlowDerived)
		assert.False(t, qq.StatementIsFinancial)

		vi := q.ValuationInputs
		require.NotNil(t, vi)
		migratedNum(t, vi.Shares, 200e6, "shares")
		migratedDate(t, vi.SharesPeriodEnd, E, "shares period end")
		migratedNum(t, vi.MedianK, 1.0, "median_k")
		assert.Equal(t, int32(5), vi.KPeriods, "two TTM and three annual vendor rows allow k")
		assert.True(t, vi.KConsistent)
		assert.False(t, vi.FXConverted)
		migratedNum(t, vi.EPSDiluted, 0.395, "eps diluted")
		migratedNum(t, vi.EPSBasic, 0.40, "eps basic")
		migratedDate(t, vi.EPSPeriodEnd, E, "eps period end")
		assert.Equal(t, "AUD", vi.EPSCurrency)

		// USX: the derived-OCF marker, and a stored (Yahoo) net debt.
		u := byCode["USX"].Quality
		require.NotNil(t, u)
		assert.Equal(t, "annual", u.BasisPeriodType)
		assert.True(t, u.OperatingCashFlowDerived)
		migratedNum(t, u.NetDebt, 1.1e9, "USX net_debt: the stored value wins")
		migratedNum(t, u.ROEPct, 1.1/((4.9+4.5)/2)*100, "USX roe_pct")
		assert.Equal(t, "USD", u.Currency)
		require.NotNil(t, byCode["USX"].Growth)
		migratedNum(t, byCode["USX"].Growth.RevenueYoYPct, (5.5-5.6)/5.6*100, "USX revenue_yoy_pct")

		// BNK: the view flags the statement; the not-meaningful set is Go's.
		b := byCode["BNK"].Quality
		require.NotNil(t, b)
		assert.True(t, b.StatementIsFinancial)
		assert.Nil(t, b.ROEPct, "equity under 10% of assets")
		migratedNum(t, b.ROAPct, 10.0/((1300+1250)/2.0)*100, "BNK roa_pct")
		migratedNum(t, b.NetInterestIncome, 23e9, "BNK net_interest_income, read from the flow row")

		// FXC: EPS and shares only. A growth row, and no flow basis for ratios.
		f := byCode["FXC"]
		require.NotNil(t, f.Growth)
		assert.Nil(t, f.Growth.RevenueYoYPct)
		assert.Equal(t, "", f.Growth.RevenueBasisSource, "no revenue figure, no source")
		require.NotNil(t, f.ValuationInputs)
		assert.True(t, f.ValuationInputs.FXConverted)
		assert.Nil(t, f.Quality, "the view's all-NULL row for an EPS-only stock is no quality row")
		var fxcRow string
		db.scalar(&fxcRow, `SELECT row_to_json(v)::text FROM mv_fundamentals_quality v WHERE v.stock_code = 'FXC'`)
		assert.Contains(t, fxcRow, `"basis_period_end":null`, "the view does emit that row (plan §2.7: one row per stock with any flow row)")

		// PLN: prices only.
		assert.Nil(t, byCode["PLN"].Growth)
		assert.Nil(t, byCode["PLN"].Quality)
		assert.Nil(t, byCode["PLN"].ValuationInputs)
	})

	t.Run("valuation and quality-compounders over the real reads", func(t *testing.T) {
		cands, err := listStrategyCandidates(ctx, pool)
		require.NoError(t, err)
		strategies.PrepareCandidates(cands)
		byCode := migratedByCode(cands)

		qv := byCode["QCO"].Valuation
		migratedNum(t, qv.MarketCap, 15*200e6, "QCO market cap: our close x shares")
		migratedNum(t, qv.PERatio, 15/0.395, "QCO P/E on the diluted TTM EPS")
		assert.Equal(t, strategies.PEBasisDiluted, qv.PEEPSBasis)
		migratedDate(t, qv.PEEPSPeriodEnd, E, "pe eps period end")
		migratedNum(t, qv.PriceToBook, 15*200e6/420e6, "QCO P/B on the aligned equity")
		assert.Equal(t, "", qv.Note)
		migratedNum(t, byCode["QCO"].ResolvedMarketCap(), 15*200e6, "the picker's market cap is ours, not the screener's 999")

		bv := byCode["BNK"].Valuation
		migratedNum(t, bv.PERatio, 32/5.95, "BNK P/E")
		migratedNum(t, bv.PriceToBook, 32*1.67e9/78e9, "BNK P/B")
		assert.True(t, byCode["BNK"].Quality.IsFinancial)
		assert.Nil(t, byCode["BNK"].Quality.NetDebt, "not meaningful for a bank")
		assert.Equal(t, strategies.NotMeaningfulForFinancials(), byCode["BNK"].Quality.NotMeaningful)

		uv := byCode["USX"].Valuation
		migratedNum(t, uv.MarketCap, 36*5.07e8, "USX market cap (AUD: a price times a count)")
		assert.Nil(t, uv.PERatio, "USD statements")
		assert.Nil(t, uv.PriceToBook)
		assert.Equal(t, strategies.ValuationNoteNonAUD, uv.Note)

		fv := byCode["FXC"].Valuation
		migratedNum(t, fv.MarketCap, 5.5*1.5e8, "FXC market cap")
		assert.Nil(t, fv.PERatio, "an FX-converted code gets no P/E")
		assert.Nil(t, fv.PriceToBook)
		assert.Equal(t, strategies.ValuationNoteNonAUD, fv.Note)

		migratedNum(t, byCode["PLN"].ResolvedMarketCap(), 4.4e8, "no shares held: the key_metrics fallback")
		assert.Equal(t, 4, strategies.FundamentalsRows(cands), "QCO BNK USX FXC hold rows; PLN none")
		assert.Equal(t, 3, strategies.QualityCoverage(cands),
			"QCO BNK USX have statements to compute ratios from; FXC's EPS-only rows do not")

		st, ok := strategies.Lookup(strategies.IDQualityCompounders)
		require.True(t, ok)
		regime, err := (&postgresStore{db: pool}).GetMarketRegime(ctx, "XJO")
		require.NoError(t, err)
		assert.Equal(t, strategies.RegimeUptrend, regime.Label, "XJO rose steadily over 270 sessions")
		env := strategies.NewEnv(cands, regime)
		picks := strategies.EvaluateWithEnv(st, cands, env)
		byPick := map[string]strategies.Pick{}
		for _, p := range picks {
			byPick[p.Candidate.StockCode] = p
		}

		qp, ok := byPick["QCO"]
		require.True(t, ok)
		assert.Equal(t, strategies.StatusTriggered, qp.Status, "%+v", qp.Rules)
		assert.Equal(t, 1, qp.Rank)
		for _, r := range qp.Rules {
			assert.Equal(t, strategies.RulePass, r.Status, "QCO %s: %s", r.RuleID, r.Detail)
		}

		up, ok := byPick["USX"]
		require.True(t, ok)
		assert.Equal(t, strategies.StatusSetup, up.Status, "every quality rule passes; the price is below its 200-day average")
		assert.Equal(t, strategies.RuleFail, migratedRule(t, up, strategies.RuleAboveSMA200).Status)
		assert.Equal(t, strategies.RuleFail, migratedRule(t, up, strategies.RuleRevenueNotShrinking).Status)

		bp, ok := byPick["BNK"]
		require.True(t, ok)
		assert.Equal(t, strategies.StatusWatch, bp.Status, "a bank ranks as watch at most")
		for _, id := range []string{strategies.RuleROE, strategies.RuleCashConversion, strategies.RuleLeverage} {
			assert.Equal(t, strategies.RuleUnknown, migratedRule(t, bp, id).Status, "BNK %s", id)
		}
		assert.Equal(t, strategies.RulePass, migratedRule(t, bp, strategies.RuleNetMargin).Status)

		fp, ok := byPick["FXC"]
		require.True(t, ok)
		for _, id := range []string{strategies.RuleROE, strategies.RuleNetMargin, strategies.RuleCashConversion, strategies.RuleLeverage} {
			assert.Equal(t, strategies.RuleUnknown, migratedRule(t, fp, id).Status, "FXC %s: unknown, never a pass", id)
		}

		// EvaluateOne (GetStockStrategyFit's path) agrees with the ranked list.
		one, _ := strategies.EvaluateOne(st, *byCode["QCO"], env)
		assert.Equal(t, qp.Status, one.Status)
		assert.Equal(t, qp.Score, one.Score)
		assert.Equal(t, qp.Rules, one.Rules)
	})

	t.Run("GetStockFundamentals scans every real column", func(t *testing.T) {
		periods, err := getStockFundamentals(ctx, pool, "QCO", "", 40)
		require.NoError(t, err)
		var got []string
		for _, p := range periods {
			got = append(got, p.PeriodType+"@"+ds(p.PeriodEnd))
		}
		assert.Equal(t, []string{
			"half@" + ds(E), "quarter@" + ds(E), "ttm@" + ds(E), "annual@" + ds(fy),
			"half@" + ds(me(-12)), "quarter@" + ds(me(-12)), "ttm@" + ds(me(-12)),
			"annual@" + ds(fyPrior), "annual@" + ds(fyPrior2),
		}, got, "newest first, then period_type")

		ttm := periods[2]
		for _, c := range append(append([]fundamentalsColumn{}, fundamentalsBaseValueColumns...), fundamentalsExtendedColumns...) {
			want, seeded := qcoTTM[c.name]
			v := *c.field(&ttm)
			if !seeded {
				assert.Nil(t, v, "ttm %s", c.name)
				continue
			}
			migratedNum(t, v, want.(float64), "ttm "+c.name)
		}
		assert.Equal(t, "AUD", ttm.Currency)
		assert.Equal(t, y, ttm.Source)
		assert.Nil(t, ttm.FieldSources)
		assert.Equal(t, "", ttm.SourceDocumentURL)

		snap := periods[1]
		for k, want := range qcoSnap {
			col := migratedColumn(t, k)
			migratedNum(t, *col.field(&snap), want.(float64), "quarter "+k)
		}
		assert.Nil(t, snap.Revenue, "a snapshot carries no flow line")

		half := periods[0]
		assert.Equal(t, fil, half.Source)
		assert.Equal(t, qcoDoc, half.SourceDocumentURL)
		migratedDate(t, half.SourceDocumentDate, filed, "source_document_date")
		assert.Equal(t, map[string]string{"revenue": mk}, periods[3].FieldSources)

		only, err := getStockFundamentals(ctx, pool, "QCO", "quarter", 40)
		require.NoError(t, err)
		assert.Len(t, only, 2)
	})

	t.Run("GetFundamentalsExtras (the stock page) over the real views", func(t *testing.T) {
		e, err := getFundamentalsExtras(ctx, pool, "QCO")
		require.NoError(t, err)
		require.NotNil(t, e)
		migratedNum(t, e.Close, 15, "close from mv_price_features")
		migratedDate(t, e.PriceAsOf, asOf, "price as of")
		assert.Equal(t, "Capital Goods", e.Industry)
		assert.True(t, e.HasGrowthRow)
		assert.Equal(t, "vendor", e.RevenueBasisSource)
		require.NotNil(t, e.Quality)
		migratedNum(t, e.Quality.ROEPct, 20, "roe_pct")
		v := strategies.Valuate(*e.Close, *e.PriceAsOf, &e.Valuation, e.Quality)
		migratedNum(t, v.MarketCap, 3e9, "the page's market cap equals the picker's")

		// OLD: outside mv_price_features, and its last stock_prices close is
		// 500 days old, so there is no close to value it at: a stale close
		// times a newer share count is not a market cap.
		old, err := getFundamentalsExtras(ctx, pool, "OLD")
		require.NoError(t, err)
		require.NotNil(t, old)
		assert.Nil(t, old.Close, "a close older than 45 sessions is not used")
		assert.Nil(t, old.PriceAsOf)
		require.NotNil(t, old.Quality)
		migratedNum(t, old.Quality.NetMarginPct, 10, "OLD net margin")
		assert.Equal(t, strategies.ValuationNoteNoPrice, strategies.Valuate(0, time.Time{}, &old.Valuation, old.Quality).Note)

		none, err := getFundamentalsExtras(ctx, pool, "PEN")
		require.NoError(t, err)
		require.NotNil(t, none)
		assert.False(t, none.HasGrowthRow)
		assert.Nil(t, none.Quality)
		assert.Nil(t, none.Close)
	})

	t.Run("GetFundamentalsCoverage over the real sync table", func(t *testing.T) {
		for code, want := range map[string]struct {
			sources []string
			hasSync bool
			outcome string
			success bool
		}{
			"QCO": {[]string{fil, y}, true, "loaded", true},
			"EMP": {nil, true, "empty", false},
			"PEN": {nil, false, "", false},
		} {
			cov, err := getFundamentalsCoverage(ctx, pool, code)
			require.NoError(t, err, code)
			require.NotNil(t, cov, code)
			assert.True(t, cov.OutcomeKnown, code)
			assert.ElementsMatch(t, want.sources, cov.Sources, code)
			assert.Equal(t, want.hasSync, cov.HasSyncRow, code)
			assert.Equal(t, want.outcome, cov.LastOutcome, code)
			assert.Equal(t, want.success, cov.LastSuccessAt != nil, code)
			assert.Equal(t, want.hasSync, cov.LastAttemptAt != nil, code)
		}
	})

	t.Run("GetLatestFilingInputs over the real extractions table", func(t *testing.T) {
		in, err := getLatestFilingInputs(ctx, pool, "QCO")
		require.NoError(t, err)
		require.NotNil(t, in)
		migratedDate(t, in.NewestFlowPeriodEnd, E, "newest flow period")
		migratedDate(t, in.LatestAnnualPeriodEnd, fy, "latest annual")
		assert.Equal(t, "QUOKKA COMPOUNDERS LIMITED", in.CompanyName)
		require.Len(t, in.Candidates, 3, "the 0.4-confidence digest is never read")
		assert.Equal(t, "Half Year Results Presentation", in.Candidates[0].Title, "newest first")
		assert.False(t, extractiontrust.IsResultsDocument(in.Candidates[0].Title, in.Candidates[0].DocumentMeta.ReportKind))

		c := in.Candidates[1]
		assert.Equal(t, qcoDoc, c.ReportURL)
		migratedDate(t, c.ReportDate, filed, "report date")
		migratedNum(t, c.DigestConfidence, 0.82, "digest confidence")
		assert.True(t, extractiontrust.IsResultsDocument(c.Title, c.DocumentMeta.ReportKind))
		assert.Equal(t, "appendix_4d", c.DocumentMeta.ReportKind)
		assert.Equal(t, ds(E), c.DocumentMeta.PeriodEnd)
		assert.Equal(t, "half", c.DocumentMeta.PeriodType)
		assert.Equal(t, "AUD", c.DocumentMeta.Currency)
		assert.Equal(t, "Quokka Compounders Limited", c.DocumentMeta.Entity)

		fy4e := in.Candidates[2]
		assert.Equal(t, ds(fy), fy4e.DocumentMeta.PeriodEnd)
		assert.Equal(t, "", fy4e.DocumentMeta.Units, "outside the closed vocabulary: absent")
	})

	t.Run("replays: 000132 twice, then the deploy allowlist, are no-ops", func(t *testing.T) {
		replay := migratedAllowlistReplay(t)
		t.Logf("allowlist replay order: %s", strings.Join(replay, ", "))
		rolesOK := db.withRoles()

		before := db.snapshot()
		if rolesOK {
			assert.Contains(t, before.owners, "mv_fundamentals_growth=m132api_owner_")
			assert.Contains(t, before.owners, "mv_fundamentals_quality=m132api_owner_")
			assert.Contains(t, before.acls, "m132api_reader_")
		}
		db.apply("000132_extend_fundamentals.up.sql")
		assert.Equal(t, before, db.snapshot(), "a second 000132 apply changed something")

		for i := 0; i < 2; i++ {
			for _, f := range replay {
				db.apply(f)
			}
			assert.Equal(t, before, db.snapshot(), "allowlist replay %d changed something", i+1)
		}

		// Mid-deploy: 000129 and 000130 have been replayed but 000132 has not
		// run yet. The function is 000130's three-view body for that window;
		// the rebuilt growth view survives 000129's IF NOT EXISTS, and a
		// refresh then still refreshes every view it names.
		db.apply("000129_add_stock_fundamentals.up.sql")
		db.apply("000130_add_price_features.up.sql")
		mid := db.snapshot()
		assert.NotContains(t, mid.function, "mv_fundamentals_quality", "000130's replay writes the three-view body")
		assert.Equal(t, before.growthOID, mid.growthOID)
		assert.Equal(t, before.growth, mid.growth)
		db.refresh()
		cands, err := listStrategyCandidates(ctx, pool)
		require.NoError(t, err)
		assert.NotNil(t, migratedByCode(cands)["QCO"].Quality, "the reads keep working in that window")
		db.apply("000131_widen_stock_price_precision.up.sql")
		db.apply("000132_extend_fundamentals.up.sql")
		assert.Equal(t, before, db.snapshot(), "000132 restores the four-view body and the growth COMMENT")

		// A refresh after all of it recomputes the same contents.
		db.refresh()
		assert.Equal(t, before, db.snapshot())
		if !rolesOK {
			t.Log("no CREATEROLE: owner and grant carry were not exercised")
		}
	})
}

// TestExtrasQualityRowNeedsAFlowBasis pins, without a database, what the
// real-migration test above found: mv_fundamentals_quality has a row for an
// EPS-only stock whose every column but stock_code is NULL, and the store
// must not read that row as a quality row.
func TestExtrasQualityRowNeedsAFlowBasis(t *testing.T) {
	var r extrasRow
	for _, c := range fundamentalsExtrasColumns {
		if c.target(&r) == any(&r.hasQuality) {
			assert.Equal(t, `(q.stock_code IS NOT NULL AND q.basis_period_end IS NOT NULL)`, c.expr)
			return
		}
	}
	t.Fatal("no extras column scans into hasQuality")
}

// ---------------------------------------------------------------- helpers

type migratedDB struct {
	t    *testing.T
	ctx  context.Context
	pool *pgxpool.Pool
}

func (d *migratedDB) apply(file string) {
	d.t.Helper()
	body, err := os.ReadFile(filepath.Join(migratedMigrationsDir, file))
	require.NoError(d.t, err, file)
	_, err = d.pool.Exec(d.ctx, string(body))
	require.NoError(d.t, err, "applying %s", file)
}

func (d *migratedDB) exec(sql string, args ...any) {
	d.t.Helper()
	_, err := d.pool.Exec(d.ctx, sql, args...)
	require.NoError(d.t, err, sql)
}

func (d *migratedDB) scalar(dst any, sql string, args ...any) {
	d.t.Helper()
	require.NoError(d.t, d.pool.QueryRow(d.ctx, sql, args...).Scan(dst), sql)
}

func (d *migratedDB) columnSet(rel string) map[string]bool {
	d.t.Helper()
	rows, err := d.pool.Query(d.ctx, `SELECT attname FROM pg_attribute
		WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped`, rel)
	require.NoError(d.t, err)
	out := map[string]bool{}
	for rows.Next() {
		var n string
		require.NoError(d.t, rows.Scan(&n))
		out[n] = true
	}
	require.NoError(d.t, rows.Err())
	return out
}

// seed writes one stock_fundamentals row; field_sources takes a JSON object
// literal and source_document_date a date string.
func (d *migratedDB) seed(code, periodType string, end time.Time, currency, source string, vals map[string]any) {
	d.t.Helper()
	cols := []string{"stock_code", "period_type", "period_end", "fiscal_year", "currency", "source", "source_fetched_at"}
	exprs := []string{"$1", "$2", "$3::date", "$4", "$5", "$6", "now()"}
	args := []any{code, periodType, end.Format("2006-01-02"), int32(end.Year()), currency, source}
	keys := make([]string, 0, len(vals))
	for k := range vals {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		args = append(args, vals[k])
		expr := fmt.Sprintf("$%d", len(args))
		switch k {
		case "field_sources":
			expr += "::jsonb"
		case "source_document_date":
			expr += "::date"
		}
		cols = append(cols, k)
		exprs = append(exprs, expr)
	}
	d.exec(fmt.Sprintf(`INSERT INTO stock_fundamentals (%s) VALUES (%s)`,
		strings.Join(cols, ", "), strings.Join(exprs, ", ")), args...)
}

// refresh runs the job's refresh command on its own connection and fails on
// any 'Skipping' warning, which the job treats as a failed run.
func (d *migratedDB) refresh() {
	d.t.Helper()
	cfg := d.pool.Config().ConnConfig.Copy()
	var (
		mu      sync.Mutex
		notices []string
	)
	cfg.OnNotice = func(_ *pgconn.PgConn, n *pgconn.Notice) {
		mu.Lock()
		defer mu.Unlock()
		notices = append(notices, n.Severity+": "+n.Message)
	}
	conn, err := pgx.ConnectConfig(d.ctx, cfg)
	require.NoError(d.t, err)
	defer conn.Close(d.ctx)
	_, err = conn.Exec(d.ctx, `BEGIN; SET LOCAL statement_timeout = 0; SELECT refresh_strategy_views(); COMMIT`)
	require.NoError(d.t, err)
	mu.Lock()
	defer mu.Unlock()
	for _, n := range notices {
		assert.NotContains(d.t, n, "Skipping", "refresh_strategy_views skipped a view")
		assert.NotContains(d.t, n, "Failed to refresh", "a concurrent refresh fell back")
	}
}

// withRoles gives both picker views a non-default owner and a grant, so the
// replays can be checked to keep them. false (logged) without CREATEROLE.
func (d *migratedDB) withRoles() bool {
	d.t.Helper()
	suffix := time.Now().UnixNano() % 1e9
	owner, reader := fmt.Sprintf("m132api_owner_%d", suffix), fmt.Sprintf("m132api_reader_%d", suffix)
	for _, role := range []string{owner, reader} {
		if _, err := d.pool.Exec(d.ctx, `CREATE ROLE `+role+` NOLOGIN`); err != nil {
			d.t.Logf("cannot create roles (%v)", err)
			return false
		}
		role := role
		d.t.Cleanup(func() {
			// Runs before the database is dropped (cleanups are LIFO).
			ctx := context.Background()
			_, _ = d.pool.Exec(ctx, `REASSIGN OWNED BY `+role+` TO CURRENT_USER`)
			_, _ = d.pool.Exec(ctx, `DROP OWNED BY `+role)
			_, _ = d.pool.Exec(ctx, `DROP ROLE IF EXISTS `+role)
		})
	}
	d.exec(`GRANT SELECT ON stock_fundamentals TO ` + owner) // REFRESH runs the view's query as its owner
	for _, mv := range []string{"mv_fundamentals_growth", "mv_fundamentals_quality"} {
		d.exec(`ALTER MATERIALIZED VIEW ` + mv + ` OWNER TO ` + owner)
		d.exec(`GRANT SELECT ON ` + mv + ` TO ` + reader)
	}
	return true
}

// migratedSnapshot is everything a replay must leave alone.
type migratedSnapshot struct {
	growthOID, qualityOID uint32
	growth, quality       string // md5 of the view contents, in stock_code order
	fundamentals, sync    string // md5 of the table contents
	extractions           string
	owners, acls          string
	function              string // refresh_strategy_views() body
	functionConfig        string
	growthNote, qualNote  string
	constraints           string
	columns               string
}

func (d *migratedDB) snapshot() migratedSnapshot {
	d.t.Helper()
	var s migratedSnapshot
	d.scalar(&s.growthOID, `SELECT 'mv_fundamentals_growth'::regclass::oid`)
	d.scalar(&s.qualityOID, `SELECT 'mv_fundamentals_quality'::regclass::oid`)
	d.scalar(&s.growth, `SELECT md5(string_agg(row_to_json(v)::text, '|' ORDER BY v.stock_code)) FROM mv_fundamentals_growth v`)
	d.scalar(&s.quality, `SELECT md5(string_agg(row_to_json(v)::text, '|' ORDER BY v.stock_code)) FROM mv_fundamentals_quality v`)
	d.scalar(&s.fundamentals, `SELECT md5(string_agg(row_to_json(v)::text, '|' ORDER BY v.stock_code, v.period_type, v.period_end))
		FROM stock_fundamentals v`)
	d.scalar(&s.sync, `SELECT md5(string_agg(row_to_json(v)::text, '|' ORDER BY v.stock_code)) FROM stock_fundamentals_sync v`)
	d.scalar(&s.extractions, `SELECT md5(string_agg(row_to_json(v)::text, '|' ORDER BY v.report_url)) FROM financial_report_extractions v`)
	d.scalar(&s.owners, `SELECT string_agg(c.relname || '=' || pg_get_userbyid(c.relowner), ',' ORDER BY c.relname)
		FROM pg_class c WHERE c.relname IN ('mv_fundamentals_growth', 'mv_fundamentals_quality', 'stock_fundamentals', 'stock_fundamentals_sync')`)
	d.scalar(&s.acls, `SELECT string_agg(c.relname || '=' || COALESCE(c.relacl::text, '') || '/' || COALESCE(c.reloptions::text, ''), ',' ORDER BY c.relname)
		FROM pg_class c WHERE c.relname IN ('mv_fundamentals_growth', 'mv_fundamentals_quality', 'stock_fundamentals', 'stock_fundamentals_sync')`)
	d.scalar(&s.function, `SELECT prosrc FROM pg_proc WHERE oid = 'refresh_strategy_views'::regproc`)
	d.scalar(&s.functionConfig, `SELECT COALESCE(array_to_string(proconfig, ','), '') FROM pg_proc WHERE oid = 'refresh_strategy_views'::regproc`)
	d.scalar(&s.growthNote, `SELECT COALESCE(obj_description('mv_fundamentals_growth'::regclass, 'pg_class'), '')`)
	d.scalar(&s.qualNote, `SELECT COALESCE(obj_description('mv_fundamentals_quality'::regclass, 'pg_class'), '')`)
	d.scalar(&s.constraints, `SELECT string_agg(conname || ':' || convalidated::text, ',' ORDER BY conname)
		FROM pg_constraint WHERE conrelid IN ('stock_fundamentals'::regclass, 'stock_fundamentals_sync'::regclass)`)
	d.scalar(&s.columns, `SELECT string_agg(c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY c.relname, a.attnum)
		FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
		WHERE c.relname IN ('mv_fundamentals_growth', 'mv_fundamentals_quality', 'stock_fundamentals', 'stock_fundamentals_sync',
		                    'financial_report_extractions', 'picks_run_lease')
		  AND a.attnum > 0 AND NOT a.attisdropped`)
	return s
}

// migratedAllowlistReplay reads the prod allowlist from the deploy workflow
// and returns the files that touch this test's objects, in the order the
// deploy runs them.
func migratedAllowlistReplay(t *testing.T) []string {
	t.Helper()
	body, err := os.ReadFile(migratedWorkflow)
	require.NoError(t, err)
	var out []string
	seen := map[string]bool{}
	for _, m := range regexp.MustCompile(`-f /migrations/(\S+\.up\.sql)`).FindAllStringSubmatch(string(body), -1) {
		if migratedReplayRelevant[m[1]] && !seen[m[1]] {
			seen[m[1]] = true
			out = append(out, m[1])
		}
	}
	require.Len(t, out, len(migratedReplayRelevant), "every relevant file is allowlisted: %v", out)
	pos := map[string]int{}
	for i, f := range out {
		pos[f] = i
	}
	for _, earlier := range []string{"000129_add_stock_fundamentals.up.sql", "000130_add_price_features.up.sql", "000131_widen_stock_price_precision.up.sql"} {
		assert.Less(t, pos[earlier], pos["000132_extend_fundamentals.up.sql"], "%s runs before 000132", earlier)
	}
	return out
}

// migratedGrowthColumnsRead are the mv_fundamentals_growth columns the store
// names (growthColumns and the extras query).
func migratedGrowthColumnsRead() []string {
	out := []string{"stock_code", "revenue_basis_source", "eps_basis_source", "revenue_latest_period_end", "revenue_prior_period_end"}
	for _, m := range regexp.MustCompile(`g\.([a-z0-9_]+)`).FindAllStringSubmatch(growthColumns, -1) {
		out = append(out, m[1])
	}
	return out
}

func migratedMonthEnd(e time.Time, n int) time.Time {
	first := time.Date(e.Year(), e.Month()+time.Month(n)+1, 1, 0, 0, 0, 0, time.UTC)
	return first.AddDate(0, 0, -1)
}

func migratedByCode(cands []strategies.Candidate) map[string]*strategies.Candidate {
	out := map[string]*strategies.Candidate{}
	for i := range cands {
		out[cands[i].StockCode] = &cands[i]
	}
	return out
}

func migratedRule(t *testing.T, p strategies.Pick, id string) strategies.RuleResult {
	t.Helper()
	for _, r := range p.Rules {
		if r.RuleID == id {
			return r
		}
	}
	t.Fatalf("%s has no %s result", p.Candidate.StockCode, id)
	return strategies.RuleResult{}
}

func migratedColumn(t *testing.T, name string) fundamentalsColumn {
	t.Helper()
	for _, c := range append(append([]fundamentalsColumn{}, fundamentalsBaseValueColumns...), fundamentalsExtendedColumns...) {
		if c.name == name {
			return c
		}
	}
	t.Fatalf("no stock_fundamentals column %s", name)
	return fundamentalsColumn{}
}

func migratedNum(t *testing.T, got *float64, want float64, what string) {
	t.Helper()
	if !assert.NotNil(t, got, what) {
		return
	}
	tol := 1e-9
	if abs := want; abs < 0 {
		tol = -abs * 1e-9
	} else if abs > 1 {
		tol = abs * 1e-9
	}
	assert.InDelta(t, want, *got, tol, what)
}

func migratedDate(t *testing.T, got *time.Time, want time.Time, what string) {
	t.Helper()
	if !assert.NotNil(t, got, what) {
		return
	}
	assert.Equal(t, want.Format("2006-01-02"), got.Format("2006-01-02"), what)
}
