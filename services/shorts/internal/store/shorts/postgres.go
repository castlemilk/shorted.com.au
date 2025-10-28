package shorts

import (
	"context"
	"fmt"
	"time"

	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
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
	// Configure connection pool for better concurrency
	poolConfig, err := pgxpool.ParseConfig(fmt.Sprintf("postgres://%s:%s@%s/%s", 
		config.PostgresUsername, config.PostgresPassword, config.PostgresAddress, config.PostgresDatabase))
	if err != nil {
		panic("Unable to parse database config: " + err.Error())
	}
	
	// Set connection pool settings for better concurrency
	poolConfig.MaxConns = 25                    // Maximum number of connections
	poolConfig.MinConns = 5                     // Minimum number of connections
	poolConfig.MaxConnLifetime = time.Hour      // Maximum connection lifetime
	poolConfig.MaxConnIdleTime = time.Minute * 30 // Maximum idle time
	
	dbPool, err := pgxpool.NewWithConfig(context.Background(), poolConfig)
	if err != nil {
		panic("Unable to connect to database: " + err.Error())
	}
	
	return &postgresStore{
		db: dbPool,
	}
}

// GetStock retrieves a single stock by its ID.
func (s *postgresStore) GetStock(productCode string) (*stocksv1alpha1.Stock, error) {
	rows, _ := s.db.Query(context.Background(),
		`
SELECT "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" as percentage_shorted,
	"PRODUCT_CODE" as product_code,
	"PRODUCT" as name, 
	"TOTAL_PRODUCT_IN_ISSUE" as total_product_in_issue, 
	"REPORTED_SHORT_POSITIONS" as reported_short_positions
FROM shorts WHERE "PRODUCT_CODE" = $1 
ORDER BY "DATE" DESC LIMIT 1`,
		productCode)
	stock, err := pgx.CollectOneRow(rows, pgx.RowToStructByName[stocksv1alpha1.Stock])
	if err != nil {
		return nil, err
	}
	return &stock, nil
}

// GetTop10Shorts retrieves the top 10 shorted stocks.
func (s *postgresStore) GetTopShorts(period string, limit int32, offset int32) ([]*stocksv1alpha1.TimeSeriesData, int, error) {
	// You'll need to adjust FetchTimeSeriesData to use pgx as well.
	return FetchTimeSeriesData(s.db, int(limit), int(offset), period)
}

// GetStockData retrieves the time series data for a single stock, downsampling it for performance.
func (s *postgresStore) GetStockData(productCode, period string) (*stocksv1alpha1.TimeSeriesData, error) {
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

	// Return time series data even if there are fewer than 10 points
	if len(points) > 0 {
		return &stocksv1alpha1.TimeSeriesData{
			ProductCode:         productCode,
			Points:              points,
			LatestShortPosition: points[len(points)-1].ShortPosition,
		}, nil
	}
	// Return empty time series data if no points found
	return &stocksv1alpha1.TimeSeriesData{
		ProductCode:         productCode,
		Points:              []*stocksv1alpha1.TimeSeriesPoint{},
		LatestShortPosition: 0,
	}, nil
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
func (s *postgresStore) GetStockDetails(stockCode string) (*stocksv1alpha1.StockDetails, error) {
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

	stock, err := pgx.CollectOneRow(rows, pgx.RowToStructByName[stocksv1alpha1.StockDetails]) // Update as per actual table schema
	if err != nil {
		return nil, err
	}
	return &stock, nil
}

// GetHeatmapData retrieves the top shorted stocks by industry.
func (s *postgresStore) GetIndustryTreeMap(limit int32, period string, viewMode string) (*stocksv1alpha1.IndustryTreeMap, error) {
	return FetchTreeMapData(s.db, limit, period, viewMode)
}

func (s *postgresStore) RegisterEmail(email string) error {
	query := `insert into "subscriptions" (email) values ($1)`
	_, err := s.db.Exec(context.Background(), query, email)
	return err
}

// SearchStocks searches for stocks by symbol or company name
func (s *postgresStore) SearchStocks(query string, limit int32) ([]*stocksv1alpha1.Stock, error) {
	log.Debugf("Searching stocks with query: %s, limit: %d", query, limit)
	
	// Optimized search query that uses indexes efficiently
	// First try exact PRODUCT_CODE matches, then partial matches
	searchQuery := `
		WITH results AS (
			SELECT 
				"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" as percentage_shorted,
				"PRODUCT_CODE" as product_code,
				"PRODUCT" as name, 
				"TOTAL_PRODUCT_IN_ISSUE" as total_product_in_issue, 
				"REPORTED_SHORT_POSITIONS" as reported_short_positions,
				1 as sort_priority
			FROM shorts 
			WHERE "PRODUCT_CODE" = $1
			
			UNION ALL
			
			SELECT DISTINCT ON ("PRODUCT_CODE")
				"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" as percentage_shorted,
				"PRODUCT_CODE" as product_code,
				"PRODUCT" as name, 
				"TOTAL_PRODUCT_IN_ISSUE" as total_product_in_issue, 
				"REPORTED_SHORT_POSITIONS" as reported_short_positions,
				2 as sort_priority
			FROM shorts 
			WHERE "PRODUCT_CODE" ILIKE $2 AND "PRODUCT_CODE" != $1
			
			UNION ALL
			
			SELECT DISTINCT ON ("PRODUCT_CODE")
				"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" as percentage_shorted,
				"PRODUCT_CODE" as product_code,
				"PRODUCT" as name, 
				"TOTAL_PRODUCT_IN_ISSUE" as total_product_in_issue, 
				"REPORTED_SHORT_POSITIONS" as reported_short_positions,
				3 as sort_priority
			FROM shorts 
			WHERE "PRODUCT" ILIKE $3
		)
		SELECT DISTINCT ON (product_code)
			percentage_shorted, product_code, name, total_product_in_issue, reported_short_positions, sort_priority
		FROM results
		ORDER BY product_code, sort_priority
		LIMIT $4`
	
	// Create context with timeout to prevent hanging
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Prepare search patterns
	exactQuery := query
	partialQuery := "%" + query + "%"
	
	rows, err := s.db.Query(ctx, searchQuery, exactQuery, partialQuery, partialQuery, limit)
	if err != nil {
		log.Errorf("Database query failed for search '%s': %v", query, err)
		// Check if it's a context timeout
		if ctx.Err() == context.DeadlineExceeded {
			log.Errorf("Search query timed out for '%s'", query)
			return nil, fmt.Errorf("search query timed out: %w", err)
		}
		return nil, fmt.Errorf("failed to search stocks: %w", err)
	}
	defer rows.Close()
	
	// Custom scan function to handle sort_priority
	type searchResult struct {
		stocksv1alpha1.Stock
		SortPriority int32 `db:"sort_priority"`
	}
	
	var results []searchResult
	for rows.Next() {
		var result searchResult
		if err := rows.Scan(
			&result.PercentageShorted,
			&result.ProductCode,
			&result.Name,
			&result.TotalProductInIssue,
			&result.ReportedShortPositions,
			&result.SortPriority,
		); err != nil {
			log.Errorf("Failed to scan stock row for search '%s': %v", query, err)
			return nil, fmt.Errorf("failed to scan stock row: %w", err)
		}
		results = append(results, result)
	}
	
	// Convert []searchResult to []*stocksv1alpha1.Stock
	stockPointers := make([]*stocksv1alpha1.Stock, len(results))
	for i := range results {
		stockPointers[i] = &results[i].Stock
	}
	
	log.Debugf("Search completed for '%s': found %d stocks", query, len(results))
	return stockPointers, nil
}