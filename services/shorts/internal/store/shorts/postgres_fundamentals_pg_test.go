package shorts

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/extractiontrust"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/strategies"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Real-Postgres check of the fundamentals reads (plan
// docs/plans/fundamentals-coverage.md §5.3): against a schema WITHOUT
// migration 000132 the universe and fundamentals return with nil extras, and
// against 000132-shaped objects every new read returns what the contract
// names. The 000132 objects here are stand-ins built from the contract's
// column lists (§2.1-§2.7), not the migration, which the data stream owns;
// 000129 is applied verbatim.
//
// Env-gated: it needs an admin DSN to a DISPOSABLE server, creates an
// isolated database and drops it afterwards.
//
//	SHORTS_TEST_POSTGRES_URL='postgres://postgres@127.0.0.1:55432/postgres?sslmode=disable' \
//	  GOWORK=off go test ./shorts/internal/store/shorts/ -run TestFundamentalsReadsAgainstPostgres -v
func TestFundamentalsReadsAgainstPostgres(t *testing.T) {
	adminURL := os.Getenv("SHORTS_TEST_POSTGRES_URL")
	if adminURL == "" {
		t.Skip("SHORTS_TEST_POSTGRES_URL not set; skipping the real-Postgres fundamentals test")
	}
	for _, shared := range []string{"supabase", "pooler", ":6543"} {
		if strings.Contains(adminURL, shared) {
			t.Fatalf("refusing a shared or pooled database (%q): this test creates and drops databases", shared)
		}
	}
	ctx := context.Background()
	pool := fundamentalsTestDatabase(t, ctx, adminURL)
	exec := func(sql string) {
		t.Helper()
		_, err := pool.Exec(ctx, sql)
		require.NoError(t, err)
	}

	migration, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "migrations", "000129_add_stock_fundamentals.up.sql"))
	require.NoError(t, err)
	exec(string(migration))
	exec(fundamentalsTestBaseSchema)
	exec(fundamentalsTestSeed)

	t.Run("without 000132", func(t *testing.T) {
		cands, err := listStrategyCandidates(ctx, pool)
		require.NoError(t, err)
		require.Len(t, cands, 2)
		bhp := cands[0]
		assert.Equal(t, "BHP", bhp.StockCode)
		require.NotNil(t, bhp.Growth, "000129's growth row still joins")
		require.NotNil(t, bhp.Growth.RevenueYoYPct)
		assert.InDelta(t, (5.5e10-5.6e10)/5.6e10*100, *bhp.Growth.RevenueYoYPct, 1e-6)
		for _, c := range cands {
			assert.Nil(t, c.Quality, c.StockCode)
			assert.Nil(t, c.ValuationInputs, c.StockCode)
			assert.Equal(t, "", c.Growth.RevenueBasisSource)
		}

		periods, err := getStockFundamentals(ctx, pool, "BHP", "", 40)
		require.NoError(t, err)
		require.Len(t, periods, 2)
		assert.Equal(t, "2026-06-30", periods[0].PeriodEnd.Format("2006-01-02"))
		assert.Nil(t, periods[0].GrossProfit)
		assert.Nil(t, periods[0].FieldSources)

		extras, err := getFundamentalsExtras(ctx, pool, "BHP")
		require.NoError(t, err)
		assert.Nil(t, extras)

		cov, err := getFundamentalsCoverage(ctx, pool, "BHP")
		require.NoError(t, err)
		require.NotNil(t, cov)
		assert.False(t, cov.OutcomeKnown)
		assert.True(t, cov.HasSyncRow)
		assert.Equal(t, []string{"yahoo-timeseries"}, cov.Sources)

		filing, err := getLatestFilingInputs(ctx, pool, "BHP")
		require.NoError(t, err)
		require.NotNil(t, filing)
		require.NotNil(t, filing.NewestFlowPeriodEnd)
		assert.Equal(t, "2026-06-30", filing.NewestFlowPeriodEnd.Format("2006-01-02"))
		assert.Equal(t, "BHP GROUP LIMITED", filing.CompanyName)
		require.Len(t, filing.Candidates, 1)
		assert.True(t, filing.Candidates[0].DocumentMeta.IsZero())
	})

	exec(fundamentalsTest132StandIns)

	t.Run("with 000132", func(t *testing.T) {
		cands, err := listStrategyCandidates(ctx, pool)
		require.NoError(t, err)
		require.Len(t, cands, 2)
		bhp, cba := cands[0], cands[1]
		require.NotNil(t, bhp.Quality)
		require.NotNil(t, bhp.Quality.ROEPct)
		assert.InDelta(t, 22.5, *bhp.Quality.ROEPct, 1e-9)
		require.NotNil(t, bhp.Quality.BalanceLagMonths)
		require.NotNil(t, bhp.Quality.NetInterestIncome, "read from the flow basis row")
		assert.InDelta(t, -1e9, *bhp.Quality.NetInterestIncome, 1)
		assert.Equal(t, "vendor", bhp.Growth.RevenueBasisSource)
		require.NotNil(t, bhp.Growth.RevenuePriorPeriodEnd)
		assert.Equal(t, "2025-06-30", bhp.Growth.RevenuePriorPeriodEnd.Format("2006-01-02"))
		vi := bhp.ValuationInputs
		require.NotNil(t, vi)
		require.NotNil(t, vi.MedianK)
		require.NotNil(t, vi.Shares)
		assert.InDelta(t, 5.07e9, *vi.Shares, 1)
		assert.Equal(t, "USD", vi.EPSCurrency)
		assert.Equal(t, int32(2), vi.KPeriods)
		assert.True(t, vi.KConsistent)
		assert.False(t, vi.KFarFromOne)

		require.NotNil(t, cba.Quality)
		assert.True(t, cba.Quality.StatementIsFinancial)
		require.NotNil(t, cba.ValuationInputs)
		assert.Nil(t, cba.ValuationInputs.MedianK, "no sync row")
		assert.Equal(t, int32(1), cba.ValuationInputs.KPeriods)
		assert.True(t, cba.ValuationInputs.KConsistent)
		assert.False(t, cba.ValuationInputs.KFarFromOne)
		assert.False(t, cba.ValuationInputs.FXConverted, "no sync row, whole-unit vendor figures")

		strategies.PrepareCandidates(cands)
		assert.True(t, cands[1].Quality.IsFinancial)
		require.NotNil(t, cands[0].Valuation.MarketCap)
		assert.InDelta(t, 45.1*5.07e9, *cands[0].Valuation.MarketCap, 1e3)
		assert.Nil(t, cands[0].Valuation.PERatio, "BHP reports in USD")
		assert.Equal(t, strategies.ValuationNoteNonAUD, cands[0].Valuation.Note)
		require.NotNil(t, cands[1].Valuation.PERatio)
		assert.InDelta(t, 160/5.95, *cands[1].Valuation.PERatio, 1e-6)

		periods, err := getStockFundamentals(ctx, pool, "BHP", "annual", 40)
		require.NoError(t, err)
		require.Len(t, periods, 2)
		p := periods[0]
		require.NotNil(t, p.GrossProfit)
		assert.InDelta(t, 3e10, *p.GrossProfit, 1)
		require.NotNil(t, p.TotalEquity)
		assert.Equal(t, map[string]string{"revenue": "markit-key-statistics"}, p.FieldSources, "unknown keys dropped")
		assert.Equal(t, "https://asx/bhp-4e.pdf", p.SourceDocumentURL)
		require.NotNil(t, p.SourceDocumentDate)
		assert.Equal(t, "2026-08-19", p.SourceDocumentDate.Format("2006-01-02"))
		assert.Nil(t, periods[1].FieldSources)

		extras, err := getFundamentalsExtras(ctx, pool, "BHP")
		require.NoError(t, err)
		require.NotNil(t, extras)
		require.NotNil(t, extras.Close)
		assert.InDelta(t, 45.1, *extras.Close, 1e-9, "the close the picks use (mv_price_features)")
		require.NotNil(t, extras.PriceAsOf)
		assert.Equal(t, "2026-09-25", extras.PriceAsOf.Format("2006-01-02"))
		assert.Equal(t, "Materials", extras.Industry)
		require.NotNil(t, extras.Quality)

		// A code outside the price features falls back to stock_prices.
		lone, err := getFundamentalsExtras(ctx, pool, "XYZ")
		require.NoError(t, err)
		require.NotNil(t, lone)
		require.NotNil(t, lone.Close)
		assert.InDelta(t, 1.23, *lone.Close, 1e-9)
		assert.Nil(t, lone.Quality)
		assert.False(t, lone.HasGrowthRow)

		cov, err := getFundamentalsCoverage(ctx, pool, "BHP")
		require.NoError(t, err)
		assert.True(t, cov.OutcomeKnown)
		assert.Equal(t, "loaded", cov.LastOutcome)
		pending, err := getFundamentalsCoverage(ctx, pool, "XYZ")
		require.NoError(t, err)
		assert.True(t, pending.OutcomeKnown)
		assert.False(t, pending.HasSyncRow)
		assert.Empty(t, pending.Sources)

		filing, err := getLatestFilingInputs(ctx, pool, "BHP")
		require.NoError(t, err)
		require.Len(t, filing.Candidates, 1)
		meta := filing.Candidates[0].DocumentMeta
		assert.Equal(t, "2026-06-30", meta.PeriodEnd)
		assert.Equal(t, "appendix_4e", meta.ReportKind)
		assert.Equal(t, "BHP Group Limited", meta.Entity)

		// An FX-converted code: the rows' AUD label is not trusted, so no
		// P/E or P/B, while market cap (a price times a count) stands.
		assert.False(t, bhp.ValuationInputs.FXConverted, "fx_converted false on BHP's sync row")
		_, err = pool.Exec(ctx, `INSERT INTO stock_fundamentals_sync (stock_code, last_attempt_at, last_success_at, periods_loaded, last_outcome, fx_converted, native_currency)
			VALUES ('CBA', now(), now(), 1, 'loaded', true, NULL)`)
		require.NoError(t, err)
		cands, err = listStrategyCandidates(ctx, pool)
		require.NoError(t, err)
		cba = cands[1]
		require.NotNil(t, cba.ValuationInputs)
		assert.True(t, cba.ValuationInputs.FXConverted)
		strategies.PrepareCandidates(cands)
		assert.Nil(t, cands[1].Valuation.PERatio, "an FX-converted code gets no P/E")
		assert.Nil(t, cands[1].Valuation.PriceToBook)
		require.NotNil(t, cands[1].Valuation.MarketCap)
		assert.Equal(t, strategies.ValuationNoteNonAUD, cands[1].Valuation.Note)

		// A code the job has not measured since 000132 (no sync row) whose
		// vendor rows carry converted, fractional values is FX-converted, and
		// a single year with k 0.775 (a recent issuer) is no evidence either
		// way, never a CDI.
		_, err = pool.Exec(ctx, `INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, revenue, net_income, eps_basic, shares_outstanding, source)
			VALUES ('NZL', 'annual', '2026-03-31', 'AUD', 139609739.8266, 10000000.5, 0.129, 1e8, 'yahoo-timeseries')`)
		require.NoError(t, err)
		nzl, err := getFundamentalsExtras(ctx, pool, "NZL")
		require.NoError(t, err)
		require.NotNil(t, nzl)
		assert.True(t, nzl.Valuation.FXConverted)
		assert.Equal(t, int32(1), nzl.Valuation.KPeriods)
		assert.False(t, nzl.Valuation.KConsistent)
		assert.False(t, nzl.Valuation.KFarFromOne)
		assert.Equal(t, strategies.ValuationNoteNoShares, strategies.Valuate(10, *tp("2026-09-25"), &nzl.Valuation, nil).Note)

		// A digest built from metrics that quote the few-shot example is flagged.
		_, err = pool.Exec(ctx, `INSERT INTO financial_report_extractions (stock_code, report_url, report_title, report_date, metrics, digest, digest_confidence)
			VALUES ('BHP', 'https://asx/bhp-echo.pdf', 'Appendix 4E', '2026-08-20', $1::jsonb, 'Revenue $5,142m.', 0.9)`,
			migratedJSON(t, map[string]any{"revenue": map[string]any{"value_millions": "5142", "source_text": extractiontrust.OldFewShotTexts[0]}}))
		require.NoError(t, err)
		filing, err = getLatestFilingInputs(ctx, pool, "BHP")
		require.NoError(t, err)
		require.Len(t, filing.Candidates, 2)
		assert.True(t, filing.Candidates[0].FewShotEcho)
		assert.False(t, filing.Candidates[1].FewShotEcho)
	})
}

