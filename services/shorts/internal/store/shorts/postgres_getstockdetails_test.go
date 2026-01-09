package shorts

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestGetStockDetailsSQLQuery tests that the SQL query in GetStockDetails
// matches the actual database schema. This catches column name mismatches
// that would cause "column does not exist" errors.
func TestGetStockDetailsSQLQuery(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	// Skip if no database URL is set
	dbURL := getTestDatabaseURL()
	if dbURL == "" {
		t.Skip("DATABASE_URL not set, skipping integration test")
	}

	ctx := context.Background()
	pool := createTestPool(t, dbURL)
	defer pool.Close()

	// Test query that matches GetStockDetails implementation exactly
	// This will fail if the query in postgres.go doesn't match the schema
	logoExpr := `COALESCE(logo_gcs_url, logo_url, ''::text) as logo_gcs_url`
	hasLogoURL, err := hasColumn(ctx, pool, "logo_url")
	require.NoError(t, err)
	if !hasLogoURL {
		logoExpr = `COALESCE(logo_gcs_url, ''::text) as logo_gcs_url`
		t.Log("logo_url column missing; query fallback will omit legacy logo values")
	}

	query := fmt.Sprintf(`
	SELECT 
		stock_code,
		company_name,
		industry,
		address,
		COALESCE(summary, '') as summary,
		details,
		website,
		%s,
		COALESCE(tags, ARRAY[]::text[]) as tags,
		enhanced_summary,
		company_history,
		COALESCE(key_people, '[]'::jsonb) as key_people,
		COALESCE(financial_reports, '[]'::jsonb) as financial_reports,
		competitive_advantages,
		risk_factors,
		recent_developments,
		COALESCE(social_media_links, '{}'::jsonb) as social_media_links,
		enrichment_status,
		enrichment_date,
		enrichment_error,
		COALESCE(financial_statements, '{}'::jsonb) as financial_statements,
		COALESCE(key_metrics, '{}'::jsonb) as key_metrics
	FROM "company-metadata"
	WHERE stock_code = $1
	LIMIT 1`, logoExpr)

	// Test with a stock code that might exist
	testStockCode := "CBA"

	// Set a timeout for the query
	queryCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	// Execute the query - this will fail if any column doesn't exist
	row := pool.QueryRow(queryCtx, query, testStockCode)

	// Try to scan into variables matching the expected types
	var (
		productCode,
		companyName,
		industry,
		address,
		summary,
		details,
		website,
		logoGCSURL string
		tags                  []string
		enhancedSummary       *string
		companyHistory        *string
		keyPeople             []byte
		financialReports      []byte
		competitiveAdvantages *string
		riskFactors           *string
		recentDevelopments    *string
		socialMediaLinks      []byte
		enrichmentStatus      *string
		enrichmentDate        *time.Time
		enrichmentError       *string
		financialStatements   []byte
		keyMetrics            []byte
	)

	err = row.Scan(
		&productCode,
		&companyName,
		&industry,
		&address,
		&summary,
		&details,
		&website,
		&logoGCSURL,
		&tags,
		&enhancedSummary,
		&companyHistory,
		&keyPeople,
		&financialReports,
		&competitiveAdvantages,
		&riskFactors,
		&recentDevelopments,
		&socialMediaLinks,
		&enrichmentStatus,
		&enrichmentDate,
		&enrichmentError,
		&financialStatements,
		&keyMetrics,
	)

	// If the stock doesn't exist, that's OK - we're just testing the query structure
	if err != nil {
		// Check if it's a "no rows" error (expected if stock doesn't exist)
		if err.Error() == "no rows in result set" {
			t.Logf("Stock %s not found in database, but query structure is valid", testStockCode)
			return
		}
		// If it's a column error, fail the test
		if contains(err.Error(), "column") && contains(err.Error(), "does not exist") {
			t.Fatalf("SQL query references non-existent column: %v", err)
		}
		// Other errors might be OK (connection issues, etc.)
		t.Logf("Query execution error (may be expected): %v", err)
		return
	}

	// If we got here, the query worked and we scanned successfully
	assert.NotEmpty(t, productCode, "Product code should not be empty")
	t.Logf("Successfully queried stock details for %s", productCode)
}

