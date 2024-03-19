package shorts

import (
	stockv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/go-pg/pg/v10"
)

// postgresStore implements the Store interface for a PostgreSQL backend.
type postgresStore struct {
	db *pg.DB
}

// newPostgresStore initializes a new store with a PostgreSQL backend.
func newPostgresStore(config Config) Store {
	db := pg.Connect(&pg.Options{
		Addr:     config.PostgresAddr, // Assumes Addr is in the form "host:port"
		User:     config.PostgresUser,
		Password: config.PostgresPassword,
		Database: config.PostgresDatabase,
	})
	return &postgresStore{
		db: db,
	}
}

// GetStock retrieves a single stock by its ID.
func (s *postgresStore) GetStock(productCode string) (*stockv1alpha1.Stock, error) {
	stock := &stockv1alpha1.Stock{ProductCode: productCode}
	err := s.db.Model(stock).WherePK().Select()
	if err != nil {
		return nil, err
	}
	return stock, nil
}

// GetTop10Shorts retrieves the top 10 shorted stocks.
func (s *postgresStore) GetTopShorts(period string, limit int32) ([]*stockv1alpha1.TimeSeriesData, error) {

	return FetchTimeSeriesData(s.db, int(limit), period)
}

// GetStockDetails retrieves details for a specific stock.
func (s *postgresStore) GetStockDetails(productCode string) (*stockv1alpha1.StockDetails, error) {
	var details *stockv1alpha1.StockDetails
	// err := s.db.Model(&details).Where("product_code = ?", productCode).Select()
	// if err != nil {
	// 	return nil, err
	// }
	return details, nil
}

// GetStockData retrieves details for a specific stock.
func (s *postgresStore) GetStockData(productCode string) (*stockv1alpha1.TimeSeriesData, error) {
	var details *stockv1alpha1.TimeSeriesData
	// err := s.db.Model(&details).Where("product_code = ?", productCode).Select()
	// if err != nil {
	// 	return nil, err
	// }
	return details, nil
}
