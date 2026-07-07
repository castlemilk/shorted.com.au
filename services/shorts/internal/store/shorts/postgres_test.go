package shorts

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// Commented out as it's currently not being used
// func setupPostgresStore() Store {
// 	// Assuming you have a function to set env variables for local testing
// 	return newPostgresStore(DefaultPostgresConfig())
// }

func TestPostgresPoolSettingsFromEnv(t *testing.T) {
	t.Run("defaults keep per-instance pool conservative", func(t *testing.T) {
		t.Setenv("SHORTS_DB_MAX_CONNS", "")
		t.Setenv("SHORTS_DB_MIN_CONNS", "")

		settings := postgresPoolSettingsFromEnv()

		require.EqualValues(t, 3, settings.maxConns)
		require.EqualValues(t, 0, settings.minConns)
	})

	t.Run("valid env overrides are applied", func(t *testing.T) {
		t.Setenv("SHORTS_DB_MAX_CONNS", "5")
		t.Setenv("SHORTS_DB_MIN_CONNS", "1")

		settings := postgresPoolSettingsFromEnv()

		require.EqualValues(t, 5, settings.maxConns)
		require.EqualValues(t, 1, settings.minConns)
	})

	t.Run("min connections never exceed max connections", func(t *testing.T) {
		t.Setenv("SHORTS_DB_MAX_CONNS", "2")
		t.Setenv("SHORTS_DB_MIN_CONNS", "8")

		settings := postgresPoolSettingsFromEnv()

		require.EqualValues(t, 2, settings.maxConns)
		require.EqualValues(t, 2, settings.minConns)
	})
}

func TestSearchStocksQueryAvoidsFullDistinctStockPricesScan(t *testing.T) {
	require.NotContains(t, searchStocksQuery, "SELECT DISTINCT stock_code")
	require.NotContains(t, searchStocksQuery, "INNER JOIN valid_stocks")
	require.Contains(t, searchStocksQuery, "EXISTS (")
	require.Contains(t, searchStocksQuery, "FROM stock_prices p")
	require.Contains(t, searchStocksQuery, `p.stock_code = s."PRODUCT_CODE"`)
}