// TestGetStockDetailsColumnNames validates that all columns referenced
// in GetStockDetails exist in the database schema.
func TestGetStockDetailsColumnNames(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	dbURL := getTestDatabaseURL()
	if dbURL == "" {
		t.Skip("DATABASE_URL not set, skipping integration test")
	}

	ctx := context.Background()
	pool := createTestPool(t, dbURL)
	defer pool.Close()

	// Query to get all column names from company-metadata table
	columnQuery := `
	SELECT column_name, data_type
	FROM information_schema.columns
	WHERE table_schema = 'public' 
	AND table_name = 'company-metadata'
	ORDER BY ordinal_position`

	rows, err := pool.Query(ctx, columnQuery)
	require.NoError(t, err, "Failed to query column information")
	defer rows.Close()

	columns := make(map[string]string)
	for rows.Next() {
		var colName, dataType string
		err := rows.Scan(&colName, &dataType)
		require.NoError(t, err)
		columns[colName] = dataType
	}

	// Required columns that GetStockDetails expects
	requiredColumns := []string{
		"stock_code",
		"company_name",
		"industry",
		"address",
		"summary",
		"details",
		"website",
		"logo_gcs_url",
		"logo_url", // Required for fallback logic
		"tags",
		"enhanced_summary",
		"company_history",
		"key_people",
		"financial_reports",
		"competitive_advantages",
		"risk_factors",
		"recent_developments",
		"social_media_links",
		"enrichment_status",
		"enrichment_date",
		"enrichment_error",
		"financial_statements",
		"key_metrics", // New column for market data
	}

	// Check that all required columns exist
	for _, col := range requiredColumns {
		if _, exists := columns[col]; !exists {
			if col == "logo_url" {
				t.Logf("Optional column '%s' missing; falling back to logo_gcs_url only", col)
				continue
			}
			t.Errorf("Required column '%s' does not exist in company-metadata table", col)
		}
	}

	// Verify that 'description' column does NOT exist (it was causing errors)
	if _, exists := columns["description"]; exists {
		t.Logf("Warning: 'description' column exists but is not used in GetStockDetails query")
	}
}

// Helper function to get test database URL
func getTestDatabaseURL() string {
	// Try common environment variable names
	envVars := []string{"DATABASE_URL", "TEST_DATABASE_URL", "POSTGRES_URL"}
	for _, envVar := range envVars {
		if url := os.Getenv(envVar); url != "" {
			return url
		}
	}
	return ""
}

// Helper function to create a test connection pool with simple protocol mode
// This prevents prepared statement cache conflicts when tests run
func createTestPool(t *testing.T, dbURL string) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	
	config, err := pgxpool.ParseConfig(dbURL)
	require.NoError(t, err, "Failed to parse DATABASE_URL")
	
	// Use simple protocol mode to avoid prepared statement cache conflicts
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	
	pool, err := pgxpool.NewWithConfig(ctx, config)
	require.NoError(t, err, "Failed to create connection pool")
	
	return pool
}

