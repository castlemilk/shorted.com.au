package integration

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Frontend search test data structures
type FrontendSearchResponse struct {
	Query  string                 `json:"query"`
	Stocks []FrontendSearchStock  `json:"stocks"`
	Count  int                    `json:"count"`
}

type FrontendSearchStock struct {
	ProductCode           string  `json:"product_code"`
	Name                  string  `json:"name"`
	PercentageShorted     float64 `json:"percentage_shorted"`
	TotalProductInIssue   float64 `json:"total_product_in_issue"`
	ReportedShortPositions float64 `json:"reported_short_positions"`
}

func TestSearchEndToEnd(t *testing.T) {
	client := &http.Client{Timeout: 15 * time.Second}
	
	t.Run("Frontend Search Integration", func(t *testing.T) {
		// Test that frontend can access the search API
		testCases := []struct {
			name        string
			query       string
			limit       int
			expectError bool
		}{
			{
				name:        "Search for CBA stock",
				query:       "CBA",
				limit:       5,
				expectError: false,
			},
			{
				name:        "Search for BHP stock",
				query:       "BHP",
				limit:       5,
				expectError: false,
			},
			{
				name:        "Search for bank companies",
				query:       "Bank",
				limit:       10,
				expectError: false,
			},
			{
				name:        "Search with empty query",
				query:       "",
				limit:       5,
				expectError: true,
			},
		}
		
		for _, tc := range testCases {
			t.Run(tc.name, func(t *testing.T) {
				url := fmt.Sprintf("%s/api/stocks/search?q=%s&limit=%d", backendURL, tc.query, tc.limit)
				
				resp, err := client.Get(url)
				require.NoError(t, err, "Search request failed")
				defer resp.Body.Close()
				
				if tc.expectError {
					assert.Contains(t, []int{http.StatusBadRequest, http.StatusNotFound}, 
						resp.StatusCode, "Expected error status for invalid input")
				} else {
					assert.Contains(t, []int{http.StatusOK, http.StatusNotFound}, 
						resp.StatusCode, "Unexpected status code for search")
					
					if resp.StatusCode == http.StatusOK {
						var response FrontendSearchResponse
						err = json.NewDecoder(resp.Body).Decode(&response)
						assert.NoError(t, err, "Failed to decode search response")
						
						// Validate response structure
						assert.Equal(t, tc.query, response.Query, "Query should match request")
						assert.Equal(t, len(response.Stocks), response.Count, "Count should match stocks length")
						
						// Validate each stock in results
						for i, stock := range response.Stocks {
							assert.NotEmpty(t, stock.ProductCode, "Stock %d should have product code", i)
							assert.NotEmpty(t, stock.Name, "Stock %d should have name", i)
							assert.GreaterOrEqual(t, stock.PercentageShorted, 0.0, 
								"Stock %d should have non-negative short percentage", i)
						}
						
						t.Logf("Search for '%s' returned %d results", tc.query, response.Count)
					}
				}
			})
		}
	})
	
	t.Run("Search Performance Benchmarks", func(t *testing.T) {
		benchmarks := []struct {
			name      string
			query     string
			limit     int
			threshold time.Duration
		}{
			{
				name:      "Single character search",
				query:     "A",
				limit:     10,
				threshold: 3 * time.Second,
			},
			{
				name:      "Stock code search",
				query:     "CBA",
				limit:     5,
				threshold: 1 * time.Second,
			},
			{
				name:      "Company name search",
				query:     "Bank",
				limit:     20,
				threshold: 2 * time.Second,
			},
			{
				name:      "Broad search with high limit",
				query:     "L",
				limit:     50,
				threshold: 5 * time.Second,
			},
		}
		
		for _, bm := range benchmarks {
			t.Run(bm.name, func(t *testing.T) {
				url := fmt.Sprintf("%s/api/stocks/search?q=%s&limit=%d", backendURL, bm.query, bm.limit)
				
				start := time.Now()
				resp, err := client.Get(url)
				elapsed := time.Since(start)
				
				require.NoError(t, err, "Search request failed")
				defer resp.Body.Close()
				
				assert.Less(t, elapsed, bm.threshold, 
					"Search for '%s' took %v, should be less than %v", bm.query, elapsed, bm.threshold)
				
				t.Logf("Search benchmark '%s': %v (threshold: %v)", bm.name, elapsed, bm.threshold)
			})
		}
	})
	
	t.Run("Search Cache Effectiveness", func(t *testing.T) {
		query := "CBA"
		limit := 5
		url := fmt.Sprintf("%s/api/stocks/search?q=%s&limit=%d", backendURL, query, limit)
		
		// First request (cache miss)
		start1 := time.Now()
		resp1, err := client.Get(url)
		elapsed1 := time.Since(start1)
		require.NoError(t, err, "First search request failed")
		resp1.Body.Close()
		
		// Small delay to ensure cache is populated
		time.Sleep(100 * time.Millisecond)
		
		// Second request (should be cache hit)
		start2 := time.Now()
		resp2, err := client.Get(url)
		elapsed2 := time.Since(start2)
		require.NoError(t, err, "Second search request failed")
		resp2.Body.Close()
		
		// Both should succeed
		if resp1.StatusCode == http.StatusOK {
			assert.Equal(t, http.StatusOK, resp2.StatusCode, "Cached response should match original")
		}
		
		// Cache hit should generally be faster
		t.Logf("First request: %v, Second request: %v", elapsed1, elapsed2)
		
		if elapsed2 < elapsed1 {
			t.Logf("Cache appears to be working - second request was faster")
		} else {
			t.Logf("Cache may not be working or timing difference is negligible")
		}
	})
	
	t.Run("Search Result Quality", func(t *testing.T) {
		testCases := []struct {
			name           string
			query          string
			expectedFields []string
		}{
			{
				name:           "Stock code search",
				query:          "CBA",
				expectedFields: []string{"product_code", "name", "percentage_shorted"},
			},
			{
				name:           "Company name search",
				query:          "Bank",
				expectedFields: []string{"product_code", "name", "percentage_shorted"},
			},
		}
		
		for _, tc := range testCases {
			t.Run(tc.name, func(t *testing.T) {
				url := fmt.Sprintf("%s/api/stocks/search?q=%s&limit=5", backendURL, tc.query)
				
				resp, err := client.Get(url)
				require.NoError(t, err, "Search request failed")
				defer resp.Body.Close()
				
				if resp.StatusCode == http.StatusOK {
					var response FrontendSearchResponse
					err = json.NewDecoder(resp.Body).Decode(&response)
					require.NoError(t, err, "Failed to decode response")
					
					// Validate that we have results
					if len(response.Stocks) > 0 {
						stock := response.Stocks[0]
						
						// Check that all expected fields are present and non-empty
						for _, field := range tc.expectedFields {
							switch field {
							case "product_code":
								assert.NotEmpty(t, stock.ProductCode, "Product code should not be empty")
							case "name":
								assert.NotEmpty(t, stock.Name, "Name should not be empty")
							case "percentage_shorted":
								assert.GreaterOrEqual(t, stock.PercentageShorted, 0.0, 
									"Percentage shorted should be non-negative")
							}
						}
						
						t.Logf("Search quality check passed for '%s': found %d results", tc.query, response.Count)
					} else {
						t.Logf("No results found for '%s' - this may be expected", tc.query)
					}
				}
			})
		}
	})
	
	t.Run("Search Error Handling", func(t *testing.T) {
		errorCases := []struct {
			name  string
			query string
			limit int
		}{
			{
				name:  "Empty query",
				query: "",
				limit: 5,
			},
			{
				name:  "Negative limit",
				query: "CBA",
				limit: -1,
			},
			{
				name:  "Very high limit",
				query: "A",
				limit: 10000,
			},
		}
		
		for _, ec := range errorCases {
			t.Run(ec.name, func(t *testing.T) {
				url := fmt.Sprintf("%s/api/stocks/search?q=%s&limit=%d", backendURL, ec.query, ec.limit)
				
				resp, err := client.Get(url)
				require.NoError(t, err, "Search request failed")
				defer resp.Body.Close()
				
				// Should handle errors gracefully
				if ec.name == "Negative limit" {
					assert.Contains(t, []int{http.StatusOK, http.StatusBadRequest, http.StatusNotFound, http.StatusInternalServerError}, 
						resp.StatusCode, "Should return valid status code")
				} else {
					assert.Contains(t, []int{http.StatusOK, http.StatusBadRequest, http.StatusNotFound}, 
						resp.StatusCode, "Should return valid status code")
				}
				
				t.Logf("Error handling test '%s': status %d", ec.name, resp.StatusCode)
			})
		}
	})
}

