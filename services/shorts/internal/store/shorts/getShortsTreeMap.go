package shorts

import (
	"context"
	"fmt"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Fallback queries for when mv_treemap_data doesn't exist (dev/test environments)
var (
	fallbackPercentageChangeQuery = `
	WITH period_data AS (
		SELECT
			"PRODUCT_CODE",
			"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS",
			"DATE",
			ROW_NUMBER() OVER (PARTITION BY "PRODUCT_CODE" ORDER BY "DATE" DESC) AS rnk_desc,
			ROW_NUMBER() OVER (PARTITION BY "PRODUCT_CODE" ORDER BY "DATE" ASC) AS rnk_asc
		FROM public.shorts
		WHERE "DATE" >= (SELECT MAX("DATE") FROM shorts) - INTERVAL '%s'
	),
	latest_data AS (
		SELECT
			"PRODUCT_CODE",
			"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS latest_short_position,
			"DATE" AS latest_date
		FROM period_data
		WHERE rnk_desc = 1
			AND "DATE" >= (SELECT MAX("DATE") FROM shorts) - INTERVAL '6 months'
	),
	earliest_data AS (
		SELECT
			"PRODUCT_CODE",
			"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS earliest_short_position
		FROM period_data
		WHERE rnk_asc = 1
	),
	percentage_change AS (
		SELECT
			ld."PRODUCT_CODE",
			CASE
				WHEN ed.earliest_short_position = 0 THEN NULL
				ELSE ((ld.latest_short_position - ed.earliest_short_position) / ed.earliest_short_position) * 100
			END AS percentage_change
		FROM latest_data ld
		JOIN earliest_data ed ON ld."PRODUCT_CODE" = ed."PRODUCT_CODE"
	),
	ranked_stocks AS (
		SELECT
			cm.industry,
			pc."PRODUCT_CODE",
			pc.percentage_change,
			ROW_NUMBER() OVER (PARTITION BY cm.industry ORDER BY pc.percentage_change DESC) AS rank
		FROM percentage_change pc
		JOIN public."company-metadata" cm ON pc."PRODUCT_CODE" = cm.stock_code
		WHERE cm.industry IS NOT NULL
	)
	SELECT industry, "PRODUCT_CODE", percentage_change
	FROM ranked_stocks
	WHERE rank <= $1
	ORDER BY industry, percentage_change DESC`

	fallbackCurrentShortsQuery = `
	WITH latest_short_positions AS (
		SELECT "PRODUCT_CODE", MAX("DATE") AS max_date
		FROM public.shorts
		WHERE "DATE" >= (SELECT MAX("DATE") FROM shorts) - INTERVAL '%s'
		GROUP BY "PRODUCT_CODE"
		HAVING MAX("DATE") >= (SELECT MAX("DATE") FROM shorts) - INTERVAL '6 months'
	),
	current_short_positions AS (
		SELECT
			lsp."PRODUCT_CODE",
			s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS current_short_position
		FROM latest_short_positions lsp
		JOIN public.shorts s ON lsp."PRODUCT_CODE" = s."PRODUCT_CODE" AND lsp.max_date = s."DATE"
	),
	ranked_stocks AS (
		SELECT
			cm.industry,
			csp."PRODUCT_CODE",
			csp.current_short_position,
			ROW_NUMBER() OVER (PARTITION BY cm.industry ORDER BY csp.current_short_position DESC) AS rank
		FROM current_short_positions csp
		JOIN public."company-metadata" cm ON csp."PRODUCT_CODE" = cm.stock_code
		WHERE cm.industry IS NOT NULL
	)
	SELECT industry, "PRODUCT_CODE", current_short_position
	FROM ranked_stocks
	WHERE rank <= $1
	ORDER BY industry, current_short_position DESC`
)

// periodToMVPeriod converts API period strings to materialized view period_name values
func periodToMVPeriod(period string) string {
	switch period {
	case "1M", "1m":
		return "3m" // Use 3m as minimum (MV doesn't have 1m)
	case "3M", "3m":
		return "3m"
	case "6M", "6m":
		return "6m"
	case "1Y", "1y":
		return "1y"
	case "2Y", "2y":
		return "2y"
	case "5Y", "5y":
		return "5y"
	case "MAX", "max", "10Y", "10y":
		return "max"
	default:
		return "3m"
	}
}

// FetchTreeMapData retrieves heatmap data from the mv_treemap_data materialized view.
// This is significantly faster than querying raw tables (~3ms vs ~500ms+).
//
// The materialized view pre-calculates percentage changes and current short positions
// for all stocks across multiple time periods (3m, 6m, 1y, 2y, 5y, max).
// Falls back to raw query if MV doesn't exist (for dev/test environments).
func FetchTreeMapData(db *pgxpool.Pool, limit int32, period string, viewMode string) (*stocksv1alpha1.IndustryTreeMap, error) {
	ctx := context.Background()

	mvPeriod := periodToMVPeriod(period)
	interval := periodToInterval(period)

	// Query the materialized view instead of raw tables
	// The MV has pre-computed data for both view modes
	var query string
	var useMV = true
	switch viewMode {
	case shortsv1alpha1.ViewMode_CURRENT_CHANGE.String():
		// Use current_short_position for CURRENT_CHANGE mode
		query = `
		WITH ranked_stocks AS (
			SELECT
				industry,
				product_code,
				current_short_position as short_position,
				ROW_NUMBER() OVER (PARTITION BY industry ORDER BY current_short_position DESC) AS rank
			FROM mv_treemap_data
			WHERE period_name = $1
				AND industry IS NOT NULL
				AND current_short_position > 0
		)
		SELECT industry, product_code, short_position
		FROM ranked_stocks
		WHERE rank <= $2
		ORDER BY industry, short_position DESC`
	case shortsv1alpha1.ViewMode_PERCENTAGE_CHANGE.String():
		// Use percentage_change for PERCENTAGE_CHANGE mode
		query = `
		WITH ranked_stocks AS (
			SELECT
				industry,
				product_code,
				percentage_change as short_position,
				ROW_NUMBER() OVER (PARTITION BY industry ORDER BY percentage_change DESC NULLS LAST) AS rank
			FROM mv_treemap_data
			WHERE period_name = $1
				AND industry IS NOT NULL
				AND percentage_change IS NOT NULL
		)
		SELECT industry, product_code, short_position
		FROM ranked_stocks
		WHERE rank <= $2
		ORDER BY industry, short_position DESC`
	default:
		// Default to current short position
		query = `
		WITH ranked_stocks AS (
			SELECT
				industry,
				product_code,
				current_short_position as short_position,
				ROW_NUMBER() OVER (PARTITION BY industry ORDER BY current_short_position DESC) AS rank
			FROM mv_treemap_data
			WHERE period_name = $1
				AND industry IS NOT NULL
				AND current_short_position > 0
		)
		SELECT industry, product_code, short_position
		FROM ranked_stocks
		WHERE rank <= $2
		ORDER BY industry, short_position DESC`
	}

	rows, err := db.Query(ctx, query, mvPeriod, limit)
	if err != nil {
		// Fallback to raw query if MV doesn't exist (dev/test environments)
		log.Infof("mv_treemap_data not available, using fallback query: %v", err)
		useMV = false
		switch viewMode {
		case shortsv1alpha1.ViewMode_PERCENTAGE_CHANGE.String():
			query = fmt.Sprintf(fallbackPercentageChangeQuery, interval)
		default:
			query = fmt.Sprintf(fallbackCurrentShortsQuery, interval)
		}
		rows, err = db.Query(ctx, query, limit)
		if err != nil {
			return nil, fmt.Errorf("error querying database: %v", err)
		}
	}
	defer rows.Close()
	_ = useMV // suppress unused warning

	industryMap := make(map[string][]*stocksv1alpha1.TreemapShortPosition)
	for rows.Next() {
		var industry string
		var productCode string
		var shortPosition float64

		if err := rows.Scan(&industry, &productCode, &shortPosition); err != nil {
			return nil, fmt.Errorf("error scanning row: %v", err)
		}

		industryMap[industry] = append(industryMap[industry], &stocksv1alpha1.TreemapShortPosition{
			Industry:      industry,
			ProductCode:   productCode,
			ShortPosition: shortPosition,
		})
	}

	if rows.Err() != nil {
		return nil, fmt.Errorf("row error: %v", rows.Err())
	}

	industryTreeMap := &stocksv1alpha1.IndustryTreeMap{}
	for industry, stocks := range industryMap {
		industryTreeMap.Industries = append(industryTreeMap.Industries, industry)
		industryTreeMap.Stocks = append(industryTreeMap.Stocks, stocks...)
	}

	return industryTreeMap, nil
}
