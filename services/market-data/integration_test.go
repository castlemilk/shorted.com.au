//go:build integration
// +build integration

package main

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"
	marketdatav1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/marketdata/v1"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestDatabaseConnection verifies the database connection is properly configured
// This would have caught the port 5432 vs 6543 issue
func TestDatabaseConnection(t *testing.T) {
	dbURL := GetTestDatabaseURL()
	require.NotEmpty(t, dbURL, "Test database URL should be set by TestMain")

	t.Run("connection_establishes_quickly", func(t *testing.T) {
		// Connection should establish within 10 seconds
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		config, err := pgxpool.ParseConfig(dbURL)
		require.NoError(t, err, "Failed to parse DATABASE_URL")

		// Configure like production
		config.MaxConns = 10
		config.MinConns = 2
		config.ConnConfig.ConnectTimeout = 5 * time.Second
		config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol

		startTime := time.Now()
		pool, err := pgxpool.NewWithConfig(ctx, config)
		require.NoError(t, err, "Failed to create connection pool")
		defer pool.Close()

		connectionTime := time.Since(startTime)
		t.Logf("Connection established in %v", connectionTime)

		// Connection should be fast (< 5 seconds)
		assert.Less(t, connectionTime, 5*time.Second,
			"Database connection took too long - check port and SSL configuration")

		// Verify ping works
		err = pool.Ping(ctx)
		require.NoError(t, err, "Failed to ping database")
	})

	t.Run("prepared_statements_not_conflicting", func(t *testing.T) {
		ctx := context.Background()

		config, err := pgxpool.ParseConfig(dbURL)
		require.NoError(t, err)

		// Test with simple protocol (production config)
		config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
		pool, err := pgxpool.NewWithConfig(ctx, config)
		require.NoError(t, err)
		defer pool.Close()

		// Execute same query multiple times - should not fail with "prepared statement already exists"
		query := "SELECT COUNT(*) FROM stock_prices WHERE stock_code = $1"
		for i := 0; i < 3; i++ {
			var count int
			err := pool.QueryRow(ctx, query, "CBA").Scan(&count)
			assert.NoError(t, err, "Query failed on iteration %d - prepared statement conflict?", i)
		}
	})

	t.Run("connection_pool_handles_concurrency", func(t *testing.T) {
		ctx := context.Background()

		config, err := pgxpool.ParseConfig(dbURL)
		require.NoError(t, err)
		config.MaxConns = 5
		config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol

		pool, err := pgxpool.NewWithConfig(ctx, config)
		require.NoError(t, err)
		defer pool.Close()

		// Simulate concurrent requests
		done := make(chan error, 10)
		for i := 0; i < 10; i++ {
			go func(id int) {
				var count int
				err := pool.QueryRow(ctx, "SELECT COUNT(*) FROM stock_prices LIMIT 1").Scan(&count)
				done <- err
			}(i)
		}

		// All should complete without error
		for i := 0; i < 10; i++ {
			err := <-done
			assert.NoError(t, err, "Concurrent query %d failed", i)
		}
	})
}

// TestGetHistoricalPricesNilDatabase tests nil database connection handling
// This would have caught the nil database connection issue
func TestGetHistoricalPricesNilDatabase(t *testing.T) {
	service := &MarketDataService{db: nil}

	ctx := context.Background()
	req := connect.NewRequest(&marketdatav1.GetHistoricalPricesRequest{
		StockCode: "CBA",
		Period:    "1m",
	})

	_, err := service.GetHistoricalPrices(ctx, req)
	require.Error(t, err, "Should return error when database is nil")
	
	// Verify it's the correct error type
	connectErr, ok := err.(*connect.Error)
	require.True(t, ok, "Error should be a connect.Error")
	assert.Equal(t, connect.CodeUnavailable, connectErr.Code(), "Should return Unavailable code")
	assert.Contains(t, connectErr.Message(), "database connection not available")
}

