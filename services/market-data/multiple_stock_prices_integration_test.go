//go:build integration

package main

import (
	"context"
	"fmt"
	"testing"
	"time"

	"connectrpc.com/connect"
	marketdatav1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/marketdata/v1"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

// Keep the former query as an equivalence/performance baseline, not production
// code. Both queries must choose the latest strictly earlier date, even when
// that row's close is NULL or zero and an older positive close exists.
const previousMultipleStockPricesQuery = `
	WITH latest_prices AS (
		SELECT DISTINCT ON (stock_code)
			stock_code, date, open, high, low, close, volume, adjusted_close
		FROM stock_prices
		WHERE stock_code = ANY($1)
		ORDER BY stock_code, date DESC
	), prev_prices AS (
		SELECT DISTINCT ON (sp.stock_code) sp.stock_code, sp.close AS prev_close
		FROM stock_prices sp
		INNER JOIN latest_prices lp ON sp.stock_code = lp.stock_code
		WHERE sp.date < lp.date
		ORDER BY sp.stock_code, sp.date DESC
	)
	SELECT lp.stock_code, lp.date, lp.open, lp.high, lp.low, lp.close,
		lp.volume, lp.adjusted_close, pp.prev_close
	FROM latest_prices lp
	LEFT JOIN prev_prices pp ON lp.stock_code = pp.stock_code
`

func quoteTestPool(t testing.TB) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(GetTestDatabaseURL())
	require.NoError(t, err)
	schema := fmt.Sprintf("batch_quotes_%d", time.Now().UnixNano())
	config.ConnConfig.RuntimeParams["search_path"] = schema + ",public"
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	pool, err := pgxpool.NewWithConfig(ctx, config)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
		pool.Close()
	})
	_, err = pool.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize())
	require.NoError(t, err)
	// Include the existing unique symbol/date constraint and production indexes.
	_, err = pool.Exec(ctx, "CREATE TABLE stock_prices (LIKE public.stock_prices INCLUDING ALL)")
	require.NoError(t, err)
	return pool
}

func seedQuoteContract(t testing.TB, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO stock_prices (stock_code,date,open,high,low,close,volume,adjusted_close)
		VALUES
		('AAA','2026-09-25',80,80,80,80,1000,80),
		('AAA','2026-10-01',100,100,100,100,1000,100),
		('AAA','2026-10-02',120,120,120,120,1000,119),
		('AAB','2026-10-02',50,50,50,50,1000,NULL),
		('AAC','2026-09-30',10,10,10,10,1000,10),
		('AAC','2026-10-01',20,20,20,NULL,1000,20),
		('AAC','2026-10-02',30,30,30,30,1000,30),
		('AAD','2026-10-01',0,0,0,0,1000,0),
		('AAD','2026-10-02',20,20,20,20,1000,20),
		('AAE','2026-10-02',20,20,20,NULL,1000,20),
		('AAP','2026-09-25',50,50,50,50,1000,50),
		('AAP','2026-09-30',70,70,70,70,1000,70)
	`)
	require.NoError(t, err)
}

func requireQuoteQueryEquivalence(t testing.TB, pool *pgxpool.Pool, codes []string) {
	t.Helper()
	query := `WITH old_prices AS (` + previousMultipleStockPricesQuery + `),
		new_prices AS (` + multipleStockPricesQuery + `)
		SELECT COUNT(*) FROM (
			(TABLE old_prices EXCEPT ALL TABLE new_prices)
			UNION ALL
			(TABLE new_prices EXCEPT ALL TABLE old_prices)
		) differences`
	var differences int
	require.NoError(t, pool.QueryRow(context.Background(), query, codes).Scan(&differences))
	require.Zero(t, differences, "latest/previous query changed its SQL results")
}

func TestGetMultipleStockPricesContract(t *testing.T) {
	pool := quoteTestPool(t)
	seedQuoteContract(t, pool)
	service := &MarketDataService{db: pool}
	req := connect.NewRequest(&marketdatav1.GetMultipleStockPricesRequest{
		StockCodes: []string{" aaa ", "AAA", "aab", "AAC", "AAD", "AAP", "ZZZ"},
	})
	resp, err := service.GetMultipleStockPrices(context.Background(), req)
	require.NoError(t, err)
	require.Len(t, resp.Msg.Prices, 5)
	require.NotContains(t, resp.Msg.Prices, "ZZZ")

	for _, tc := range []struct {
		code, date                       string
		close, adjusted, change, percent float64
	}{
		{"AAA", "2026-10-02", 120, 119, 20, 20},
		{"AAB", "2026-10-02", 50, 50, 0, 0},
		{"AAC", "2026-10-02", 30, 30, 0, 0},
		{"AAD", "2026-10-02", 20, 20, 0, 0},
		{"AAP", "2026-09-30", 70, 70, 20, 40},
	} {
		t.Run(tc.code, func(t *testing.T) {
			price := resp.Msg.Prices[tc.code]
			require.NotNil(t, price)
			require.Equal(t, tc.date, price.Date.AsTime().Format("2006-01-02"))
			require.Equal(t, tc.close, price.Close)
			require.Equal(t, tc.adjusted, price.AdjustedClose)
			require.Equal(t, tc.change, price.Change)
			require.InDelta(t, tc.percent, price.ChangePercent, 0.000001)
		})
	}
	// Raw SQL equivalence includes malformed latest and nullable previous rows;
	// request normalization has already preserved duplicate ANY semantics.
	requireQuoteQueryEquivalence(t, pool, append(req.Msg.StockCodes, "AAE"))
}

func TestGetMultipleStockPricesMissingCoverage(t *testing.T) {
	pool := quoteTestPool(t)
	service := &MarketDataService{db: pool}
	resp, err := service.GetMultipleStockPrices(context.Background(), connect.NewRequest(
		&marketdatav1.GetMultipleStockPricesRequest{StockCodes: []string{"ZZZ", "ZZZ"}},
	))
	require.NoError(t, err)
	require.Empty(t, resp.Msg.Prices)
	requireQuoteQueryEquivalence(t, pool, []string{"ZZZ", "ZZZ"})
}

func TestGetMultipleStockPricesMalformedLatestIsError(t *testing.T) {
	pool := quoteTestPool(t)
	seedQuoteContract(t, pool)
	service := &MarketDataService{db: pool}
	resp, err := service.GetMultipleStockPrices(context.Background(), connect.NewRequest(
		&marketdatav1.GetMultipleStockPricesRequest{StockCodes: []string{"AAE"}},
	))
	require.Error(t, err)
	require.Equal(t, connect.CodeInternal, connect.CodeOf(err))
	require.Nil(t, resp)
}

func TestGetMultipleStockPricesCancellation(t *testing.T) {
	pool := quoteTestPool(t)
	seedQuoteContract(t, pool)
	service := &MarketDataService{db: pool}
	tx, err := pool.Begin(context.Background())
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(context.Background()) }()
	_, err = tx.Exec(context.Background(), "LOCK TABLE stock_prices IN ACCESS EXCLUSIVE MODE")
	require.NoError(t, err)

	// A blocked real query must return its deadline error, never a success map.
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	resp, err := service.GetMultipleStockPrices(ctx, connect.NewRequest(
		&marketdatav1.GetMultipleStockPricesRequest{StockCodes: []string{"AAA"}},
	))
	require.ErrorIs(t, err, context.DeadlineExceeded)
	require.Equal(t, connect.CodeInternal, connect.CodeOf(err))
	require.Nil(t, resp)
}
