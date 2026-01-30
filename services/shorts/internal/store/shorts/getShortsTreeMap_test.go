package shorts

import (
	"context"
	"testing"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

// setupTreeMapTestDatabase creates a PostgreSQL container with schema and data for treemap tests
func setupTreeMapTestDatabase(t *testing.T) (*pgxpool.Pool, func()) {
	t.Helper()

	ctx := context.Background()

	// Start PostgreSQL container
	postgresContainer, err := postgres.Run(ctx,
		"postgres:14-alpine",
		postgres.WithDatabase("treemap_test"),
		postgres.WithUsername("test_user"),
		postgres.WithPassword("test_password"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(60*time.Second)),
	)
	checkDockerError(t, err)
	require.NoError(t, err, "Failed to start PostgreSQL container")

	connStr, err := postgresContainer.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err, "Failed to get connection string")

	pool, err := pgxpool.New(ctx, connStr)
	require.NoError(t, err, "Failed to create connection pool")

	// Create schema and load test data
	setupTreeMapSchema(t, pool)
	loadTreeMapTestData(t, pool)

	cleanup := func() {
		pool.Close()
		if err := postgresContainer.Terminate(ctx); err != nil {
			t.Logf("Failed to terminate container: %v", err)
		}
	}

	return pool, cleanup
}

// setupTreeMapSchema creates the database schema including company-metadata table
func setupTreeMapSchema(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()

	ctx := context.Background()

	createTablesSQL := `
	-- Create shorts table
	CREATE TABLE IF NOT EXISTS shorts (
		"PRODUCT_CODE" VARCHAR(20) NOT NULL,
		"PRODUCT" VARCHAR(255) NOT NULL,
		"DATE" TIMESTAMP NOT NULL,
		"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" NUMERIC(10, 8) NOT NULL,
		"REPORTED_SHORT_POSITIONS" NUMERIC,
		"TOTAL_PRODUCT_IN_ISSUE" NUMERIC,
		PRIMARY KEY ("PRODUCT_CODE", "DATE")
	);

	-- Create indexes for performance
	CREATE INDEX IF NOT EXISTS idx_shorts_product_code_date ON shorts("PRODUCT_CODE", "DATE" DESC);
	CREATE INDEX IF NOT EXISTS idx_shorts_percent ON shorts("PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS");

	-- Create company-metadata table (note: quoted name due to hyphen)
	CREATE TABLE IF NOT EXISTS "company-metadata" (
		stock_code VARCHAR(20) PRIMARY KEY,
		company_name VARCHAR(255),
		industry VARCHAR(100),
		sector VARCHAR(100),
		market_cap NUMERIC,
		logo_gcs_url VARCHAR(500),
		website VARCHAR(500),
		description TEXT
	);

	-- Create index on industry for treemap queries
	CREATE INDEX IF NOT EXISTS idx_company_metadata_industry ON "company-metadata"(industry);
	`

	_, err := pool.Exec(ctx, createTablesSQL)
	require.NoError(t, err, "Failed to create tables")
}

