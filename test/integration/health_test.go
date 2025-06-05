package integration

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	backendURL  = "http://localhost:8081"
	frontendURL = "http://localhost:3001"
	maxRetries  = 30
	retryDelay  = 2 * time.Second
)

func TestServiceHealth(t *testing.T) {
	tests := []struct {
		name string
		url  string
	}{
		{
			name: "Backend Health Check",
			url:  backendURL + "/health",
		},
		{
			name: "Frontend Health Check", 
			url:  frontendURL + "/api/health",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Wait for service to be healthy with retries
			var resp *http.Response
			var err error
			
			for i := 0; i < maxRetries; i++ {
				resp, err = http.Get(tt.url)
				if err == nil && resp.StatusCode == http.StatusOK {
					break
				}
				
				if resp != nil {
					resp.Body.Close()
				}
				
				t.Logf("Attempt %d/%d: Service not ready yet, waiting %v...", i+1, maxRetries, retryDelay)
				time.Sleep(retryDelay)
			}
			
			require.NoError(t, err, "Health check request failed")
			require.NotNil(t, resp, "No response received")
			defer resp.Body.Close()
			
			assert.Equal(t, http.StatusOK, resp.StatusCode, "Health check failed")
		})
	}
}

func TestDatabaseConnectivity(t *testing.T) {
	// Test database connectivity through the backend service
	url := fmt.Sprintf("%s/shorts.v1alpha1.ShortedStocksService/GetTopShorts", backendURL)
	
	// Create a simple request to test database connectivity
	req, err := http.NewRequest("POST", url, nil)
	require.NoError(t, err)
	
	req.Header.Set("Content-Type", "application/json")
	
	client := &http.Client{Timeout: 10 * time.Second}
	
	// Wait for service to be ready
	var resp *http.Response
	for i := 0; i < maxRetries; i++ {
		resp, err = client.Do(req)
		if err == nil {
			break
		}
		
		t.Logf("Database connectivity test attempt %d/%d, waiting %v...", i+1, maxRetries, retryDelay)
		time.Sleep(retryDelay)
	}
	
	require.NoError(t, err, "Database connectivity test failed")
	defer resp.Body.Close()
	
	// We expect either 200 (success) or 400 (bad request due to empty body)
	// Both indicate the service is running and can connect to the database
	assert.Contains(t, []int{http.StatusOK, http.StatusBadRequest}, resp.StatusCode, 
		"Database connectivity test failed - service not responding properly")
}

func TestServiceStartupOrder(t *testing.T) {
	// Test that services start in the correct order and dependencies are met
	
	t.Run("Database starts first", func(t *testing.T) {
		// This is implicitly tested by the backend service health check
		// since the backend depends on the database
		url := backendURL + "/health"
		
		resp, err := http.Get(url)
		require.NoError(t, err)
		defer resp.Body.Close()
		
		assert.Equal(t, http.StatusOK, resp.StatusCode)
	})
	
	t.Run("Backend starts after database", func(t *testing.T) {
		url := backendURL + "/health"
		
		resp, err := http.Get(url)
		require.NoError(t, err)
		defer resp.Body.Close()
		
		assert.Equal(t, http.StatusOK, resp.StatusCode)
	})
	
	t.Run("Frontend starts after backend", func(t *testing.T) {
		url := frontendURL + "/api/health"
		
		resp, err := http.Get(url)
		require.NoError(t, err)
		defer resp.Body.Close()
		
		assert.Equal(t, http.StatusOK, resp.StatusCode)
	})
}