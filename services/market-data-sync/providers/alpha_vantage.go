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

const alphaVantageDefaultURL = "https://www.alphavantage.co/query"

type AlphaVantageProvider struct {
	apiKey string
	// baseURL is the query endpoint. Overridable so the symbol-verification
	// behaviour can be tested against a stub; production always uses the default.
	baseURL string
}

func NewAlphaVantageProvider(apiKey string) *AlphaVantageProvider {
	return &AlphaVantageProvider{apiKey: apiKey, baseURL: alphaVantageDefaultURL}
}

// newAlphaVantageForTest builds a provider pointed at a stub server.
func newAlphaVantageForTest(baseURL, apiKey string) *AlphaVantageProvider {
	return &AlphaVantageProvider{apiKey: apiKey, baseURL: baseURL}
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

	base := p.baseURL
	if base == "" {
		base = alphaVantageDefaultURL
	}
	u, _ := url.Parse(base)
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
		// MetaData echoes the symbol Alpha Vantage actually answered for, which is
		// not always the one asked for — see the audience check below.
		MetaData   map[string]string            `json:"Meta Data"`
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
		if strings.Contains(data.Error, "Invalid API call") {
			return nil, NewNoDataError(symbol, fmt.Sprintf("alpha vantage: %s", data.Error))
		}
		return nil, fmt.Errorf("alpha vantage error: %s", data.Error)
	}

	// VERIFY THE RESPONSE IS ABOUT THE SECURITY WE ASKED FOR.
	//
	// Alpha Vantage does not reject an exchange suffix it does not carry; for
	// `AMD.AX` it resolves to the base symbol and returns NASDAQ's AMD. Nothing in
	// the payload distinguishes that from a correct answer except `Meta Data`, and
	// this function used to discard it — stamping every record with the symbol we
	// REQUESTED rather than the one that came back.
	//
	// What that produced in production: on ASX holidays the Yahoo provider returns
	// no data, the chain falls through to here, and ASX:AMD (Arrow Minerals, ~$0.02)
	// was written at $214.99 with 15.7M shares of NASDAQ volume. Boxing Day 2025 did
	// it across the universe — 215 of 1,006 codes, 745 bad sessions concentrated in
	// Nov-Dec 2025. The value reverts the next session, so it reads as a 10,000x
	// return rather than as missing data, and every downstream consumer believed it.
	//
	// A price for the wrong company is worse than no price. No data is visible; this
	// was not.
	if returned := strings.TrimSpace(data.MetaData["2. Symbol"]); returned != "" {
		if !strings.EqualFold(returned, avSymbol) {
			return nil, NewNoDataError(symbol, fmt.Sprintf(
				"alpha vantage answered for %q when asked for %q — refusing a price for a different security",
				returned, avSymbol))
		}
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