// loadTreeMapTestData inserts test data with multiple industries
func loadTreeMapTestData(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()

	ctx := context.Background()
	now := time.Now()

	// Define test stocks with industries
	testStocks := []struct {
		code     string
		name     string
		industry string
		shorts   []float64 // Historical short positions (newest to oldest)
	}{
		// Banks
		{"CBA", "COMMONWEALTH BANK OF AUSTRALIA", "Banks", []float64{0.025, 0.024, 0.023, 0.022}},
		{"WBC", "WESTPAC BANKING CORP", "Banks", []float64{0.032, 0.031, 0.030, 0.029}},
		{"ANZ", "ANZ GROUP HOLDINGS LTD", "Banks", []float64{0.028, 0.027, 0.026, 0.025}},
		{"NAB", "NATIONAL AUSTRALIA BANK", "Banks", []float64{0.022, 0.021, 0.020, 0.019}},

		// Mining
		{"BHP", "BHP GROUP LIMITED", "Materials", []float64{0.018, 0.017, 0.016, 0.015}},
		{"RIO", "RIO TINTO LIMITED", "Materials", []float64{0.015, 0.014, 0.013, 0.012}},
		{"FMG", "FORTESCUE LIMITED", "Materials", []float64{0.045, 0.044, 0.043, 0.042}},

		// Technology
		{"XRO", "XERO LIMITED", "Software & Services", []float64{0.055, 0.054, 0.053, 0.052}},
		{"APX", "APPEN LIMITED", "Software & Services", []float64{0.120, 0.115, 0.110, 0.105}},
		{"WTC", "WISETECH GLOBAL LTD", "Software & Services", []float64{0.035, 0.034, 0.033, 0.032}},

		// Retail
		{"WOW", "WOOLWORTHS GROUP LTD", "Food & Staples Retailing", []float64{0.008, 0.007, 0.006, 0.005}},
		{"COL", "COLES GROUP LTD", "Food & Staples Retailing", []float64{0.012, 0.011, 0.010, 0.009}},

		// Healthcare
		{"CSL", "CSL LIMITED", "Pharmaceuticals, Biotechnology & Life Sciences", []float64{0.012, 0.011, 0.010, 0.009}},
		{"RMD", "RESMED INC", "Health Care Equipment & Services", []float64{0.025, 0.024, 0.023, 0.022}},
	}

	// Insert company metadata
	for _, stock := range testStocks {
		_, err := pool.Exec(ctx, `
			INSERT INTO "company-metadata" (stock_code, company_name, industry)
			VALUES ($1, $2, $3)
			ON CONFLICT (stock_code) DO NOTHING
		`, stock.code, stock.name, stock.industry)
		require.NoError(t, err, "Failed to insert metadata for %s", stock.code)
	}

	// Insert shorts data (generate 180 days of data for each stock)
	for _, stock := range testStocks {
		for i := 0; i < 180; i++ {
			date := now.AddDate(0, 0, -i)

			// Calculate short position with some variance
			baseIdx := i / 45 // Change base value every ~45 days
			if baseIdx >= len(stock.shorts) {
				baseIdx = len(stock.shorts) - 1
			}
			shortPosition := stock.shorts[baseIdx] * (1 + float64(i%10-5)/100)

			_, err := pool.Exec(ctx, `
				INSERT INTO shorts (
					"PRODUCT_CODE", "PRODUCT", "DATE",
					"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
				) VALUES ($1, $2, $3, $4)
				ON CONFLICT ("PRODUCT_CODE", "DATE") DO NOTHING
			`, stock.code, stock.name, date, shortPosition)
			require.NoError(t, err, "Failed to insert shorts data for %s", stock.code)
		}
	}

	var count int
	err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM shorts`).Scan(&count)
	require.NoError(t, err)
	t.Logf("Loaded %d test records into database", count)
}

// TestFetchTreeMapData_AllPeriods tests that the treemap query works for all periods.
// This is a regression test to ensure both MV queries and fallback queries work.
func TestFetchTreeMapData_AllPeriods(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupTreeMapTestDatabase(t)
	defer cleanup()

	periods := []string{"3M", "6M", "1Y", "2Y", "5Y", "MAX"}

	for _, period := range periods {
		t.Run(period, func(t *testing.T) {
			result, err := FetchTreeMapData(pool, 5, period, shortsv1alpha1.ViewMode_CURRENT_CHANGE.String())
			require.NoError(t, err, "FetchTreeMapData should not fail for period %s", period)
			require.NotNil(t, result, "Result should not be nil for period %s", period)

			// Should have industries and stocks
			assert.NotEmpty(t, result.Industries, "Should have industries for period %s", period)
			assert.NotEmpty(t, result.Stocks, "Should have stocks for period %s", period)
		})
	}
}

// TestFetchTreeMapData_AllViewModes tests both view modes work correctly.
func TestFetchTreeMapData_AllViewModes(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupTreeMapTestDatabase(t)
	defer cleanup()

	viewModes := []string{
		shortsv1alpha1.ViewMode_CURRENT_CHANGE.String(),
		shortsv1alpha1.ViewMode_PERCENTAGE_CHANGE.String(),
	}

	for _, viewMode := range viewModes {
		t.Run(viewMode, func(t *testing.T) {
			result, err := FetchTreeMapData(pool, 5, "3M", viewMode)
			require.NoError(t, err, "FetchTreeMapData should not fail for viewMode %s", viewMode)
			require.NotNil(t, result, "Result should not be nil for viewMode %s", viewMode)

			// Should have industries and stocks
			assert.NotEmpty(t, result.Industries, "Should have industries for viewMode %s", viewMode)
			assert.NotEmpty(t, result.Stocks, "Should have stocks for viewMode %s", viewMode)
		})
	}
}

// TestFetchTreeMapData_DifferentLimits tests that limit parameter works correctly.
func TestFetchTreeMapData_DifferentLimits(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupTreeMapTestDatabase(t)
	defer cleanup()

	limits := []int32{1, 3, 5, 10}

	for _, limit := range limits {
		t.Run("Limit"+string(rune('0'+limit)), func(t *testing.T) {
			result, err := FetchTreeMapData(pool, limit, "3M", shortsv1alpha1.ViewMode_CURRENT_CHANGE.String())
			require.NoError(t, err, "FetchTreeMapData should not fail for limit %d", limit)
			require.NotNil(t, result, "Result should not be nil for limit %d", limit)

			// Count stocks per industry - should not exceed limit
			industryCount := make(map[string]int)
			for _, stock := range result.Stocks {
				industryCount[stock.Industry]++
			}

			for industry, count := range industryCount {
				assert.LessOrEqual(t, int32(count), limit,
					"Industry %s should have at most %d stocks, got %d", industry, limit, count)
			}
		})
	}
}

// TestFetchTreeMapData_ReturnsMultipleIndustries validates that treemap groups by industry.
func TestFetchTreeMapData_ReturnsMultipleIndustries(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupTreeMapTestDatabase(t)
	defer cleanup()

	result, err := FetchTreeMapData(pool, 10, "6M", shortsv1alpha1.ViewMode_CURRENT_CHANGE.String())
	require.NoError(t, err, "FetchTreeMapData should not fail")
	require.NotNil(t, result)

	// Should have multiple industries
	assert.Greater(t, len(result.Industries), 1, "Should have multiple industries")

	// Each stock should have a valid industry
	for _, stock := range result.Stocks {
		assert.NotEmpty(t, stock.Industry, "Stock %s should have an industry", stock.ProductCode)
		assert.NotEmpty(t, stock.ProductCode, "Stock should have a product code")
		assert.Greater(t, stock.ShortPosition, 0.0, "Stock %s should have positive short position", stock.ProductCode)
	}

	t.Logf("Found %d industries with %d total stocks", len(result.Industries), len(result.Stocks))
}

// TestFetchTreeMapData_FallbackQuery tests that the fallback query works when MV doesn't exist.
// Since we're not creating the MV in tests, this tests the fallback path directly.
func TestFetchTreeMapData_FallbackQuery(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupTreeMapTestDatabase(t)
	defer cleanup()

	// Since mv_treemap_data doesn't exist in the test database,
	// this will use the fallback query
	result, err := FetchTreeMapData(pool, 5, "3M", shortsv1alpha1.ViewMode_CURRENT_CHANGE.String())
	require.NoError(t, err, "Fallback query should work when MV doesn't exist")
	require.NotNil(t, result)

	// Validate we get data from the fallback
	assert.NotEmpty(t, result.Industries, "Fallback should return industries")
	assert.NotEmpty(t, result.Stocks, "Fallback should return stocks")

	t.Logf("Fallback query returned %d industries with %d stocks", len(result.Industries), len(result.Stocks))
}

// TestFetchTreeMapData_PercentageChangeMode tests the percentage change view mode.
func TestFetchTreeMapData_PercentageChangeMode(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupTreeMapTestDatabase(t)
	defer cleanup()

	result, err := FetchTreeMapData(pool, 5, "3M", shortsv1alpha1.ViewMode_PERCENTAGE_CHANGE.String())
	require.NoError(t, err, "FetchTreeMapData should not fail for PERCENTAGE_CHANGE mode")
	require.NotNil(t, result)

	// In percentage change mode, short_position represents the % change
	// This could be positive or negative
	for _, stock := range result.Stocks {
		assert.NotEmpty(t, stock.ProductCode, "Stock should have a product code")
		assert.NotEmpty(t, stock.Industry, "Stock %s should have an industry", stock.ProductCode)
		// ShortPosition here is actually percentage change, which can be any value
	}

	t.Logf("Percentage change mode returned %d industries with %d stocks", len(result.Industries), len(result.Stocks))
}

// TestPeriodToMVPeriod tests the period conversion function.
func TestPeriodToMVPeriod(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"1M", "3m"},
		{"1m", "3m"},
		{"3M", "3m"},
		{"3m", "3m"},
		{"6M", "6m"},
		{"6m", "6m"},
		{"1Y", "1y"},
		{"1y", "1y"},
		{"2Y", "2y"},
		{"2y", "2y"},
		{"5Y", "5y"},
		{"5y", "5y"},
		{"MAX", "max"},
		{"max", "max"},
		{"10Y", "max"},
		{"10y", "max"},
		{"INVALID", "3m"}, // Default
		{"", "3m"},        // Default
	}

	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			result := periodToMVPeriod(tc.input)
			assert.Equal(t, tc.expected, result, "periodToMVPeriod(%s) should return %s", tc.input, tc.expected)
		})
	}
}

// TestPeriodToInterval tests the period to SQL interval conversion.
func TestPeriodToInterval(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"1D", "1 day"},
		{"1W", "1 week"},
		{"1M", "1 month"},
		{"3M", "3 month"},
		{"6M", "6 month"},
		{"1Y", "1 year"},
		{"2Y", "2 year"},
		{"5Y", "5 year"},
		{"10Y", "10 year"},
		{"MAX", "100 year"},
		{"INVALID", "6 month"}, // Default
	}

	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			result := periodToInterval(tc.input)
			assert.Equal(t, tc.expected, result, "periodToInterval(%s) should return %s", tc.input, tc.expected)
		})
	}
}

// TestFetchTreeMapData_DataIntegrity validates the structure of returned data.
func TestFetchTreeMapData_DataIntegrity(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupTreeMapTestDatabase(t)
	defer cleanup()

	result, err := FetchTreeMapData(pool, 10, "6M", shortsv1alpha1.ViewMode_CURRENT_CHANGE.String())
	require.NoError(t, err)
	require.NotNil(t, result)

	// Create a map of industries from the stocks
	stockIndustries := make(map[string]bool)
	for _, stock := range result.Stocks {
		stockIndustries[stock.Industry] = true
	}

	// All industries in the result.Industries should have corresponding stocks
	for _, industry := range result.Industries {
		assert.True(t, stockIndustries[industry],
			"Industry %s should have at least one stock", industry)
	}

	// All stock industries should be in result.Industries
	industrySet := make(map[string]bool)
	for _, industry := range result.Industries {
		industrySet[industry] = true
	}

	for _, stock := range result.Stocks {
		assert.True(t, industrySet[stock.Industry],
			"Stock %s has industry %s which is not in Industries list",
			stock.ProductCode, stock.Industry)
	}

	t.Logf("Data integrity validated: %d industries, %d stocks", len(result.Industries), len(result.Stocks))
}
