package integration

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsv1alpha1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
	"github.com/castlemilk/shorted.com.au/services/test/integration/testdata"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestDatabaseSetup tests that the PostgreSQL container setup works correctly
func TestDatabaseSetup(t *testing.T) {
	t.Parallel() // Enable parallel execution - each test gets its own container with random port
	WithTestDatabase(t, func(container *TestContainer) {
		ctx := context.Background()

		// Test database connection
		err := container.DB.Ping(ctx)
		require.NoError(t, err, "Database should be accessible")

		// Test that tables exist
		tables := []string{"shorts", "\"company-metadata\"", "subscriptions"}
		for _, table := range tables {
			var count int
			err := container.DB.QueryRow(ctx, fmt.Sprintf("SELECT COUNT(*) FROM %s", table)).Scan(&count)
			require.NoError(t, err, "Table %s should exist and be queryable", table)
		}

		// Seed test data
		seeder := container.GetSeeder()
		
		// Generate test data for today
		today := time.Now().Truncate(24 * time.Hour)
		shorts, metadata := testdata.GetTopShortsTestData(10, today)
		
		// Insert test data
		err = seeder.SeedShorts(ctx, shorts)
		require.NoError(t, err, "Should be able to seed shorts data")
		
		err = seeder.SeedCompanyMetadata(ctx, metadata)
		require.NoError(t, err, "Should be able to seed company metadata")

		// Verify test data was loaded
		var shortCount int
		err = container.DB.QueryRow(ctx, "SELECT COUNT(*) FROM shorts").Scan(&shortCount)
		require.NoError(t, err)
		assert.Greater(t, shortCount, 0, "Test data should be loaded into shorts table")

		var metadataCount int
		err = container.DB.QueryRow(ctx, "SELECT COUNT(*) FROM \"company-metadata\"").Scan(&metadataCount)
		require.NoError(t, err)
		assert.Greater(t, metadataCount, 0, "Test data should be loaded into metadata table")
	})
}

// TestDatabaseOperations tests basic database operations
func TestDatabaseOperations(t *testing.T) {
	t.Parallel() // Enable parallel execution - each test gets its own container with random port
	WithTestDatabase(t, func(container *TestContainer) {
		ctx := context.Background()
		seeder := container.GetSeeder()

		// Seed test data with comprehensive CBA data
		testDate := time.Date(2024, 1, 15, 0, 0, 0, 0, time.UTC)
		shorts, metadata, _ := testdata.GetCBATestData(testDate, 30)

		// Seed the data
		err := seeder.SeedCompanyMetadata(ctx, []testdata.CompanyMetadata{metadata})
		require.NoError(t, err)
		
		err = seeder.SeedShorts(ctx, shorts)
		require.NoError(t, err)

		// Test querying shorts data
		rows, err := container.DB.Query(ctx, `
			SELECT "PRODUCT_CODE", "PRODUCT", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" 
			FROM shorts 
			WHERE "DATE" = $1
			ORDER BY "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DESC 
			LIMIT 5
		`, testDate)
		require.NoError(t, err)
		defer rows.Close()

		stocksFound := 0
		for rows.Next() {
			var productCode, productName string
			var percentShorted float64

			err := rows.Scan(&productCode, &productName, &percentShorted)
			require.NoError(t, err)

			assert.NotEmpty(t, productCode, "Product code should not be empty")
			assert.NotEmpty(t, productName, "Product name should not be empty")
			assert.Greater(t, percentShorted, 0.0, "Percent shorted should be positive")

			stocksFound++
		}
		assert.Greater(t, stocksFound, 0, "Should find some stocks in test data")

		// Test joining with metadata
		var companyName string
		err = container.DB.QueryRow(ctx, `
			SELECT m.company_name 
			FROM shorts s 
			JOIN "company-metadata" m ON s."PRODUCT_CODE" = m.stock_code 
			WHERE s."PRODUCT_CODE" = 'CBA' 
			LIMIT 1
		`).Scan(&companyName)
		require.NoError(t, err)
		assert.Contains(t, strings.ToLower(companyName), "commonwealth", "CBA should be Commonwealth Bank")
	})
}

