package shorts

import (
	"context"
	"fmt"

	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/jackc/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// Function to convert period enum values to PostgreSQL interval strings.
func periodToInterval(period string) string {
	switch period {
	case "1D":
		return "1 day"
	case "1W":
		return "1 week"
	case "1M":
		return "1 month"
	case "3M":
		return "3 month"
	case "6M":
		return "6 month"
	case "1Y":
		return "1 year"
	case "2Y":
		return "2 year"
	case "5Y":
		return "5 year"
	case "10Y":
		return "10 year"
	case "MAX":
		return "100 year" // Use a very large interval for MAX
	default:
		return "6 month"
	}
}

// FetchTimeSeriesData retrieves time series data for the top N products with the highest short positions,
// over a specified period, starting from the given offset for infinite scrolling.
//
// Uses mv_top_shorts materialized view for fast retrieval of top stocks (~6ms vs ~2s),
// then fetches time series data from the raw shorts table.
// Falls back to raw query if MV doesn't exist (for dev/test environments).
func FetchTimeSeriesData(db *pgxpool.Pool, limit, offset int, period string, summaryOnly bool) ([]*stocksv1alpha1.TimeSeriesData, int, error) {
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
	log.Infof("Period: %s, Interval: %s", period, interval)

	// Summary-only mode: use mv_top_shorts with current_percent, skip time series query.
	// Returns ~5-10KB instead of ~10MB for 1000 stocks.
	if summaryOnly {
		summaryQuery := `
		SELECT product_name, product_code, current_percent
		FROM mv_top_shorts
		ORDER BY current_percent DESC
		LIMIT $1 OFFSET $2`

		rows, err := connection.Query(ctx, summaryQuery, limit, offset)
		if err != nil {
			// Fallback if MV doesn't exist
			log.Infof("mv_top_shorts not available for summary, using fallback: %v", err)
			summaryQuery = `
			WITH latest_shorts AS (
				SELECT DISTINCT ON ("PRODUCT_CODE")
					"PRODUCT_CODE",
					"PRODUCT",
					"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
				FROM shorts
				WHERE "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
					AND "DATE" > (SELECT MAX("DATE") FROM shorts) - INTERVAL '1 month'
					AND "PRODUCT" NOT ILIKE '%DEFERRED SETTLEMENT%'
					AND "PRODUCT" NOT ILIKE '%DEFERRED%'
					AND "PRODUCT" !~* 'ETF\M'
					AND LENGTH("PRODUCT_CODE") <= 4
					AND "PRODUCT" !~ '[0-9]+(\.[0-9]+)?\s*%'
					AND ("TOTAL_PRODUCT_IN_ISSUE" IS NULL OR "TOTAL_PRODUCT_IN_ISSUE" >= 5000000)
				ORDER BY "PRODUCT_CODE", "DATE" DESC
			)
			SELECT "PRODUCT", "PRODUCT_CODE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
			FROM latest_shorts
			ORDER BY "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DESC
			LIMIT $1 OFFSET $2`
			rows, err = connection.Query(ctx, summaryQuery, limit, offset)
			if err != nil {
				return nil, 0, err
			}
		}
		defer rows.Close()

		result := make([]*stocksv1alpha1.TimeSeriesData, 0, limit)
		for rows.Next() {
			var productName, productCode string
			var currentPercent float64
			if err := rows.Scan(&productName, &productCode, &currentPercent); err != nil {
				return nil, 0, err
			}
			result = append(result, &stocksv1alpha1.TimeSeriesData{
				ProductCode:         productCode,
				Name:                productName,
				LatestShortPosition: currentPercent,
			})
		}
		if rows.Err() != nil {
			return nil, 0, rows.Err()
		}
		return result, offset + len(result), nil
	}

	// Try mv_top_shorts materialized view first (fast path, ~6ms)
	// Falls back to raw query if MV doesn't exist (dev/test environments, ~2s)
	topCodesQuery := `
	SELECT product_name, product_code
	FROM mv_top_shorts
	ORDER BY current_percent DESC
	LIMIT $1 OFFSET $2`

	rows, err := connection.Query(ctx, topCodesQuery, limit, offset)
	if err != nil {
		// Fallback to original query if MV doesn't exist
		log.Infof("mv_top_shorts not available, using fallback query: %v", err)
		topCodesQuery = `
		WITH latest_shorts AS (
			SELECT DISTINCT ON ("PRODUCT_CODE")
				"PRODUCT_CODE",
				"PRODUCT",
				"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
			FROM shorts
			WHERE "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
				AND "DATE" > (SELECT MAX("DATE") FROM shorts) - INTERVAL '1 month'
				AND "PRODUCT" NOT ILIKE '%DEFERRED SETTLEMENT%'
				AND "PRODUCT" NOT ILIKE '%DEFERRED%'
				AND "PRODUCT" !~* 'ETF\M'
				AND LENGTH("PRODUCT_CODE") <= 4
				AND "PRODUCT" !~ '[0-9]+(\.[0-9]+)?\s*%'
				AND ("TOTAL_PRODUCT_IN_ISSUE" IS NULL OR "TOTAL_PRODUCT_IN_ISSUE" >= 5000000)
			ORDER BY "PRODUCT_CODE", "DATE" DESC
		)
		SELECT "PRODUCT", "PRODUCT_CODE"
		FROM latest_shorts
		ORDER BY "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DESC
		LIMIT $1 OFFSET $2`
		rows, err = connection.Query(ctx, topCodesQuery, limit, offset)
		if err != nil {
			return nil, 0, err
		}
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
	// Uses MAX(DATE) instead of CURRENT_DATE to work with historical data
	timeSeriesQuery := fmt.Sprintf(`
	SELECT 
	    "PRODUCT_CODE",
	    "DATE",
	    "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS "PERCENT"
	FROM shorts
	WHERE "PRODUCT_CODE" = ANY($1)
	    AND "DATE" > (SELECT MAX("DATE") FROM shorts) - INTERVAL '%s'
	    AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
	ORDER BY "PRODUCT_CODE", "DATE" ASC`, interval)

	rows, err = connection.Query(ctx, timeSeriesQuery, topShorts)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	timeSeriesMap := make(map[string][]*stocksv1alpha1.TimeSeriesPoint)
	minMaxMap := make(map[string]*struct {
		min, max *stocksv1alpha1.TimeSeriesPoint
	})

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
			minMaxMap[productCode] = &struct {
				min, max *stocksv1alpha1.TimeSeriesPoint
			}{point, point}
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
		// Require at least 2 points to draw a meaningful line chart
		if len(points) >= 2 {
			minMax := minMaxMap[productCode]
			latest := points[len(points)-1].ShortPosition
			tsData := &stocksv1alpha1.TimeSeriesData{
				ProductCode: productCode,
				Name:        productNames[productCode],
				// Decimate the series to a sparkline-appropriate resolution. These
				// are list sparklines (not the full per-stock chart), so full daily
				// resolution just bloats the payload (a 50-stock 6mo response was
				// ~370KB). Min/Max/Latest are computed from the FULL series, so
				// the markers and current value stay exact.
				Points:              decimatePoints(points, topShortsSparklineMaxPoints),
				LatestShortPosition: latest,
				Max:                 minMax.max,
				Min:                 minMax.min,
			}
			timeSeriesDataSlice = append(timeSeriesDataSlice, tsData)
		}
	}

	return timeSeriesDataSlice, newOffset, nil
}

// topShortsSparklineMaxPoints caps the number of series points returned per
// stock in the top-shorts list. ~60 points renders a smooth sparkline at a
// fraction of the bytes of full daily resolution.
const topShortsSparklineMaxPoints = 60

// decimatePoints evenly downsamples points to at most maxPoints, always keeping
// the first and last point so the line spans the full period. Returns the input
// unchanged when it's already small enough.
func decimatePoints(points []*stocksv1alpha1.TimeSeriesPoint, maxPoints int) []*stocksv1alpha1.TimeSeriesPoint {
	if maxPoints <= 1 || len(points) <= maxPoints {
		return points
	}
	out := make([]*stocksv1alpha1.TimeSeriesPoint, 0, maxPoints)
	step := float64(len(points)-1) / float64(maxPoints-1)
	for i := 0; i < maxPoints-1; i++ {
		out = append(out, points[int(float64(i)*step)])
	}
	out = append(out, points[len(points)-1]) // always include the most recent point
	return out
}
