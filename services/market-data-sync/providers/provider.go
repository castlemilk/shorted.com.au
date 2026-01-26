package providers

import (
	"context"
	"time"
)

// PriceRecord represents a single day's stock price data
type PriceRecord struct {
	StockCode     string
	Date          time.Time
	Open          float64
	High          float64
	Low           float64
	Close         float64
	AdjustedClose float64
	Volume        int64
}

// DataProvider defines the interface for stock price data sources
type DataProvider interface {
	// FetchHistoricalData returns price records for a symbol within a date range
	FetchHistoricalData(ctx context.Context, symbol string, startDate, endDate time.Time) ([]PriceRecord, error)
	// GetRateLimit returns the duration to wait between calls
	GetRateLimit() time.Duration
	// Name returns the provider name
	Name() string
}
