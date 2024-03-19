package shorts

import (
	stockv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
)

type Store interface {
	GetStock(string) (*stockv1alpha1.Stock, error)
	GetTopShorts(string, int32) ([]*stockv1alpha1.TimeSeriesData, error)
	GetStockDetails(string) (*stockv1alpha1.StockDetails, error)
	GetStockData(string) (*stockv1alpha1.TimeSeriesData, error)
}

func NewStore(config Config) Store {
	switch config.StorageBackend {
	case PostgresStore:
		return newPostgresStore(config)
	default:
		return nil
	}
}