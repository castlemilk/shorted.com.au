package providers

import (
	"context"
	"fmt"
	"time"

	"github.com/piquette/finance-go/chart"
	"github.com/piquette/finance-go/datetime"
)

type YahooFinanceProvider struct{}

func NewYahooFinanceProvider() *YahooFinanceProvider {
	return &YahooFinanceProvider{}
}

func (p *YahooFinanceProvider) Name() string {
	return "Yahoo Finance"
}

func (p *YahooFinanceProvider) GetRateLimit() time.Duration {
	return 2 * time.Second
}

func (p *YahooFinanceProvider) FetchHistoricalData(ctx context.Context, symbol string, startDate, endDate time.Time) ([]PriceRecord, error) {
	// Yahoo Finance requires .AX suffix for ASX stocks
	yfTicker := symbol
	if !containsSuffix(yfTicker, ".AX") {
		yfTicker = fmt.Sprintf("%s.AX", symbol)
	}

	params := &chart.Params{
		Symbol:   yfTicker,
		Start:    datetime.New(&startDate),
		End:      datetime.New(&endDate),
		Interval: datetime.OneDay,
	}

	iter := chart.Get(params)
	var records []PriceRecord

	// Try to fetch at least one record to detect errors early
	hasData := false
	for iter.Next() {
		hasData = true
		b := iter.Bar()
		
		t := time.Unix(int64(b.Timestamp), 0)
		
		open, _ := b.Open.Float64()
		high, _ := b.High.Float64()
		low, _ := b.Low.Float64()
		closePrice, _ := b.Close.Float64()
		adjClose, _ := b.AdjClose.Float64()

		records = append(records, PriceRecord{
			StockCode:     symbol,
			Date:          t,
			Open:          open,
			High:          high,
			Low:           low,
			Close:         closePrice,
			AdjustedClose: adjClose,
			Volume:        int64(b.Volume),
		})
	}

	if err := iter.Err(); err != nil {
		// Enhance error message with symbol and date range for debugging
		return nil, fmt.Errorf("yahoo finance API error for %s (%s to %s): %w", yfTicker, startDate.Format("2006-01-02"), endDate.Format("2006-01-02"), err)
	}

	// If no data and no error, Yahoo Finance might have returned empty results
	// This could indicate the symbol doesn't exist or date range has no data
	if !hasData && len(records) == 0 {
		return nil, fmt.Errorf("yahoo finance returned no data for %s (symbol may not exist or date range has no trading data)", yfTicker)
	}

	return records, nil
}

func containsSuffix(s, suffix string) bool {
	if len(s) < len(suffix) {
		return false
	}
	return s[len(s)-len(suffix):] == suffix
}
