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
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestDatabaseSetup tests that the PostgreSQL container setup works correctly
func TestDatabaseSetup(t *testing.T) {
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

		// Test that test data was loaded
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
	WithTestDatabase(t, func(container *TestContainer) {
		ctx := context.Background()

		// Test querying shorts data
		rows, err := container.DB.Query(ctx, `
			SELECT product_code, product_name, percent_of_total_shares 
			FROM shorts 
			WHERE date = '2024-01-15' 
			ORDER BY percent_of_total_shares DESC 
			LIMIT 5
		`)
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
			JOIN "company-metadata" m ON s.product_code = m.stock_code 
			WHERE s.product_code = 'CBA' 
			LIMIT 1
		`).Scan(&companyName)
		require.NoError(t, err)
		assert.Contains(t, strings.ToLower(companyName), "commonwealth", "CBA should be Commonwealth Bank")
	})
}

// TestShortsServiceIntegration tests the API when the service is available
func TestShortsServiceIntegration(t *testing.T) {
	// Check if we're testing against a running service
	apiURL := os.Getenv("SHORTS_API_URL")
	if apiURL == "" {
		apiURL = "http://localhost:9091"
	}

	// Quick check if service is available
	resp, err := http.Get(apiURL + "/health")
	if err != nil || resp.StatusCode != 200 {
		t.Skip("Shorts service not available at", apiURL, "- skipping API tests")
		return
	}
	resp.Body.Close()

	// Create client for the running service
	client := shortsv1alpha1connect.NewShortedStocksServiceClient(
		http.DefaultClient,
		apiURL,
	)

	ctx := context.Background()

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

		t.Run("ShortsDataIntegrity", func(t *testing.T) {
			// Test that all shorts have corresponding dates and valid percentages
			var invalidCount int
			err := container.DB.QueryRow(ctx, `
				SELECT COUNT(*) FROM shorts 
				WHERE percent_of_total_shares < 0 OR percent_of_total_shares > 100
			`).Scan(&invalidCount)
			require.NoError(t, err)
			assert.Equal(t, 0, invalidCount, "No shorts should have invalid percentages")

			// Test that we have multiple dates
			var dateCount int
			err = container.DB.QueryRow(ctx, "SELECT COUNT(DISTINCT date) FROM shorts").Scan(&dateCount)
			require.NoError(t, err)
			assert.Greater(t, dateCount, 1, "Should have multiple dates in test data")
		})

		t.Run("MetadataConsistency", func(t *testing.T) {
			// Test that all stocks in shorts have metadata
			var orphanCount int
			err := container.DB.QueryRow(ctx, `
				SELECT COUNT(DISTINCT s.product_code) 
				FROM shorts s 
				LEFT JOIN "company-metadata" m ON s.product_code = m.stock_code 
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

		t.Run("QueryResponseTime", func(t *testing.T) {
			start := time.Now()
			
			rows, err := container.DB.Query(ctx, `
				SELECT s.product_code, s.percent_of_total_shares, m.company_name
				FROM shorts s
				JOIN "company-metadata" m ON s.product_code = m.stock_code
				WHERE s.date = '2024-01-15'
				ORDER BY s.percent_of_total_shares DESC
				LIMIT 10
			`)
			
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

		// Seed sample data again
		container.SeedSampleData(ctx, t)

		// Verify sample data is there
		err = container.DB.QueryRow(ctx, "SELECT COUNT(*) FROM shorts WHERE product_code = 'CBA'").Scan(&count)
		require.NoError(t, err)
		assert.Greater(t, count, 0)
	})
}