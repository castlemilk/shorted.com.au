package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
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
	// Be respectful: 3-4 seconds between requests to avoid overwhelming Yahoo Finance
	// This gives ~900-1200 requests/hour, well below any reasonable rate limits
	// Yahoo Finance doesn't publish official limits, but being conservative prevents:
	// - IP blocking
	// - Rate limit errors
	// - Being flagged as abusive
	return 4 * time.Second
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
// For long date ranges (>2 years), it chunks requests to ensure full daily data fidelity
func (p *YahooFinanceDirectProvider) FetchHistoricalData(ctx context.Context, symbol string, startDate, endDate time.Time) ([]PriceRecord, error) {
	// Yahoo Finance requires .AX suffix for ASX stocks
	yfTicker := symbol
	if !containsSuffix(yfTicker, ".AX") {
		yfTicker = fmt.Sprintf("%s.AX", symbol)
	}

	// For long date ranges (>2 years), chunk into smaller requests to ensure full data fidelity
	// Yahoo Finance may sample/limit data points for very long ranges
	daysDiff := int(endDate.Sub(startDate).Hours() / 24)
	log.Printf("🔍 %s: Date range %s to %s = %d days", yfTicker, startDate.Format("2006-01-02"), endDate.Format("2006-01-02"), daysDiff)
	if daysDiff > 730 { // More than 2 years
		log.Printf("📦 Using chunked requests for %s (%d days > 730)", yfTicker, daysDiff)
		return p.fetchHistoricalDataChunked(ctx, yfTicker, symbol, startDate, endDate)
	}

	// For shorter ranges, use single request
	log.Printf("📥 Using single request for %s (%d days <= 730)", yfTicker, daysDiff)
	return p.fetchHistoricalDataSingle(ctx, yfTicker, symbol, startDate, endDate)
}

// fetchHistoricalDataSingle fetches data for a single date range (up to 2 years)
func (p *YahooFinanceDirectProvider) fetchHistoricalDataSingle(ctx context.Context, yfTicker, symbol string, startDate, endDate time.Time) ([]PriceRecord, error) {
	// We now use period1/period2 Unix timestamps directly in makeAPIRequest
	// This ensures we get daily data for the exact date range specified
	// (using range=max caused Yahoo Finance to return weekly/monthly data)
	return p.makeAPIRequest(ctx, yfTicker, symbol, startDate, endDate)
}

// fetchHistoricalDataChunked fetches data in 2-year chunks to ensure full daily data fidelity
func (p *YahooFinanceDirectProvider) fetchHistoricalDataChunked(ctx context.Context, yfTicker, symbol string, startDate, endDate time.Time) ([]PriceRecord, error) {
	var allRecords []PriceRecord
	currentStart := startDate
	
	// Chunk into 2-year periods (730 days)
	chunkDays := 730
	chunkDuration := time.Duration(chunkDays) * 24 * time.Hour
	
	totalDays := int(endDate.Sub(startDate).Hours() / 24)
	expectedChunks := (totalDays / chunkDays) + 1
	log.Printf("📦 Chunking %s: %d days into ~%d chunks of 2 years each", yfTicker, totalDays, expectedChunks)
	
	chunkNum := 0
	for currentStart.Before(endDate) {
		chunkNum++
		// Calculate chunk end date
		chunkEnd := currentStart.Add(chunkDuration)
		if chunkEnd.After(endDate) {
			chunkEnd = endDate
		}
		
		log.Printf("📦 [%d/%d] Fetching chunk %s to %s for %s", chunkNum, expectedChunks,
			currentStart.Format("2006-01-02"), chunkEnd.Format("2006-01-02"), yfTicker)
		
		// Fetch this chunk
		chunkRecords, err := p.fetchHistoricalDataSingle(ctx, yfTicker, symbol, currentStart, chunkEnd)
		if err != nil {
			// Log error but continue with next chunk
			log.Printf("⚠️ Error fetching chunk %s to %s for %s: %v", 
				currentStart.Format("2006-01-02"), chunkEnd.Format("2006-01-02"), yfTicker, err)
			// Move to next chunk
			currentStart = chunkEnd.AddDate(0, 0, 1)
			continue
		}
		
		log.Printf("✅ [%d/%d] Chunk returned %d records for %s", chunkNum, expectedChunks, len(chunkRecords), yfTicker)
		allRecords = append(allRecords, chunkRecords...)
		
		// Move to next chunk
		currentStart = chunkEnd.AddDate(0, 0, 1)
		
		// Rate limiting between chunks
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(p.GetRateLimit()):
		}
	}
	
	log.Printf("📊 Combined %d chunks into %d total records for %s", chunkNum, len(allRecords), yfTicker)
	
	// Remove duplicates (in case of overlap) and sort by date
	recordsMap := make(map[string]PriceRecord)
	for _, record := range allRecords {
		dateKey := record.Date.Format("2006-01-02")
		if existing, exists := recordsMap[dateKey]; !exists || record.Date.After(existing.Date) {
			recordsMap[dateKey] = record
		}
	}
	
	// Convert back to slice and sort
	var finalRecords []PriceRecord
	for _, record := range recordsMap {
		finalRecords = append(finalRecords, record)
	}
	
	// Sort by date
	for i := 0; i < len(finalRecords)-1; i++ {
		for j := i + 1; j < len(finalRecords); j++ {
			if finalRecords[i].Date.After(finalRecords[j].Date) {
				finalRecords[i], finalRecords[j] = finalRecords[j], finalRecords[i]
			}
		}
	}
	
	return finalRecords, nil
}

