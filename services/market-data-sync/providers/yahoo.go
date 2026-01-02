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

	for iter.Next() {
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
		return nil, err
	}

	return records, nil
}

func containsSuffix(s, suffix string) bool {
	if len(s) < len(suffix) {
		return false
	}
	return s[len(s)-len(suffix):] == suffix
}
