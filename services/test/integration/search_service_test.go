package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"testing"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsv1alpha1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
	"github.com/castlemilk/shorted.com.au/services/test/integration/testdata"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestSearchStocksRPC tests the SearchStocks RPC endpoint via Connect client
func TestSearchStocksRPC(t *testing.T) {
	// Skip if no service URL is provided
	apiURL := os.Getenv("SHORTS_API_URL")
	if apiURL == "" {
		t.Skip("SHORTS_API_URL not set - skipping RPC integration tests")
	}

	WithTestDatabase(t, func(container *TestContainer) {
		ctx := context.Background()
		seeder := container.GetSeeder()

		// Seed comprehensive test data with different industries and tags
		testDate := time.Now().Truncate(24 * time.Hour)
		stockCodes := []string{"CBA", "BHP", "CSL", "WBC", "NAB"}
		shorts, metadata, _ := testdata.GetMultipleStocksTestData(stockCodes, testDate.AddDate(0, 0, -30), 30)

		// Customize metadata for search testing
		for i := range metadata {
			switch metadata[i].StockCode {
			case "BHP":
				metadata[i].Industry = "Mining"
				metadata[i].Tags = []string{"mining", "resources", "iron-ore", "copper", "commodities"}
				metadata[i].Description = "World's largest mining company producing iron ore and copper"
			case "CSL":
				metadata[i].Industry = "Biotechnology"
				metadata[i].Tags = []string{"healthcare", "biotech", "pharma", "plasma"}
				metadata[i].Description = "Global biotechnology company specializing in blood plasma products"
			case "CBA":
				metadata[i].Industry = "Banks"
				metadata[i].Tags = []string{"banking", "financial-services", "mortgages"}
				metadata[i].Description = "Australia's largest bank by market capitalization"
			case "WBC":
				metadata[i].Industry = "Banks"
				metadata[i].Tags = []string{"banking", "financial-services", "retail-banking"}
			case "NAB":
				metadata[i].Industry = "Banks"
				metadata[i].Tags = []string{"banking", "financial-services", "business-banking"}
			}
		}

		require.NoError(t, seeder.SeedCompanyMetadata(ctx, metadata))
		require.NoError(t, seeder.SeedShorts(ctx, shorts))

		// Wait for service to be ready
		if !waitForServiceHealth(apiURL, 10*time.Second) {
			t.Fatalf("Service not available at %s", apiURL)
		}

		// Create Connect RPC client
		client := shortsv1alpha1connect.NewShortedStocksServiceClient(
			http.DefaultClient,
			apiURL,
		)

		t.Run("SearchByStockCode", func(t *testing.T) {
			req := connect.NewRequest(&shortsv1alpha1.SearchStocksRequest{
				Query: "BHP",
				Limit: 10,
			})

			resp, err := client.SearchStocks(ctx, req)
			require.NoError(t, err)
			require.NotNil(t, resp.Msg)

			assert.Equal(t, "BHP", resp.Msg.Query)
			assert.Greater(t, resp.Msg.Count, int32(0), "Should find at least one stock")

			// BHP should be the first result (exact match)
			if len(resp.Msg.Stocks) > 0 {
				assert.Equal(t, "BHP", resp.Msg.Stocks[0].ProductCode)
			}
		})

		t.Run("SearchByIndustry", func(t *testing.T) {
			req := connect.NewRequest(&shortsv1alpha1.SearchStocksRequest{
				Query: "Mining",
				Limit: 10,
			})

			resp, err := client.SearchStocks(ctx, req)
			require.NoError(t, err)
			require.NotNil(t, resp.Msg)

			// Should find mining stocks
			foundBHP := false
			for _, stock := range resp.Msg.Stocks {
				if stock.ProductCode == "BHP" {
					foundBHP = true
					break
				}
			}
			assert.True(t, foundBHP, "Should find BHP when searching for Mining")
		})

		t.Run("SearchByTag", func(t *testing.T) {
			req := connect.NewRequest(&shortsv1alpha1.SearchStocksRequest{
				Query: "biotech",
				Limit: 10,
			})

			resp, err := client.SearchStocks(ctx, req)
			require.NoError(t, err)
			require.NotNil(t, resp.Msg)

			// Should find CSL
			foundCSL := false
			for _, stock := range resp.Msg.Stocks {
				if stock.ProductCode == "CSL" {
					foundCSL = true
					break
				}
			}
			assert.True(t, foundCSL, "Should find CSL when searching for biotech")
		})

		t.Run("SearchPartialMatch", func(t *testing.T) {
			req := connect.NewRequest(&shortsv1alpha1.SearchStocksRequest{
				Query: "Common", // Partial match for Commonwealth
				Limit: 10,
			})

			resp, err := client.SearchStocks(ctx, req)
			require.NoError(t, err)
			require.NotNil(t, resp.Msg)

			// Should find CBA
			foundCBA := false
			for _, stock := range resp.Msg.Stocks {
				if stock.ProductCode == "CBA" {
					foundCBA = true
					break
				}
			}
			assert.True(t, foundCBA, "Should find CBA when searching for 'Common'")
		})

		t.Run("SearchCaseInsensitive", func(t *testing.T) {
			req := connect.NewRequest(&shortsv1alpha1.SearchStocksRequest{
				Query: "miNiNg",
				Limit: 10,
			})

			resp, err := client.SearchStocks(ctx, req)
			require.NoError(t, err)
			require.NotNil(t, resp.Msg)

			// Should find BHP regardless of case
			foundBHP := false
			for _, stock := range resp.Msg.Stocks {
				if stock.ProductCode == "BHP" {
					foundBHP = true
					break
				}
			}
			assert.True(t, foundBHP, "Should find BHP with case-insensitive search")
		})

		t.Run("SearchLimitRespected", func(t *testing.T) {
			req := connect.NewRequest(&shortsv1alpha1.SearchStocksRequest{
				Query: "Bank", // Should match multiple banks
				Limit: 2,
			})

			resp, err := client.SearchStocks(ctx, req)
			require.NoError(t, err)
			require.NotNil(t, resp.Msg)

			assert.LessOrEqual(t, len(resp.Msg.Stocks), 2, "Should respect limit")
		})

		t.Run("SearchNoResults", func(t *testing.T) {
			req := connect.NewRequest(&shortsv1alpha1.SearchStocksRequest{
				Query: "NonExistentCompanyXYZ123",
				Limit: 10,
			})

			resp, err := client.SearchStocks(ctx, req)
			require.NoError(t, err)
			require.NotNil(t, resp.Msg)

			assert.Equal(t, int32(0), resp.Msg.Count, "Should return zero results for non-existent query")
			assert.Empty(t, resp.Msg.Stocks)
		})

		t.Run("SearchEmptyQuery", func(t *testing.T) {
			req := connect.NewRequest(&shortsv1alpha1.SearchStocksRequest{
				Query: "",
				Limit: 10,
			})

			_, err := client.SearchStocks(ctx, req)
			// Empty query should return an error
			require.Error(t, err)

			var connectErr *connect.Error
			require.ErrorAs(t, err, &connectErr)
			assert.Equal(t, connect.CodeInvalidArgument, connectErr.Code())
		})

		t.Run("SearchReturnsMetadata", func(t *testing.T) {
			req := connect.NewRequest(&shortsv1alpha1.SearchStocksRequest{
				Query:          "BHP",
				Limit:          1,
				IncludeDetails: true,
			})

			resp, err := client.SearchStocks(ctx, req)
			require.NoError(t, err)
			require.NotNil(t, resp.Msg)
			require.Len(t, resp.Msg.Stocks, 1)

			stock := resp.Msg.Stocks[0]
			assert.Equal(t, "BHP", stock.ProductCode)
			assert.NotEmpty(t, stock.Name, "Should return stock name")
			assert.NotEmpty(t, stock.Industry, "Should return industry")
			assert.NotEmpty(t, stock.Tags, "Should return tags")
		})
	})
}

