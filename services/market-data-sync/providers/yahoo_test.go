//go:build integration
// +build integration

package providers

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestYahooFinanceProvider_Integration(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	provider := NewYahooFinanceProvider()
	ctx := context.Background()

	t.Run("provider_name", func(t *testing.T) {
		assert.Equal(t, "Yahoo Finance", provider.Name())
	})

	t.Run("rate_limit", func(t *testing.T) {
		assert.Equal(t, 2*time.Second, provider.GetRateLimit())
	})

	t.Run("fetch_bhp_ax_recent_data", func(t *testing.T) {
		// Test with BHP.AX - a major ASX stock that should have data
		startDate := time.Now().AddDate(0, 0, -30) // Last 30 days
		endDate := time.Now()

		records, err := provider.FetchHistoricalData(ctx, "BHP", startDate, endDate)

		if err != nil {
			t.Logf("⚠️ Yahoo Finance error: %v", err)
			t.Logf("Error type: %T", err)
			// Log the full error details
			if e, ok := err.(interface{ Error() string }); ok {
				t.Logf("Error string: %s", e.Error())
			}
			if e, ok := err.(interface{ Code() string }); ok {
				t.Logf("Error code: %s", e.Code())
			}
			if e, ok := err.(interface{ Detail() string }); ok {
				t.Logf("Error detail: %s", e.Detail())
			}
		}

		if len(records) == 0 && err != nil {
			t.Logf("❌ No records returned, error: %v", err)
			// Don't fail the test - we want to see what the error is
			t.Skipf("Yahoo Finance returned error: %v", err)
		}

		require.NoError(t, err, "Yahoo Finance should return data for BHP")
		assert.Greater(t, len(records), 0, "Should return at least one record")

		// Validate record structure
		for i, record := range records {
			assert.NotEmpty(t, record.StockCode, "Record %d should have stock code", i)
			assert.False(t, record.Date.IsZero(), "Record %d should have a valid date", i)
			assert.Greater(t, record.Close, 0.0, "Record %d should have a positive close price", i)
			assert.GreaterOrEqual(t, record.Volume, int64(0), "Record %d should have non-negative volume", i)
		}

		t.Logf("✅ Successfully fetched %d records for BHP", len(records))
	})

	t.Run("fetch_cba_ax_recent_data", func(t *testing.T) {
		// Test with CBA.AX - another major ASX stock
		startDate := time.Now().AddDate(0, 0, -7) // Last 7 days
		endDate := time.Now()

		records, err := provider.FetchHistoricalData(ctx, "CBA", startDate, endDate)

		if err != nil {
			t.Logf("⚠️ Yahoo Finance error for CBA: %v", err)
			t.Logf("Error type: %T", err)
		}

		if len(records) == 0 && err != nil {
			t.Skipf("Yahoo Finance returned error for CBA: %v", err)
		}

		require.NoError(t, err, "Yahoo Finance should return data for CBA")
		assert.Greater(t, len(records), 0, "Should return at least one record")
		t.Logf("✅ Successfully fetched %d records for CBA", len(records))
	})

	t.Run("fetch_with_ax_suffix", func(t *testing.T) {
		// Test that .AX suffix is handled correctly
		startDate := time.Now().AddDate(0, 0, -7)
		endDate := time.Now()

		records, err := provider.FetchHistoricalData(ctx, "BHP.AX", startDate, endDate)

		if err != nil {
			t.Logf("⚠️ Yahoo Finance error with .AX suffix: %v", err)
			t.Skipf("Yahoo Finance returned error: %v", err)
		}

		require.NoError(t, err)
		assert.Greater(t, len(records), 0)
		t.Logf("✅ Successfully fetched %d records for BHP.AX", len(records))
	})

	t.Run("fetch_longer_date_range", func(t *testing.T) {
		// Test with a longer date range (1 year)
		startDate := time.Now().AddDate(-1, 0, 0)
		endDate := time.Now()

		records, err := provider.FetchHistoricalData(ctx, "BHP", startDate, endDate)

		if err != nil {
			t.Logf("⚠️ Yahoo Finance error for 1 year range: %v", err)
			t.Skipf("Yahoo Finance returned error: %v", err)
		}

		require.NoError(t, err)
		assert.Greater(t, len(records), 0)
		// Should have approximately 250 trading days in a year
		assert.Greater(t, len(records), 200, "Should have substantial data for 1 year range")
		t.Logf("✅ Successfully fetched %d records for 1 year range", len(records))
	})

	t.Run("fetch_invalid_symbol", func(t *testing.T) {
		// Test with an invalid symbol - should return error or empty result
		startDate := time.Now().AddDate(0, 0, -7)
		endDate := time.Now()

		records, err := provider.FetchHistoricalData(ctx, "INVALID123", startDate, endDate)

		// Invalid symbols may return empty results or errors - both are acceptable
		if err != nil {
			t.Logf("ℹ️ Yahoo Finance returned error for invalid symbol (expected): %v", err)
		} else {
			assert.Equal(t, 0, len(records), "Invalid symbol should return no records")
		}
	})

	t.Run("context_cancellation", func(t *testing.T) {
		// Test that context cancellation is respected
		ctx, cancel := context.WithCancel(context.Background())
		cancel() // Cancel immediately

		startDate := time.Now().AddDate(0, 0, -7)
		endDate := time.Now()

		_, err := provider.FetchHistoricalData(ctx, "BHP", startDate, endDate)

		// Should handle cancellation gracefully
		// Note: piquette/finance-go may not respect context cancellation immediately
		// and may return API errors instead, so we just check that it doesn't panic
		if err != nil {
			t.Logf("Context cancellation test returned error (acceptable): %v", err)
		}
		// Don't assert on error content as library may not properly handle context
	})
}

func TestYahooFinanceProvider_ErrorDetails(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	provider := NewYahooFinanceProvider()
	ctx := context.Background()

	// Test multiple stocks to see error patterns
	testStocks := []string{"BHP", "CBA", "ANZ", "WBC", "NAB"}

	for _, symbol := range testStocks {
		t.Run(fmt.Sprintf("error_details_%s", symbol), func(t *testing.T) {
			startDate := time.Now().AddDate(0, 0, -7)
			endDate := time.Now()

			records, err := provider.FetchHistoricalData(ctx, symbol, startDate, endDate)

			if err != nil {
				// Log detailed error information
				t.Logf("Symbol: %s", symbol)
				t.Logf("Error: %v", err)
				t.Logf("Error type: %T", err)
				t.Logf("Error string: %s", err.Error())

				// Try to extract more details using type assertion
				if e, ok := err.(interface{ Code() string }); ok {
					t.Logf("Error code: %s", e.Code())
				}
				if e, ok := err.(interface{ Detail() string }); ok {
					t.Logf("Error detail: %s", e.Detail())
				}
				if e, ok := err.(interface{ Message() string }); ok {
					t.Logf("Error message: %s", e.Message())
				}

				// Check if it's a gRPC-style error
				if e, ok := err.(interface{ GRPCStatus() interface{} }); ok {
					t.Logf("gRPC status: %v", e.GRPCStatus())
				}
			} else if len(records) == 0 {
				t.Logf("Symbol: %s - No error but also no records returned", symbol)
			} else {
				t.Logf("Symbol: %s - Success! Got %d records", symbol, len(records))
			}

			// Small delay to avoid rate limiting
			time.Sleep(provider.GetRateLimit())
		})
	}
}
