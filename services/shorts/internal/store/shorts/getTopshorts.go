package shorts

import (
	"context"
	"fmt"

	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/jackc/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// Function to convert period enum values to PostgreSQL interval strings.
func periodToInterval(period string) string {
	switch period {
	case "1m":
		return "1 month"
	case "3m":
		return "3 month"
	case "6m":
		return "6 month"
	case "1y":
		return "1 year"
	case "2y":
		return "2 year"
	case "max":
		return "10 year"
	default:
		return "6 month"
	}
}

// FetchTimeSeriesData retrieves time series data for the top N products with the highest short positions,
// over a specified period, starting from the given offset for infinite scrolling.
func FetchTimeSeriesData(db *pgxpool.Pool, limit, offset int, period string) ([]*stocksv1alpha1.TimeSeriesData, int, error) {
	if limit <= 0 {
		limit = 10 // Default to 10 if a non-positive limit is provided
	}
	if offset < 0 {
		offset = 0 // Start at the beginning if a negative offset is given
	}
	
	ctx := context.Background()
	connection, err := db.Acquire(ctx)
	if err != nil {
		return nil, 0, err
	}
	defer connection.Release()

	interval := periodToInterval(period)
	
	// Optimized query for top product codes
	topCodesQuery := fmt.Sprintf(`
	WITH latest_shorts AS (
	    SELECT "PRODUCT_CODE", "PRODUCT", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS",
	           ROW_NUMBER() OVER (PARTITION BY "PRODUCT_CODE" ORDER BY "DATE" DESC) as rn
	    FROM shorts
	    WHERE "DATE" > CURRENT_DATE - INTERVAL '%s'
	      AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
	)
	SELECT "PRODUCT", "PRODUCT_CODE"
	FROM latest_shorts
	WHERE rn = 1
	ORDER BY "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DESC
	LIMIT $1 OFFSET $2`, interval)

	rows, err := connection.Query(ctx, topCodesQuery, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	productNames := make(map[string]string)
	topShorts := make([]string, 0)

	for rows.Next() {
		var productCode, productName string
		if err := rows.Scan(&productName, &productCode); err != nil {
			return nil, 0, err
		}
		topShorts = append(topShorts, productCode)
		productNames[productCode] = productName
	}
	if rows.Err() != nil {
		return nil, 0, rows.Err()
	}

	// Optimized query for time series data without downsampling
	timeSeriesQuery := fmt.Sprintf(`
	SELECT 
	    "PRODUCT_CODE",
	    "DATE",
	    "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS "PERCENT"
	FROM shorts
	WHERE "PRODUCT_CODE" = ANY($1)
	    AND "DATE" > CURRENT_DATE - INTERVAL '%s'
	    AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
	ORDER BY "PRODUCT_CODE", "DATE" ASC`, interval)

	rows, err = connection.Query(ctx, timeSeriesQuery, topShorts)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	timeSeriesMap := make(map[string][]*stocksv1alpha1.TimeSeriesPoint)
	minMaxMap := make(map[string]*struct{min, max *stocksv1alpha1.TimeSeriesPoint})

	for rows.Next() {
		var productCode string
		var date pgtype.Timestamp
		var percent pgtype.Float8
		if err := rows.Scan(&productCode, &date, &percent); err != nil {
			return nil, 0, err
		}
		if date.Status != pgtype.Present || percent.Status != pgtype.Present {
			continue
		}
		shortPosition := percent.Float
		point := &stocksv1alpha1.TimeSeriesPoint{
			Timestamp:     timestamppb.New(date.Time),
			ShortPosition: shortPosition,
		}
		timeSeriesMap[productCode] = append(timeSeriesMap[productCode], point)
		
		if minMax, ok := minMaxMap[productCode]; !ok {
			minMaxMap[productCode] = &struct{min, max *stocksv1alpha1.TimeSeriesPoint}{point, point}
		} else {
			if shortPosition < minMax.min.ShortPosition {
				minMax.min = point
			}
			if shortPosition > minMax.max.ShortPosition {
				minMax.max = point
			}
		}
	}

	// Calculate the new offset for subsequent queries
	newOffset := offset + len(topShorts)

	timeSeriesDataSlice := make([]*stocksv1alpha1.TimeSeriesData, 0)
	for _, productCode := range topShorts {
		points := timeSeriesMap[productCode]
		if len(points) >= 10 {
			minMax := minMaxMap[productCode]
			tsData := &stocksv1alpha1.TimeSeriesData{
				ProductCode:         productCode,
				Name:                productNames[productCode],
				Points:              points,
				LatestShortPosition: points[len(points)-1].ShortPosition,
				Max:                 minMax.max,
				Min:                 minMax.min,
			}
			timeSeriesDataSlice = append(timeSeriesDataSlice, tsData)
		}
	}

	return timeSeriesDataSlice, newOffset, nil
}
