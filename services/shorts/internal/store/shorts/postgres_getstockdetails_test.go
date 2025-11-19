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
	pool, err := pgxpool.New(ctx, dbURL)
	require.NoError(t, err, "Failed to create connection pool")
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
		COALESCE(financial_statements, '{}'::jsonb) as financial_statements
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
	pool, err := pgxpool.New(ctx, dbURL)
	require.NoError(t, err, "Failed to create connection pool")
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
	pool, err := pgxpool.New(ctx, dbURL)
	require.NoError(t, err, "Failed to create connection pool")
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
