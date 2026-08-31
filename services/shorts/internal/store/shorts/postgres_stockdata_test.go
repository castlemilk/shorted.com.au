package shorts

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// GetStockData used to take (productCode, period) and always bucket the long
// windows, with no way to ask for the stored record and no way to name a
// window. It also returned only the percent — while the share COUNT and the
// shares-on-issue denominator behind it sit on the same row, 100% populated.
func TestGetStockDataQueryOptions(t *testing.T) {
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

	// A code with a decent run of observations, chosen from the data rather
	// than hardcoded, so this works against any seeded database.
	var code string
	var observations int
	require.NoError(t, pool.QueryRow(context.Background(), `
		SELECT "PRODUCT_CODE", COUNT(*) AS n
		FROM shorts
		WHERE "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" IS NOT NULL
		GROUP BY "PRODUCT_CODE" ORDER BY n DESC LIMIT 1`).Scan(&code, &observations))
	if observations < 10 {
		t.Skip("not enough seeded observations for a meaningful series")
	}

	t.Run("full resolution returns every stored observation", func(t *testing.T) {
		got, err := store.GetStockData(StockDataQuery{
			ProductCode: code, Period: "MAX", FullResolution: true,
		})
		require.NoError(t, err)
		require.Equal(t, observations, len(got.Points),
			"full resolution must return the complete stored record")
		require.Equal(t, int32(observations), got.TotalObservations)
		require.False(t, got.Downsampled, "nothing was dropped, so downsampled must be false")
	})

	t.Run("total_observations counts raw rows, not buckets", func(t *testing.T) {
		// The bucketed path returns at most one point per bucket, but
		// total_observations must still describe the underlying record — that
		// is the number a caller uses to decide whether the series is complete.
		got, err := store.GetStockData(StockDataQuery{ProductCode: code, Period: "MAX"})
		require.NoError(t, err)
		require.Equal(t, int32(observations), got.TotalObservations)
	})

	t.Run("max_points caps the series and reports that it did", func(t *testing.T) {
		const cap = 5
		got, err := store.GetStockData(StockDataQuery{
			ProductCode: code, Period: "MAX", FullResolution: true, MaxPoints: cap,
		})
		require.NoError(t, err)
		require.Len(t, got.Points, cap)
		require.True(t, got.Downsampled, "a capped series is downsampled")
		require.Equal(t, int32(observations), got.TotalObservations,
			"the cap must not change the reported total")
	})

	t.Run("every point carries the raw count and its denominator", func(t *testing.T) {
		got, err := store.GetStockData(StockDataQuery{
			ProductCode: code, Period: "MAX", FullResolution: true,
		})
		require.NoError(t, err)
		require.NotEmpty(t, got.Points)
		for _, p := range got.Points {
			require.Positive(t, p.ReportedShortPositions,
				"reported_short_positions is a share count and is populated on every row")
			require.Positive(t, p.TotalProductInIssue,
				"total_product_in_issue is the percent's denominator and is populated on every row")
		}
	})

	t.Run("an explicit window narrows the series", func(t *testing.T) {
		full, err := store.GetStockData(StockDataQuery{
			ProductCode: code, Period: "MAX", FullResolution: true,
		})
		require.NoError(t, err)
		require.Greater(t, len(full.Points), 2)

		// Ask for a window ending at the midpoint observation.
		mid := full.Points[len(full.Points)/2].Timestamp.AsTime().Format("2006-01-02")
		windowed, err := store.GetStockData(StockDataQuery{
			ProductCode: code, To: mid, FullResolution: true,
		})
		require.NoError(t, err)
		require.Less(t, len(windowed.Points), len(full.Points),
			"a bounded window must return fewer observations than the whole series")
		require.NotEmpty(t, windowed.Points)
		last := windowed.Points[len(windowed.Points)-1].Timestamp.AsTime().Format("2006-01-02")
		require.LessOrEqual(t, last, mid, "no observation may fall after the window's end")
	})

	t.Run("an empty result is empty, not nil", func(t *testing.T) {
		got, err := store.GetStockData(StockDataQuery{ProductCode: "ZZZZ", Period: "MAX"})
		require.NoError(t, err)
		require.NotNil(t, got.Points)
		require.Empty(t, got.Points)
		require.Zero(t, got.TotalObservations)
		require.False(t, got.Downsampled)
	})
}
