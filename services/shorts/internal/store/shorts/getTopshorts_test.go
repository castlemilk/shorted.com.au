package shorts

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

// setupTestDatabase creates a PostgreSQL container with test data
func setupTestDatabase(t *testing.T) (*pgxpool.Pool, func()) {
	t.Helper()

	ctx := context.Background()

	// Start PostgreSQL container
	postgresContainer, err := postgres.Run(ctx,
		"postgres:14-alpine",
		postgres.WithDatabase("shorts_test"),
		postgres.WithUsername("test_user"),
		postgres.WithPassword("test_password"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(60*time.Second)),
	)
	// Check if error is Docker-related and skip test if so
	checkDockerError(t, err)
	require.NoError(t, err, "Failed to start PostgreSQL container")

	// Get connection string
	connStr, err := postgresContainer.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err, "Failed to get connection string")

	// Create connection pool
	pool, err := pgxpool.New(ctx, connStr)
	require.NoError(t, err, "Failed to create connection pool")

	// Create schema and load test data
	setupSchema(t, pool)
	loadTestData(t, pool)

	// Return cleanup function
	cleanup := func() {
		pool.Close()
		if err := postgresContainer.Terminate(ctx); err != nil {
			t.Logf("Failed to terminate container: %v", err)
		}
	}

	return pool, cleanup
}

// setupSchema creates the necessary database schema
func setupSchema(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()

	ctx := context.Background()

	// Create shorts table with correct schema
	createTableSQL := `
	CREATE TABLE IF NOT EXISTS shorts (
		"PRODUCT_CODE" VARCHAR(20) NOT NULL,
		"PRODUCT" VARCHAR(255) NOT NULL,
		"DATE" TIMESTAMP NOT NULL,
		"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" NUMERIC(10, 8) NOT NULL,
		PRIMARY KEY ("PRODUCT_CODE", "DATE")
	);

	-- Create indexes for performance
	CREATE INDEX IF NOT EXISTS idx_shorts_product_code ON shorts("PRODUCT_CODE");
	CREATE INDEX IF NOT EXISTS idx_shorts_date ON shorts("DATE");
	CREATE INDEX IF NOT EXISTS idx_shorts_percent ON shorts("PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS");
	`

	_, err := pool.Exec(ctx, createTableSQL)
	require.NoError(t, err, "Failed to create table")
}

