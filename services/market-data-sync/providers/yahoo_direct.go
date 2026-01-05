package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// YahooFinanceDirectProvider implements a direct HTTP client for Yahoo Finance API
// This bypasses the broken piquette/finance-go library
type YahooFinanceDirectProvider struct {
	client *http.Client
}

// NewYahooFinanceDirectProvider creates a new direct Yahoo Finance provider
func NewYahooFinanceDirectProvider() *YahooFinanceDirectProvider {
	return &YahooFinanceDirectProvider{
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (p *YahooFinanceDirectProvider) Name() string {
	return "Yahoo Finance (Direct)"
}

func (p *YahooFinanceDirectProvider) GetRateLimit() time.Duration {
	return 2 * time.Second
}

// yahooChartResponse represents the Yahoo Finance v8 API response structure
type yahooChartResponse struct {
	Chart struct {
		Result []struct {
			Meta struct {
				Symbol string `json:"symbol"`
			} `json:"meta"`
			Timestamp  []int64 `json:"timestamp"`
			Indicators struct {
				Quote []struct {
					Open   []float64 `json:"open"`
					High   []float64 `json:"high"`
					Low    []float64 `json:"low"`
					Close  []float64 `json:"close"`
					Volume []int64   `json:"volume"`
				} `json:"quote"`
				AdjClose []struct {
					AdjClose []float64 `json:"adjclose"`
				} `json:"adjclose"`
			} `json:"indicators"`
		} `json:"result"`
		Error interface{} `json:"error"`
	} `json:"chart"`
}

// FetchHistoricalData fetches historical stock data directly from Yahoo Finance API
func (p *YahooFinanceDirectProvider) FetchHistoricalData(ctx context.Context, symbol string, startDate, endDate time.Time) ([]PriceRecord, error) {
	// Yahoo Finance requires .AX suffix for ASX stocks
	yfTicker := symbol
	if !containsSuffix(yfTicker, ".AX") {
		yfTicker = fmt.Sprintf("%s.AX", symbol)
	}

	// Calculate date range for Yahoo Finance API
	// Yahoo Finance uses predefined ranges: 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, ytd, max
	// For custom ranges, we'll use the closest match and filter results
	daysDiff := int(time.Since(startDate).Hours() / 24)
	var apiRange string
	switch {
	case daysDiff <= 1:
		apiRange = "1d"
	case daysDiff <= 5:
		apiRange = "5d"
	case daysDiff <= 30:
		apiRange = "1mo"
	case daysDiff <= 90:
		apiRange = "3mo"
	case daysDiff <= 180:
		apiRange = "6mo"
	case daysDiff <= 365:
		apiRange = "1y"
	case daysDiff <= 730:
		apiRange = "2y"
	case daysDiff <= 1825:
		apiRange = "5y"
	case daysDiff <= 3650:
		apiRange = "10y"
	default:
		apiRange = "max"
	}

	// Build API URL
	apiURL := fmt.Sprintf("https://query1.finance.yahoo.com/v8/finance/chart/%s", url.QueryEscape(yfTicker))
	req, err := http.NewRequestWithContext(ctx, "GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Add query parameters
	q := req.URL.Query()
	q.Set("interval", "1d")
	q.Set("range", apiRange)
	q.Set("includePrePost", "false")
	req.URL.RawQuery = q.Encode()

	// Set headers to mimic browser request
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")

	// Make request
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("yahoo finance API returned status %d: %s", resp.StatusCode, string(body))
	}

	// Parse JSON response
	var chartResp yahooChartResponse
	if err := json.NewDecoder(resp.Body).Decode(&chartResp); err != nil {
		return nil, fmt.Errorf("failed to parse JSON response: %w", err)
	}

	// Check for API errors
	if chartResp.Chart.Error != nil {
		errorBytes, _ := json.Marshal(chartResp.Chart.Error)
		return nil, fmt.Errorf("yahoo finance API error: %s", string(errorBytes))
	}

	// Check if we have results
	if len(chartResp.Chart.Result) == 0 {
		return nil, fmt.Errorf("yahoo finance returned no results for %s", yfTicker)
	}

	result := chartResp.Chart.Result[0]
	timestamps := result.Timestamp

	// Check if we have quote data
	if len(result.Indicators.Quote) == 0 {
		return nil, fmt.Errorf("yahoo finance returned no quote data for %s", yfTicker)
	}

	quote := result.Indicators.Quote[0]
	opens := quote.Open
	highs := quote.High
	lows := quote.Low
	closes := quote.Close
	volumes := quote.Volume

	// Get adjusted close if available
	var adjCloses []float64
	if len(result.Indicators.AdjClose) > 0 && len(result.Indicators.AdjClose[0].AdjClose) > 0 {
		adjCloses = result.Indicators.AdjClose[0].AdjClose
	}

	// Convert to PriceRecord slice
	var records []PriceRecord
	for i, ts := range timestamps {
		// Filter by date range
		recordDate := time.Unix(ts, 0)
		if recordDate.Before(startDate) || recordDate.After(endDate) {
			continue
		}

		// Skip if we don't have all required data
		if i >= len(opens) || i >= len(highs) || i >= len(lows) || i >= len(closes) || i >= len(volumes) {
			continue
		}

		// Use adjusted close if available, otherwise use regular close
		adjClose := closes[i]
		if i < len(adjCloses) && adjCloses[i] > 0 {
			adjClose = adjCloses[i]
		}

		records = append(records, PriceRecord{
			StockCode:     symbol,
			Date:          recordDate,
			Open:          opens[i],
			High:          highs[i],
			Low:           lows[i],
			Close:         closes[i],
			AdjustedClose: adjClose,
			Volume:        volumes[i],
		})
	}

	if len(records) == 0 {
		return nil, fmt.Errorf("yahoo finance returned no data for %s in date range %s to %s", yfTicker, startDate.Format("2006-01-02"), endDate.Format("2006-01-02"))
	}

	return records, nil
}
