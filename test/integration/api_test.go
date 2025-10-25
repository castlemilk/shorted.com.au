package integration

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Test data structures
type GetTopShortsRequest struct {
	Period string `json:"period"`
	Limit  int32  `json:"limit"`
	Offset int32  `json:"offset"`
}

type GetTopShortsResponse struct {
	TimeSeries []TimeSeriesData `json:"timeSeries"`
	Offset     int32            `json:"offset"`
}

type TimeSeriesData struct {
	ProductCode           string              `json:"productCode"`
	Name                  string              `json:"name"`
	LatestShortPosition   float64             `json:"latestShortPosition"`
	Points                []TimeSeriesPoint   `json:"points"`
}

type TimeSeriesPoint struct {
	Timestamp     string  `json:"timestamp"`
	ShortPosition float64 `json:"shortPosition"`
}

type GetStockRequest struct {
	ProductCode string `json:"productCode"`
}

type Stock struct {
	ProductCode            string  `json:"productCode"`
	Name                   string  `json:"name"`
	TotalProductInIssue    float32 `json:"totalProductInIssue"`
	ReportedShortPositions float32 `json:"reportedShortPositions"`
	PercentageShorted      float32 `json:"percentageShorted"`
}

type GetStockDataRequest struct {
	ProductCode string `json:"productCode"`
	Period      string `json:"period"`
}

type SearchStocksRequest struct {
	Query           string `json:"query"`
	Limit           int32  `json:"limit"`
	IncludeDetails  bool   `json:"includeDetails"`
}

type SearchStocksResponse struct {
	Query  string  `json:"query"`
	Stocks []Stock `json:"stocks"`
	Count  int32   `json:"count"`
}

