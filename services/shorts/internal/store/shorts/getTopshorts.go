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
	interval := periodToInterval(period)
	// Fetch top product codes with pagination
	topCodesQuery := fmt.Sprintf(`
	SELECT "PRODUCT", "PRODUCT_CODE"
	FROM shorts
	WHERE "DATE" > CURRENT_DATE - INTERVAL '%s'
	GROUP BY 
		"PRODUCT", "PRODUCT_CODE"
	HAVING
		COUNT(*) > 10
	ORDER BY 
		MAX("PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS") DESC
	LIMIT $1 OFFSET $2`, interval)

	rows, err := db.Query(ctx, topCodesQuery, limit, offset)
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

	// Prepare to fetch time series data for each product code
	var timeSeriesDataSlice []*stocksv1alpha1.TimeSeriesData
	for _, productCode := range topShorts {
		query := fmt.Sprintf(`
		SELECT "DATE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
		FROM shorts
		WHERE "PRODUCT_CODE" = $1
			AND "DATE" > CURRENT_DATE - INTERVAL '%s'
			AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" IS NOT NULL
			AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
		ORDER BY "DATE" ASC`, interval)

		rows, err := db.Query(ctx, query, productCode)
		if err != nil {
			return nil, 0, err
		}

		var points []*stocksv1alpha1.TimeSeriesPoint
		var minShort, maxShort *stocksv1alpha1.TimeSeriesPoint
		minShort, maxShort = &stocksv1alpha1.TimeSeriesPoint{ShortPosition: -1}, &stocksv1alpha1.TimeSeriesPoint{ShortPosition: -1}
		for rows.Next() {
			var date pgtype.Timestamp
			var percent pgtype.Float8
			if err := rows.Scan(&date, &percent); err != nil {
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
			points = append(points, point)
			if minShort.ShortPosition == -1 || shortPosition < minShort.ShortPosition {
				minShort = point
			}
			if maxShort.ShortPosition == -1 || shortPosition > maxShort.ShortPosition {
				maxShort = point
			}
		}
		if rows.Err() != nil {
			return nil, 0, rows.Err()
		}
		rows.Close()

		if len(points) >= 10 {
			tsData := &stocksv1alpha1.TimeSeriesData{
				ProductCode: productCode,
				Name:        productNames[productCode],
				Points:      points,
				LatestShortPosition: points[len(points)-1].ShortPosition,
				Max: maxShort,
				Min: minShort,
			}
			timeSeriesDataSlice = append(timeSeriesDataSlice, tsData)
		}
	}

	// Calculate the new offset for subsequent queries
	newOffset := offset + len(topShorts)

	return timeSeriesDataSlice, newOffset, nil
}