// TestSearchStocksHTTPAPI tests the /api/stocks/search HTTP endpoint
func TestSearchStocksHTTPAPI(t *testing.T) {
	apiURL := os.Getenv("SHORTS_API_URL")
	if apiURL == "" {
		t.Skip("SHORTS_API_URL not set - skipping HTTP API integration tests")
	}

	WithTestDatabase(t, func(container *TestContainer) {
		ctx := context.Background()
		seeder := container.GetSeeder()

		// Seed test data
		testDate := time.Now().Truncate(24 * time.Hour)
		stockCodes := []string{"CBA", "BHP", "CSL"}
		shorts, metadata, _ := testdata.GetMultipleStocksTestData(stockCodes, testDate, 1)

		// Customize metadata
		for i := range metadata {
			switch metadata[i].StockCode {
			case "BHP":
				metadata[i].Industry = "Mining"
				metadata[i].Tags = []string{"mining", "resources", "copper"}
			case "CSL":
				metadata[i].Industry = "Biotechnology"
				metadata[i].Tags = []string{"healthcare", "biotech"}
			case "CBA":
				metadata[i].Industry = "Banks"
				metadata[i].Tags = []string{"banking", "financial-services"}
			}
		}

		require.NoError(t, seeder.SeedCompanyMetadata(ctx, metadata))
		require.NoError(t, seeder.SeedShorts(ctx, shorts))

		// Wait for service
		if !waitForServiceHealth(apiURL, 10*time.Second) {
			t.Fatalf("Service not available at %s", apiURL)
		}

		t.Run("BasicSearch", func(t *testing.T) {
			searchURL := fmt.Sprintf("%s/api/stocks/search?q=%s", apiURL, url.QueryEscape("BHP"))

			resp, err := http.Get(searchURL)
			require.NoError(t, err)
			defer func() {
				_ = resp.Body.Close()
			}()

			assert.Equal(t, http.StatusOK, resp.StatusCode)

			var result struct {
				Query  string `json:"query"`
				Stocks []struct {
					ProductCode       string   `json:"product_code"`
					Name              string   `json:"name"`
					PercentageShorted float64  `json:"percentage_shorted"`
					Industry          string   `json:"industry"`
					Tags              []string `json:"tags"`
					LogoUrl           string   `json:"logoUrl"`
				} `json:"stocks"`
				Count int `json:"count"`
			}

			err = json.NewDecoder(resp.Body).Decode(&result)
			require.NoError(t, err)

			assert.Equal(t, "BHP", result.Query)
			assert.Greater(t, result.Count, 0)
			if len(result.Stocks) > 0 {
				assert.Equal(t, "BHP", result.Stocks[0].ProductCode)
			}
		})

		t.Run("SearchWithLimit", func(t *testing.T) {
			searchURL := fmt.Sprintf("%s/api/stocks/search?q=%s&limit=%d", apiURL, url.QueryEscape("Bank"), 1)

			resp, err := http.Get(searchURL)
			require.NoError(t, err)
			defer func() {
				_ = resp.Body.Close()
			}()

			assert.Equal(t, http.StatusOK, resp.StatusCode)

			var result struct {
				Stocks []interface{} `json:"stocks"`
				Count  int           `json:"count"`
			}

			err = json.NewDecoder(resp.Body).Decode(&result)
			require.NoError(t, err)

			assert.LessOrEqual(t, len(result.Stocks), 1)
		})

		t.Run("MissingQueryParam", func(t *testing.T) {
			searchURL := fmt.Sprintf("%s/api/stocks/search", apiURL)

			resp, err := http.Get(searchURL)
			require.NoError(t, err)
			defer func() {
				_ = resp.Body.Close()
			}()

			assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
		})

		t.Run("InvalidLimit", func(t *testing.T) {
			searchURL := fmt.Sprintf("%s/api/stocks/search?q=test&limit=-1", apiURL)

			resp, err := http.Get(searchURL)
			require.NoError(t, err)
			defer func() {
				_ = resp.Body.Close()
			}()

			assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
		})

		t.Run("MethodNotAllowed", func(t *testing.T) {
			searchURL := fmt.Sprintf("%s/api/stocks/search?q=test", apiURL)

			req, _ := http.NewRequest(http.MethodDelete, searchURL, nil)
			resp, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			defer func() {
				_ = resp.Body.Close()
			}()

			assert.Equal(t, http.StatusMethodNotAllowed, resp.StatusCode)
		})

		t.Run("CORSHeaders", func(t *testing.T) {
			searchURL := fmt.Sprintf("%s/api/stocks/search?q=BHP", apiURL)

			resp, err := http.Get(searchURL)
			require.NoError(t, err)
			defer func() {
				_ = resp.Body.Close()
			}()

			// Check CORS headers are present
			assert.Equal(t, "*", resp.Header.Get("Access-Control-Allow-Origin"))
		})
	})
}