// TestShortsServiceIntegration tests the API with a test database and seeded data
func TestShortsServiceIntegration(t *testing.T) {
	// Skip if explicitly disabled
	if os.Getenv("SKIP_SERVICE_TESTS") != "" {
		t.Skip("Skipping service tests as SKIP_SERVICE_TESTS is set")
	}

	WithTestDatabase(t, func(container *TestContainer) {
		ctx := context.Background()
		seeder := container.GetSeeder()

		// Seed test data
		testDate := time.Now().Truncate(24 * time.Hour)
		stockCodes := []string{"CBA", "BHP", "CSL", "WBC", "NAB"}
		shorts, metadata, _ := testdata.GetMultipleStocksTestData(stockCodes, testDate.AddDate(0, 0, -30), 30)
		
		// Seed the database
		require.NoError(t, seeder.SeedCompanyMetadata(ctx, metadata))
		require.NoError(t, seeder.SeedShorts(ctx, shorts))

		// Note: This test suite now runs against seeded data in a testcontainer
		// If testing against an external running service, set SHORTS_API_URL
		apiURL := os.Getenv("SHORTS_API_URL")
		if apiURL != "" {
			// Testing against external service
			resp, err := http.Get(apiURL + "/health")
			if err != nil || resp.StatusCode != 200 {
				t.Skip("Shorts service not available at", apiURL)
				return
			}
			_ = resp.Body.Close()

			client := shortsv1alpha1connect.NewShortedStocksServiceClient(
				http.DefaultClient,
				apiURL,
			)

			t.Run("GetTopShorts", func(t *testing.T) {
				testGetTopShorts(t, ctx, client)
			})

			t.Run("GetStock", func(t *testing.T) {
				testGetStock(t, ctx, client)
			})

			t.Run("GetStockData", func(t *testing.T) {
				testGetStockData(t, ctx, client)
			})

			t.Run("GetStockDetails", func(t *testing.T) {
				testGetStockDetails(t, ctx, client)
			})

			t.Run("GetIndustryTreeMap", func(t *testing.T) {
				testGetIndustryTreeMap(t, ctx, client)
			})

			t.Run("ErrorHandling", func(t *testing.T) {
				testErrorHandling(t, ctx, client)
			})
		} else {
			// CI mode: Just verify database is set up correctly
			// Full service tests are in TestShortsServiceWithSeededData
			t.Log("No SHORTS_API_URL set - database setup verified, skipping API tests")
			t.Log("Use TestShortsServiceWithSeededData for full service integration tests")
			
			// Verify data was seeded
			var count int
			err := container.DB.QueryRow(ctx, "SELECT COUNT(*) FROM shorts").Scan(&count)
			require.NoError(t, err)
			assert.Greater(t, count, 0, "Should have seeded short data")
		}
	})
}

func testGetTopShorts(t *testing.T, ctx context.Context, client shortsv1alpha1connect.ShortedStocksServiceClient) {
	t.Run("ValidRequest", func(t *testing.T) {
		req := connect.NewRequest(&shortsv1alpha1.GetTopShortsRequest{
			Period: "1d",
			Limit:  5,
			Offset: 0,
		})

		resp, err := client.GetTopShorts(ctx, req)
		require.NoError(t, err)
		require.NotNil(t, resp.Msg)

		// Validate response structure
		assert.GreaterOrEqual(t, len(resp.Msg.TimeSeries), 1)
		assert.LessOrEqual(t, len(resp.Msg.TimeSeries), 5)

		// Validate that we get stocks with proper data
		for _, timeSeries := range resp.Msg.TimeSeries {
			assert.NotEmpty(t, timeSeries.ProductCode)
			assert.NotEmpty(t, timeSeries.Name)
			assert.GreaterOrEqual(t, timeSeries.LatestShortPosition, 0.0)
		}
	})

	t.Run("DifferentPeriods", func(t *testing.T) {
		periods := []string{"1d", "1w", "1m"}

		for _, period := range periods {
			t.Run("Period_"+period, func(t *testing.T) {
				req := connect.NewRequest(&shortsv1alpha1.GetTopShortsRequest{
					Period: period,
					Limit:  3,
					Offset: 0,
				})

				resp, err := client.GetTopShorts(ctx, req)
				require.NoError(t, err)
				require.NotNil(t, resp.Msg)
			})
		}
	})
}

func testGetStock(t *testing.T, ctx context.Context, client shortsv1alpha1connect.ShortedStocksServiceClient) {
	t.Run("ValidStock", func(t *testing.T) {
		req := connect.NewRequest(&shortsv1alpha1.GetStockRequest{
			ProductCode: "CBA",
		})

		resp, err := client.GetStock(ctx, req)
		require.NoError(t, err)
		require.NotNil(t, resp.Msg)

		// Validate stock data
		assert.Equal(t, "CBA", resp.Msg.ProductCode)
		assert.NotEmpty(t, resp.Msg.Name)
		assert.Greater(t, resp.Msg.TotalProductInIssue, float32(0))
		assert.Greater(t, resp.Msg.ReportedShortPositions, float32(0))
		assert.Greater(t, resp.Msg.PercentageShorted, float32(0))
	})
}