func TestAPIEndpoints(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}
	
	t.Run("GetTopShorts API", func(t *testing.T) {
		// Test with default parameters
		req := GetTopShortsRequest{
			Period: "1M",
			Limit:  10,
			Offset: 0,
		}
		
		resp, err := makeConnectRequest(client, "GetTopShorts", req)
		require.NoError(t, err, "GetTopShorts request failed")
		defer resp.Body.Close()
		
		// Should return 200 or 400 (if no data)
		assert.Contains(t, []int{http.StatusOK, http.StatusBadRequest, http.StatusNotFound}, 
			resp.StatusCode, "Unexpected status code for GetTopShorts")
		
		if resp.StatusCode == http.StatusOK {
			var response GetTopShortsResponse
			err = json.NewDecoder(resp.Body).Decode(&response)
			assert.NoError(t, err, "Failed to decode GetTopShorts response")
			
			// Validate response structure
			assert.GreaterOrEqual(t, len(response.TimeSeries), 0, "TimeSeries should be a valid array")
		}
	})
	
	t.Run("GetStock API", func(t *testing.T) {
		testCases := []struct {
			name        string
			productCode string
			expectError bool
		}{
			{
				name:        "Valid stock code CBA",
				productCode: "CBA",
				expectError: false,
			},
			{
				name:        "Valid stock code BHP", 
				productCode: "BHP",
				expectError: false,
			},
			{
				name:        "Invalid stock code",
				productCode: "INVALID",
				expectError: true,
			},
			{
				name:        "Empty stock code",
				productCode: "",
				expectError: true,
			},
		}
		
		for _, tc := range testCases {
			t.Run(tc.name, func(t *testing.T) {
				req := GetStockRequest{
					ProductCode: tc.productCode,
				}
				
				resp, err := makeConnectRequest(client, "GetStock", req)
				require.NoError(t, err, "GetStock request failed")
				defer resp.Body.Close()
				
				if tc.expectError {
					assert.Contains(t, []int{http.StatusBadRequest, http.StatusNotFound}, 
						resp.StatusCode, "Expected error status for invalid input")
				} else {
					// Should return 200 or 404 (if stock not found)
					assert.Contains(t, []int{http.StatusOK, http.StatusNotFound}, 
						resp.StatusCode, "Unexpected status code for GetStock")
					
					if resp.StatusCode == http.StatusOK {
						var response Stock
						err = json.NewDecoder(resp.Body).Decode(&response)
						assert.NoError(t, err, "Failed to decode GetStock response")
						
						// Validate response structure
						assert.Equal(t, tc.productCode, response.ProductCode, "Product code mismatch")
						assert.NotEmpty(t, response.Name, "Stock name should not be empty")
					}
				}
			})
		}
	})
	
	t.Run("GetStockData API", func(t *testing.T) {
		testCases := []struct {
			name        string
			productCode string
			period      string
			expectError bool
		}{
			{
				name:        "Valid stock with 1 month period",
				productCode: "CBA",
				period:      "1M",
				expectError: false,
			},
			{
				name:        "Valid stock with 6 month period",
				productCode: "BHP",
				period:      "6M",
				expectError: false,
			},
			{
				name:        "Valid stock with 1 year period",
				productCode: "WBC",
				period:      "1Y",
				expectError: false,
			},
			{
				name:        "Invalid stock code",
				productCode: "INVALID",
				period:      "1M",
				expectError: true,
			},
			{
				name:        "Empty stock code",
				productCode: "",
				period:      "1M",
				expectError: true,
			},
			{
				name:        "Invalid period",
				productCode: "CBA",
				period:      "invalid",
				expectError: true,
			},
		}
		
		for _, tc := range testCases {
			t.Run(tc.name, func(t *testing.T) {
				req := GetStockDataRequest{
					ProductCode: tc.productCode,
					Period:      tc.period,
				}
				
				resp, err := makeConnectRequest(client, "GetStockData", req)
				require.NoError(t, err, "GetStockData request failed")
				defer resp.Body.Close()
				
				// Log the response for debugging
				var bodyBytes bytes.Buffer
				_, _ = bodyBytes.ReadFrom(resp.Body)
				t.Logf("GetStockData response for %s/%s: Status=%d, Body=%s", 
					tc.productCode, tc.period, resp.StatusCode, bodyBytes.String())
				
				if tc.expectError {
					assert.Contains(t, []int{http.StatusBadRequest, http.StatusNotFound}, 
						resp.StatusCode, "Expected error status for invalid input")
				} else {
					// Should return 200 or 404 (if stock data not found)
					assert.Contains(t, []int{http.StatusOK, http.StatusNotFound}, 
						resp.StatusCode, "Unexpected status code for GetStockData")
					
					if resp.StatusCode == http.StatusOK {
						var response TimeSeriesData
						err = json.NewDecoder(bytes.NewReader(bodyBytes.Bytes())).Decode(&response)
						assert.NoError(t, err, "Failed to decode GetStockData response")
						
						// Validate response structure
						assert.Equal(t, tc.productCode, response.ProductCode, "Product code mismatch")
						// Note: points array might be empty if no data exists
						if len(response.Points) > 0 {
							assert.Greater(t, response.LatestShortPosition, float64(0), 
								"Latest short position should be positive when data exists")
							
							// Validate time series points
							for i, point := range response.Points {
								assert.NotEmpty(t, point.Timestamp, "Timestamp should not be empty")
								assert.GreaterOrEqual(t, point.ShortPosition, float64(0), 
									"Short position should be non-negative at point %d", i)
							}
						} else {
							t.Logf("No data points returned for %s/%s", tc.productCode, tc.period)
						}
					}
				}
			})
		}
	})
	
	t.Run("API Input Validation", func(t *testing.T) {
		// Test invalid period values
		req := GetTopShortsRequest{
			Period: "INVALID",
			Limit:  10,
			Offset: 0,
		}
		
		resp, err := makeConnectRequest(client, "GetTopShorts", req)
		require.NoError(t, err)
		defer resp.Body.Close()
		
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode, 
			"Should return 400 for invalid period")
	})
	
	t.Run("API Rate Limiting", func(t *testing.T) {
		// Make rapid requests to test rate limiting
		req := GetTopShortsRequest{
			Period: "1M",
			Limit:  1,
			Offset: 0,
		}
		
		successCount := 0
		rateLimitedCount := 0
		
		// Make 20 rapid requests
		for i := 0; i < 20; i++ {
			resp, err := makeConnectRequest(client, "GetTopShorts", req)
			require.NoError(t, err)
			
			switch resp.StatusCode {
			case http.StatusOK:
				successCount++
			case http.StatusTooManyRequests:
				rateLimitedCount++
			}
			
			resp.Body.Close()
		}
		
		// We should get at least some successful requests
		assert.Greater(t, successCount, 0, "Should have some successful requests")
		
		// If rate limiting is implemented, we might see some 429s
		// This is optional for now
		t.Logf("Successful requests: %d, Rate limited: %d", successCount, rateLimitedCount)
	})
	
	t.Run("SearchStocks API", func(t *testing.T) {
		testCases := []struct {
			name        string
			query       string
			limit       int32
			expectError bool
			minResults  int
		}{
			{
				name:        "Search by stock code CBA",
				query:       "CBA",
				limit:       10,
				expectError: false,
				minResults:  1,
			},
			{
				name:        "Search by stock code BHP",
				query:       "BHP",
				limit:       10,
				expectError: false,
				minResults:  1,
			},
			{
				name:        "Search by company name containing Bank",
				query:       "Bank",
				limit:       10,
				expectError: false,
				minResults:  0, // May or may not have results
			},
			{
				name:        "Search with empty query",
				query:       "",
				limit:       10,
				expectError: true,
				minResults:  0,
			},
			{
				name:        "Search with very long query",
				query:       "ThisIsAVeryLongQueryThatShouldNotMatchAnythingInTheDatabase",
				limit:       10,
				expectError: false,
				minResults:  0,
			},
			{
				name:        "Search with limit 0",
				query:       "CBA",
				limit:       0,
				expectError: false,
				minResults:  0,
			},
			{
				name:        "Search with high limit",
				query:       "A",
				limit:       100,
				expectError: false,
				minResults:  0,
			},
		}
		
		for _, tc := range testCases {
			t.Run(tc.name, func(t *testing.T) {
				req := SearchStocksRequest{
					Query:          tc.query,
					Limit:          tc.limit,
					IncludeDetails: false,
				}
				
				resp, err := makeSearchRequest(client, req)
				require.NoError(t, err, "SearchStocks request failed")
				defer resp.Body.Close()
				
				if tc.expectError {
					assert.Contains(t, []int{http.StatusBadRequest, http.StatusNotFound}, 
						resp.StatusCode, "Expected error status for invalid input")
				} else {
					// Should return 200 or 404 (if no results found)
					assert.Contains(t, []int{http.StatusOK, http.StatusNotFound}, 
						resp.StatusCode, "Unexpected status code for SearchStocks")
					
					if resp.StatusCode == http.StatusOK {
						var response SearchStocksResponse
						err = json.NewDecoder(resp.Body).Decode(&response)
						assert.NoError(t, err, "Failed to decode SearchStocks response")
						
						// Validate response structure
						assert.Equal(t, tc.query, response.Query, "Query should match request")
						assert.Equal(t, int32(len(response.Stocks)), response.Count, "Count should match stocks length")
						assert.GreaterOrEqual(t, len(response.Stocks), tc.minResults, 
							"Should return at least minimum expected results")
						
						// Validate each stock in results
						for i, stock := range response.Stocks {
							assert.NotEmpty(t, stock.ProductCode, "Stock %d should have product code", i)
							assert.NotEmpty(t, stock.Name, "Stock %d should have name", i)
							assert.GreaterOrEqual(t, stock.PercentageShorted, float32(0), 
								"Stock %d should have non-negative short percentage", i)
						}
						
						// Validate limit is respected
						if tc.limit > 0 {
							assert.LessOrEqual(t, len(response.Stocks), int(tc.limit), 
								"Results should not exceed limit")
						}
					}
				}
			})
		}
	})
}

