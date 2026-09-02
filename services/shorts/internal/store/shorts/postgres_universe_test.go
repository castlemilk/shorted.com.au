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

// GetMarketByDate is a point-in-time universe, but its `industry` label was
// not point-in-time: it came from company-metadata, which holds one CURRENT row
// per stock. Ranking a 2014 cross-section by 2026 sector labels is lookahead —
// mild, but real, and previously invisible, because the field was returned with
// nothing to say which date it described (#557).
//
// History cannot be reconstructed, so the fix is not to invent past labels. It
// is to say which date the label actually describes, every time.
func TestIndustryLabelSaysWhereItCameFrom(t *testing.T) {
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

	var haveHistory bool
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT EXISTS (SELECT 1 FROM information_schema.tables
		 WHERE table_name = 'stock_industry_history')`).Scan(&haveHistory))
	if !haveHistory {
		t.Skip("stock_industry_history not present; migration 000118 has not been applied here")
	}

	var date string
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT MAX("DATE")::date::text FROM shorts`).Scan(&date))

	stocks, _, err := store.GetMarketByDate(date, 200, 0, true, false)
	require.NoError(t, err)
	require.NotEmpty(t, stocks)

	valid := map[string]bool{"observed": true, "seed": true, "current": true}

	t.Run("every row states its provenance", func(t *testing.T) {
		for _, s := range stocks {
			require.True(t, valid[s.IndustrySource],
				"%s has industry_source %q, which is not one of observed/seed/current",
				s.ProductCode, s.IndustrySource)
		}
	})

	t.Run("a dated label carries the date it was observed from", func(t *testing.T) {
		for _, s := range stocks {
			if s.IndustrySource == "current" {
				require.Empty(t, s.IndustryAsOf,
					"%s is today's label, so it cannot claim an as-of date", s.ProductCode)
				continue
			}
			require.NotEmpty(t, s.IndustryAsOf,
				"%s came from history but carries no as-of date", s.ProductCode)
			require.LessOrEqual(t, s.IndustryAsOf, date,
				"%s claims a label observed AFTER the date being asked about — that is lookahead",
				s.ProductCode)
		}
	})

	t.Run("a pre-capture date falls back to current, and says so", func(t *testing.T) {
		// Capture began recently, so nothing covers a historical cross-section.
		// The fallback is correct; being silent about it was the bug.
		var early string
		require.NoError(t, pool.QueryRow(context.Background(),
			`SELECT MIN("DATE")::date::text FROM shorts`).Scan(&early))

		var seeded string
		require.NoError(t, pool.QueryRow(context.Background(),
			`SELECT MIN(observed_from)::text FROM stock_industry_history`).Scan(&seeded))
		if early >= seeded {
			t.Skip("this dataset starts after capture began; no pre-capture date to test")
		}

		old, _, err := store.GetMarketByDate(early, 50, 0, true, false)
		require.NoError(t, err)
		require.NotEmpty(t, old)
		for _, s := range old {
			require.Equal(t, "current", s.IndustrySource,
				"%s claims a %q label for %s, before capture began", s.ProductCode, s.IndustrySource, early)
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

// A page must be exactly as long as it was asked for, and the whole universe
// must be reachable by paging through it.
//
// This is the property #577 reported violated: limit 100 returned 99, limit 500
// returned 497, and six names of a 553-row universe were unreachable at ANY
// page size. The cause was pagination happening in SQL while filtering happened
// in Go, so each page was sliced BEFORE the filter and lost roughly one row per
// hundred.
//
// That had already been fixed once, for #565, and was then reverted by a commit
// that rebuilt this package from a stale working tree — taking the guarding
// test with it, which is why nothing failed. This test exists so the property
// is asserted independently of the one it was bundled with.
func TestEveryConstituentIsReachableByPaging(t *testing.T) {
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

	for _, ordinaryOnly := range []bool{false, true} {
		name := "all instruments"
		if ordinaryOnly {
			name = "ordinary only"
		}
		t.Run(name, func(t *testing.T) {
			_, total, err := store.GetMarketByDate(date, 5000, 0, true, ordinaryOnly)
			require.NoError(t, err)
			require.Positive(t, total)

			t.Run("a full page is full", func(t *testing.T) {
				for _, limit := range []int32{10, 50, 100} {
					if int(limit) > total {
						continue
					}
					page, pageTotal, err := store.GetMarketByDate(date, limit, 0, true, ordinaryOnly)
					require.NoError(t, err)
					require.Len(t, page, int(limit),
						"limit=%d returned %d rows — a page shorter than its limit means rows are dropped after slicing",
						limit, len(page))
					require.Equal(t, total, pageTotal, "the total must not move with the page size")
				}
			})

			t.Run("paging reaches every constituent exactly once", func(t *testing.T) {
				const page = 100
				seen := map[string]int{}
				for offset := int32(0); int(offset) < total; offset += page {
					rows, _, err := store.GetMarketByDate(date, page, offset, true, ordinaryOnly)
					require.NoError(t, err)
					for _, s := range rows {
						seen[s.ProductCode]++
					}
				}
				require.Len(t, seen, total,
					"paged through %d distinct codes but the universe reports %d — %d unreachable",
					len(seen), total, total-len(seen))
				for code, n := range seen {
					require.Equal(t, 1, n, "%s appeared on %d pages", code, n)
				}
			})
		})
	}
}

// A survivorship-free universe whose price data is survivor-only is more
// dangerous than one biased in both, because the bias becomes invisible: the
// caller selects the delisted names correctly, then silently drops exactly the
// acquisitions and failures when returns are computed. A company taken over at
// a premium and one that went to zero are treated identically — as though the
// position never existed (#576).
//
// This does not fill the hole. It makes it measurable before a backtest runs.
func TestHasPriceHistoryMarksUnpriceableConstituents(t *testing.T) {
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

	stocks, _, err := store.GetMarketByDate(date, 5000, 0, true, false)
	require.NoError(t, err)
	require.NotEmpty(t, stocks)

	t.Run("the flag agrees with whether a price was actually found", func(t *testing.T) {
		// market_cap and the traded-value figures are derived from the same
		// price join, so they cannot be populated on a row the flag calls
		// unpriceable — that would be the flag lying about data it can see.
		for _, s := range stocks {
			if !s.HasPriceHistory {
				require.Zero(t, s.MarketCap,
					"%s is marked unpriceable yet carries a market cap", s.ProductCode)
				require.Zero(t, s.AverageDailyValue_20D,
					"%s is marked unpriceable yet carries a traded value", s.ProductCode)
			}
		}
	})

	t.Run("it is as-of the date, not lifetime", func(t *testing.T) {
		// A name priced only in some other era is NOT priceable in this
		// cross-section, and a lifetime flag would claim it was. Verify the
		// flag tracks the as-of price join by checking it against a direct
		// query for prices on or before the date.
		for _, s := range stocks {
			var priceableNow bool
			require.NoError(t, pool.QueryRow(context.Background(), `
				SELECT EXISTS (
					SELECT 1 FROM stock_prices
					WHERE stock_code = $1 AND date <= $2::date AND volume > 0
				)`, s.ProductCode, date).Scan(&priceableNow))
			require.Equal(t, priceableNow, s.HasPriceHistory,
				"%s: flag=%v but prices on/before %s exist=%v",
				s.ProductCode, s.HasPriceHistory, date, priceableNow)
		}
	})

	t.Run("the hole is measurable", func(t *testing.T) {
		unpriceable := 0
		for _, s := range stocks {
			if !s.HasPriceHistory {
				unpriceable++
			}
		}
		// Not an assertion about the number — it will move as prices are
		// ingested. The point is that a caller can now compute it at all,
		// which was the ask: measure the hole rather than discover it.
		t.Logf("%d of %d constituents cannot be priced as of %s (%.1f%%)",
			unpriceable, len(stocks), date, 100*float64(unpriceable)/float64(len(stocks)))
	})
}
