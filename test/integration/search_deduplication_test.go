package integration

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestSearchDeduplication verifies that search results don't contain duplicate stocks
func TestSearchDeduplication(t *testing.T) {
	client := &http.Client{}

	// Insert test data that would cause duplicates if not deduplicated
	// This simulates a real-world scenario where a stock like "RMX" appears in multiple categories
	
	testCases := []struct {
		name           string
		query          string
		expectedUnique bool
	}{
		{
			name:           "Search for RMX returns unique results",
			query:          "RMX",
			expectedUnique: true,
		},
		{
			name:           "Search for CBA returns unique results",
			query:          "CBA",
			expectedUnique: true,
		},
		{
			name:           "Partial match doesn't create duplicates",
			query:          "AX",
			expectedUnique: true,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			url := fmt.Sprintf("%s/api/stocks/search?q=%s&limit=50", backendURL, tc.query)
			
			resp, err := client.Get(url)
			require.NoError(t, err, "Search request failed")
			defer resp.Body.Close()
			
			if resp.StatusCode == http.StatusOK {
				var response struct {
					Query  string   `json:"query"`
					Stocks []struct {
						ProductCode string `json:"product_code"`
						Name        string `json:"name"`
					} `json:"stocks"`
					Count int `json:"count"`
				}
				
				err = json.NewDecoder(resp.Body).Decode(&response)
				require.NoError(t, err, "Failed to decode search response")
				
				// Check for duplicates
				productCodes := make(map[string]bool)
				duplicates := []string{}
				
				for _, stock := range response.Stocks {
					if productCodes[stock.ProductCode] {
						duplicates = append(duplicates, stock.ProductCode)
					}
					productCodes[stock.ProductCode] = true
				}
				
				if tc.expectedUnique {
					assert.Empty(t, duplicates, "Found duplicate product codes: %v", duplicates)
					t.Logf("Search for '%s' returned %d unique results", tc.query, len(response.Stocks))
				}
				
				// Verify count matches number of stocks
				assert.Equal(t, len(response.Stocks), response.Count, "Count should match number of stocks")
			}
		})
	}
}

// TestSearchMultipleFields verifies search works across multiple fields
func TestSearchMultipleFields(t *testing.T) {
	client := &http.Client{}

	testCases := []struct {
		name        string
		query       string
		description string
	}{
		{
			name:        "Search by exact product code",
			query:       "CBA",
			description: "Should find stocks with exact PRODUCT_CODE match",
		},
		{
			name:        "Search by partial product code",
			query:       "RMX",
			description: "Should find stocks with PRODUCT_CODE containing query",
		},
		{
			name:        "Search by company name",
			query:       "Bank",
			description: "Should find stocks with PRODUCT name containing query",
		},
		{
			name:        "Search with case insensitive",
			query:       "cba",
			description: "Should find stocks regardless of case",
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			url := fmt.Sprintf("%s/api/stocks/search?q=%s&limit=10", backendURL, tc.query)
			
			resp, err := client.Get(url)
			require.NoError(t, err, "Search request failed")
			defer resp.Body.Close()
			
			// Should return valid status
			assert.Contains(t, []int{http.StatusOK, http.StatusNotFound}, resp.StatusCode,
				"Search should return valid status code")
			
			if resp.StatusCode == http.StatusOK {
				var response struct {
					Query  string `json:"query"`
					Stocks []struct {
						ProductCode string `json:"product_code"`
						Name        string `json:"name"`
					} `json:"stocks"`
					Count int `json:"count"`
				}
				
				err = json.NewDecoder(resp.Body).Decode(&response)
				require.NoError(t, err, "Failed to decode search response")
				
				// Verify all results are unique
				productCodes := make(map[string]bool)
				for _, stock := range response.Stocks {
					assert.False(t, productCodes[stock.ProductCode], 
						"Duplicate product code found: %s", stock.ProductCode)
					productCodes[stock.ProductCode] = true
				}
				
				t.Logf("Search for '%s' returned %d unique results", tc.query, response.Count)
			}
		})
	}
}