func TestAPIResponseFormat(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}
	
	t.Run("Content-Type headers", func(t *testing.T) {
		req := GetTopShortsRequest{
			Period: "1M", 
			Limit:  1,
			Offset: 0,
		}
		
		resp, err := makeConnectRequest(client, "GetTopShorts", req)
		require.NoError(t, err)
		defer resp.Body.Close()
		
		contentType := resp.Header.Get("Content-Type")
		assert.Contains(t, contentType, "application/json", 
			"Response should have JSON content type")
	})
	
	t.Run("CORS headers", func(t *testing.T) {
		req := GetTopShortsRequest{
			Period: "1M",
			Limit:  1, 
			Offset: 0,
		}
		
		resp, err := makeConnectRequest(client, "GetTopShorts", req)
		require.NoError(t, err)
		defer resp.Body.Close()
		
		// Check for CORS headers (if implemented)
		corsHeader := resp.Header.Get("Access-Control-Allow-Origin")
		t.Logf("CORS header: %s", corsHeader)
		// This is informational for now
	})
	
	t.Run("Search API Content-Type headers", func(t *testing.T) {
		req := SearchStocksRequest{
			Query: "CBA",
			Limit: 5,
		}
		
		resp, err := makeSearchRequest(client, req)
		require.NoError(t, err)
		defer resp.Body.Close()
		
		contentType := resp.Header.Get("Content-Type")
		assert.Contains(t, contentType, "application/json", 
			"Search API response should have JSON content type")
	})
}

