package shorts

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// GetMarketByDate is the point-in-time universe, and the properties that make
// it usable for research are easy to break by accident: an INNER JOIN to
// metadata would delete delisted constituents, and reading size from
// company-metadata would attach today's numbers to a historical date.
func TestGetMarketByDateUniverse(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}
	dbURL := getTestDatabaseURL()
	if dbURL == "" {
		t.Skip("DATABASE_URL not set, skipping integration test")
	}

	pool := createTestPool(t, dbURL)
	defer pool.Close()
	store := &postgresStore{db: pool}

	var date string
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT MAX("DATE")::date::text FROM shorts`).Scan(&date))

	t.Run("includes constituents with no company metadata", func(t *testing.T) {
		// The join to company-metadata must be outward. A security that
		// delisted years ago may have no metadata row at all, and it is
		// precisely those names whose removal biases a backtest.
		var orphans int
		require.NoError(t, pool.QueryRow(context.Background(), `
			SELECT COUNT(*) FROM shorts s
			LEFT JOIN "company-metadata" m ON s."PRODUCT_CODE" = m.stock_code
			WHERE s."DATE"::date = $1::date AND m.stock_code IS NULL
			  AND s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0`,
			date).Scan(&orphans))

		stocks, total, err := store.GetMarketByDate(date, 5000, 0, false)
		require.NoError(t, err)
		require.Equal(t, total, len(stocks))

		var withoutIndustry int
		for _, s := range stocks {
			if s.Industry == "" {
				withoutIndustry++
			}
		}
		require.GreaterOrEqual(t, withoutIndustry, orphans,
			"every constituent lacking metadata must still be in the universe")
	})

	t.Run("include_zero widens the universe rather than reordering it", func(t *testing.T) {
		excluded, exTotal, err := store.GetMarketByDate(date, 5000, 0, false)
		require.NoError(t, err)
		included, incTotal, err := store.GetMarketByDate(date, 5000, 0, true)
		require.NoError(t, err)

		require.GreaterOrEqual(t, incTotal, exTotal,
			"including zero positions can only add constituents")

		// Everything in the narrow universe must still be in the wide one.
		wide := map[string]bool{}
		for _, s := range included {
			wide[s.ProductCode] = true
		}
		for _, s := range excluded {
			require.True(t, wide[s.ProductCode],
				"%s dropped out of the universe when zero positions were included", s.ProductCode)
		}
	})

	t.Run("size and liquidity are populated where prices exist", func(t *testing.T) {
		stocks, _, err := store.GetMarketByDate(date, 5000, 0, false)
		require.NoError(t, err)
		require.NotEmpty(t, stocks)

		var priced int
		for _, s := range stocks {
			if s.MarketCap > 0 {
				priced++
				// Market cap is close x shares on issue, so it cannot be
				// positive while its own denominator is not.
				require.Positive(t, s.TotalProductInIssue,
					"%s has a market cap with no shares on issue", s.ProductCode)
			}
			if s.AverageDailyValue_20D > 0 {
				require.NotEmpty(t, s.LiquidityBand,
					"%s has a traded value but no band", s.ProductCode)
			} else {
				require.Empty(t, s.LiquidityBand,
					"%s has no traded value, so its band must be unknown rather than micro", s.ProductCode)
			}
		}
		require.Positive(t, priced, "no constituent got a market cap — the price join is not working")
	})
}
