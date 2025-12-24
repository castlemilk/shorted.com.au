package shorts

import (
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stockv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
)

// SyncStatusFilter defines filtering options for sync status queries
type SyncStatusFilter struct {
	Limit       int
	Environment string // "production", "development", or empty for all
	ExcludeLocal bool   // if true, exclude runs from local hostnames
}

type Store interface {
	GetStock(string) (*stockv1alpha1.Stock, error)
	GetTopShorts(string, int32, int32) ([]*stockv1alpha1.TimeSeriesData, int, error)
	GetStockDetails(string) (*stockv1alpha1.StockDetails, error)
	GetStockData(string, string) (*stockv1alpha1.TimeSeriesData, error)
	GetIndustryTreeMap(int32, string, string) (*stockv1alpha1.IndustryTreeMap, error)
	RegisterEmail(string) error
	SearchStocks(string, int32) ([]*stockv1alpha1.Stock, error)
	GetSyncStatus(filter SyncStatusFilter) ([]*shortsv1alpha1.SyncRun, error)
	
	// Key metrics sync methods
	GetAllStockCodes() ([]string, error)
	StockExists(stockCode string) (bool, error)
	UpdateKeyMetrics(stockCode string, metrics map[string]interface{}) error
}

func NewStore(config Config) Store {
	switch config.StorageBackend {
	case PostgresStore:
		return newPostgresStore(config)
	default:
		return nil
	}
}