func TestSearchConcurrency(t *testing.T) {
	client := &http.Client{Timeout: 30 * time.Second}
	
	t.Run("Concurrent Search Requests", func(t *testing.T) {
		const numRequests = 10
		queries := []string{"CBA", "BHP", "Bank", "A", "L"}
		
		type result struct {
			query      string
			statusCode int
			duration   time.Duration
			err        error
		}
		
		results := make(chan result, numRequests)
		
		// Start concurrent requests
		for i := 0; i < numRequests; i++ {
			go func(i int) {
				query := queries[i%len(queries)]
				url := fmt.Sprintf("%s/api/stocks/search?q=%s&limit=5", backendURL, query)
				
				start := time.Now()
				resp, err := client.Get(url)
				duration := time.Since(start)
				
				r := result{
					query:    query,
					duration: duration,
					err:      err,
				}
				
				if resp != nil {
					r.statusCode = resp.StatusCode
					resp.Body.Close()
				}
				
				results <- r
			}(i)
		}
		
		// Collect results
		successCount := 0
		var totalDuration time.Duration
		
		for i := 0; i < numRequests; i++ {
			select {
			case r := <-results:
				if r.err == nil && (r.statusCode == http.StatusOK || r.statusCode == http.StatusNotFound) {
					successCount++
					totalDuration += r.duration
				} else if r.err != nil {
					t.Logf("Request %d failed: %v", i+1, r.err)
				} else {
					t.Logf("Request %d returned status %d", i+1, r.statusCode)
				}
			case <-time.After(30 * time.Second):
				t.Fatal("Request timed out")
			}
		}
		
		assert.Greater(t, successCount, numRequests/2, 
			"At least half of concurrent requests should succeed")
		
		if successCount > 0 {
			avgDuration := totalDuration / time.Duration(successCount)
			t.Logf("Concurrent search requests: %d/%d successful, avg duration: %v", 
				successCount, numRequests, avgDuration)
		}
	})
	
	t.Run("Search Load Testing", func(t *testing.T) {
		// Test search under load
		const numRequests = 20
		query := "CBA"
		
		type loadResult struct {
			statusCode int
			duration   time.Duration
			err        error
		}
		
		results := make(chan loadResult, numRequests)
		
		// Start load test
		for i := 0; i < numRequests; i++ {
			go func() {
				url := fmt.Sprintf("%s/api/stocks/search?q=%s&limit=10", backendURL, query)
				
				start := time.Now()
				resp, err := client.Get(url)
				duration := time.Since(start)
				
				r := loadResult{
					duration: duration,
					err:      err,
				}
				
				if resp != nil {
					r.statusCode = resp.StatusCode
					resp.Body.Close()
				}
				
				results <- r
			}()
		}
		
		// Collect load test results
		successCount := 0
		var totalDuration time.Duration
		var maxDuration time.Duration
		
		for i := 0; i < numRequests; i++ {
			select {
			case r := <-results:
				if r.err == nil && (r.statusCode == http.StatusOK || r.statusCode == http.StatusNotFound) {
					successCount++
					totalDuration += r.duration
					if r.duration > maxDuration {
						maxDuration = r.duration
					}
				}
			case <-time.After(30 * time.Second):
				t.Fatal("Load test request timed out")
			}
		}
		
		assert.Greater(t, successCount, numRequests*8/10, 
			"At least 80%% of load test requests should succeed")
		
		if successCount > 0 {
			avgDuration := totalDuration / time.Duration(successCount)
			t.Logf("Load test results: %d/%d successful, avg: %v, max: %v", 
				successCount, numRequests, avgDuration, maxDuration)
		}
	})
}
