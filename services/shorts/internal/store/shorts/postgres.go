package shorts

import (
	"context"
	"fmt"

	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	stockv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/jackc/pgtype"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/types/known/timestamppb"
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
func (s *postgresStore) GetStockData(productCode, period string) (*stockv1alpha1.TimeSeriesData, error) {
	// You'll need to adjust FetchTimeSeriesData to use pgx as well.
	query := fmt.Sprintf(`
		SELECT "DATE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
		FROM shorts
		WHERE "PRODUCT_CODE" = $1
		AND "DATE" > CURRENT_DATE - INTERVAL '%s'
		AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" IS NOT NULL
		AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
		ORDER BY "DATE" ASC`, periodToInterval(period))
	
		rows, err := s.db.Query(context.Background(), query, productCode)
		if err != nil {
			return nil, err
		}
	
		var points []*stocksv1alpha1.TimeSeriesPoint
		for rows.Next() {
			var date pgtype.Timestamp
			var percent pgtype.Float8
			if err := rows.Scan(&date, &percent); err != nil {
				return nil, err
			}
			// Skip if the date or percent is null
			if date.Status != pgtype.Present || percent.Status != pgtype.Present {
				continue
			}
			point := &stocksv1alpha1.TimeSeriesPoint{
				Timestamp:     timestamppb.New(date.Time),
				ShortPosition: percent.Float,
			}
			points = append(points, point)
		}
		if rows.Err() != nil {
			return nil, rows.Err()
		}
		rows.Close()
	
		// Only add this product's time series data if it has at least 10 data points
		if len(points) >= 1 {
			return &stocksv1alpha1.TimeSeriesData{
				ProductCode: productCode,
				Points:      points,
				LatestShortPosition: points[len(points)-1].ShortPosition,
			}, nil
		}
	return nil, nil
}

// GetStockDetails implements Store.
// fetch the stock metadata following the schema:
/**
Table "public.metadata"
      Column       | Type | Collation | Nullable | Default 
-------------------+------+-----------+----------+---------
 company_name      | text |           |          | 
 address           | text |           |          | 
 summary           | text |           |          | 
 details           | text |           |          | 
 website           | text |           |          | 
 stock_code        | text |           |          | 
 links             | text |           |          | 
 images            | text |           |          | 
 company_logo_link | text |           |          | 
 gcsUrl            | text |           |          | 
*/
func (s *postgresStore) GetStockDetails(stockCode string) (*stockv1alpha1.StockDetails, error) {
	query := `select 
		stock_code as ProductCode,
		company_name as CompanyName,
		address as Address,
		industry as Industry,
		summary as Summary,
		details as Details,
		website as Website,
		"gcsUrl" as GcsUrl
		from metadata 
		where stock_code = $1
		LIMIT 1`

	rows, _ := s.db.Query(context.Background(), query, stockCode)
	stock, err := pgx.CollectOneRow(rows, pgx.RowToStructByName[stockv1alpha1.StockDetails]) // Update as per actual table schema
	if err != nil {
		return nil, err
	}
	return &stock, nil
}
