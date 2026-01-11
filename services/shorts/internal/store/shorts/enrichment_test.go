package shorts

import (
	"context"
	"testing"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

// setupEnrichmentTestDatabase creates a PostgreSQL container with the company-metadata table
func setupEnrichmentTestDatabase(t *testing.T) (*pgxpool.Pool, func()) {
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

	// Create schema
	setupEnrichmentSchema(t, pool)

	// Return cleanup function
	cleanup := func() {
		pool.Close()
		if err := postgresContainer.Terminate(ctx); err != nil {
			t.Logf("Failed to terminate container: %v", err)
		}
	}

	return pool, cleanup
}

// setupEnrichmentSchema creates the company-metadata table with all enrichment columns
func setupEnrichmentSchema(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()

	ctx := context.Background()

	createTableSQL := `
	CREATE TABLE IF NOT EXISTS "company-metadata" (
		id SERIAL PRIMARY KEY,
		stock_code VARCHAR(50) UNIQUE NOT NULL,
		company_name VARCHAR(255),
		industry VARCHAR(100),
		address TEXT,
		summary TEXT,
		details TEXT,
		website VARCHAR(500),
		logo_url VARCHAR(500),
		"gcsUrl" TEXT,
		logo_gcs_url TEXT,
		logo_icon_gcs_url TEXT,
		logo_svg_gcs_url TEXT,
		logo_source_url TEXT,
		logo_format VARCHAR(50),
		tags TEXT[],
		enhanced_summary TEXT,
		company_history TEXT,
		key_people JSONB DEFAULT '[]'::jsonb,
		financial_reports JSONB DEFAULT '[]'::jsonb,
		competitive_advantages TEXT,
		risk_factors TEXT,
		recent_developments TEXT,
		social_media_links JSONB DEFAULT '{}'::jsonb,
		enrichment_status VARCHAR(50) DEFAULT 'pending',
		enrichment_date TIMESTAMP WITH TIME ZONE,
		enrichment_error TEXT,
		financial_statements JSONB DEFAULT '{}'::jsonb,
		key_metrics JSONB DEFAULT '{}'::jsonb,
		created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
		updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	);

	CREATE INDEX IF NOT EXISTS idx_metadata_stock_code ON "company-metadata"(stock_code);
	`

	_, err := pool.Exec(ctx, createTableSQL)
	require.NoError(t, err, "Failed to create company-metadata table")
}

// TestApplyEnrichment_RiskFactorsEncoding tests that risk_factors []string is properly encoded
// This test reproduces the issue where passing []string directly to PostgreSQL TEXT column fails
func TestApplyEnrichment_RiskFactorsEncoding(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupEnrichmentTestDatabase(t)
	defer cleanup()

	ctx := context.Background()

	// Create store
	stockDetailsQuery, err := buildStockDetailsQuery(ctx, pool)
	require.NoError(t, err, "Failed to build stock details query")
	store := &postgresStore{
		db:                pool,
		stockDetailsQuery: stockDetailsQuery,
	}

	// Insert a test stock
	stockCode := "CVN"
	insertSQL := `
		INSERT INTO "company-metadata" (stock_code, company_name, industry, website, summary)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (stock_code) DO UPDATE SET
			company_name = EXCLUDED.company_name,
			industry = EXCLUDED.industry,
			website = EXCLUDED.website,
			summary = EXCLUDED.summary
	`
	_, err = pool.Exec(ctx, insertSQL, stockCode, "Carnarvon Energy Limited", "Energy", "https://carnarvon.com.au", "Test company")
	require.NoError(t, err, "Failed to insert test stock")

	// Create enrichment data with risk_factors as []string
	enrichmentData := &shortsv1alpha1.EnrichmentData{
		Tags:                []string{"energy", "oil", "gas", "exploration", "australia"},
		EnhancedSummary:     "Enhanced summary for testing",
		CompanyHistory:      "Company history for testing",
		CompetitiveAdvantages: "Competitive advantages for testing",
		RiskFactors: []string{
			"High concentration risk in the Bedout Basin and a small number of key assets, meaning exploration or development setbacks could materially impact the company's value.",
			"Exposure to commodity price volatility and long development lead times, which can affect project economics, funding options, and investor appetite for small-cap E&P stocks.",
			"Regulatory, environmental, and permitting risks associated with offshore oil and gas development in Australia, including potential delays, cost increases, or policy shifts related to climate and emissions.",
		},
		RecentDevelopments: "Recent developments for testing",
		KeyPeople: []*stocksv1alpha1.CompanyPerson{
			{
				Name: "John Doe",
				Role: "CEO",
				Bio:  "CEO bio",
			},
		},
		FinancialReports: []*stocksv1alpha1.FinancialReport{
			{
				Url:    "https://example.com/report.pdf",
				Title:  "Annual Report 2023",
				Type:   "annual_report",
				Date:   "2023-12-31",
				Source: "crawler",
			},
		},
		SocialMediaLinks: &stocksv1alpha1.SocialMediaLinks{
			Linkedin: "https://linkedin.com/company/cvn",
			Twitter:  "https://twitter.com/cvn",
		},
	}

	// Apply enrichment - this should not fail with encoding error
	err = store.ApplyEnrichment(stockCode, enrichmentData)
	require.NoError(t, err, "ApplyEnrichment should succeed without encoding errors")

	// Verify the enrichment was applied correctly
	details, err := store.GetStockDetails(stockCode)
	require.NoError(t, err, "GetStockDetails should succeed")
	require.NotNil(t, details, "Stock details should not be nil")

	// Verify risk_factors were stored and retrieved correctly
	assert.Equal(t, enrichmentData.RiskFactors, details.RiskFactors, "Risk factors should match")
	assert.Equal(t, len(enrichmentData.RiskFactors), len(details.RiskFactors), "Risk factors count should match")
	if len(enrichmentData.RiskFactors) > 0 {
		assert.Equal(t, enrichmentData.RiskFactors[0], details.RiskFactors[0], "First risk factor should match")
	}

	// Verify other fields
	assert.Equal(t, enrichmentData.Tags, details.Tags, "Tags should match")
	assert.Equal(t, enrichmentData.EnhancedSummary, details.EnhancedSummary, "Enhanced summary should match")
	assert.Equal(t, enrichmentData.CompanyHistory, details.CompanyHistory, "Company history should match")
	assert.Equal(t, enrichmentData.CompetitiveAdvantages, details.CompetitiveAdvantages, "Competitive advantages should match")
	assert.Equal(t, enrichmentData.RecentDevelopments, details.RecentDevelopments, "Recent developments should match")
	assert.Equal(t, "completed", details.EnrichmentStatus, "Enrichment status should be completed")
	assert.NotNil(t, details.EnrichmentDate, "Enrichment date should be set")

	// Verify key people
	assert.Equal(t, len(enrichmentData.KeyPeople), len(details.KeyPeople), "Key people count should match")
	if len(enrichmentData.KeyPeople) > 0 {
		assert.Equal(t, enrichmentData.KeyPeople[0].Name, details.KeyPeople[0].Name, "First key person name should match")
		assert.Equal(t, enrichmentData.KeyPeople[0].Role, details.KeyPeople[0].Role, "First key person role should match")
	}

	// Verify financial reports
	assert.Equal(t, len(enrichmentData.FinancialReports), len(details.FinancialReports), "Financial reports count should match")
	if len(enrichmentData.FinancialReports) > 0 {
		assert.Equal(t, enrichmentData.FinancialReports[0].Url, details.FinancialReports[0].Url, "First report URL should match")
		assert.Equal(t, enrichmentData.FinancialReports[0].Title, details.FinancialReports[0].Title, "First report title should match")
	}

	// Verify social media links
	if enrichmentData.SocialMediaLinks != nil {
		assert.NotNil(t, details.SocialMediaLinks, "Social media links should not be nil")
		if details.SocialMediaLinks != nil {
			assert.Equal(t, enrichmentData.SocialMediaLinks.Linkedin, details.SocialMediaLinks.Linkedin, "LinkedIn should match")
			assert.Equal(t, enrichmentData.SocialMediaLinks.Twitter, details.SocialMediaLinks.Twitter, "Twitter should match")
		}
	}
}

// TestApplyEnrichment_EmptyRiskFactors tests that empty risk_factors are handled correctly
func TestApplyEnrichment_EmptyRiskFactors(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupEnrichmentTestDatabase(t)
	defer cleanup()

	ctx := context.Background()

	// Create store
	stockDetailsQuery, err := buildStockDetailsQuery(ctx, pool)
	require.NoError(t, err, "Failed to build stock details query")
	store := &postgresStore{
		db:                pool,
		stockDetailsQuery: stockDetailsQuery,
	}

	// Insert a test stock
	stockCode := "TEST"
	insertSQL := `
		INSERT INTO "company-metadata" (stock_code, company_name)
		VALUES ($1, $2)
		ON CONFLICT (stock_code) DO UPDATE SET
			company_name = EXCLUDED.company_name
	`
	_, err = pool.Exec(ctx, insertSQL, stockCode, "Test Company")
	require.NoError(t, err, "Failed to insert test stock")

	// Create enrichment data with empty risk_factors
	enrichmentData := &shortsv1alpha1.EnrichmentData{
		Tags:            []string{"test"},
		EnhancedSummary: "Test summary",
		RiskFactors:     []string{}, // Empty array
	}

	// Apply enrichment - should not fail
	err = store.ApplyEnrichment(stockCode, enrichmentData)
	require.NoError(t, err, "ApplyEnrichment should succeed with empty risk_factors")

	// Verify the enrichment was applied
	details, err := store.GetStockDetails(stockCode)
	require.NoError(t, err, "GetStockDetails should succeed")
	// Empty array may be stored as empty JSON array "[]" or null, both are valid
	if details.RiskFactors != nil {
		assert.Equal(t, 0, len(details.RiskFactors), "Risk factors should be empty if not nil")
	}
}

// TestApplyEnrichment_NilRiskFactors tests that nil risk_factors are handled correctly
func TestApplyEnrichment_NilRiskFactors(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupEnrichmentTestDatabase(t)
	defer cleanup()

	ctx := context.Background()

	// Create store
	stockDetailsQuery, err := buildStockDetailsQuery(ctx, pool)
	require.NoError(t, err, "Failed to build stock details query")
	store := &postgresStore{
		db:                pool,
		stockDetailsQuery: stockDetailsQuery,
	}

	// Insert a test stock
	stockCode := "TEST2"
	insertSQL := `
		INSERT INTO "company-metadata" (stock_code, company_name)
		VALUES ($1, $2)
		ON CONFLICT (stock_code) DO UPDATE SET
			company_name = EXCLUDED.company_name
	`
	_, err = pool.Exec(ctx, insertSQL, stockCode, "Test Company 2")
	require.NoError(t, err, "Failed to insert test stock")

	// Create enrichment data with nil risk_factors
	enrichmentData := &shortsv1alpha1.EnrichmentData{
		Tags:            []string{"test"},
		EnhancedSummary: "Test summary",
		RiskFactors:     nil, // Nil array
	}

	// Apply enrichment - should not fail
	err = store.ApplyEnrichment(stockCode, enrichmentData)
	require.NoError(t, err, "ApplyEnrichment should succeed with nil risk_factors")

	// Verify the enrichment was applied
	details, err := store.GetStockDetails(stockCode)
	require.NoError(t, err, "GetStockDetails should succeed")
	// Risk factors should be empty or nil
	if details.RiskFactors != nil {
		assert.Equal(t, 0, len(details.RiskFactors), "Risk factors should be empty if not nil")
	}
}

// TestGetPendingEnrichmentByStockCode tests the GetPendingEnrichmentByStockCode method
func TestGetPendingEnrichmentByStockCode(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupEnrichmentTestDatabase(t)
	defer cleanup()

	ctx := context.Background()

	// Create store
	stockDetailsQuery, err := buildStockDetailsQuery(ctx, pool)
	require.NoError(t, err, "Failed to build stock details query")
	store := &postgresStore{
		db:                pool,
		stockDetailsQuery: stockDetailsQuery,
	}

	// Create enrichment-pending table
	createPendingTableSQL := `
	CREATE TABLE IF NOT EXISTS "enrichment-pending" (
		enrichment_id UUID PRIMARY KEY,
		stock_code VARCHAR(50) NOT NULL,
		enrichment_data JSONB NOT NULL,
		quality_score JSONB NOT NULL,
		status VARCHAR(50) NOT NULL DEFAULT 'pending_review',
		created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
		reviewed_at TIMESTAMP WITH TIME ZONE,
		reviewed_by VARCHAR(255),
		review_notes TEXT
	);

	CREATE INDEX IF NOT EXISTS idx_enrichment_pending_stock_code ON "enrichment-pending"(stock_code);
	CREATE INDEX IF NOT EXISTS idx_enrichment_pending_status ON "enrichment-pending"(status);
	`
	_, err = pool.Exec(ctx, createPendingTableSQL)
	require.NoError(t, err, "Failed to create enrichment-pending table")

	stockCode := "TEST3"
	enrichmentID := "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"

	// Test 1: No pending enrichment exists - should return nil
	pending, err := store.GetPendingEnrichmentByStockCode(stockCode)
	assert.NoError(t, err, "Should not error when no pending enrichment exists")
	assert.Nil(t, pending, "Should return nil when no pending enrichment exists")

	// Insert a pending enrichment
	enrichmentData := &shortsv1alpha1.EnrichmentData{
		EnhancedSummary: "Test summary",
		Tags:            []string{"test"},
	}
	qualityScore := &shortsv1alpha1.QualityScore{
		OverallScore: 0.8,
	}

	returnedID, err := store.SavePendingEnrichment(
		enrichmentID,
		stockCode,
		shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_PENDING_REVIEW,
		enrichmentData,
		qualityScore,
	)
	require.NoError(t, err, "Failed to save pending enrichment")
	assert.Equal(t, enrichmentID, returnedID, "Should return the provided ID when no existing pending enrichment")

	// Test 2: Pending enrichment exists - should return it
	pending, err = store.GetPendingEnrichmentByStockCode(stockCode)
	assert.NoError(t, err, "Should not error when pending enrichment exists")
	assert.NotNil(t, pending, "Should return pending enrichment")
	assert.Equal(t, enrichmentID, pending.EnrichmentId, "Enrichment ID should match")
	assert.Equal(t, stockCode, pending.StockCode, "Stock code should match")
	assert.Equal(t, shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_PENDING_REVIEW, pending.Status, "Status should be pending_review")
	assert.NotNil(t, pending.QualityScore, "Quality score should not be nil")
	assert.Equal(t, qualityScore.OverallScore, pending.QualityScore.OverallScore, "Quality score should match")

	// Test 3: Saving another enrichment for the same stock updates the existing one
	// (This is by design - SavePendingEnrichment prevents duplicates by updating existing pending reviews)
	enrichmentID2 := "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
	returnedID2, err := store.SavePendingEnrichment(
		enrichmentID2,
		stockCode,
		shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_PENDING_REVIEW,
		enrichmentData,
		qualityScore,
	)
	require.NoError(t, err, "Failed to save second pending enrichment")
	// Should return the original ID, not the new one (because existing pending review is updated)
	assert.Equal(t, enrichmentID, returnedID2, "Should return original ID when updating existing pending enrichment")

	// Wait a bit to ensure different timestamps
	time.Sleep(100 * time.Millisecond)

	pending, err = store.GetPendingEnrichmentByStockCode(stockCode)
	assert.NoError(t, err, "Should not error")
	assert.NotNil(t, pending, "Should return pending enrichment")
	// SavePendingEnrichment updates existing pending reviews, so it should return the original ID
	// (the method reuses existing enrichment_id when updating)
	assert.Equal(t, enrichmentID, pending.EnrichmentId, "Should return the updated enrichment (original ID reused)")

	// Test 4: Pending enrichment with different status - should not return it
	enrichmentID3 := "cccccccc-cccc-cccc-cccc-cccccccccccc"
	_, err = store.SavePendingEnrichment(
		enrichmentID3,
		"TEST4",
		shortsv1alpha1.EnrichmentStatus_ENRICHMENT_STATUS_COMPLETED,
		enrichmentData,
		qualityScore,
	)
	require.NoError(t, err, "Failed to save completed enrichment")

	pending, err = store.GetPendingEnrichmentByStockCode("TEST4")
	assert.NoError(t, err, "Should not error")
	assert.Nil(t, pending, "Should return nil for non-pending_review status (only returns pending_review)")

	// Test 5: Different stock code - should return nil
	pending, err = store.GetPendingEnrichmentByStockCode("DIFFERENT")
	assert.NoError(t, err, "Should not error")
	assert.Nil(t, pending, "Should return nil for different stock code")
}