// TestAlgoliaProxyEndpoint tests the /api/algolia/search proxy endpoint
func TestAlgoliaProxyEndpoint(t *testing.T) {
	apiURL := os.Getenv("SHORTS_API_URL")
	if apiURL == "" {
		t.Skip("SHORTS_API_URL not set - skipping Algolia proxy tests")
	}

	// Wait for service
	if !waitForServiceHealth(apiURL, 10*time.Second) {
		t.Fatalf("Service not available at %s", apiURL)
	}

	t.Run("AlgoliaSearchGET", func(t *testing.T) {
		searchURL := fmt.Sprintf("%s/api/algolia/search?q=%s&limit=%d", apiURL, url.QueryEscape("BHP"), 10)

		resp, err := http.Get(searchURL)
		require.NoError(t, err)
		defer func() {
			_ = resp.Body.Close()
		}()

		// Either returns results (if Algolia configured) or ServiceUnavailable
		switch resp.StatusCode {
		case http.StatusOK:
			var result struct {
				Hits []interface{} `json:"hits"`
			}
			err = json.NewDecoder(resp.Body).Decode(&result)
			require.NoError(t, err)
			t.Logf("Algolia returned %d hits", len(result.Hits))
		case http.StatusServiceUnavailable:
			t.Log("Algolia not configured - endpoint correctly returns 503")
		default:
			t.Errorf("Unexpected status code: %d", resp.StatusCode)
		}
	})

	t.Run("AlgoliaSearchPOST", func(t *testing.T) {
		searchURL := fmt.Sprintf("%s/api/algolia/search", apiURL)

		req, _ := http.NewRequest(http.MethodPost, searchURL, bytes.NewBufferString(`{"query": "bank", "hitsPerPage": 5}`))
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer func() {
			_ = resp.Body.Close()
		}()

		// Should handle POST method
		if resp.StatusCode == http.StatusServiceUnavailable {
			t.Log("Algolia not configured - endpoint correctly returns 503")
		} else {
			// If Algolia is configured, should get OK or BadRequest (for empty body)
			assert.True(t, resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusBadRequest,
				"Should handle POST request, got: %d", resp.StatusCode)
		}
	})

	t.Run("MissingQueryParam", func(t *testing.T) {
		searchURL := fmt.Sprintf("%s/api/algolia/search", apiURL)

		resp, err := http.Get(searchURL)
		require.NoError(t, err)
		defer func() {
			_ = resp.Body.Close()
		}()

		// Should return BadRequest or ServiceUnavailable
		assert.True(t, resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusServiceUnavailable,
			"Should return 400 or 503, got: %d", resp.StatusCode)
	})
}