func fundamentalsTestDatabase(t *testing.T, ctx context.Context, adminURL string) *pgxpool.Pool {
	t.Helper()
	admin, err := pgx.Connect(ctx, adminURL)
	require.NoError(t, err, "connect to the disposable PostgreSQL server")
	name := fmt.Sprintf("fundamentals_api_test_%d", time.Now().UnixNano())
	_, err = admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()+" ENCODING 'UTF8' TEMPLATE template0")
	require.NoError(t, err)

	cfg, err := pgxpool.ParseConfig(adminURL)
	require.NoError(t, err)
	cfg.ConnConfig.Database = name
	// The store runs pgx in simple-protocol mode in prod (postgres.go); so
	// does this test.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(func() {
		pool.Close()
		if _, err := admin.Exec(ctx, "DROP DATABASE "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)"); err != nil {
			t.Logf("drop %s: %v", name, err)
		}
		_ = admin.Close(ctx)
	})
	return pool
}

// The relations the candidates and fundamentals reads join, as plain tables
// with the columns the reads name (the real ones are 000130's views and older
// tables).
const fundamentalsTestBaseSchema = `
CREATE TABLE "company-metadata" (
	stock_code varchar(50) UNIQUE, company_name text, industry text,
	logo_icon_gcs_url text, logo_gcs_url text, key_metrics jsonb
);
CREATE TABLE mv_screener_data (
	stock_code varchar(10), company_name text, industry text, logo_url text,
	short_pct numeric, days_to_cover numeric, avg_volume_20d numeric, market_cap numeric
);
CREATE TABLE mv_price_features (
	stock_code varchar(10), as_of date, close numeric(12,4), prev_close numeric,
	sma10 numeric, sma20 numeric, sma50 numeric, sma150 numeric, sma200 numeric, sma200_1m_ago numeric,
	high_52w numeric, low_52w numeric, pct_off_52w_high numeric, pct_above_52w_low numeric,
	volume bigint, avg_volume_50d numeric, volume_ratio_50d numeric, dollar_volume_20d numeric,
	base_high numeric, base_low numeric, base_depth_pct numeric, base_length_days int,
	breakout_recent boolean, breakout_date date,
	ret_1m_pct numeric, ret_3m_pct numeric, ret_6m_pct numeric, ret_12m_pct numeric,
	rs_3m_pct numeric, rs_6m_pct numeric, sessions_available int
);
CREATE TABLE stock_prices (stock_code varchar(10), date date, close numeric(12,4));
CREATE TABLE financial_report_extractions (
	id serial PRIMARY KEY, stock_code varchar(50) NOT NULL, report_url text NOT NULL UNIQUE,
	report_type varchar(50), report_title text, report_date date,
	metrics jsonb NOT NULL DEFAULT '{}', extracted_at timestamptz NOT NULL DEFAULT now(),
	digest text, digest_confidence double precision
);
`

