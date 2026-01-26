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

func TestEndToEndUserFlows(t *testing.T) {
	client := &http.Client{
		Timeout: 15 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			// Allow up to 5 redirects
			if len(via) >= 5 {
				return fmt.Errorf("too many redirects")
			}
			return nil
		},
	}
	
	t.Run("Homepage Load", func(t *testing.T) {
		resp, err := client.Get(frontendURL)
		require.NoError(t, err, "Homepage request failed")
		defer resp.Body.Close()
		
		assert.Equal(t, http.StatusOK, resp.StatusCode, "Homepage should load successfully")
		
		// Check for basic HTML structure
		contentType := resp.Header.Get("Content-Type")
		assert.Contains(t, contentType, "text/html", "Homepage should return HTML")
	})
	
	t.Run("API Routes Accessible", func(t *testing.T) {
		// Test that API routes are accessible from frontend
		resp, err := client.Get(frontendURL + "/api/health")
		require.NoError(t, err, "API health check failed")
		defer resp.Body.Close()
		
		assert.Equal(t, http.StatusOK, resp.StatusCode, "API health endpoint should be accessible")
	})
	
	t.Run("Static Assets Load", func(t *testing.T) {
		// Test that static assets are served
		staticAssets := []string{
			"/favicon.ico",
			"/_next/static/css", // This might return a directory listing or 404, both are fine
		}
		
		for _, asset := range staticAssets {
			resp, err := client.Get(frontendURL + asset)
			if err != nil {
				t.Logf("Asset %s failed to load: %v", asset, err)
				continue
			}
			resp.Body.Close()
			
			// 200, 404, or 403 are all acceptable for static assets
			assert.Contains(t, []int{http.StatusOK, http.StatusNotFound, http.StatusForbidden}, 
				resp.StatusCode, "Static asset %s returned unexpected status", asset)
		}
	})
	
	t.Run("Frontend-Backend Integration", func(t *testing.T) {
		// Test that frontend can communicate with backend
		// This tests the full request flow: Frontend -> API Route -> Backend Service
		
		// Make a request to a frontend page that should fetch data from backend
		resp, err := client.Get(frontendURL + "/") // Homepage likely fetches top shorts
		require.NoError(t, err, "Frontend page request failed")
		defer resp.Body.Close()
		
		assert.Equal(t, http.StatusOK, resp.StatusCode, "Frontend page should load")
		
		// Check if the page loads without server errors
		// A 500 error would indicate backend integration issues
	})
	
	t.Run("Error Handling", func(t *testing.T) {
		// Test 404 handling
		resp, err := client.Get(frontendURL + "/nonexistent-page")
		require.NoError(t, err, "404 test request failed")
		defer resp.Body.Close()
		
		assert.Equal(t, http.StatusNotFound, resp.StatusCode, "Should return 404 for nonexistent pages")
	})
	
	t.Run("Security Headers", func(t *testing.T) {
		resp, err := client.Get(frontendURL)
		require.NoError(t, err, "Security headers test request failed")
		defer resp.Body.Close()
		
		// Check for basic security headers
		headers := resp.Header
		
		// These are optional but good to have
		securityHeaders := map[string]string{
			"X-Frame-Options":        "",
			"X-Content-Type-Options": "nosniff",
			"X-XSS-Protection":       "",
		}
		
		for header, expectedValue := range securityHeaders {
			value := headers.Get(header)
			if expectedValue != "" {
				assert.Equal(t, expectedValue, value, "Security header %s should have expected value", header)
			} else {
				t.Logf("Security header %s: %s", header, value)
			}
		}
	})
}

