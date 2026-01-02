package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

type AlphaVantageProvider struct {
	apiKey string
}

func NewAlphaVantageProvider(apiKey string) *AlphaVantageProvider {
	return &AlphaVantageProvider{apiKey: apiKey}
}

func (p *AlphaVantageProvider) Name() string {
	return "Alpha Vantage"
}

func (p *AlphaVantageProvider) GetRateLimit() time.Duration {
	// 5 calls per minute = 12 seconds per call
	return 12 * time.Second
}

func (p *AlphaVantageProvider) FetchHistoricalData(ctx context.Context, symbol string, startDate, endDate time.Time) ([]PriceRecord, error) {
	// Alpha Vantage requires .AX suffix for ASX stocks
	// Add .AX if not already present
	avSymbol := symbol
	if !strings.HasSuffix(avSymbol, ".AX") {
		avSymbol = symbol + ".AX"
	}

	// Determine outputsize based on date range
	// Free tier only supports "compact" (last 100 days)
	// Premium tier supports "full" (all history)
	// Use "compact" for free tier - covers last ~100 trading days
	outputSize := "compact"
	daysDiff := int(time.Since(startDate).Hours() / 24)
	if daysDiff > 100 {
		// For longer ranges, we'll use compact and filter by date
		outputSize = "compact"
	}

	u, _ := url.Parse("https://www.alphavantage.co/query")
	q := u.Query()
	q.Set("function", "TIME_SERIES_DAILY")
	q.Set("symbol", avSymbol)
	q.Set("apikey", p.apiKey)
	q.Set("outputsize", outputSize)
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if err != nil {
		return nil, err
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("bad status from Alpha Vantage: %s", resp.Status)
	}

	var data struct {
		TimeSeries map[string]map[string]string `json:"Time Series (Daily)"`
		Note       string                       `json:"Note"`
		Info       string                       `json:"Information"`
		Error      string                       `json:"Error Message"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, err
	}

	if data.Note != "" || data.Info != "" {
		return nil, fmt.Errorf("rate limit hit or info: %s %s", data.Note, data.Info)
	}

	if data.Error != "" {
		return nil, fmt.Errorf("alpha vantage error: %s", data.Error)
	}

	var records []PriceRecord
	for dateStr, values := range data.TimeSeries {
		t, err := time.Parse("2006-01-02", dateStr)
		if err != nil {
			continue
		}

		if t.Before(startDate) || t.After(endDate) {
			continue
		}

		open, _ := strconv.ParseFloat(values["1. open"], 64)
		high, _ := strconv.ParseFloat(values["2. high"], 64)
		low, _ := strconv.ParseFloat(values["3. low"], 64)
		closePrice, _ := strconv.ParseFloat(values["4. close"], 64)
		volume, _ := strconv.ParseInt(values["5. volume"], 10, 64)

		records = append(records, PriceRecord{
			StockCode:     symbol,
			Date:          t,
			Open:          open,
			High:          high,
			Low:           low,
			Close:         closePrice,
			AdjustedClose: closePrice,
			Volume:        volume,
		})
	}

	// Sort by date ascending
	sort.Slice(records, func(i, j int) bool {
		return records[i].Date.Before(records[j].Date)
	})

	return records, nil
}