const fundamentalsTestSeed = `
INSERT INTO "company-metadata" (stock_code, company_name, industry, key_metrics) VALUES
	('BHP', 'BHP GROUP LIMITED', 'Materials', '{}'),
	('CBA', 'COMMONWEALTH BANK OF AUSTRALIA.', 'Banks', '{}'),
	('XYZ', 'XYZ LIMITED', 'Capital Goods', '{}');
INSERT INTO mv_price_features (stock_code, as_of, close, sma200, dollar_volume_20d, sessions_available) VALUES
	('BHP', '2026-09-25', 45.10, 41, 2e8, 250),
	('CBA', '2026-09-25', 160, 150, 3e8, 250);
INSERT INTO stock_prices VALUES ('BHP', '2026-09-24', 44.9), ('BHP', '2026-09-25', 45.1), ('XYZ', '2026-09-25', 1.23);
INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, revenue, net_income, eps_basic, eps_diluted, free_cash_flow, shares_outstanding, source) VALUES
	('BHP', 'annual', '2025-06-30', 'USD', 5.6e10, 9.0e9, 1.77, 1.76, 6e9, 5.07e9, 'yahoo-timeseries'),
	('BHP', 'annual', '2026-06-30', 'USD', 5.5e10, 1.1e10, 2.17, 2.16, 9e9, 5.07e9, 'yahoo-timeseries'),
	('CBA', 'annual', '2026-06-30', 'AUD', 2.7e10, 1.0e10, 6.0, 5.95, NULL, 1.67e9, 'yahoo-timeseries');
INSERT INTO stock_fundamentals_sync (stock_code, last_attempt_at, last_success_at, periods_loaded) VALUES ('BHP', now(), now(), 2);
INSERT INTO financial_report_extractions (stock_code, report_url, report_title, report_date, digest, digest_confidence) VALUES
	('BHP', 'https://asx/bhp-4e.pdf', 'Appendix 4E and Annual Report', '2026-08-19', 'BHP lifted copper output.', 0.9);
REFRESH MATERIALIZED VIEW mv_fundamentals_growth;
`