// TestGetHistoricalPricesTimezone tests timezone handling in date queries
// This would have caught the timezone mismatch issue
func TestGetHistoricalPricesTimezone(t *testing.T) {
	dbURL := GetTestDatabaseURL()
	require.NotEmpty(t, dbURL, "Test database URL should be set by TestMain")

	config, err := pgxpool.ParseConfig(dbURL)
	require.NoError(t, err)

	config.MaxConns = 10
	config.MinConns = 2
	config.ConnConfig.ConnectTimeout = 5 * time.Second
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol

	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	require.NoError(t, err)
	defer pool.Close()

	service := &MarketDataService{db: pool}

	// Test that dates are calculated in UTC (matching database timezone)
	ctx := context.Background()
	req := connect.NewRequest(&marketdatav1.GetHistoricalPricesRequest{
		StockCode: "WES", // Known to have data
		Period:    "1m",
	})

	resp, err := service.GetHistoricalPrices(ctx, req)
	require.NoError(t, err, "Query should succeed")
	require.NotNil(t, resp)

	// Verify we got data (proves date range query worked correctly)
	if len(resp.Msg.Prices) > 0 {
		// Verify dates are in reasonable range (within last month)
		now := time.Now().UTC()
		oneMonthAgo := now.AddDate(0, -1, 0)
		// Normalize to date only (midnight UTC) for comparison
		oneMonthAgoDate := time.Date(oneMonthAgo.Year(), oneMonthAgo.Month(), oneMonthAgo.Day(), 0, 0, 0, 0, time.UTC)
		nowDate := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)

		for _, price := range resp.Msg.Prices {
			priceDate := price.Date.AsTime()
			priceDateOnly := time.Date(priceDate.Year(), priceDate.Month(), priceDate.Day(), 0, 0, 0, 0, time.UTC)
			assert.True(t, priceDateOnly.After(oneMonthAgoDate) || priceDateOnly.Equal(oneMonthAgoDate),
				"Price date %s should be after or equal to %s", priceDateOnly.Format("2006-01-02"), oneMonthAgoDate.Format("2006-01-02"))
			assert.True(t, priceDateOnly.Before(nowDate) || priceDateOnly.Equal(nowDate),
				"Price date %s should be before or equal to %s", priceDateOnly.Format("2006-01-02"), nowDate.Format("2006-01-02"))
		}
	}
}

// TestGetHistoricalPricesIntegration tests the full GetHistoricalPrices flow
// This would have caught the hanging query issue
func TestGetHistoricalPricesIntegration(t *testing.T) {
	dbURL := GetTestDatabaseURL()
	require.NotEmpty(t, dbURL, "Test database URL should be set by TestMain")

	// Setup service
	config, err := pgxpool.ParseConfig(dbURL)
	require.NoError(t, err)

	config.MaxConns = 10
	config.MinConns = 2
	config.ConnConfig.ConnectTimeout = 5 * time.Second
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol

	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	require.NoError(t, err)
	defer pool.Close()

	service := &MarketDataService{db: pool}

	testCases := []struct {
		name        string
		stockCode   string
		period      string
		timeout     time.Duration
		expectError bool
		minRecords  int
	}{
		{
			name:        "one_month_CBA",
			stockCode:   "CBA",
			period:      "1m",
			timeout:     10 * time.Second,
			expectError: false,
			minRecords:  1, // Should have at least some data
		},
		{
			name:        "three_months_BHP",
			stockCode:   "BHP",
			period:      "3m",
			timeout:     10 * time.Second,
			expectError: false,
			minRecords:  1,
		},
		{
			name:        "one_year_CBA",
			stockCode:   "CBA",
			period:      "1y",
			timeout:     15 * time.Second, // Slightly longer for more data
			expectError: false,
			minRecords:  50, // Should have substantial data
		},
		{
			name:        "invalid_stock",
			stockCode:   "XXXX", // 4 letters but non-existent stock
			period:      "1m",
			timeout:     10 * time.Second,
			expectError: false, // Not an error, just empty results
			minRecords:  0,
		},
		{
			name:        "all_periods_covered",
			stockCode:   "WES", // Known to have extensive data
			period:      "1d",
			timeout:     10 * time.Second,
			expectError: false,
			minRecords:  0, // May have 0-1 records for 1 day
		},
		{
			name:        "max_period",
			stockCode:   "WES",
			period:      "max",
			timeout:     20 * time.Second,
			expectError: false,
			minRecords:  50, // Should have substantial historical data (10 years = ~2500 trading days, but test data may be limited)
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			// CRITICAL: Test with timeout to catch hanging queries
			ctx, cancel := context.WithTimeout(context.Background(), tc.timeout)
			defer cancel()

			req := connect.NewRequest(&marketdatav1.GetHistoricalPricesRequest{
				StockCode: tc.stockCode,
				Period:    tc.period,
			})

			startTime := time.Now()
			resp, err := service.GetHistoricalPrices(ctx, req)
			duration := time.Since(startTime)

			t.Logf("Query completed in %v", duration)

			if tc.expectError {
				assert.Error(t, err)
			} else {
				require.NoError(t, err, "Query should not error")
				require.NotNil(t, resp)

				// Verify we got expected data
				prices := resp.Msg.Prices
				assert.GreaterOrEqual(t, len(prices), tc.minRecords,
					"Expected at least %d records, got %d", tc.minRecords, len(prices))

				// If we have data, verify structure
				if len(prices) > 0 {
					for i, price := range prices {
						assert.Equal(t, tc.stockCode, price.StockCode, "Stock code mismatch at index %d", i)
						assert.NotNil(t, price.Date, "Date should not be nil at index %d", i)
						assert.Greater(t, price.Close, 0.0, "Close price should be positive at index %d", i)
						assert.GreaterOrEqual(t, price.Volume, int64(0), "Volume should be non-negative at index %d", i)
					}
				}

				// CRITICAL: Verify query doesn't take too long (catches hanging queries)
				assert.Less(t, duration, tc.timeout,
					"Query took too long - possible hanging query or connection issue")
			}

			// Verify context wasn't cancelled due to timeout
			select {
			case <-ctx.Done():
				if ctx.Err() == context.DeadlineExceeded {
					t.Fatal("Query timed out - this indicates a hanging query or connection issue")
				}
			default:
				// Context not done, good
			}
		})
	}
}