// makeAPIRequest makes a single API request to Yahoo Finance
func (p *YahooFinanceDirectProvider) makeAPIRequest(ctx context.Context, yfTicker, symbol string, startDate, endDate time.Time) ([]PriceRecord, error) {
	// Build API URL
	apiURL := fmt.Sprintf("https://query1.finance.yahoo.com/v8/finance/chart/%s", url.QueryEscape(yfTicker))
	req, err := http.NewRequestWithContext(ctx, "GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Add query parameters
	// IMPORTANT: Use period1/period2 Unix timestamps for date ranges instead of "range" parameter
	// When using range=max, Yahoo Finance may return weekly/monthly data instead of daily
	// Using explicit period1/period2 ensures we get daily data for the specified range
	q := req.URL.Query()
	q.Set("interval", "1d")
	q.Set("period1", fmt.Sprintf("%d", startDate.Unix()))
	q.Set("period2", fmt.Sprintf("%d", endDate.Unix()))
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
	now := time.Now()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	yesterday := today.AddDate(0, 0, -1)
	
	// Adjust date range: if requesting today's data but Yahoo Finance only has up to yesterday,
	// we should accept yesterday's data as valid
	adjustedStartDate := startDate
	adjustedEndDate := endDate
	
	// Only adjust dates if we're requesting recent data (within last few days)
	// For historical backfills (10 years), we don't want to adjust the range
	daysSinceStart := int(time.Since(startDate).Hours() / 24)
	if daysSinceStart <= 5 {
		// If requesting today's data (startDate is today or later), adjust to accept yesterday
		if !startDate.Before(today) {
			// If startDate is today, adjust it to yesterday to allow yesterday's data
			if startDate.Equal(today) || (startDate.After(today) && startDate.Before(today.Add(24*time.Hour))) {
				adjustedStartDate = yesterday
			}
			// Adjust endDate to end of yesterday if requesting today/future
			if endDate.After(today) || endDate.Equal(today) {
				adjustedEndDate = yesterday.Add(23*time.Hour + 59*time.Minute + 59*time.Second)
			}
		}
	}
	
	// Log what Yahoo Finance returned BEFORE filtering
	if len(timestamps) > 0 {
		earliestReturned := time.Unix(timestamps[0], 0)
		latestReturned := time.Unix(timestamps[len(timestamps)-1], 0)
		log.Printf("📊 Yahoo Finance returned %d timestamps for %s: %s to %s", 
			len(timestamps), yfTicker, earliestReturned.Format("2006-01-02"), latestReturned.Format("2006-01-02"))
	}
	
	var filteredCount int
	for i, ts := range timestamps {
		// Filter by date range (using adjusted dates)
		recordDate := time.Unix(ts, 0)
		if recordDate.Before(adjustedStartDate) || recordDate.After(adjustedEndDate) {
			filteredCount++
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

	// Debug: Log filtering stats for long date ranges
	daysSinceStartForLog := int(time.Since(startDate).Hours() / 24)
	if daysSinceStartForLog > 365 && filteredCount > 0 {
		log.Printf("📊 Filtered %d records outside date range for %s (kept %d)", filteredCount, yfTicker, len(records))
	}

	if len(records) == 0 {
		// Provide more helpful error message
		if len(timestamps) > 0 {
			latestDataDate := time.Unix(timestamps[len(timestamps)-1], 0)
			earliestDataDate := time.Unix(timestamps[0], 0)
			return nil, fmt.Errorf("yahoo finance returned no data for %s in date range %s to %s (available: %s to %s, filtered %d/%d)", 
				yfTicker, startDate.Format("2006-01-02"), endDate.Format("2006-01-02"), 
				earliestDataDate.Format("2006-01-02"), latestDataDate.Format("2006-01-02"), filteredCount, len(timestamps))
		}
		return nil, fmt.Errorf("yahoo finance returned no data for %s in date range %s to %s", yfTicker, startDate.Format("2006-01-02"), endDate.Format("2006-01-02"))
	}

	return records, nil
}
