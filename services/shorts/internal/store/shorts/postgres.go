package shorts

import (
	"context"
	"fmt"

	stockv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// postgresStore implements the Store interface for a PostgreSQL backend.
type postgresStore struct {
	db *pgxpool.Pool
}

// newPostgresStore initializes a new store with a PostgreSQL backend.
func newPostgresStore(config Config) Store {

	dbPool, err := pgxpool.New(context.Background(), fmt.Sprintf("postgres://%s:%s@%s/%s", config.PostgresUsername, config.PostgresPassword, config.PostgresAddress, config.PostgresDatabase))
	if err != nil {
		panic("Unable to connect to database: " + err.Error())
	}
	return &postgresStore{
		db: dbPool,
	}
}

// GetStock retrieves a single stock by its ID.
func (s *postgresStore) GetStock(productCode string) (*stockv1alpha1.Stock, error) {
	rows, _ := s.db.Query(context.Background(), 
	`
SELECT "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" as percentageShorted,
	"PRODUCT_CODE" as productCode,
	"PRODUCT" as name, 
	"TOTAL_PRODUCT_IN_ISSUE" as totalProductInIssue, 
	"REPORTED_SHORT_POSITIONS" as reportedShortPositions
FROM shorts WHERE "PRODUCT_CODE" = $1 
ORDER BY "DATE" DESC LIMIT 1`, 
	   productCode)
	stock, err := pgx.CollectOneRow(rows, pgx.RowToStructByName[stockv1alpha1.Stock]) // Update as per actual table schema
	if err != nil {
		return nil, err
	}
	return &stock, nil
}

// GetTop10Shorts retrieves the top 10 shorted stocks.
func (s *postgresStore) GetTopShorts(period string, limit int32) ([]*stockv1alpha1.TimeSeriesData, error) {
	// You'll need to adjust FetchTimeSeriesData to use pgx as well.
	return FetchTimeSeriesData(s.db, int(limit), period)
}

// The remaining functions need to be updated similarly.
// GetStockDetails and GetStockData examples are omitted but follow the pattern above.
func (s *postgresStore) GetStockData(period string) (*stockv1alpha1.TimeSeriesData, error) {
	// You'll need to adjust FetchTimeSeriesData to use pgx as well.
	return nil, nil
}

// GetStockDetails implements Store.
func (s *postgresStore) GetStockDetails(string) (*stockv1alpha1.StockDetails, error) {
	panic("unimplemented")
}