// TestSearchPerformance tests search performance with larger datasets
func TestSearchPerformance(t *testing.T) {
	// Only run performance tests if explicitly enabled
	if os.Getenv("RUN_PERF_TESTS") == "" {
		t.Skip("RUN_PERF_TESTS not set - skipping performance tests")
	}

	apiURL := os.Getenv("SHORTS_API_URL")
	if apiURL == "" {
		t.Skip("SHORTS_API_URL not set - skipping performance tests")
	}

	WithTestDatabase(t, func(container *TestContainer) {
		ctx := context.Background()
		seeder := container.GetSeeder()

		// Seed larger dataset for performance testing
		testDate := time.Now().Truncate(24 * time.Hour)
		stockCodes := testdata.GetSampleStocks()
		shorts, metadata, _ := testdata.GetMultipleStocksTestData(stockCodes, testDate.AddDate(0, 0, -30), 30)

		require.NoError(t, seeder.SeedCompanyMetadata(ctx, metadata))
		require.NoError(t, seeder.SeedShorts(ctx, shorts))

		if !waitForServiceHealth(apiURL, 10*time.Second) {
			t.Fatalf("Service not available at %s", apiURL)
		}

		client := shortsv1alpha1connect.NewShortedStocksServiceClient(
			http.DefaultClient,
			apiURL,
		)

		t.Run("SearchResponseTime", func(t *testing.T) {
			queries := []string{"BHP", "Mining", "Bank", "Common", "health"}

			for _, query := range queries {
				start := time.Now()

				req := connect.NewRequest(&shortsv1alpha1.SearchStocksRequest{
					Query: query,
					Limit: 50,
				})

				_, err := client.SearchStocks(ctx, req)
				duration := time.Since(start)

				require.NoError(t, err)
				assert.Less(t, duration, 500*time.Millisecond,
					"Search for '%s' should complete in under 500ms, took %v", query, duration)

				t.Logf("Search '%s' completed in %v", query, duration)
			}
		})

		t.Run("ConcurrentSearches", func(t *testing.T) {
			numConcurrent := 10
			done := make(chan error, numConcurrent)

			start := time.Now()

			for i := 0; i < numConcurrent; i++ {
				go func(idx int) {
					req := connect.NewRequest(&shortsv1alpha1.SearchStocksRequest{
						Query: fmt.Sprintf("query%d", idx),
						Limit: 10,
					})
					_, err := client.SearchStocks(ctx, req)
					done <- err
				}(i)
			}

			// Wait for all to complete
			for i := 0; i < numConcurrent; i++ {
				err := <-done
				require.NoError(t, err)
			}

			duration := time.Since(start)
			t.Logf("Completed %d concurrent searches in %v", numConcurrent, duration)
			assert.Less(t, duration, 2*time.Second, "Concurrent searches should complete quickly")
		})
	})
}

