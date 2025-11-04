package shorts

import (
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
)

//go:generate mockgen -source=interfaces.go -destination=mocks/mock_interfaces.go -package=mocks

// ShortsStore defines the interface for shorts data operations
type ShortsStore interface {
	GetTopShorts(period string, limit int32, offset int32) ([]*stocksv1alpha1.TimeSeriesData, int, error)
	GetStock(productCode string) (*stocksv1alpha1.Stock, error)
	GetStockData(productCode, period string) (*stocksv1alpha1.TimeSeriesData, error)
	GetStockDetails(productCode string) (*stocksv1alpha1.StockDetails, error)
	GetIndustryTreeMap(limit int32, period, viewMode string) (*stocksv1alpha1.IndustryTreeMap, error)
	SearchStocks(query string, limit int32) ([]*stocksv1alpha1.Stock, error)
}

// Cache defines the interface for caching operations
type Cache interface {
	Get(key string) (interface{}, bool)
	Set(key string, value interface{})
	GetOrSet(key string, computeFn func() (interface{}, error)) (interface{}, error)
	Delete(key string)
	Clear()
	Size() int

	// Cache key generators
	GetTopShortsKey(period string, limit int32, offset int32) string
	GetStockKey(productCode string) string
	GetStockDataKey(productCode, period string) string
	GetStockDetailsKey(productCode string) string
	GetIndustryTreeMapKey(limit int32, period, viewMode string) string
	GetSearchStocksKey(query string, limit int32) string
}

// Logger defines the interface for logging operations
type Logger interface {
	Debugf(format string, args ...interface{})
	Infof(format string, args ...interface{})
	Warnf(format string, args ...interface{})
	Errorf(format string, args ...interface{})
}