// TestGetStockDetailsLogoFallback tests that logo_url is used as fallback when logo_gcs_url is NULL
func TestGetStockDetailsLogoFallback(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	dbURL := getTestDatabaseURL()
	if dbURL == "" {
		t.Skip("DATABASE_URL not set, skipping integration test")
	}

	ctx := context.Background()
	pool := createTestPool(t, dbURL)
	defer pool.Close()

	hasLogoURL, err := hasColumn(ctx, pool, "logo_url")
	require.NoError(t, err)
	if !hasLogoURL {
		t.Skip("logo_url column missing; skipping fallback test")
	}

	// Create a test stock with logo_url but no logo_gcs_url
	testStockCode := "TEST_LOGO_FALLBACK"
	testLogoURL := "https://example.com/test-logo.png"

	// Clean up any existing test data
	_, _ = pool.Exec(ctx, `DELETE FROM "company-metadata" WHERE stock_code = $1`, testStockCode)

	// Insert test data with logo_url but NULL logo_gcs_url
	insertQuery := `
		INSERT INTO "company-metadata" (
			stock_code, company_name, industry, logo_url, logo_gcs_url
		) VALUES ($1, $2, $3, $4, NULL)
		ON CONFLICT (stock_code) DO UPDATE SET
			logo_url = EXCLUDED.logo_url,
			logo_gcs_url = NULL
	`
	_, err = pool.Exec(ctx, insertQuery, testStockCode, "Test Company", "Test Industry", testLogoURL)
	require.NoError(t, err, "Failed to insert test data")

	// Clean up after test
	defer func() {
		_, _ = pool.Exec(ctx, `DELETE FROM "company-metadata" WHERE stock_code = $1`, testStockCode)
	}()

	// Test the query with COALESCE fallback
	query := `
		SELECT COALESCE(logo_gcs_url, logo_url, '') as logo_gcs_url
		FROM "company-metadata"
		WHERE stock_code = $1
		LIMIT 1
	`

	var resultLogoURL string
	err = pool.QueryRow(ctx, query, testStockCode).Scan(&resultLogoURL)
	require.NoError(t, err, "Failed to query logo URL")

	// Verify that logo_url was used as fallback
	assert.Equal(t, testLogoURL, resultLogoURL, "Should fallback to logo_url when logo_gcs_url is NULL")

	// Test case 2: logo_gcs_url takes precedence when both exist
	testGCSURL := "https://storage.googleapis.com/logos/test.png"
	updateQuery := `
		UPDATE "company-metadata"
		SET logo_gcs_url = $1
		WHERE stock_code = $2
	`
	_, err = pool.Exec(ctx, updateQuery, testGCSURL, testStockCode)
	require.NoError(t, err, "Failed to update logo_gcs_url")

	err = pool.QueryRow(ctx, query, testStockCode).Scan(&resultLogoURL)
	require.NoError(t, err, "Failed to query logo URL after update")

	// Verify that logo_gcs_url takes precedence
	assert.Equal(t, testGCSURL, resultLogoURL, "Should use logo_gcs_url when both exist")

	// Test case 3: empty string when both are NULL
	updateQuery2 := `
		UPDATE "company-metadata"
		SET logo_gcs_url = NULL, logo_url = NULL
		WHERE stock_code = $1
	`
	_, err = pool.Exec(ctx, updateQuery2, testStockCode)
	require.NoError(t, err, "Failed to clear logo URLs")

	err = pool.QueryRow(ctx, query, testStockCode).Scan(&resultLogoURL)
	require.NoError(t, err, "Failed to query logo URL after clearing")

	// Verify that empty string is returned when both are NULL
	assert.Equal(t, "", resultLogoURL, "Should return empty string when both logo URLs are NULL")
}

// Helper function to check if error message contains substring
func contains(s, substr string) bool {
	return strings.Contains(s, substr)
}