func testGetStockData(t *testing.T, ctx context.Context, client shortsv1alpha1connect.ShortedStocksServiceClient) {
	t.Run("ValidStockData", func(t *testing.T) {
		req := connect.NewRequest(&shortsv1alpha1.GetStockDataRequest{
			ProductCode: "CBA",
			Period:      "1w",
		})

		resp, err := client.GetStockData(ctx, req)
		require.NoError(t, err)
		require.NotNil(t, resp.Msg)

		// Validate time series data
		assert.Equal(t, "CBA", resp.Msg.ProductCode)
		assert.NotEmpty(t, resp.Msg.Name)
		assert.Greater(t, resp.Msg.LatestShortPosition, 0.0)

		// Validate points are ordered by time if they exist
		if len(resp.Msg.Points) > 1 {
			for i := 1; i < len(resp.Msg.Points); i++ {
				currentTime := resp.Msg.Points[i].Timestamp.AsTime()
				previousTime := resp.Msg.Points[i-1].Timestamp.AsTime()
				assert.True(t, currentTime.After(previousTime) || currentTime.Equal(previousTime))
			}
		}
	})
}

func testGetStockDetails(t *testing.T, ctx context.Context, client shortsv1alpha1connect.ShortedStocksServiceClient) {
	t.Run("ValidStockDetails", func(t *testing.T) {
		req := connect.NewRequest(&shortsv1alpha1.GetStockDetailsRequest{
			ProductCode: "CBA",
		})

		resp, err := client.GetStockDetails(ctx, req)
		require.NoError(t, err)
		require.NotNil(t, resp.Msg)

		// Validate stock details
		assert.Equal(t, "CBA", resp.Msg.ProductCode)
		assert.NotEmpty(t, resp.Msg.CompanyName)
	})
}

func testGetIndustryTreeMap(t *testing.T, ctx context.Context, client shortsv1alpha1connect.ShortedStocksServiceClient) {
	t.Run("ValidTreeMap", func(t *testing.T) {
		req := connect.NewRequest(&shortsv1alpha1.GetIndustryTreeMapRequest{
			Period:   "1d",
			Limit:    10,
			ViewMode: shortsv1alpha1.ViewMode_CURRENT_CHANGE,
		})

		resp, err := client.GetIndustryTreeMap(ctx, req)
		require.NoError(t, err)
		require.NotNil(t, resp.Msg)

		// Basic validation - may be empty if no data
		assert.NotNil(t, resp.Msg.Industries)
		assert.NotNil(t, resp.Msg.Stocks)
	})
}

func testErrorHandling(t *testing.T, ctx context.Context, client shortsv1alpha1connect.ShortedStocksServiceClient) {
	t.Run("NonExistentStock", func(t *testing.T) {
		req := connect.NewRequest(&shortsv1alpha1.GetStockRequest{
			ProductCode: "NONEXISTENT",
		})

		_, err := client.GetStock(ctx, req)
		require.Error(t, err)

		var connectErr *connect.Error
		require.ErrorAs(t, err, &connectErr)
		assert.Equal(t, connect.CodeNotFound, connectErr.Code())
	})

	t.Run("EmptyProductCode", func(t *testing.T) {
		req := connect.NewRequest(&shortsv1alpha1.GetStockRequest{
			ProductCode: "",
		})

		_, err := client.GetStock(ctx, req)
		require.Error(t, err)

		var connectErr *connect.Error
		require.ErrorAs(t, err, &connectErr)
		assert.Equal(t, connect.CodeInvalidArgument, connectErr.Code())
	})
}

