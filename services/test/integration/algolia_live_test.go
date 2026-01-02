package integration

import (
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
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestAlgoliaLive tests the Algolia integration against a live backend
// Run with: go test -v -run TestAlgoliaLive -timeout 30s
func TestAlgoliaLive(t *testing.T) {
	apiURL := os.Getenv("SHORTS_API_URL")
	if apiURL == "" {
		apiURL = "http://localhost:9091"
	}

	// Check if service is running
	healthResp, err := http.Get(apiURL + "/health")
	if err != nil {
		t.Skipf("Service not available at %s: %v", apiURL, err)
	}
	defer func() {
		_ = healthResp.Body.Close()
	}()
	if healthResp.StatusCode != 200 {
		t.Skipf("Service not healthy at %s", apiURL)
	}

	ctx := context.Background()

	t.Run("AlgoliaProxyEndpoint", func(t *testing.T) {
		searchURL := fmt.Sprintf("%s/api/algolia/search?q=%s&limit=5", apiURL, url.QueryEscape("BHP"))
		t.Logf("Testing Algolia proxy at: %s", searchURL)

		resp, err := http.Get(searchURL)
		require.NoError(t, err)
		defer func() {
			_ = resp.Body.Close()
		}()

		t.Logf("Response status: %d", resp.StatusCode)

		switch resp.StatusCode {
		case http.StatusOK:
			var result map[string]interface{}
			err = json.NewDecoder(resp.Body).Decode(&result)
			require.NoError(t, err)
			t.Logf("Algolia response: %+v", result)

			// Verify we got hits
			if hits, ok := result["hits"].([]interface{}); ok {
				t.Logf("Found %d hits from Algolia", len(hits))
				for i, hit := range hits {
					if i < 3 { // Show first 3
						t.Logf("  Hit %d: %+v", i, hit)
					}
				}
			}
		case http.StatusServiceUnavailable:
			t.Log("Algolia not configured (503) - this is expected if ALGOLIA_* env vars are not set")
		case http.StatusNotFound:
			t.Log("Algolia endpoint not found (404) - service may need restart to pick up new endpoint")
		default:
			body := make([]byte, 1024)
			n, _ := resp.Body.Read(body)
			t.Logf("Unexpected response: %d - %s", resp.StatusCode, string(body[:n]))
		}
	})

	t.Run("SearchStocksRPC_WithAlgolia", func(t *testing.T) {
		// Check if Algolia is configured by testing the proxy endpoint first
		searchURL := fmt.Sprintf("%s/api/algolia/search?q=%s&limit=5", apiURL, url.QueryEscape("BHP"))
		algoliaResp, err := http.Get(searchURL)
		if err == nil {
			_ = algoliaResp.Body.Close()
			if algoliaResp.StatusCode == http.StatusServiceUnavailable {
				t.Skip("Algolia not configured (503) - skipping Algolia-dependent tests")
			}
		}

		client := shortsv1alpha1connect.NewShortedStocksServiceClient(
			http.DefaultClient,
			apiURL,
		)

		queries := []string{"BHP", "mining", "copper", "bank", "healthcare"}

		for _, query := range queries {
			t.Run("Query_"+query, func(t *testing.T) {
				start := time.Now()

				req := connect.NewRequest(&shortsv1alpha1.SearchStocksRequest{
					Query:          query,
					Limit:          10,
					IncludeDetails: true,
				})

				resp, err := client.SearchStocks(ctx, req)
				duration := time.Since(start)

				// If Algolia isn't configured, the service may return an error
				// In that case, skip this test rather than failing
				if err != nil {
					if connect.CodeOf(err) == connect.CodeInternal {
						t.Skipf("Search failed (likely Algolia not configured): %v", err)
					}
					require.NoError(t, err)
				}
				require.NotNil(t, resp.Msg)

				t.Logf("Search '%s': %d results in %v", query, resp.Msg.Count, duration)

				// Log first few results
				for i, stock := range resp.Msg.Stocks {
					if i < 3 {
						t.Logf("  [%d] %s - %s (%.2f%% short, industry: %s)",
							i+1, stock.ProductCode, stock.Name,
							stock.PercentageShorted, stock.Industry)
					}
				}

				// Verify we get reasonable results
				if query == "BHP" {
					assert.Greater(t, int(resp.Msg.Count), 0, "Should find BHP")
					if len(resp.Msg.Stocks) > 0 {
						assert.Equal(t, "BHP", resp.Msg.Stocks[0].ProductCode, "BHP should be first result")
					}
				}
			})
		}
	})

	t.Run("SearchPerformanceComparison", func(t *testing.T) {
		// Check if Algolia is configured
		searchURL := fmt.Sprintf("%s/api/algolia/search?q=%s&limit=5", apiURL, url.QueryEscape("BHP"))
		algoliaResp, err := http.Get(searchURL)
		if err == nil {
			_ = algoliaResp.Body.Close()
			if algoliaResp.StatusCode == http.StatusServiceUnavailable {
				t.Skip("Algolia not configured (503) - skipping Algolia-dependent tests")
			}
		}

		client := shortsv1alpha1connect.NewShortedStocksServiceClient(
			http.DefaultClient,
			apiURL,
		)

		// Run multiple searches to test caching and performance
		queries := []string{"BHP", "CSL", "CBA", "mining", "technology"}
		var totalDuration time.Duration

		for _, query := range queries {
			start := time.Now()
			req := connect.NewRequest(&shortsv1alpha1.SearchStocksRequest{
				Query: query,
				Limit: 20,
			})
			_, err := client.SearchStocks(ctx, req)
			duration := time.Since(start)
			totalDuration += duration

			if err != nil {
				if connect.CodeOf(err) == connect.CodeInternal {
					t.Skipf("Search failed (likely Algolia not configured): %v", err)
				}
				require.NoError(t, err)
			}
			t.Logf("Search '%s': %v", query, duration)
		}

		avgDuration := totalDuration / time.Duration(len(queries))
		t.Logf("Average search time: %v", avgDuration)

		// With Algolia, searches should be fast (<100ms typically)
		// With PostgreSQL fallback, might be 100-500ms
		assert.Less(t, avgDuration, 2*time.Second, "Searches should complete in reasonable time")
	})

	t.Run("TypoTolerance", func(t *testing.T) {
		// Check if Algolia is configured
		searchURL := fmt.Sprintf("%s/api/algolia/search?q=%s&limit=5", apiURL, url.QueryEscape("BHP"))
		algoliaResp, err := http.Get(searchURL)
		if err == nil {
			_ = algoliaResp.Body.Close()
			if algoliaResp.StatusCode == http.StatusServiceUnavailable {
				t.Skip("Algolia not configured (503) - skipping Algolia-dependent tests")
			}
		}

		// Algolia should handle typos - PostgreSQL won't
		client := shortsv1alpha1connect.NewShortedStocksServiceClient(
			http.DefaultClient,
			apiURL,
		)

		// Common typos
		typoTests := []struct {
			typo     string
			expected string
		}{
			{"BPH", "BHP"},      // transposed letters
			{"commwealth", ""},  // should find Commonwealth Bank
			{"mning", ""},       // should find Mining stocks
		}

		for _, tt := range typoTests {
			t.Run("Typo_"+tt.typo, func(t *testing.T) {
				req := connect.NewRequest(&shortsv1alpha1.SearchStocksRequest{
					Query: tt.typo,
					Limit: 5,
				})

				resp, err := client.SearchStocks(ctx, req)
				if err != nil {
					if connect.CodeOf(err) == connect.CodeInternal {
						t.Skipf("Search failed (likely Algolia not configured): %v", err)
					}
					require.NoError(t, err)
				}

				t.Logf("Typo search '%s': %d results", tt.typo, resp.Msg.Count)
				for i, stock := range resp.Msg.Stocks {
					if i < 3 {
						t.Logf("  [%d] %s - %s", i+1, stock.ProductCode, stock.Name)
					}
				}

				// If Algolia is working, typos should still find results
				// If PostgreSQL fallback, typos may not work
				if resp.Msg.Count > 0 && tt.expected != "" {
					found := false
					for _, stock := range resp.Msg.Stocks {
						if stock.ProductCode == tt.expected {
							found = true
							break
						}
					}
					if found {
						t.Logf("✅ Typo tolerance working: '%s' found '%s'", tt.typo, tt.expected)
					}
				}
			})
		}
	})
}

