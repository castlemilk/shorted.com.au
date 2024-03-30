package shorts

import (
	"context"
	"fmt"
	"time"

	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/jackc/pgx/v4/pgxpool"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// Function to convert period enum values to PostgreSQL interval strings.
func periodToInterval(period string) string {
	switch period {
	case "1m":
		return "1 month"
	case "3m":
		return "3 months"
	case "6m":
		return "6 months"
	case "1y":
		return "1 year"
	case "2y":
		return "2 years"
	default:
		return "6 months"
	}
}

// FetchTimeSeriesData retrieves time series data for the top N products with the highest short positions,
// over a specified period.
func FetchTimeSeriesData(db *pgxpool.Pool, limit int, period string) ([]*stocksv1alpha1.TimeSeriesData, error) {
	if limit <= 0 {
		limit = 10 // Default to 10 if a non-positive limit is provided
	}

	ctx := context.Background()
	interval := periodToInterval(period)
	// Fetch top product codes
	topCodesQuery := fmt.Sprintf(`
	SELECT "PRODUCT_CODE"
	FROM shorts
	WHERE "DATE" > CURRENT_DATE - INTERVAL '%s'
	GROUP BY "PRODUCT_CODE"
	ORDER BY MAX("PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS") DESC
	LIMIT $1`, interval)

	rows, err := db.Query(ctx, topCodesQuery, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	top10Shorts := make([]string, 0)
	productNames := make(map[string]string)

	for rows.Next() {
		var productCode, productName string
		// Adjust your SQL query to also select the product name
		if err := rows.Scan(&productCode, &productName); err != nil {
			return nil, err
		}
		top10Shorts = append(top10Shorts, productCode)
		productNames[productCode] = productName // Store the name associated with the product code
	}
	if rows.Err() != nil {
		return nil, rows.Err()
	}

	// Prepare to fetch time series data for each product code
	var timeSeriesDataSlice []*stocksv1alpha1.TimeSeriesData
	for _, productCode := range top10Shorts {
		query := fmt.Sprintf(`
		SELECT "DATE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
		FROM shorts
		WHERE "PRODUCT_CODE" = $1
		AND "DATE" > CURRENT_DATE - INTERVAL '%s'
		ORDER BY "DATE" ASC`, interval)

		rows, err := db.Query(ctx, query, productCode)
		if err != nil {
			return nil, err
		}

		var points []*stocksv1alpha1.TimeSeriesPoint
		for rows.Next() {
			var date time.Time
			var percent float64
			if err := rows.Scan(&date, &percent); err != nil {
				return nil, err
			}
			point := &stocksv1alpha1.TimeSeriesPoint{
				Timestamp:     timestamppb.New(date),
				ShortPosition: percent,
			}
			points = append(points, point)
		}
		if rows.Err() != nil {
			return nil, rows.Err()
		}
		rows.Close()

		tsData := &stocksv1alpha1.TimeSeriesData{
			ProductCode: productCode,
			Name: productNames[productCode],
			Points:      points,
		}
		timeSeriesDataSlice = append(timeSeriesDataSlice, tsData)
	}

	return timeSeriesDataSlice, nil
}