func TestSearchFunctionality(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}
	
	t.Run("Search Performance", func(t *testing.T) {
		testCases := []struct {
			name      string
			query     string
			threshold time.Duration
		}{
			{
				name:      "Single character search",
				query:     "A",
				threshold: 2 * time.Second,
			},
			{
				name:      "Stock code search",
				query:     "CBA",
				threshold: 1 * time.Second,
			},
			{
				name:      "Company name search",
				query:     "Bank",
				threshold: 2 * time.Second,
			},
		}
		
		for _, tc := range testCases {
			t.Run(tc.name, func(t *testing.T) {
				req := SearchStocksRequest{
					Query: tc.query,
					Limit: 10,
				}
				
				start := time.Now()
				resp, err := makeSearchRequest(client, req)
				elapsed := time.Since(start)
				
				require.NoError(t, err, "Search request failed")
				defer resp.Body.Close()
				
				assert.Less(t, elapsed, tc.threshold, 
					"Search for '%s' took %v, should be less than %v", tc.query, elapsed, tc.threshold)
				
				t.Logf("Search for '%s' took %v", tc.query, elapsed)
			})
		}
	})
	
	t.Run("Search Cache Behavior", func(t *testing.T) {
		req := SearchStocksRequest{
			Query: "CBA",
			Limit: 5,
		}
		
		var firstResponseTime, secondResponseTime time.Duration
		
		// First request (cache miss)
		start := time.Now()
		resp1, err := makeSearchRequest(client, req)
		firstResponseTime = time.Since(start)
		require.NoError(t, err, "First search request failed")
		resp1.Body.Close()
		
		// Second request (should be cache hit)
		start = time.Now()
		resp2, err := makeSearchRequest(client, req)
		secondResponseTime = time.Since(start)
		require.NoError(t, err, "Second search request failed")
		resp2.Body.Close()
		
		// Both should succeed
		if resp1.StatusCode == http.StatusOK {
			assert.Equal(t, http.StatusOK, resp2.StatusCode, "Cached search response should match original")
		}
		
		// Log timing for analysis
		t.Logf("First search time: %v, Second search time: %v", firstResponseTime, secondResponseTime)
		
		if secondResponseTime < firstResponseTime {
			t.Logf("Search cache appears to be working - second request was faster")
		}
	})
	
	t.Run("Search Result Consistency", func(t *testing.T) {
		req := SearchStocksRequest{
			Query: "CBA",
			Limit: 10,
		}
		
		// Make multiple requests and verify consistency
		var responses []SearchStocksResponse
		
		for i := 0; i < 3; i++ {
			resp, err := makeSearchRequest(client, req)
			require.NoError(t, err, "Search request %d failed", i+1)
			
			if resp.StatusCode == http.StatusOK {
				var response SearchStocksResponse
				err = json.NewDecoder(resp.Body).Decode(&response)
				require.NoError(t, err, "Failed to decode response %d", i+1)
				responses = append(responses, response)
			}
			
			resp.Body.Close()
			time.Sleep(100 * time.Millisecond) // Small delay between requests
		}
		
		if len(responses) >= 2 {
			// Compare first two responses
			assert.Equal(t, responses[0].Query, responses[1].Query, "Query should be consistent")
			assert.Equal(t, responses[0].Count, responses[1].Count, "Count should be consistent")
			
			if len(responses[0].Stocks) > 0 && len(responses[1].Stocks) > 0 {
				assert.Equal(t, responses[0].Stocks[0].ProductCode, responses[1].Stocks[0].ProductCode, 
					"First result should be consistent")
			}
		}
	})
	
	t.Run("Search Edge Cases", func(t *testing.T) {
		testCases := []struct {
			name        string
			query       string
			limit       int32
			expectError bool
		}{
			{
				name:        "Special characters",
				query:       "CBA@#$%",
				limit:       10,
				expectError: false,
			},
			{
				name:        "Numbers only",
				query:       "123",
				limit:       10,
				expectError: false,
			},
			{
				name:        "Mixed case",
				query:       "cBa",
				limit:       10,
				expectError: false,
			},
			{
				name:        "Very high limit",
				query:       "A",
				limit:       1000,
				expectError: false,
			},
		}
		
		for _, tc := range testCases {
			t.Run(tc.name, func(t *testing.T) {
				req := SearchStocksRequest{
					Query: tc.query,
					Limit: tc.limit,
				}
				
				resp, err := makeSearchRequest(client, req)
				require.NoError(t, err, "Search request failed")
				defer resp.Body.Close()
				
				if tc.expectError {
					assert.Contains(t, []int{http.StatusBadRequest, http.StatusNotFound}, 
						resp.StatusCode, "Expected error status")
				} else {
					assert.Contains(t, []int{http.StatusOK, http.StatusNotFound}, 
						resp.StatusCode, "Should return valid status")
				}
			})
		}
	})
}

// Helper function to make Connect RPC requests
func makeConnectRequest(client *http.Client, method string, payload interface{}) (*http.Response, error) {
	jsonData, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	
	url := fmt.Sprintf("%s/shorts.v1alpha1.ShortedStocksService/%s", backendURL, method)
	
	req, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, err
	}
	
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	
	return client.Do(req)
}

// Helper function to make search API requests
func makeSearchRequest(client *http.Client, payload SearchStocksRequest) (*http.Response, error) {
	url := fmt.Sprintf("%s/api/stocks/search?q=%s&limit=%d", backendURL, 
		url.QueryEscape(payload.Query), payload.Limit)
	
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	
	req.Header.Set("Accept", "application/json")
	
	return client.Do(req)
}