package stocklist

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

// The survivorship hole in the backfill's own universe (#576).
//
// Every stock list in this service described the PRESENT: the ASX CSV is
// current listings, company-metadata holds one row per current stock, and
// mv_stock_price_coverage is `SELECT ... FROM stock_prices GROUP BY
// stock_code` — codes that already have prices. Using the last of those as the
// backfill's universe closed a loop: a code had no prices because it was never
// fetched, and was never fetched because it had no prices. 936 of 1,941 codes
// sat inside it.
//
// `shorts` is the one list that is survivorship-free by construction, because
// it is append-only and dated.
func TestFetchHistoricalCodesIncludesDelisted(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		t.Skip("DATABASE_URL not set, skipping integration test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	require.NoError(t, err)
	defer pool.Close()

	const (
		delisted = "ZZGONE" // in the ASIC report, never priced
		priced   = "ZZHERE" // in the ASIC report and in stock_prices
	)
	cleanup := func() {
		for _, c := range []string{delisted, priced} {
			_, _ = pool.Exec(ctx, `DELETE FROM shorts WHERE "PRODUCT_CODE" = $1`, c)
			_, _ = pool.Exec(ctx, `DELETE FROM stock_prices WHERE stock_code = $1`, c)
		}
	}
	cleanup()
	t.Cleanup(cleanup)

	for _, c := range []string{delisted, priced} {
		_, err := pool.Exec(ctx, `
			INSERT INTO shorts ("DATE", "PRODUCT", "PRODUCT_CODE",
				"REPORTED_SHORT_POSITIONS", "TOTAL_PRODUCT_IN_ISSUE",
				"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS")
			VALUES ('2016-05-13'::date, $1 || ' ORDINARY FULLY PAID', $1, 1000, 100000, 1.0)`, c)
		require.NoError(t, err)
	}
	// Only one of them has ever been priced, which is what put the other beyond
	// the reach of every list the backfill used.
	_, err = pool.Exec(ctx, `
		INSERT INTO stock_prices (stock_code, date, close, volume)
		VALUES ($1, '2016-05-13'::date, 1.23, 5000)
		ON CONFLICT (stock_code, date) DO NOTHING`, priced)
	require.NoError(t, err)

	svc := &Service{db: pool}
	codes, err := svc.fetchHistoricalCodes(ctx)
	require.NoError(t, err)

	set := make(map[string]bool, len(codes))
	for _, c := range codes {
		set[c] = true
	}

	t.Run("a code with no price history is still in the universe", func(t *testing.T) {
		require.True(t, set[delisted],
			"%s is in the ASIC report and must be fetchable; excluding it is the bug", delisted)
	})

	t.Run("priced codes are not lost by widening", func(t *testing.T) {
		require.True(t, set[priced], "widening must be additive, not a replacement")
	})

	t.Run("the widened universe is not the priced universe", func(t *testing.T) {
		// The property that matters: the two lists must actually differ, or the
		// fix is a no-op dressed as a change. mv_stock_price_coverage is
		// derived from stock_prices, so a code with no prices could never
		// appear in it — and this one does appear here.
		require.False(t, hasPrices(ctx, t, pool, delisted),
			"the fixture is wrong if the supposedly unpriced code has prices")
		require.True(t, set[delisted],
			"a code absent from stock_prices must still reach the backfill")
	})

	t.Run("codes are returned sorted and unique", func(t *testing.T) {
		require.Len(t, set, len(codes), "fetchHistoricalCodes returned duplicates")
		for i := 1; i < len(codes); i++ {
			require.LessOrEqual(t, codes[i-1], codes[i], "codes must be sorted")
		}
	})
}

func hasPrices(ctx context.Context, t *testing.T, pool *pgxpool.Pool, code string) bool {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM stock_prices WHERE stock_code = $1`, code).Scan(&n))
	return n > 0
}