// loadTestData inserts test data into the database
func loadTestData(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()

	ctx := context.Background()
	now := time.Now()

	// Define test stocks with various scenarios
	// Note: Values are stored as fractions (0.2159 = 21.59%) in the database
	testStocks := []struct {
		code         string
		name         string
		latestShort  float64 // Stored as fraction, not percentage
		isRecent     bool    // Has data within last month
		daysOfData   int     // Number of days of historical data
	}{
		// Active stocks with high short positions (should appear in results)
		{"BOE", "BOSS ENERGY LTD ORDINARY", 0.2159, true, 180},
		{"DMP", "DOMINO PIZZA ENTERPR ORDINARY", 0.1751, true, 180},
		{"PLS", "PILBARA MIN LTD ORDINARY", 0.1447, true, 180},
		{"GYG", "GUZMAN Y GOMEZ LTD ORDINARY", 0.1208, true, 180},
		{"PDN", "PALADIN ENERGY LTD ORDINARY", 0.1194, true, 180},
		{"IEL", "IDP EDUCATION LTD ORDINARY", 0.1147, true, 180},
		{"FLT", "FLIGHT CENTRE TRAVEL ORDINARY", 0.1104, true, 180},
		{"PWH", "PWR HOLDINGS LIMITED ORDINARY", 0.1096, true, 180},
		{"PNV", "POLYNOVO LIMITED ORDINARY", 0.1070, true, 180},
		{"TLX", "TELIX PHARMACEUTICAL ORDINARY", 0.1032, true, 180},
		{"IPH", "IPH LIMITED ORDINARY", 0.1017, true, 180},
		{"CTD", "CORP TRAVEL LIMITED ORDINARY", 0.0980, true, 180},

		// Delisted/stale stocks with high short positions (should NOT appear)
		// These have extremely high values but are stale, so shouldn't appear
		{"EEU", "BETASHARES EURO ETF ETF UNITS", 1.7308, false, 180},
		{"ENY", "AII200ENERGY ETF UNITS", 1.2500, false, 180},
		{"BBFD", "BETA GEARED SH UST TMF UNITS", 1.0555, false, 180},
		{"MAM", "AII300METALS&MINING ETF UNITS", 0.9500, false, 180},
		{"GNSPA", "GUNNS LIMITED FORESTS", 0.6521, false, 180},
		{"FIX", "AII200FINXAREIT ETF UNITS", 0.5142, false, 180},

		// Active stocks with lower short positions
		{"CBA", "COMMONWEALTH BANK OF AUSTRALIA", 0.0250, true, 180},
		{"BHP", "BHP GROUP LIMITED", 0.0180, true, 180},
		{"CSL", "CSL LIMITED", 0.0120, true, 180},
	}

	// Insert data for each stock
	for _, stock := range testStocks {
		baseDate := now
		if !stock.isRecent {
			// For stale stocks, last data is from 2+ months ago
			baseDate = now.AddDate(0, -3, 0)
		}

		// Generate daily data points
		for i := 0; i < stock.daysOfData; i++ {
			date := baseDate.AddDate(0, 0, -i)
			
			// Add some variance to short position (±10%)
			variance := (float64(i%10) - 5) / 50.0 // -10% to +10%
			shortPosition := stock.latestShort * (1 + variance)
			
			// Ensure positive values
			if shortPosition < 0 {
				shortPosition = 0.1
			}

			insertSQL := `
			INSERT INTO shorts (
				"PRODUCT_CODE",
				"PRODUCT",
				"DATE",
				"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
			) VALUES ($1, $2, $3, $4)
			ON CONFLICT ("PRODUCT_CODE", "DATE") DO NOTHING
			`

			_, err := pool.Exec(ctx, insertSQL, stock.code, stock.name, date, shortPosition)
			require.NoError(t, err, "Failed to insert data for %s", stock.code)
		}
	}

	// Verify data was inserted
	var count int
	err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM shorts`).Scan(&count)
	require.NoError(t, err, "Failed to count records")
	t.Logf("Loaded %d test records into database", count)
}

// TestFetchTimeSeriesData_ReturnsMultipleResults validates that the top shorts
// query returns multiple active stocks, not just one.
// This is a regression test for the issue where only 1 stock was returned
// because delisted/stale stocks were included in the top shorts selection.
func TestFetchTimeSeriesData_ReturnsMultipleResults(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupTestDatabase(t)
	defer cleanup()

	// Test with default parameters
	limit := 10
	offset := 0
	period := "6M"

	results, newOffset, err := FetchTimeSeriesData(pool, limit, offset, period)
	require.NoError(t, err, "FetchTimeSeriesData should not return error")

	// Validate we get multiple results (regression test)
	assert.GreaterOrEqual(t, len(results), 10,
		"Should return at least 10 stocks with active data (regression: was returning only 1)")

	// Validate offset is updated correctly
	assert.Equal(t, offset+len(results), newOffset, "New offset should be incremented by number of results")

	// Validate each result has required data
	for i, result := range results {
		assert.NotEmpty(t, result.ProductCode, "Result %d: Product code should not be empty", i)
		assert.NotEmpty(t, result.Name, "Result %d: Product name should not be empty", i)
		assert.NotEmpty(t, result.Points, "Result %d: Points should not be empty", i)
		assert.Greater(t, result.LatestShortPosition, 0.0, "Result %d: Latest short position should be > 0", i)

		// Each stock should have at least 2 points (minimum for a line chart)
		assert.GreaterOrEqual(t, len(result.Points), 2,
			"Result %d (%s): Should have at least 2 data points", i, result.ProductCode)

		// Validate min/max are set
		assert.NotNil(t, result.Min, "Result %d (%s): Min should be set", i, result.ProductCode)
		assert.NotNil(t, result.Max, "Result %d (%s): Max should be set", i, result.ProductCode)
	}

	t.Logf("✓ Returned %d active stocks out of requested %d", len(results), limit)
}

// TestFetchTimeSeriesData_OnlyReturnsRecentStocks validates that only stocks
// with recent data (within 1 month of latest report) are returned.
// This prevents delisted or stale stocks from appearing in top shorts.
func TestFetchTimeSeriesData_OnlyReturnsRecentStocks(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupTestDatabase(t)
	defer cleanup()

	ctx := context.Background()

	// First, find the latest report date in the database
	var latestDate time.Time
	err := pool.QueryRow(ctx, `SELECT MAX("DATE") FROM shorts`).Scan(&latestDate)
	require.NoError(t, err, "Failed to get latest date from shorts table")

	t.Logf("Latest report date in database: %s", latestDate.Format("2006-01-02"))

	// Fetch top shorts
	limit := 15
	results, _, err := FetchTimeSeriesData(pool, limit, 0, "6M")
	require.NoError(t, err, "FetchTimeSeriesData should not return error")
	require.NotEmpty(t, results, "Should return results")

	// Query to check if each returned stock has recent data
	checkRecentQuery := `
		SELECT MAX("DATE") 
		FROM shorts 
		WHERE "PRODUCT_CODE" = $1
	`

	oneMonthAgo := latestDate.AddDate(0, -1, 0)

	for i, result := range results {
		var stockLatestDate time.Time
		err := pool.QueryRow(ctx, checkRecentQuery, result.ProductCode).Scan(&stockLatestDate)
		require.NoError(t, err, "Failed to check latest date for %s", result.ProductCode)

		// Verify the stock has data within 1 month of the latest report
		assert.True(t, stockLatestDate.After(oneMonthAgo) || stockLatestDate.Equal(latestDate),
			"Stock %d (%s) has stale data: latest=%s, cutoff=%s",
			i, result.ProductCode, stockLatestDate.Format("2006-01-02"), oneMonthAgo.Format("2006-01-02"))
	}

	t.Logf("✓ All %d returned stocks have recent data (within 1 month)", len(results))
}

// TestFetchTimeSeriesData_ResultsOrderedByShortPosition validates that
// results are returned in descending order by short position percentage.
func TestFetchTimeSeriesData_ResultsOrderedByShortPosition(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupTestDatabase(t)
	defer cleanup()

	results, _, err := FetchTimeSeriesData(pool, 10, 0, "6M")
	require.NoError(t, err, "FetchTimeSeriesData should not return error")
	require.NotEmpty(t, results, "Should return at least one result")

	// Verify results are in descending order
	for i := 1; i < len(results); i++ {
		prevShortPosition := results[i-1].LatestShortPosition
		currShortPosition := results[i].LatestShortPosition

		assert.GreaterOrEqual(t, prevShortPosition, currShortPosition,
			"Results should be ordered by short position (descending): %s (%.2f%%) should be >= %s (%.2f%%)",
			results[i-1].ProductCode, prevShortPosition*100,
			results[i].ProductCode, currShortPosition*100)
	}

	// Log the top shorts for manual verification
	t.Log("Top shorts (ordered by short position):")
	for i, result := range results {
		t.Logf("  %d. %s (%s): %.2f%% with %d data points",
			i+1, result.Name, result.ProductCode, result.LatestShortPosition*100, len(result.Points))
	}

	t.Logf("✓ Results are correctly ordered by short position (descending)")
}

// TestFetchTimeSeriesData_DifferentPeriods tests that the function works
// correctly with different time periods.
func TestFetchTimeSeriesData_DifferentPeriods(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupTestDatabase(t)
	defer cleanup()

	periods := []struct {
		name          string
		period        string
		expectResults bool
		minPoints     int
	}{
		{"1 Month", "1M", true, 2},
		{"3 Months", "3M", true, 2},
		{"6 Months", "6M", true, 2},
		{"1 Year", "1Y", true, 2},
		{"Max", "MAX", true, 2},
	}

	for _, tc := range periods {
		t.Run(tc.name, func(t *testing.T) {
			results, _, err := FetchTimeSeriesData(pool, 5, 0, tc.period)
			require.NoError(t, err, "FetchTimeSeriesData should not return error for period %s", tc.period)

			if tc.expectResults {
				assert.NotEmpty(t, results, "Should return results for period %s", tc.period)

				// Verify that each stock has minimum required data points
				for _, result := range results {
					assert.GreaterOrEqual(t, len(result.Points), tc.minPoints,
						"Period %s: Stock %s should have at least %d points",
						tc.period, result.ProductCode, tc.minPoints)
				}

				t.Logf("Period %s: Returned %d stocks", tc.period, len(results))
			}
		})
	}

	t.Logf("✓ All period configurations work correctly")
}

// TestFetchTimeSeriesData_Pagination tests that pagination works correctly.
func TestFetchTimeSeriesData_Pagination(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupTestDatabase(t)
	defer cleanup()

	// Fetch first page
	page1, offset1, err := FetchTimeSeriesData(pool, 5, 0, "6M")
	require.NoError(t, err, "Failed to fetch first page")
	require.NotEmpty(t, page1, "First page should have results")

	// Fetch second page
	page2, offset2, err := FetchTimeSeriesData(pool, 5, offset1, "6M")
	require.NoError(t, err, "Failed to fetch second page")

	// If there are results on the second page, they should be different from the first
	if len(page2) > 0 {
		// Check that product codes don't overlap
		page1Codes := make(map[string]bool)
		for _, stock := range page1 {
			page1Codes[stock.ProductCode] = true
		}

		for _, stock := range page2 {
			assert.False(t, page1Codes[stock.ProductCode],
				"Stock %s appears in both page 1 and page 2", stock.ProductCode)
		}

		t.Logf("✓ Pagination works: Page 1: %d stocks, Page 2: %d stocks, Offset2: %d",
			len(page1), len(page2), offset2)
	}
}

// TestFetchTimeSeriesData_MinimumDataPoints validates that stocks with
// insufficient data points are filtered out.
func TestFetchTimeSeriesData_MinimumDataPoints(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupTestDatabase(t)
	defer cleanup()

	// Test with a short period (1 month) where stocks should still have enough points
	results, _, err := FetchTimeSeriesData(pool, 20, 0, "1M")
	require.NoError(t, err, "FetchTimeSeriesData should not return error")

	// All returned stocks must have at least 2 data points
	for i, result := range results {
		assert.GreaterOrEqual(t, len(result.Points), 2,
			"Stock %d (%s) should have at least 2 data points, got %d",
			i, result.ProductCode, len(result.Points))
	}

	t.Logf("✓ All %d stocks have minimum required data points (>=2)", len(results))
}

// TestFetchTimeSeriesData_ValidatesInputs tests that the function handles
// invalid inputs correctly.
func TestFetchTimeSeriesData_ValidatesInputs(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupTestDatabase(t)
	defer cleanup()

	t.Run("Zero limit defaults to 10", func(t *testing.T) {
		results, _, err := FetchTimeSeriesData(pool, 0, 0, "6M")
		require.NoError(t, err, "Should handle zero limit")
		assert.NotEmpty(t, results, "Should return results with default limit")
	})

	t.Run("Negative limit defaults to 10", func(t *testing.T) {
		results, _, err := FetchTimeSeriesData(pool, -5, 0, "6M")
		require.NoError(t, err, "Should handle negative limit")
		assert.NotEmpty(t, results, "Should return results with default limit")
	})

	t.Run("Negative offset defaults to 0", func(t *testing.T) {
		results, newOffset, err := FetchTimeSeriesData(pool, 5, -10, "6M")
		require.NoError(t, err, "Should handle negative offset")
		assert.NotEmpty(t, results, "Should return results")
		assert.Equal(t, len(results), newOffset, "Offset should start from 0")
	})

	t.Run("Invalid period defaults to 6M", func(t *testing.T) {
		results, _, err := FetchTimeSeriesData(pool, 5, 0, "INVALID")
		require.NoError(t, err, "Should handle invalid period")
		assert.NotEmpty(t, results, "Should return results with default period")
	})

	t.Logf("✓ Input validation works correctly")
}

// TestTopShortsQuery_ExcludesDelistedStocks specifically tests that known
// delisted stocks are not included in the top shorts results.
func TestTopShortsQuery_ExcludesDelistedStocks(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupTestDatabase(t)
	defer cleanup()

	// Known delisted/stale stocks that should NOT appear (from our test data)
	delistedStocks := []string{
		"EEU",    // BetaShares Euro ETF - stale data
		"ENY",    // AII200 Energy ETF - stale data
		"BBFD",   // Beta Geared Short UST - stale data
		"MAM",    // AII300 Metals & Mining - stale data
		"GNSPA",  // Gunns Limited - stale data
		"FIX",    // AII200 FinXAREIT - stale data
	}

	results, _, err := FetchTimeSeriesData(pool, 50, 0, "6M") // Get more results to be thorough
	require.NoError(t, err, "FetchTimeSeriesData should not return error")
	require.NotEmpty(t, results, "Should return results")

	// Create a map of returned product codes
	returnedCodes := make(map[string]bool)
	for _, result := range results {
		returnedCodes[result.ProductCode] = true
	}

	// Verify that none of the delisted stocks appear in results
	excludedCount := 0
	for _, delistedCode := range delistedStocks {
		if !returnedCodes[delistedCode] {
			excludedCount++
		}
		assert.False(t, returnedCodes[delistedCode],
			"Delisted stock %s should NOT appear in top shorts", delistedCode)
	}

	t.Logf("✓ Verified that %d/%d known delisted stocks are excluded from results",
		excludedCount, len(delistedStocks))
}

// TestTopShortsQuery_ExcludesDeferredSettlementStocks specifically tests that
// deferred settlement stocks (temporary trading codes) are not included in top shorts.
// These stocks have codes like LOTDB, PNRDA and have "DEFERRED SETTLEMENT" in their name.
func TestTopShortsQuery_ExcludesDeferredSettlementStocks(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupTestDatabase(t)
	defer cleanup()

	results, _, err := FetchTimeSeriesData(pool, 100, 0, "6M") // Get more results to be thorough
	require.NoError(t, err, "FetchTimeSeriesData should not return error")
	require.NotEmpty(t, results, "Should return results")

	// Check that no deferred settlement stocks appear in results
	for _, result := range results {
		assert.NotContains(t, result.Name, "DEFERRED SETTLEMENT",
			"Stock %s should not be a deferred settlement stock: %s",
			result.ProductCode, result.Name)
		assert.NotContains(t, result.Name, "DEFERRED",
			"Stock %s should not be a deferred stock: %s",
			result.ProductCode, result.Name)
	}

	t.Logf("✓ Verified that no deferred settlement stocks appear in %d results", len(results))
}

// TestFetchTimeSeriesData_DataIntegrity validates the integrity of returned data
func TestFetchTimeSeriesData_DataIntegrity(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupTestDatabase(t)
	defer cleanup()

	results, _, err := FetchTimeSeriesData(pool, 10, 0, "6M")
	require.NoError(t, err, "FetchTimeSeriesData should not return error")
	require.NotEmpty(t, results, "Should return results")

	for i, result := range results {
		// Validate timestamps are in order
		for j := 1; j < len(result.Points); j++ {
			prevTime := result.Points[j-1].Timestamp.AsTime()
			currTime := result.Points[j].Timestamp.AsTime()
			assert.True(t, currTime.After(prevTime) || currTime.Equal(prevTime),
				"Stock %d (%s): Timestamps should be in ascending order at index %d",
				i, result.ProductCode, j)
		}

		// Validate min is actually the minimum
		minValue := result.Min.ShortPosition
		for _, point := range result.Points {
			assert.LessOrEqual(t, minValue, point.ShortPosition,
				"Stock %d (%s): Min value should be <= all points",
				i, result.ProductCode)
		}

		// Validate max is actually the maximum
		maxValue := result.Max.ShortPosition
		for _, point := range result.Points {
			assert.GreaterOrEqual(t, maxValue, point.ShortPosition,
				"Stock %d (%s): Max value should be >= all points",
				i, result.ProductCode)
		}

		// Validate latest short position matches the last point
		latestPoint := result.Points[len(result.Points)-1]
		assert.Equal(t, latestPoint.ShortPosition, result.LatestShortPosition,
			"Stock %d (%s): LatestShortPosition should match last point",
			i, result.ProductCode)
	}

	t.Logf("✓ Data integrity validated for %d stocks", len(results))
}

// Benchmark for performance testing
func BenchmarkFetchTimeSeriesData(b *testing.B) {
	// Setup is excluded from benchmark timing
	b.StopTimer()
	
	ctx := context.Background()
	postgresContainer, err := postgres.Run(ctx,
		"postgres:14-alpine",
		postgres.WithDatabase("shorts_bench"),
		postgres.WithUsername("bench_user"),
		postgres.WithPassword("bench_password"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(60*time.Second)),
	)
	if err != nil {
		b.Fatal(err)
	}
	defer func() {
		_ = postgresContainer.Terminate(ctx)
	}()

	connStr, err := postgresContainer.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		b.Fatal(err)
	}

	pool, err := pgxpool.New(ctx, connStr)
	if err != nil {
		b.Fatal(err)
	}
	defer pool.Close()

	// Setup schema and data
	setupSchema(&testing.T{}, pool)
	loadTestData(&testing.T{}, pool)

	b.StartTimer()
	
	// Run the benchmark
	for i := 0; i < b.N; i++ {
		_, _, err := FetchTimeSeriesData(pool, 10, 0, "6M")
		if err != nil {
			b.Fatal(err)
		}
	}
}

// Example of how to run a specific test:
// go test -v -run TestFetchTimeSeriesData_ReturnsMultipleResults ./internal/store/shorts/
//
// Run all integration tests:
// go test -v ./internal/store/shorts/
//
// Skip integration tests (run unit tests only):
// go test -v -short ./internal/store/shorts/
//
// Run benchmarks:
// go test -bench=. -benchmem ./internal/store/shorts/

// Mock implementation note:
// When adding this test, ensure it's properly categorized in your CI/CD:
// - These tests require Docker to run testcontainers
// - Consider separating into a different test suite if needed
// - Use build tags if you want to exclude from regular test runs:
//   // +build integration
