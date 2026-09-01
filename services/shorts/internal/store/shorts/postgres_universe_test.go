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

		stocks, total, err := store.GetMarketByDate(date, 5000, 0, false, false)
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
		excluded, exTotal, err := store.GetMarketByDate(date, 5000, 0, false, false)
		require.NoError(t, err)
		included, incTotal, err := store.GetMarketByDate(date, 5000, 0, true, false)
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
		stocks, _, err := store.GetMarketByDate(date, 5000, 0, false, false)
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

// list_top_shorts and the screener state that non-equity instruments are
// excluded, and they filter. GetMarketByDate returned everything, so the two
// surfaces answered "what is the ASX universe" differently and only one said
// so — discoverable only by noticing a warrant at 132% short (issue #563).
func TestGetMarketByDateOrdinaryOnly(t *testing.T) {
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

	all, _, err := store.GetMarketByDate(date, 5000, 0, true, false)
	require.NoError(t, err)
	ordinary, _, err := store.GetMarketByDate(date, 5000, 0, true, true)
	require.NoError(t, err)

	require.LessOrEqual(t, len(ordinary), len(all), "filtering can only remove constituents")

	t.Run("every row is labelled", func(t *testing.T) {
		for _, s := range all {
			require.NotEmpty(t, s.SecurityType,
				"%s has no security_type; a caller cannot tell it from an ordinary share", s.ProductCode)
		}
	})

	t.Run("the filtered universe is ordinary shares only", func(t *testing.T) {
		for _, s := range ordinary {
			require.Equal(t, "ordinary", s.SecurityType,
				"%s (%s) survived the ordinary-only filter", s.ProductCode, s.SecurityType)
		}
	})

	t.Run("nothing above 100% short survives the filter", func(t *testing.T) {
		// A position over 100% of shares on issue is the signature of a
		// non-ordinary instrument, and it is the symptom that exposed this.
		for _, s := range ordinary {
			require.LessOrEqual(t, s.PercentageShorted, float32(100),
				"%s reports %.2f%% short and was classified ordinary",
				s.ProductCode, s.PercentageShorted)
		}
	})
}

// A filter that is accepted and then not reflected in the count is worse than
// one that errors: the response looks filtered, so a contaminated universe
// reaches a cross-section with nothing at the call site to reveal it.
//
// Reported as #565. The classifier is Go, so SQL cannot filter — but the query
// still carried LIMIT/OFFSET and the COUNT was unfiltered, so totalCount
// described the whole universe (731) while the rows beside it were the filtered
// one (689), and a page was sliced before filtering rather than after.
func TestOrdinaryOnlyIsReflectedInTheCountAndThePage(t *testing.T) {
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

	all, allTotal, err := store.GetMarketByDate(date, 5000, 0, true, false)
	require.NoError(t, err)
	filtered, filteredTotal, err := store.GetMarketByDate(date, 5000, 0, true, true)
	require.NoError(t, err)

	t.Run("the count matches the rows it is returned with", func(t *testing.T) {
		require.Equal(t, len(all), allTotal, "unfiltered count must match unfiltered rows")
		require.Equal(t, len(filtered), filteredTotal,
			"filtered count must match filtered rows — a count describing a different set is the bug")
	})

	t.Run("the filtered count is smaller when there is anything to filter", func(t *testing.T) {
		nonOrdinary := 0
		for _, s := range all {
			if s.SecurityType != "ordinary" {
				nonOrdinary++
			}
		}
		if nonOrdinary == 0 {
			t.Skip("this dataset holds only ordinary lines; nothing to filter")
		}
		require.Equal(t, allTotal-nonOrdinary, filteredTotal,
			"every non-ordinary instrument must come out of the count")
	})

	t.Run("a page is sliced after filtering, not before", func(t *testing.T) {
		const page = 10
		if filteredTotal < page*2 {
			t.Skip("not enough filtered rows to page")
		}
		first, total, err := store.GetMarketByDate(date, page, 0, true, true)
		require.NoError(t, err)
		require.Len(t, first, page, "a full page must come back full, not short from post-filtering")
		require.Equal(t, filteredTotal, total, "the total must not change with the page size")

		second, _, err := store.GetMarketByDate(date, page, page, true, true)
		require.NoError(t, err)
		require.NotEmpty(t, second)

		// Offsets must not overlap or skip.
		require.Equal(t, filtered[page].ProductCode, second[0].ProductCode,
			"the second page must continue exactly where the first ended")
		for _, s := range append(first, second...) {
			require.Equal(t, "ordinary", s.SecurityType, "%s leaked through the filter", s.ProductCode)
		}
	})
}
