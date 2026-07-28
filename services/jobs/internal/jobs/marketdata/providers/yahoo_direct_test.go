//go:build integration
// +build integration

package providers

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestYahooFinanceDirectProvider_Integration(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	provider := NewYahooFinanceDirectProvider()
	ctx := context.Background()

	t.Run("provider_name", func(t *testing.T) {
		assert.Equal(t, "Yahoo Finance (Direct)", provider.Name())
	})

	t.Run("rate_limit", func(t *testing.T) {
		assert.Equal(t, 2*time.Second, provider.GetRateLimit())
	})

	t.Run("fetch_bhp_ax_recent_data", func(t *testing.T) {
		// Test with BHP.AX - a major ASX stock that should have data
		startDate := time.Now().AddDate(0, 0, -30) // Last 30 days
		endDate := time.Now()

		records, err := provider.FetchHistoricalData(ctx, "BHP", startDate, endDate)

		require.NoError(t, err, "Yahoo Finance Direct should return data for BHP")
		assert.Greater(t, len(records), 0, "Should return at least one record")

		// Validate record structure
		for i, record := range records {
			assert.Equal(t, "BHP", record.StockCode, "Record %d should have correct stock code", i)
			assert.False(t, record.Date.IsZero(), "Record %d should have a valid date", i)
			assert.Greater(t, record.Close, 0.0, "Record %d should have a positive close price", i)
			assert.GreaterOrEqual(t, record.Volume, int64(0), "Record %d should have non-negative volume", i)
			assert.GreaterOrEqual(t, record.High, record.Low, "Record %d should have high >= low", i)
			assert.GreaterOrEqual(t, record.Close, record.Low, "Record %d should have close >= low", i)
			assert.LessOrEqual(t, record.Close, record.High, "Record %d should have close <= high", i)
		}

		t.Logf("✅ Successfully fetched %d records for BHP", len(records))
	})

	t.Run("fetch_cba_ax_recent_data", func(t *testing.T) {
		// Test with CBA.AX - another major ASX stock
		startDate := time.Now().AddDate(0, 0, -7) // Last 7 days
		endDate := time.Now()

		records, err := provider.FetchHistoricalData(ctx, "CBA", startDate, endDate)

		require.NoError(t, err, "Yahoo Finance Direct should return data for CBA")
		assert.Greater(t, len(records), 0, "Should return at least one record")
		t.Logf("✅ Successfully fetched %d records for CBA", len(records))
	})

	t.Run("fetch_with_ax_suffix", func(t *testing.T) {
		// Test that .AX suffix is handled correctly
		startDate := time.Now().AddDate(0, 0, -7)
		endDate := time.Now()

		records, err := provider.FetchHistoricalData(ctx, "BHP.AX", startDate, endDate)

		require.NoError(t, err)
		assert.Greater(t, len(records), 0)
		t.Logf("✅ Successfully fetched %d records for BHP.AX", len(records))
	})

	t.Run("fetch_longer_date_range", func(t *testing.T) {
		// Test with a longer date range (1 year)
		startDate := time.Now().AddDate(-1, 0, 0)
		endDate := time.Now()

		records, err := provider.FetchHistoricalData(ctx, "BHP", startDate, endDate)

		require.NoError(t, err)
		assert.Greater(t, len(records), 0)
		// Should have approximately 250 trading days in a year
		assert.Greater(t, len(records), 200, "Should have substantial data for 1 year range")
		t.Logf("✅ Successfully fetched %d records for 1 year range", len(records))
	})

	t.Run("fetch_multiple_stocks", func(t *testing.T) {
		// Test multiple ASX stocks
		testStocks := []string{"BHP", "CBA", "ANZ", "WBC", "NAB"}

		for _, symbol := range testStocks {
			t.Run(symbol, func(t *testing.T) {
				startDate := time.Now().AddDate(0, 0, -7)
				endDate := time.Now()

				records, err := provider.FetchHistoricalData(ctx, symbol, startDate, endDate)

				require.NoError(t, err, "Should fetch data for %s", symbol)
				assert.Greater(t, len(records), 0, "Should return records for %s", symbol)
				t.Logf("✅ %s: %d records", symbol, len(records))

				// Small delay to avoid rate limiting
				time.Sleep(provider.GetRateLimit())
			})
		}
	})

	t.Run("date_range_filtering", func(t *testing.T) {
		// Test that date range filtering works correctly
		startDate := time.Now().AddDate(0, 0, -10)
		endDate := time.Now().AddDate(0, 0, -5) // Only last 5-10 days

		records, err := provider.FetchHistoricalData(ctx, "BHP", startDate, endDate)

		require.NoError(t, err)
		if len(records) > 0 {
			// All records should be within the date range
			for _, record := range records {
				assert.False(t, record.Date.Before(startDate), "Record date should not be before start date")
				assert.False(t, record.Date.After(endDate), "Record date should not be after end date")
			}
			t.Logf("✅ Date filtering works: %d records in range", len(records))
		}
	})
}
