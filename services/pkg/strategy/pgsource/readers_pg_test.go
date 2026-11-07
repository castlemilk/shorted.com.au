package pgsource

import (
	"context"
	"fmt"
	"math"
	"math/rand"
	"testing"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// The reader scans run against a disposable server: PGSOURCE_TEST_DATABASE_URL,
// or a container with PGSOURCE_TESTCONTAINERS=1 under -tags=testcontainers.
// Each test gets its own database, which is dropped afterwards. Without a
// server the tests skip.
//
//	PGSOURCE_TEST_DATABASE_URL='postgres://postgres:pw@127.0.0.1:55432/postgres?sslmode=disable' \
//	  GOWORK=off go test -count=1 -run ReadersAgainstPostgres ./pkg/strategy/pgsource/

// readerSchema is the subset of the production tables the readers select from,
// with the production column names and types.
const readerSchema = `
CREATE TABLE stock_prices (
	stock_code VARCHAR(50) NOT NULL, date DATE NOT NULL,
	open NUMERIC(12,4), high NUMERIC(12,4), low NUMERIC(12,4), close NUMERIC(12,4),
	adjusted_close NUMERIC(12,4), volume BIGINT,
	PRIMARY KEY (stock_code, date));
CREATE TABLE index_prices (
	index_code VARCHAR(16) NOT NULL, date DATE NOT NULL,
	open DOUBLE PRECISION, high DOUBLE PRECISION, low DOUBLE PRECISION, close DOUBLE PRECISION,
	volume BIGINT, PRIMARY KEY (index_code, date));
CREATE TABLE shorts (
	"DATE" TIMESTAMP, "PRODUCT" TEXT, "PRODUCT_CODE" TEXT,
	"REPORTED_SHORT_POSITIONS" DOUBLE PRECISION, "TOTAL_PRODUCT_IN_ISSUE" DOUBLE PRECISION,
	"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DOUBLE PRECISION);
CREATE TABLE asic_report_ingests (
	report_date DATE PRIMARY KEY, file_rows INTEGER, loaded_rows INTEGER NOT NULL);
CREATE TABLE ownership_funds (fund_type TEXT NOT NULL, asx_code VARCHAR(10));
CREATE TABLE "company-metadata" (
	stock_code VARCHAR(50) UNIQUE NOT NULL, company_name VARCHAR(255), industry VARCHAR(255),
	logo_gcs_url TEXT, logo_icon_gcs_url TEXT, key_metrics JSONB);
CREATE TABLE dividend_history (
	stock_code VARCHAR(10) NOT NULL, ex_date DATE NOT NULL, amount_per_share DECIMAL(10, 6) NOT NULL,
	dividend_type VARCHAR(30) NOT NULL DEFAULT 'ordinary', UNIQUE (stock_code, ex_date, dividend_type));
CREATE TABLE economic_series (id BIGSERIAL PRIMARY KEY, series_key TEXT UNIQUE NOT NULL);
CREATE TABLE economic_observations (
	series_id BIGINT NOT NULL REFERENCES economic_series(id), period DATE NOT NULL, value DOUBLE PRECISION NOT NULL);
`

// readerDB returns a pool on a fresh database holding readerSchema.
func readerDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn, err := testpostgres.Admin("PGSOURCE_TEST_DATABASE_URL", "PGSOURCE_TESTCONTAINERS")
	require.NoError(t, err)
	if dsn == "" {
		t.Skip("set PGSOURCE_TEST_DATABASE_URL, or PGSOURCE_TESTCONTAINERS=1 with -tags=testcontainers")
	}
	ctx := context.Background()
	name := fmt.Sprintf("pgsrc_%d_%d", time.Now().UnixNano()%1e9, rand.Intn(1e6))

	admin, err := pgxpool.New(ctx, dsn)
	require.NoError(t, err)
	_, err = admin.Exec(ctx, "CREATE DATABASE "+name)
	require.NoError(t, err)
	t.Cleanup(func() {
		admin.Close()
		cleanup, err := pgxpool.New(context.Background(), dsn)
		if err != nil {
			return
		}
		defer cleanup.Close()
		_, _ = cleanup.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
	})

	cfg, err := pgxpool.ParseConfig(dsn)
	require.NoError(t, err)
	cfg.ConnConfig.Database = name
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	_, err = pool.Exec(ctx, readerSchema)
	require.NoError(t, err)
	return pool
}

