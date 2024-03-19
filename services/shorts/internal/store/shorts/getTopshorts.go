package shorts

import (
	"time"

	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/go-pg/pg/v10"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// Function to convert period enum values to PostgreSQL interval strings, returning pg.Safe for query building.
func periodToSafeInterval(period string) pg.Safe {
	switch period {
	case "1m":
		return pg.Safe("INTERVAL '1 month'")
	case "3m":
		return pg.Safe("INTERVAL '3 months'")
	case "6m":
		return pg.Safe("INTERVAL '6 months'")
	case "1y":
		return pg.Safe("INTERVAL '1 years'")
	case "2y":
		return pg.Safe("INTERVAL '2 years'")
	default:
		return pg.Safe("INTERVAL '6 month'")
	}
}

// FetchTimeSeriesData retrieves time series data for the top N products with the highest short positions,
// over a specified period.
func FetchTimeSeriesData(db *pg.DB, limit int, period string) ([]*stocksv1alpha1.TimeSeriesData, error) {
	if limit <= 0 {
		limit = 10 // Default to 10 if a non-positive limit is provided
	}

	// Convert period to a SQL interval string
	interval := periodToSafeInterval(period)

	// Placeholder for top product codes based on the passed limit
	var top10Shorts []string

	// Query to select the top N product codes based on the limit and period
	_, err := db.Query(&top10Shorts, `
	WITH TopCodes AS (
	  SELECT
	    "PRODUCT_CODE",
	    MAX("PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS") AS max_percent_short
	  FROM
	    shorts
	  WHERE
	    "DATE" > CURRENT_DATE - ? 
	  GROUP BY
	    "PRODUCT_CODE"
	  ORDER BY
	    max_percent_short DESC
	  LIMIT ?
	)
	SELECT "PRODUCT_CODE" FROM TopCodes;
	`, interval, limit)
	if err != nil {
		return nil, err
	}

	// Execute the main query using the top N product codes and period
	var resultData []struct {
		Time   string
		Metric string
		Value  float64
	}

	_, err = db.Query(&resultData, `
	SELECT
	  "DATE" AS "time",
	  "PRODUCT_CODE" AS "metric",
	  "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS "value"
	FROM
	  shorts
	WHERE
	  "PRODUCT_CODE" IN (?)
	  AND "DATE" > CURRENT_DATE - ?
	ORDER BY
	  "metric", "DATE" ASC;
	`, pg.In(top10Shorts), interval)
	if err != nil {
		return nil, err
	}

	// Process the results into the desired protobuf structure
	var timeSeriesDataSlice []*stocksv1alpha1.TimeSeriesData
	timeSeriesDataMap := make(map[string]*stocksv1alpha1.TimeSeriesData)

	for _, row := range resultData {
		timestamp, err := time.Parse("2006-01-02 15:04:05", row.Time)
		if err != nil {
			return nil, err // handle error properly in real code
		}

		data, exists := timeSeriesDataMap[row.Metric]
		if !exists {
			data = &stocksv1alpha1.TimeSeriesData{
				ProductCode: row.Metric,
				Points:      []*stocksv1alpha1.TimeSeriesPoint{},
			}
			timeSeriesDataMap[row.Metric] = data
			timeSeriesDataSlice = append(timeSeriesDataSlice, data)
		}

		data.Points = append(data.Points, &stocksv1alpha1.TimeSeriesPoint{
			Timestamp:     timestamppb.New(timestamp),
			ShortPosition: row.Value,
		})
	}

	return timeSeriesDataSlice, nil
}
