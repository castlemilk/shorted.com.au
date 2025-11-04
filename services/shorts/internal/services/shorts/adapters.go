package shorts

import (
	"log"

	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// StoreAdapter adapts the concrete store implementation to the ShortsStore interface
type StoreAdapter struct {
	store shorts.Store
}

// NewStoreAdapter creates a new store adapter
func NewStoreAdapter(store shorts.Store) *StoreAdapter {
	return &StoreAdapter{store: store}
}

func (s *StoreAdapter) GetTopShorts(period string, limit int32, offset int32) ([]*stocksv1alpha1.TimeSeriesData, int, error) {
	return s.store.GetTopShorts(period, limit, offset)
}

func (s *StoreAdapter) GetStock(productCode string) (*stocksv1alpha1.Stock, error) {
	return s.store.GetStock(productCode)
}

func (s *StoreAdapter) GetStockData(productCode, period string) (*stocksv1alpha1.TimeSeriesData, error) {
	return s.store.GetStockData(productCode, period)
}

func (s *StoreAdapter) GetStockDetails(productCode string) (*stocksv1alpha1.StockDetails, error) {
	return s.store.GetStockDetails(productCode)
}

func (s *StoreAdapter) GetIndustryTreeMap(limit int32, period, viewMode string) (*stocksv1alpha1.IndustryTreeMap, error) {
	return s.store.GetIndustryTreeMap(limit, period, viewMode)
}

func (s *StoreAdapter) SearchStocks(query string, limit int32) ([]*stocksv1alpha1.Stock, error) {
	return s.store.SearchStocks(query, limit)
}

// LoggerAdapter adapts the standard logger to the Logger interface
type LoggerAdapter struct{}

// NewLoggerAdapter creates a new logger adapter
func NewLoggerAdapter() *LoggerAdapter {
	return &LoggerAdapter{}
}

func (l *LoggerAdapter) Debugf(format string, args ...interface{}) {
	log.Printf("[DEBUG] "+format, args...)
}

func (l *LoggerAdapter) Infof(format string, args ...interface{}) {
	log.Printf("[INFO] "+format, args...)
}

func (l *LoggerAdapter) Warnf(format string, args ...interface{}) {
	log.Printf("[WARN] "+format, args...)
}

func (l *LoggerAdapter) Errorf(format string, args ...interface{}) {
	log.Printf("[ERROR] "+format, args...)
}