func d(y int, m time.Month, day int) civil.Date { return civil.Date{Year: y, Month: m, Day: day} }

func TestReadersAgainstPostgres(t *testing.T) {
	pool := readerDB(t)
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err, sql)
	}

	t.Run("bars are per code, ordered, unfiltered, with NULLs as NaN", func(t *testing.T) {
		exec(`INSERT INTO stock_prices VALUES
			('BHP', '2026-01-05', 10, 11, 9, 10.5, 10.5, 1000),
			('BHP', '2026-01-02', 9, 10, 8, 9.5, 9.5, NULL),
			('BHP', '2026-01-06', NULL, NULL, NULL, 0, NULL, 5),
			('CBA', '2026-01-02', 1, 1, 1, 1, 1, 1)`)
		bars, err := Bars(ctx, pool, "BHP", d(2026, 1, 1), d(2026, 1, 31))
		require.NoError(t, err)
		require.Len(t, bars, 3, "CBA's bars are not BHP's")
		require.Equal(t, d(2026, 1, 2), bars[0].Date)
		require.Equal(t, 0.0, bars[0].Volume, "a NULL volume reads as zero")
		require.Equal(t, d(2026, 1, 5), bars[1].Date)
		require.Equal(t, 10.5, bars[1].Close)
		require.True(t, math.IsNaN(bars[2].Open), "a NULL open is NaN, not zero")
		require.Equal(t, 0.0, bars[2].Close, "an unpriced close stays in the rows: features drop it")

		inRange, err := Bars(ctx, pool, "BHP", d(2026, 1, 5), d(2026, 1, 5))
		require.NoError(t, err)
		require.Len(t, inRange, 1, "the range is inclusive on both ends")
	})

	t.Run("index bars are read per index", func(t *testing.T) {
		exec(`INSERT INTO index_prices (index_code, date, high, low, close) VALUES
			('XJO', '2026-01-02', 8000, 7900, 7950), ('XJO', '2026-01-05', NULL, NULL, 8010),
			('XJT', '2026-01-02', 1, 1, 1)`)
		bars, err := IndexBars(ctx, pool, "XJO", d(2026, 1, 1), d(2026, 1, 31))
		require.NoError(t, err)
		require.Len(t, bars, 2)
		require.Equal(t, 7950.0, bars[0].Close)
		require.True(t, math.IsNaN(bars[1].High))
		none, err := IndexBars(ctx, pool, "NOPE", d(2026, 1, 1), d(2026, 1, 31))
		require.NoError(t, err)
		require.Empty(t, none)
	})

	t.Run("ASIC rows keep zero rows, drop a NULL code, and keep a NULL percentage nil", func(t *testing.T) {
		exec(`INSERT INTO shorts ("DATE", "PRODUCT", "PRODUCT_CODE", "REPORTED_SHORT_POSITIONS", "TOTAL_PRODUCT_IN_ISSUE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS") VALUES
			('2026-01-02', 'BHP GROUP LIMITED', 'BHP', 1000, 2000, 5.0),
			('2026-01-02', 'CBA', 'CBA', 0, 2000, 0),
			('2026-01-02', 'NO CODE', NULL, 1, 1, 1),
			('2026-01-02', 'XYZ', 'XYZ', NULL, 500, NULL),
			('2025-06-01', 'OLD', 'OLD', 1, 1, 1)`)
		rows, err := ASICRows(ctx, pool, d(2026, 1, 1), d(2026, 1, 31))
		require.NoError(t, err)
		require.Len(t, rows, 3, "one report date in range: BHP, CBA and XYZ; the NULL code and 2025 are out")
		require.Equal(t, "BHP", rows[0].Code)
		require.Equal(t, 1000.0, rows[0].Positions)
		require.NotNil(t, rows[0].Percent)
		require.Equal(t, 0.0, rows[1].Positions, "a zero row is kept")
		require.Nil(t, rows[2].Percent, "a NULL percentage stays nil")
	})

	t.Run("report ingests carry the recorded file size, nil when unrecorded", func(t *testing.T) {
		exec(`INSERT INTO asic_report_ingests VALUES ('2026-01-02', 2000, 1990), ('2026-01-05', NULL, 1500)`)
		ings, err := ReportIngests(ctx, pool, d(2026, 1, 1), d(2026, 1, 31))
		require.NoError(t, err)
		require.Len(t, ings, 2)
		require.NotNil(t, ings[0].FileRows)
		require.Equal(t, 2000, *ings[0].FileRows)
		require.Nil(t, ings[1].FileRows)
		require.Equal(t, 1500, ings[1].LoadedRows)
	})

	t.Run("the ETP set is upper-case ETF and LIC codes", func(t *testing.T) {
		exec(`INSERT INTO ownership_funds VALUES ('etf', 'vas'), ('lic', 'ARG'), ('manager', 'BHP'), ('etf', NULL)`)
		set, err := ETPSet(ctx, pool)
		require.NoError(t, err)
		require.Equal(t, map[string]bool{"VAS": true, "ARG": true}, set)
	})

	t.Run("company names skip empty names and key on the upper-case code", func(t *testing.T) {
		exec(`INSERT INTO "company-metadata" (stock_code, company_name) VALUES ('bhp', 'BHP Group Limited'), ('XYZ', ''), ('CBA', 'Commonwealth Bank')`)
		names, err := CompanyNames(ctx, pool)
		require.NoError(t, err)
		require.Equal(t, "BHP Group Limited", names["BHP"])
		require.Equal(t, "Commonwealth Bank", names["CBA"])
		_, empty := names["XYZ"]
		require.False(t, empty)
	})

	t.Run("metadata keys on the upper-case code, prefers the icon logo, and guards the market cap", func(t *testing.T) {
		exec(`INSERT INTO "company-metadata" (stock_code, company_name, industry, logo_gcs_url, logo_icon_gcs_url, key_metrics) VALUES
			('META', 'Meta Alpha Ltd', 'Materials', 'https://x/full.png', NULL, '{"market_cap": 1234567.5}'),
			('METB', 'Meta Beta Ltd', NULL, 'https://x/full.png', 'https://x/icon.png', '{"market_cap": "9e999"}'),
			('metc', 'Meta Gamma Ltd', '', NULL, NULL, '{"market_cap": "1111111111111111111111111111111111111111"}'),
			('METD', 'Meta Delta Ltd', 'Energy', NULL, NULL, '{"market_cap": "NaN"}')`)
		meta, err := Metadata(ctx, pool)
		require.NoError(t, err, "an exponent, a long number and NaN are withheld in SQL, never a cast error")
		require.Equal(t, CompanyMeta{Name: "Meta Alpha Ltd", Industry: "Materials", LogoURL: "https://x/full.png",
			MarketCap: new(1234567.5)}, meta["META"])
		require.Equal(t, "", meta["METB"].Industry, "a NULL industry reads as empty")
		require.Equal(t, "https://x/icon.png", meta["METB"].LogoURL, "the icon logo is preferred")
		require.Nil(t, meta["METB"].MarketCap, "an exponent form is withheld")
		require.Equal(t, "Meta Gamma Ltd", meta["METC"].Name, "a lower-case code is keyed upper case")
		require.Nil(t, meta["METC"].MarketCap, "more than 15 whole digits is withheld")
		require.Nil(t, meta["METD"].MarketCap, "NaN is withheld")
	})

	t.Run("dividends come from the first ex-date on, per code, in ex-date order", func(t *testing.T) {
		exec(`INSERT INTO dividend_history (stock_code, ex_date, amount_per_share) VALUES
			('BHP', '2025-03-01', 0.50), ('BHP', '2024-08-01', 0.40), ('BHP', '2024-09-10', 0.99), ('CBA', '2025-06-01', 2.00)`)
		divs, err := Dividends(ctx, pool, DividendsFrom)
		require.NoError(t, err)
		require.Len(t, divs["BHP"], 1, "the 2024-08-01 and 2024-09-10 ex-dates are before the read starts")
		require.Equal(t, d(2025, 3, 1), divs["BHP"][0].ExDate)
		require.Equal(t, 0.5, divs["BHP"][0].AmountPerShare)
		require.Len(t, divs["CBA"], 1)
	})

	t.Run("dividends that share an ex-date come back in one fixed order, after a no-op upsert too", func(t *testing.T) {
		exec(`INSERT INTO dividend_history (stock_code, ex_date, amount_per_share, dividend_type) VALUES
			('TIE', '2025-06-01', 0.20, 'special'), ('TIE', '2025-06-01', 0.50, 'final')`)
		first, err := Dividends(ctx, pool, DividendsFrom)
		require.NoError(t, err)
		require.Equal(t, []float64{0.5, 0.2}, []float64{first["TIE"][0].AmountPerShare, first["TIE"][1].AmountPerShare},
			"final sorts before special")
		// The notice pass upserts the same figure: the row moves in the heap, and
		// the read must not follow it.
		exec(`UPDATE dividend_history SET amount_per_share = amount_per_share WHERE stock_code = 'TIE' AND dividend_type = 'special'`)
		again, err := Dividends(ctx, pool, DividendsFrom)
		require.NoError(t, err)
		require.Equal(t, first["TIE"], again["TIE"])
	})

	t.Run("the cash rate is monthly, each month carrying the rate set before it", func(t *testing.T) {
		exec(`INSERT INTO economic_series (series_key) VALUES ('rates.cash_rate_target.aus'), ('other')`)
		// RBA periods are dated at month end, so each rate is first known after
		// its own month's first day.
		exec(`INSERT INTO economic_observations (series_id, period, value)
			SELECT id, '2026-01-31'::date, 4.35 FROM economic_series WHERE series_key = 'rates.cash_rate_target.aus'
			UNION ALL SELECT id, '2026-03-31'::date, 4.10 FROM economic_series WHERE series_key = 'rates.cash_rate_target.aus'
			UNION ALL SELECT id, '2026-03-01'::date, 9.99 FROM economic_series WHERE series_key = 'other'`)
		rates, err := CashRate(ctx, pool, d(2026, 4, 15))
		require.NoError(t, err)
		require.Len(t, rates, 3, "February to April: January's rate first applies in February")
		require.Equal(t, d(2026, 2, 1), rates[0].Date)
		require.Equal(t, 4.35, rates[0].Rate)
		require.Equal(t, 4.35, rates[1].Rate, "March carries the rate set before March, not its month-end figure")
		require.Equal(t, 4.10, rates[2].Rate, "April takes the March-end rate")
	})
}

// Fundamentals reads the growth view and the extras. These views come from
// migrations 000129 to 000132, which the store's real-migration suite applies;
// this suite checks only that the reader keys the body by code and survives
// an empty database.
func TestFundamentalsEmptyDatabase(t *testing.T) {
	pool := readerDB(t)
	f, err := Fundamentals(context.Background(), pool)
	require.NoError(t, err)
	require.Empty(t, f, "no views: an empty universe, not an error")
}

// NaN is not a value, so it must never appear in a candidate's numbers.
func TestNanOr(t *testing.T) {
	require.True(t, math.IsNaN(nanOr(nil)))
	v := 2.5
	require.Equal(t, 2.5, nanOr(&v))
}