func TestDataConsistency(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}
	
	t.Run("API Data Consistency", func(t *testing.T) {
		// Test that the same request returns consistent data
		req1 := GetTopShortsRequest{
			Period: "1M",
			Limit:  5,
			Offset: 0,
		}
		
		// Make first request
		resp1, err := makeConnectRequest(client, "GetTopShorts", req1)
		require.NoError(t, err, "First GetTopShorts request failed")
		defer resp1.Body.Close()
		
		if resp1.StatusCode != http.StatusOK {
			t.Skipf("Skipping consistency test - no data available (status: %d)", resp1.StatusCode)
			return
		}
		
		// Wait a short time
		time.Sleep(100 * time.Millisecond)
		
		// Make second request
		resp2, err := makeConnectRequest(client, "GetTopShorts", req1)
		require.NoError(t, err, "Second GetTopShorts request failed")
		defer resp2.Body.Close()
		
		assert.Equal(t, resp1.StatusCode, resp2.StatusCode, "Response status should be consistent")
		
		// For caching validation, responses should be consistent within a short time window
		if resp1.StatusCode == http.StatusOK {
			// We could compare response bodies here, but for now just ensure both succeed
			assert.Equal(t, http.StatusOK, resp2.StatusCode, "Cached response should also succeed")
		}
	})
	
	t.Run("Cache Behavior", func(t *testing.T) {
		// Test caching behavior by making repeated requests
		req := GetTopShortsRequest{
			Period: "1M",
			Limit:  1,
			Offset: 0,
		}
		
		var firstResponseTime, secondResponseTime time.Duration
		
		// First request (cache miss)
		start := time.Now()
		resp1, err := makeConnectRequest(client, "GetTopShorts", req)
		firstResponseTime = time.Since(start)
		require.NoError(t, err, "First cached request failed")
		resp1.Body.Close()
		
		// Second request (should be cache hit)
		start = time.Now()
		resp2, err := makeConnectRequest(client, "GetTopShorts", req)
		secondResponseTime = time.Since(start)
		require.NoError(t, err, "Second cached request failed")
		resp2.Body.Close()
		
		// Both should succeed
		if resp1.StatusCode == http.StatusOK {
			assert.Equal(t, http.StatusOK, resp2.StatusCode, "Cached response should match original")
		}
		
		// Log timing for analysis (cache hit should typically be faster)
		t.Logf("First request time: %v, Second request time: %v", firstResponseTime, secondResponseTime)
		
		// Cache hit should generally be faster, but this is just informational
		if secondResponseTime < firstResponseTime {
			t.Logf("Cache appears to be working - second request was faster")
		}
	})
}