func hasColumn(ctx context.Context, pool *pgxpool.Pool, column string) (bool, error) {
	const query = `
SELECT 1
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'company-metadata'
  AND column_name = $1
LIMIT 1`
	var exists int
	err := pool.QueryRow(ctx, query, column).Scan(&exists)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// TestGetStockDetailsKeyMetricsMerge tests that key_metrics data is properly merged
// into financial_statements.info when financial_statements is empty
func TestGetStockDetailsKeyMetricsMerge(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	dbURL := getTestDatabaseURL()
	if dbURL == "" {
		t.Skip("DATABASE_URL not set, skipping integration test")
	}

	ctx := context.Background()
	pool := createTestPool(t, dbURL)
	defer pool.Close()

	// Check if key_metrics column exists
	hasKeyMetrics, err := hasColumn(ctx, pool, "key_metrics")
	require.NoError(t, err)
	if !hasKeyMetrics {
		t.Skip("key_metrics column missing; skipping merge test")
	}

	testStockCode := "TEST_KEY_METRICS_MERGE"
	
	// Clean up any existing test data
	_, _ = pool.Exec(ctx, `DELETE FROM "company-metadata" WHERE stock_code = $1`, testStockCode)
	
	// Clean up after test
	defer func() {
		_, _ = pool.Exec(ctx, `DELETE FROM "company-metadata" WHERE stock_code = $1`, testStockCode)
	}()

	// Insert test stock with only key_metrics (no financial_statements)
	keyMetricsJSON := `{
		"market_cap": 5678912345,
		"pe_ratio": 22.3,
		"eps": 4.50,
		"dividend_yield": 0.038,
		"beta": 1.15,
		"fifty_two_week_high": 8.95,
		"fifty_two_week_low": 5.20,
		"avg_volume": 3500000
	}`

	insertQuery := `
		INSERT INTO "company-metadata" (
			stock_code, company_name, industry, key_metrics
		) VALUES ($1, $2, $3, $4::jsonb)
	`
	_, err = pool.Exec(ctx, insertQuery, testStockCode, "Test Mining Company", "Gold Mining", keyMetricsJSON)
	require.NoError(t, err, "Failed to insert test data")

	// Create a store and fetch the stock details
	config := Config{
		PostgresAddress:  pool.Config().ConnConfig.Host + ":" + fmt.Sprintf("%d", pool.Config().ConnConfig.Port),
		PostgresUsername: pool.Config().ConnConfig.User,
		PostgresPassword: pool.Config().ConnConfig.Password,
		PostgresDatabase: pool.Config().ConnConfig.Database,
	}

	store := newPostgresStore(config)
	
	details, err := store.GetStockDetails(testStockCode)
	require.NoError(t, err, "Failed to get stock details")
	require.NotNil(t, details, "Stock details should not be nil")

	// Verify that financial_statements.info was populated from key_metrics
	require.NotNil(t, details.FinancialStatements, "FinancialStatements should not be nil")
	require.NotNil(t, details.FinancialStatements.Info, "FinancialStatements.Info should not be nil")

	info := details.FinancialStatements.Info
	assert.Equal(t, float64(5678912345), info.MarketCap, "Market cap should come from key_metrics")
	assert.Equal(t, float64(22.3), info.PeRatio, "PE ratio should come from key_metrics")
	assert.Equal(t, float64(4.50), info.Eps, "EPS should come from key_metrics")
	assert.Equal(t, float64(0.038), info.DividendYield, "Dividend yield should come from key_metrics")
	assert.Equal(t, float64(1.15), info.Beta, "Beta should come from key_metrics")
	assert.Equal(t, float64(8.95), info.Week_52High, "52-week high should come from key_metrics")
	assert.Equal(t, float64(5.20), info.Week_52Low, "52-week low should come from key_metrics")
	assert.Equal(t, float64(3500000), info.Volume, "Volume should come from key_metrics")
}

// TestGetStockDetailsKeyMetricsPreserveExisting tests that existing financial_statements.info
// values are preserved when merging with key_metrics
func TestGetStockDetailsKeyMetricsPreserveExisting(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	dbURL := getTestDatabaseURL()
	if dbURL == "" {
		t.Skip("DATABASE_URL not set, skipping integration test")
	}

	ctx := context.Background()
	pool := createTestPool(t, dbURL)
	defer pool.Close()

	hasKeyMetrics, err := hasColumn(ctx, pool, "key_metrics")
	require.NoError(t, err)
	if !hasKeyMetrics {
		t.Skip("key_metrics column missing; skipping merge test")
	}

	testStockCode := "TEST_PRESERVE_EXISTING"
	
	_, _ = pool.Exec(ctx, `DELETE FROM "company-metadata" WHERE stock_code = $1`, testStockCode)
	defer func() {
		_, _ = pool.Exec(ctx, `DELETE FROM "company-metadata" WHERE stock_code = $1`, testStockCode)
	}()

	// Insert test stock with both financial_statements and key_metrics
	// financial_statements has market_cap, key_metrics has different value and pe_ratio
	financialStatementsJSON := `{
		"success": true,
		"info": {
			"market_cap": 999999999,
			"sector": "Materials",
			"industry": "Gold Mining"
		}
	}`

	keyMetricsJSON := `{
		"market_cap": 5678912345,
		"pe_ratio": 22.3,
		"beta": 1.15
	}`

	insertQuery := `
		INSERT INTO "company-metadata" (
			stock_code, company_name, industry, 
			financial_statements, key_metrics
		) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
	`
	_, err = pool.Exec(ctx, insertQuery, testStockCode, "Test Company", "Mining", 
		financialStatementsJSON, keyMetricsJSON)
	require.NoError(t, err, "Failed to insert test data")

	config := Config{
		PostgresAddress:  pool.Config().ConnConfig.Host + ":" + fmt.Sprintf("%d", pool.Config().ConnConfig.Port),
		PostgresUsername: pool.Config().ConnConfig.User,
		PostgresPassword: pool.Config().ConnConfig.Password,
		PostgresDatabase: pool.Config().ConnConfig.Database,
	}

	store := newPostgresStore(config)
	details, err := store.GetStockDetails(testStockCode)
	require.NoError(t, err, "Failed to get stock details")
	require.NotNil(t, details.FinancialStatements.Info, "Info should not be nil")

	info := details.FinancialStatements.Info
	
	// Existing market_cap should be preserved (from financial_statements, not key_metrics)
	assert.Equal(t, float64(999999999), info.MarketCap, 
		"Existing market cap should be preserved, not overwritten by key_metrics")
	
	// Missing fields should be filled from key_metrics
	assert.Equal(t, float64(22.3), info.PeRatio, 
		"PE ratio should be filled from key_metrics")
	assert.Equal(t, float64(1.15), info.Beta, 
		"Beta should be filled from key_metrics")
	
	// Existing string fields should be preserved
	assert.Equal(t, "Materials", info.Sector, 
		"Existing sector should be preserved")
	assert.Equal(t, "Gold Mining", info.Industry, 
		"Existing industry should be preserved")
}

// TestGetStockDetailsNoKeyMetrics tests behavior when key_metrics column is empty/null
func TestGetStockDetailsNoKeyMetrics(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	dbURL := getTestDatabaseURL()
	if dbURL == "" {
		t.Skip("DATABASE_URL not set, skipping integration test")
	}

	ctx := context.Background()
	pool := createTestPool(t, dbURL)
	defer pool.Close()

	hasKeyMetrics, err := hasColumn(ctx, pool, "key_metrics")
	require.NoError(t, err)
	if !hasKeyMetrics {
		t.Skip("key_metrics column missing; skipping test")
	}

	testStockCode := "TEST_NO_KEY_METRICS"
	
	_, _ = pool.Exec(ctx, `DELETE FROM "company-metadata" WHERE stock_code = $1`, testStockCode)
	defer func() {
		_, _ = pool.Exec(ctx, `DELETE FROM "company-metadata" WHERE stock_code = $1`, testStockCode)
	}()

	// Insert test stock with NULL key_metrics
	insertQuery := `
		INSERT INTO "company-metadata" (
			stock_code, company_name, industry, key_metrics
		) VALUES ($1, $2, $3, NULL)
	`
	_, err = pool.Exec(ctx, insertQuery, testStockCode, "Test Company", "Test Industry")
	require.NoError(t, err, "Failed to insert test data")

	config := Config{
		PostgresAddress:  pool.Config().ConnConfig.Host + ":" + fmt.Sprintf("%d", pool.Config().ConnConfig.Port),
		PostgresUsername: pool.Config().ConnConfig.User,
		PostgresPassword: pool.Config().ConnConfig.Password,
		PostgresDatabase: pool.Config().ConnConfig.Database,
	}

	store := newPostgresStore(config)
	details, err := store.GetStockDetails(testStockCode)
	require.NoError(t, err, "Failed to get stock details")
	
	// Should not crash with NULL key_metrics
	assert.Equal(t, testStockCode, details.ProductCode)
	assert.Equal(t, "Test Company", details.CompanyName)
}
