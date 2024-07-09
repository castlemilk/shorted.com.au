package shorts

import (
	"context"
	"fmt"

	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	stockv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
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
func (s *postgresStore) GetTopShorts(period string, limit int32, offset int32) ([]*stockv1alpha1.TimeSeriesData, int, error) {
	// You'll need to adjust FetchTimeSeriesData to use pgx as well.
	return FetchTimeSeriesData(s.db, int(limit), int(offset), period)
}

// GetStockData retrieves the time series data for a single stock, downsampling it for performance.
func (s *postgresStore) GetStockData(productCode, period string) (*stockv1alpha1.TimeSeriesData, error) {
	// Define the interval for downsampling (e.g., 'day', 'week', 'month')
	var interval string
	switch period {
	case "1d":
		interval = "day"
	case "1w":
		interval = "day"
	case "1m":
		interval = "day"
	case "3m":
		interval = "day"
	case "6m":
		interval = "day"
	case "1y", "2y":
		interval = "day"
	case "max":
		interval = "week"
	default:
		interval = "day"
	}

	query := fmt.Sprintf(`
		SELECT date_trunc('%s', "DATE") as interval_start, 
		       AVG("PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS") as avg_percent
		FROM shorts
		WHERE "PRODUCT_CODE" = $1
		  AND "DATE" > CURRENT_DATE - INTERVAL '%s'
		  AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" IS NOT NULL
		  AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
		GROUP BY interval_start
		ORDER BY interval_start ASC`, interval, periodToInterval(period))
	log.Infof("Generated Query: %s", query)
	rows, err := s.db.Query(context.Background(), query, productCode)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

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

	// Only add this product's time series data if it has at least 10 data points
	if len(points) >= 10 {
		return &stocksv1alpha1.TimeSeriesData{
			ProductCode:         productCode,
			Points:              points,
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
		from "company-metadata" 
		where stock_code = $1
		LIMIT 1`

	rows, _ := s.db.Query(context.Background(), query, stockCode)

	stock, err := pgx.CollectOneRow(rows, pgx.RowToStructByName[stockv1alpha1.StockDetails]) // Update as per actual table schema
	if err != nil {
		return nil, err
	}
	return &stock, nil
}

// GetHeatmapData retrieves the top shorted stocks by industry.
func (s *postgresStore) GetIndustryTreeMap(limit int32, period string, viewMode string) (*stockv1alpha1.IndustryTreeMap, error) {
	return FetchTreeMapData(s.db, limit, period, viewMode)
}