// TestDataConsistency tests database data integrity
func TestDataConsistency(t *testing.T) {
	WithTestDatabase(t, func(container *TestContainer) {
		ctx := context.Background()
		seeder := container.GetSeeder()

		// Seed test data with multiple dates
		testDate := time.Date(2024, 1, 15, 0, 0, 0, 0, time.UTC)
		stockCodes := []string{"CBA", "BHP", "CSL"}
		shorts, metadata, _ := testdata.GetMultipleStocksTestData(stockCodes, testDate, 5)
		
		err := seeder.SeedCompanyMetadata(ctx, metadata)
		require.NoError(t, err)
		
		err = seeder.SeedShorts(ctx, shorts)
		require.NoError(t, err)

		t.Run("ShortsDataIntegrity", func(t *testing.T) {
			// Test that all shorts have corresponding dates and valid percentages
			var invalidCount int
			err := container.DB.QueryRow(ctx, `
			SELECT COUNT(*) FROM shorts 
			WHERE "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" < 0 OR "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 100
			`).Scan(&invalidCount)
			require.NoError(t, err)
			assert.Equal(t, 0, invalidCount, "No shorts should have invalid percentages")

			// Test that we have multiple dates
			var dateCount int
			err = container.DB.QueryRow(ctx, "SELECT COUNT(DISTINCT \"DATE\") FROM shorts").Scan(&dateCount)
			require.NoError(t, err)
			assert.Greater(t, dateCount, 1, "Should have multiple dates in test data")
		})

		t.Run("MetadataConsistency", func(t *testing.T) {
			// Test that all stocks in shorts have metadata
			var orphanCount int
			err := container.DB.QueryRow(ctx, `
				SELECT COUNT(DISTINCT s."PRODUCT_CODE") 
				FROM shorts s 
				LEFT JOIN "company-metadata" m ON s."PRODUCT_CODE" = m.stock_code 
				WHERE m.stock_code IS NULL
			`).Scan(&orphanCount)
			require.NoError(t, err)
			assert.Equal(t, 0, orphanCount, "All stocks should have metadata")
		})
	})
}

// TestPerformance tests basic database performance
func TestPerformance(t *testing.T) {
	WithTestDatabase(t, func(container *TestContainer) {
		ctx := context.Background()
		seeder := container.GetSeeder()

		// Seed test data for performance testing
		testDate := time.Date(2024, 1, 15, 0, 0, 0, 0, time.UTC)
		stockCodes := testdata.GetSampleStocks()
		shorts, metadata, _ := testdata.GetMultipleStocksTestData(stockCodes, testDate, 1)
		
		err := seeder.SeedCompanyMetadata(ctx, metadata)
		require.NoError(t, err)
		
		err = seeder.SeedShorts(ctx, shorts)
		require.NoError(t, err)

		t.Run("QueryResponseTime", func(t *testing.T) {
			start := time.Now()

			rows, err := container.DB.Query(ctx, `
				SELECT s."PRODUCT_CODE", s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS", m.company_name
				FROM shorts s
				JOIN "company-metadata" m ON s."PRODUCT_CODE" = m.stock_code
				WHERE s."DATE" = $1
				ORDER BY s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DESC
				LIMIT 10
			`, testDate)

			duration := time.Since(start)

			require.NoError(t, err)
			rows.Close()

			// Query should complete quickly with test data
			assert.Less(t, duration, 500*time.Millisecond, "Query should be fast with test data")
		})
	})
}

// TestCleanup tests that test utilities work correctly
func TestCleanup(t *testing.T) {
	WithTestDatabase(t, func(container *TestContainer) {
		ctx := context.Background()

		// Insert some test data
		container.ExecuteSQL(ctx, t, "INSERT INTO subscriptions (email) VALUES ('test@cleanup.com')")

		// Verify data exists
		var count int
		err := container.DB.QueryRow(ctx, "SELECT COUNT(*) FROM subscriptions WHERE email = 'test@cleanup.com'").Scan(&count)
		require.NoError(t, err)
		assert.Equal(t, 1, count)

		// Test cleanup
		container.TruncateAllTables(ctx, t)

		// Verify data is gone
		err = container.DB.QueryRow(ctx, "SELECT COUNT(*) FROM subscriptions WHERE email = 'test@cleanup.com'").Scan(&count)
		require.NoError(t, err)
		assert.Equal(t, 0, count)

		// Seed sample data again using the new seeder
		seeder := container.GetSeeder()
		testDate := time.Now().Truncate(24 * time.Hour)
		shorts, metadata := testdata.GetTopShortsTestData(5, testDate)
		
		err = seeder.SeedCompanyMetadata(ctx, metadata)
		require.NoError(t, err)
		
		err = seeder.SeedShorts(ctx, shorts)
		require.NoError(t, err)

		// Verify sample data is there
		err = container.DB.QueryRow(ctx, "SELECT COUNT(*) FROM shorts WHERE \"PRODUCT_CODE\" = 'CBA'").Scan(&count)
		require.NoError(t, err)
		assert.Greater(t, count, 0)
	})
}