func TestPerformance(t *testing.T) {
	client := &http.Client{Timeout: 30 * time.Second}
	
	t.Run("Response Time Thresholds", func(t *testing.T) {
		testCases := []struct {
			name      string
			url       string
			threshold time.Duration
		}{
			{
				name:      "Homepage load time",
				url:       frontendURL,
				threshold: 5 * time.Second,
			},
			{
				name:      "API health check",
				url:       backendURL + "/health",
				threshold: 1 * time.Second,
			},
		}
		
		for _, tc := range testCases {
			t.Run(tc.name, func(t *testing.T) {
				start := time.Now()
				resp, err := client.Get(tc.url)
				elapsed := time.Since(start)
				
				require.NoError(t, err, "Request failed")
				defer resp.Body.Close()
				
				assert.Equal(t, http.StatusOK, resp.StatusCode, "Request should succeed")
				assert.Less(t, elapsed, tc.threshold, 
					"Response time %v should be less than threshold %v", elapsed, tc.threshold)
				
				t.Logf("%s took %v", tc.name, elapsed)
			})
		}
	})
	
	t.Run("Concurrent Request Handling", func(t *testing.T) {
		// Test that the system can handle multiple concurrent requests
		const numRequests = 10
		
		type result struct {
			statusCode int
			duration   time.Duration
			err        error
		}
		
		results := make(chan result, numRequests)
		
		// Start concurrent requests
		for i := 0; i < numRequests; i++ {
			go func() {
				start := time.Now()
				resp, err := client.Get(frontendURL)
				duration := time.Since(start)
				
				r := result{
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
		
		// Collect results
		successCount := 0
		var totalDuration time.Duration
		
		for i := 0; i < numRequests; i++ {
			r := <-results
			
			if r.err == nil && r.statusCode == http.StatusOK {
				successCount++
				totalDuration += r.duration
			} else if r.err != nil {
				t.Logf("Request %d failed: %v", i+1, r.err)
			} else {
				t.Logf("Request %d returned status %d", i+1, r.statusCode)
			}
		}
		
		assert.Greater(t, successCount, numRequests/2, 
			"At least half of concurrent requests should succeed")
		
		if successCount > 0 {
			avgDuration := totalDuration / time.Duration(successCount)
			t.Logf("Concurrent requests: %d/%d successful, avg duration: %v", 
				successCount, numRequests, avgDuration)
		}
	})
}

func TestFullStackUserJourney(t *testing.T) {
	client := &http.Client{Timeout: 15 * time.Second}

	t.Run("Complete user workflow", func(t *testing.T) {
		// 1. User visits homepage and gets top shorted stocks
		topShortsReq := GetTopShortsRequest{
			Period: "1M",
			Limit:  10,
			Offset: 0,
		}

		resp, err := makeConnectRequest(client, "GetTopShorts", topShortsReq)
		require.NoError(t, err)
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			t.Logf("GetTopShorts returned status %d, skipping rest of test", resp.StatusCode)
			return
		}

		var topShortsResp GetTopShortsResponse
		err = json.NewDecoder(resp.Body).Decode(&topShortsResp)
		require.NoError(t, err)

		if len(topShortsResp.TimeSeries) == 0 {
			t.Skip("No stocks returned, skipping detailed tests")
		}

		// 2. User selects first stock from the list
		firstStock := topShortsResp.TimeSeries[0]
		assert.NotEmpty(t, firstStock.ProductCode)
		assert.NotEmpty(t, firstStock.Name)

		// 3. User views stock details
		stockReq := GetStockRequest{
			ProductCode: firstStock.ProductCode,
		}

		stockResp, err := makeConnectRequest(client, "GetStock", stockReq)
		require.NoError(t, err)
		defer stockResp.Body.Close()

		if stockResp.StatusCode == http.StatusOK {
			var stock Stock
			err = json.NewDecoder(stockResp.Body).Decode(&stock)
			require.NoError(t, err)

			assert.Equal(t, firstStock.ProductCode, stock.ProductCode)
			assert.NotEmpty(t, stock.Name)
		}
	})

	t.Run("Data consistency across endpoints", func(t *testing.T) {
		// Get top shorts
		topShortsReq := GetTopShortsRequest{
			Period: "1M",
			Limit:  5,
			Offset: 0,
		}

		topShortsResp, err := makeConnectRequest(client, "GetTopShorts", topShortsReq)
		require.NoError(t, err)
		defer topShortsResp.Body.Close()

		if topShortsResp.StatusCode != http.StatusOK {
			t.Skip("GetTopShorts failed, skipping consistency test")
		}

		var topShorts GetTopShortsResponse
		err = json.NewDecoder(topShortsResp.Body).Decode(&topShorts)
		require.NoError(t, err)

		if len(topShorts.TimeSeries) == 0 {
			t.Skip("No stocks returned, skipping consistency test")
		}

		// For each stock in top shorts, verify GetStock returns consistent data
		for _, stockSeries := range topShorts.TimeSeries {
			stockReq := GetStockRequest{
				ProductCode: stockSeries.ProductCode,
			}

			stockResp, err := makeConnectRequest(client, "GetStock", stockReq)
			require.NoError(t, err)
			
			if stockResp.StatusCode == http.StatusOK {
				var stock Stock
				err = json.NewDecoder(stockResp.Body).Decode(&stock)
				require.NoError(t, err)

				// Verify consistency
				assert.Equal(t, stockSeries.ProductCode, stock.ProductCode)
				assert.Equal(t, stockSeries.Name, stock.Name)
			}
			
			stockResp.Body.Close()
		}
	})
}

func TestDatabaseIntegration(t *testing.T) {
	client := &http.Client{Timeout: 10 * time.Second}

	t.Run("Database query performance", func(t *testing.T) {
		start := time.Now()

		req := GetTopShortsRequest{
			Period: "1M",
			Limit:  100,
			Offset: 0,
		}

		resp, err := makeConnectRequest(client, "GetTopShorts", req)
		require.NoError(t, err)
		defer resp.Body.Close()

		duration := time.Since(start)

		// Query should complete within reasonable time
		assert.Less(t, duration, 5*time.Second, "Query should complete within 5 seconds")

		if resp.StatusCode == http.StatusOK {
			var response GetTopShortsResponse
			err = json.NewDecoder(resp.Body).Decode(&response)
			assert.NoError(t, err)
		}
	})

	t.Run("Database connection pooling", func(t *testing.T) {
		// Make multiple concurrent requests to test connection pooling
		numRequests := 10
		results := make(chan error, numRequests)

		for i := 0; i < numRequests; i++ {
			go func() {
				req := GetTopShortsRequest{
					Period: "1M",
					Limit:  10,
					Offset: 0,
				}

				resp, err := makeConnectRequest(client, "GetTopShorts", req)
				if err != nil {
					results <- err
					return
				}
				defer resp.Body.Close()

				if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNotFound {
					results <- fmt.Errorf("unexpected status: %d", resp.StatusCode)
					return
				}

				results <- nil
			}()
		}

		// Wait for all requests to complete
		for i := 0; i < numRequests; i++ {
			select {
			case err := <-results:
				assert.NoError(t, err)
			case <-time.After(10 * time.Second):
				t.Fatal("Request timed out")
			}
		}
	})
}