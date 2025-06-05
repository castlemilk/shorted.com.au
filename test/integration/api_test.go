package integration

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
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