// Stand-ins for migration 000132's objects, from the contract's column lists.
const fundamentalsTest132StandIns = `
ALTER TABLE stock_fundamentals
	ADD COLUMN gross_profit double precision, ADD COLUMN operating_income double precision,
	ADD COLUMN ebitda double precision, ADD COLUMN normalized_ebitda double precision,
	ADD COLUMN ebit double precision, ADD COLUMN interest_expense double precision,
	ADD COLUMN pretax_income double precision, ADD COLUMN tax_provision double precision,
	ADD COLUMN net_interest_income double precision, ADD COLUMN capital_expenditure double precision,
	ADD COLUMN dividends_paid double precision, ADD COLUMN share_buybacks double precision,
	ADD COLUMN total_assets double precision, ADD COLUMN total_liabilities double precision,
	ADD COLUMN total_equity double precision, ADD COLUMN cash_and_equivalents double precision,
	ADD COLUMN total_debt double precision, ADD COLUMN capital_lease_obligations double precision,
	ADD COLUMN net_debt double precision, ADD COLUMN current_assets double precision,
	ADD COLUMN current_liabilities double precision,
	ADD COLUMN field_sources jsonb NOT NULL DEFAULT '{}'::jsonb,
	ADD COLUMN source_document_url text, ADD COLUMN source_document_date date;
ALTER TABLE stock_fundamentals_sync
	ADD COLUMN last_outcome varchar(16), ADD COLUMN consecutive_empty smallint NOT NULL DEFAULT 0,
	ADD COLUMN median_k double precision, ADD COLUMN fx_converted boolean,
	ADD COLUMN native_currency varchar(8);
ALTER TABLE financial_report_extractions ADD COLUMN document_meta jsonb;

CREATE TABLE mv_fundamentals_growth_132 AS
	SELECT g.*, NULL::varchar(8) AS revenue_basis_source, NULL::varchar(8) AS eps_basis_source,
	       NULL::date AS revenue_latest_period_end, NULL::date AS revenue_prior_period_end
	FROM mv_fundamentals_growth g;
DROP MATERIALIZED VIEW mv_fundamentals_growth;
ALTER TABLE mv_fundamentals_growth_132 RENAME TO mv_fundamentals_growth;
UPDATE mv_fundamentals_growth
	SET revenue_basis_source = 'vendor', eps_basis_source = 'vendor',
	    revenue_latest_period_end = '2026-06-30', revenue_prior_period_end = '2025-06-30'
	WHERE stock_code = 'BHP';

CREATE TABLE mv_fundamentals_quality (
	stock_code varchar(10) PRIMARY KEY, basis_period_type varchar(8), basis_period_end date,
	currency varchar(8), source varchar(32), fetched_at timestamptz,
	revenue double precision, gross_profit double precision, operating_income double precision,
	ebitda double precision, normalized_ebitda double precision, ebit double precision,
	net_income double precision, operating_cash_flow double precision, operating_cash_flow_derived boolean,
	free_cash_flow double precision, capital_expenditure double precision, dividends_paid double precision,
	interest_expense double precision, shares_outstanding double precision,
	balance_period_end date, balance_period_type varchar(8), balance_currency varchar(8), balance_lag_months integer,
	total_assets double precision, total_assets_prior double precision, total_liabilities double precision,
	total_equity double precision, total_equity_prior double precision, cash_and_equivalents double precision,
	total_debt double precision, capital_lease_obligations double precision, net_debt double precision,
	current_assets double precision, current_liabilities double precision,
	gross_margin_pct double precision, operating_margin_pct double precision, net_margin_pct double precision,
	fcf_margin_pct double precision, fcf_conversion double precision, roe_pct double precision,
	roa_pct double precision, net_debt_to_ebitda double precision, net_debt_to_equity double precision,
	current_ratio double precision, interest_cover double precision, payout_ratio_pct double precision,
	statement_is_financial boolean
);
INSERT INTO mv_fundamentals_quality (stock_code, basis_period_type, basis_period_end, currency, source, fetched_at,
		revenue, net_income, free_cash_flow, ebitda, operating_income,
		balance_period_end, balance_period_type, balance_currency, balance_lag_months,
		total_equity, net_debt, net_margin_pct, roe_pct, fcf_conversion, statement_is_financial) VALUES
	('BHP', 'annual', '2026-06-30', 'USD', 'yahoo-timeseries', now(), 5.5e10, 1.1e10, 9e9, 2.6e10, 2.2e10,
		'2026-06-30', 'annual', 'USD', 0, 4.9e10, 1.1e10, 20, 22.5, 0.82, false),
	('CBA', 'annual', '2026-06-30', 'AUD', 'yahoo-timeseries', now(), 2.7e10, 1.0e10, NULL, NULL, NULL,
		'2026-06-30', 'annual', 'AUD', 0, 8e10, NULL, 37, 13, NULL, true);

UPDATE stock_fundamentals
	SET gross_profit = 3e10, total_equity = 4.9e10, net_interest_income = -1e9,
	    field_sources = '{"revenue": "markit-key-statistics", "junk": "x"}',
	    source_document_url = 'https://asx/bhp-4e.pdf', source_document_date = '2026-08-19'
	WHERE stock_code = 'BHP' AND period_end = '2026-06-30';
UPDATE stock_fundamentals_sync SET last_outcome = 'loaded', median_k = 1.0 WHERE stock_code = 'BHP';
UPDATE financial_report_extractions
	SET document_meta = '{"period_end": "2026-06-30", "period_type": "annual", "report_kind": "appendix_4e", "entity": "BHP Group Limited"}'
	WHERE stock_code = 'BHP';
`