// TestGetHistoricalPricesConcurrency tests concurrent requests don't cause issues
// This would have caught prepared statement conflicts and connection pool issues
func TestGetHistoricalPricesConcurrency(t *testing.T) {
	dbURL := GetTestDatabaseURL()
	require.NotEmpty(t, dbURL, "Test database URL should be set by TestMain")

	config, err := pgxpool.ParseConfig(dbURL)
	require.NoError(t, err)

	config.MaxConns = 5 // Limited pool to stress test
	config.MinConns = 2
	config.ConnConfig.ConnectTimeout = 5 * time.Second
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol

	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	require.NoError(t, err)
	defer pool.Close()

	service := &MarketDataService{db: pool}

	// Simulate 20 concurrent requests
	concurrentRequests := 20
	done := make(chan error, concurrentRequests)

	for i := 0; i < concurrentRequests; i++ {
		go func(id int) {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()

			// Alternate between different stocks and periods
			stockCode := []string{"CBA", "BHP", "WOW"}[id%3]
			period := []string{"1m", "3m", "6m"}[id%3]

			req := connect.NewRequest(&marketdatav1.GetHistoricalPricesRequest{
				StockCode: stockCode,
				Period:    period,
			})

			_, err := service.GetHistoricalPrices(ctx, req)
			done <- err
		}(i)
	}

	// Collect results
	failures := 0
	for i := 0; i < concurrentRequests; i++ {
		err := <-done
		if err != nil {
			t.Logf("Request %d failed: %v", i, err)
			failures++
		}
	}

	// Allow some failures due to rate limiting, but not all
	assert.Less(t, failures, concurrentRequests/2,
		"Too many concurrent requests failed (%d/%d) - check connection pool and prepared statement config",
		failures, concurrentRequests)
}

// TestQueryTimeout verifies queries have proper timeouts
func TestQueryTimeout(t *testing.T) {
	dbURL := GetTestDatabaseURL()
	require.NotEmpty(t, dbURL, "Test database URL should be set by TestMain")

	config, err := pgxpool.ParseConfig(dbURL)
	require.NoError(t, err)
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol

	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	require.NoError(t, err)
	defer pool.Close()

	service := &MarketDataService{db: pool}

	t.Run("query_respects_context_timeout", func(t *testing.T) {
		// Very short timeout
		ctx, cancel := context.WithTimeout(context.Background(), 1*time.Millisecond)
		defer cancel()

		time.Sleep(2 * time.Millisecond) // Ensure timeout is exceeded

		req := connect.NewRequest(&marketdatav1.GetHistoricalPricesRequest{
			StockCode: "CBA",
			Period:    "10y", // Large period
		})

		startTime := time.Now()
		_, err := service.GetHistoricalPrices(ctx, req)
		duration := time.Since(startTime)

		// Should fail quickly due to timeout
		assert.Error(t, err, "Should error due to context timeout")
		assert.Less(t, duration, 5*time.Second, "Should fail quickly, not hang")
	})
}

// TestDatabaseSchema verifies required tables and columns exist
func TestDatabaseSchema(t *testing.T) {
	dbURL := GetTestDatabaseURL()
	require.NotEmpty(t, dbURL, "Test database URL should be set by TestMain")

	config, err := pgxpool.ParseConfig(dbURL)
	require.NoError(t, err)
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol

	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	require.NoError(t, err)
	defer pool.Close()

	ctx := context.Background()

	t.Run("stock_prices_table_exists", func(t *testing.T) {
		var exists bool
		err := pool.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT FROM information_schema.tables 
				WHERE table_name = 'stock_prices'
			)
		`).Scan(&exists)
		require.NoError(t, err)
		assert.True(t, exists, "stock_prices table should exist")
	})

	t.Run("required_columns_exist", func(t *testing.T) {
		requiredColumns := []string{
			"stock_code", "date", "open", "high", "low", "close", "volume", "adjusted_close",
		}

		for _, col := range requiredColumns {
			var exists bool
			err := pool.QueryRow(ctx, `
				SELECT EXISTS (
					SELECT FROM information_schema.columns 
					WHERE table_name = 'stock_prices' AND column_name = $1
				)
			`, col).Scan(&exists)
			require.NoError(t, err)
			assert.True(t, exists, "Column %s should exist", col)
		}
	})

	t.Run("stock_prices_has_data", func(t *testing.T) {
		var count int64
		err := pool.QueryRow(ctx, "SELECT COUNT(*) FROM stock_prices").Scan(&count)
		require.NoError(t, err)
		assert.Greater(t, count, int64(200),
			"stock_prices should have substantial data (got %d rows)", count)
	})
}
