package shorts

import (
	"context"
	"fmt"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/jackc/pgx/v5/pgxpool"
)

/*
*
FetchTreeMapData retrieves heatmap data for the top N products (limit) with the highest short positions for the period specified.
These short positions will be grouped by industry sector and the percentage of total product in issue reported as short positions and have the following structure
according to thhe proto definition:

	message IndustryTreeMap {
	  // indstries that a stock will belond to
	  repeated string industries = 1;
	  repeated TreemapShortPosition stocks = 2;
	}

	message TreemapShortPosition {
	  string industry = 1;
	  string product_code = 2;
	  double short_position = 3;
	}

This has to be done using a join between the short position data and the company metadata tables to get the industry sector for each product code.
The short position data is stored in the 'shorts' table with the following schema:
Table "public.shorts"

	Column                             |            Type             | Collation | Nullable | Default | Storage  | Compression | Stats target | Description

---------------------------------------------------------------+-----------------------------+-----------+----------+---------+----------+-------------+--------------+-------------

	DATE                                                          | timestamp without time zone |           |          |         | plain    |             |              |
	PRODUCT                                                       | text                        |           |          |         | extended |             |              |
	PRODUCT_CODE                                                  | text                        |           |          |         | extended |             |              |
	REPORTED_SHORT_POSITIONS                                      | double precision            |           |          |         | plain    |             |              |
	TOTAL_PRODUCT_IN_ISSUE                                        | double precision            |           |          |         | plain    |             |              |
	PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS | double precision            |           |          |         | plain    |             |              |

The company metadata is stored in the 'companies' table with the following schema:

Table "public.company-metadata"

	Column       | Type | Collation | Nullable | Default | Storage  | Compression | Stats ta

rget | Description
-------------------+------+-----------+----------+---------+----------+-------------+---------
-----+-------------

	Company name      | text |           |          |         | extended |             |              |
	industry          | text |           |          |         | extended |             |              |
	listing_date      | text |           |          |         | extended |             |              |
	market_cap        | text |           |          |         | extended |             |              |
	company_name      | text |           |          |         | extended |             |              |
	address           | text |           |          |         | extended |             |              |
	summary           | text |           |          |         | extended |             |              |
	details           | text |           |          |         | extended |             |              |
	website           | text |           |          |         | extended |             |              |
	stock_code        | text |           |          |         | extended |             |              |
	links             | text |           |          |         | extended |             |              |
	images            | text |           |          |         | extended |             |              |
	company_logo_link | text |           |          |         | extended |             |              |
	gcsUrl            | text |           |          |         | extended |             |              |
*/
var (
	percentageChangeQuery = `
	WITH period_data AS (
		SELECT 
			"PRODUCT_CODE",
			"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS",
			"DATE",
			ROW_NUMBER() OVER (PARTITION BY "PRODUCT_CODE" ORDER BY "DATE" DESC) AS rnk_desc,
			ROW_NUMBER() OVER (PARTITION BY "PRODUCT_CODE" ORDER BY "DATE" ASC) AS rnk_asc
		FROM 
			public.shorts
		WHERE 
			"DATE" >= (SELECT MAX("DATE") FROM shorts) - INTERVAL '%s'
	),
	latest_data AS (
		-- Extract the most recent short position for each product
		SELECT 
			"PRODUCT_CODE",
			"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS latest_short_position,
			"DATE" AS latest_date
		FROM 
			period_data
		WHERE 
			rnk_desc = 1
			-- Filter out stocks with stale data (older than 6 months from latest date)
			AND "DATE" >= (SELECT MAX("DATE") FROM shorts) - INTERVAL '6 months'
	),
	earliest_data AS (
		-- Extract the oldest short position within the period for each product
		SELECT 
			"PRODUCT_CODE",
			"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS earliest_short_position
		FROM 
			period_data
		WHERE 
			rnk_asc = 1
	),
	percentage_change AS (
		-- Calculate the percentage change between the latest and earliest short positions
		SELECT 
			ld."PRODUCT_CODE",
			ld.latest_short_position,
			ed.earliest_short_position,
			CASE
				WHEN ed.earliest_short_position = 0 THEN NULL
				ELSE ((ld.latest_short_position - ed.earliest_short_position) / ed.earliest_short_position) * 100
			END AS percentage_change
		FROM 
			latest_data ld
		JOIN 
			earliest_data ed
		ON 
			ld."PRODUCT_CODE" = ed."PRODUCT_CODE"
	),
	ranked_stocks AS (
		-- Rank the stocks by percentage change within each industry
		SELECT 
			cm.industry,
			pc."PRODUCT_CODE",
			pc.percentage_change,
			ROW_NUMBER() OVER (PARTITION BY cm.industry ORDER BY pc.percentage_change DESC) AS rank
		FROM 
			percentage_change pc
		JOIN 
			public."company-metadata" cm
		ON 
			pc."PRODUCT_CODE" = cm.stock_code
		WHERE 
			cm.industry IS NOT NULL
	)
	-- Select the top N stocks by percentage change for each industry
	SELECT 
		industry,
		"PRODUCT_CODE",
		percentage_change
	FROM 
		ranked_stocks
	WHERE 
		rank <= $1
	ORDER BY 
		industry,
		percentage_change DESC;
	`

	currentShortsQuery = `WITH latest_short_positions AS (
		SELECT 
			"PRODUCT_CODE",
			MAX("DATE") AS max_date
		FROM 
			public.shorts
		WHERE 
			"DATE" >= (SELECT MAX("DATE") FROM shorts) - INTERVAL '%s'
		GROUP BY 
			"PRODUCT_CODE"
		-- Filter out stocks with stale data (older than 6 months from latest date)
		HAVING MAX("DATE") >= (SELECT MAX("DATE") FROM shorts) - INTERVAL '6 months'
	),
	current_short_positions AS (
		SELECT 
			lsp."PRODUCT_CODE",
			s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS current_short_position
		FROM 
			latest_short_positions lsp
		JOIN 
			public.shorts s
		ON 
			lsp."PRODUCT_CODE" = s."PRODUCT_CODE" AND lsp.max_date = s."DATE"
	),
	ranked_stocks AS (
		SELECT 
			cm.industry,
			csp."PRODUCT_CODE",
			csp.current_short_position,
			ROW_NUMBER() OVER (PARTITION BY cm.industry ORDER BY csp.current_short_position DESC) AS rank
		FROM 
			current_short_positions csp
		JOIN 
			public."company-metadata" cm
		ON 
			csp."PRODUCT_CODE" = cm.stock_code
		WHERE 
			cm.industry IS NOT NULL
	)
	SELECT 
		industry,
		"PRODUCT_CODE",
		current_short_position
	FROM 
		ranked_stocks
	WHERE 
		rank <= $1
	ORDER BY 
		industry,
		current_short_position DESC;`
)

func FetchTreeMapData(db *pgxpool.Pool, limit int32, period string, viewMode string) (*stocksv1alpha1.IndustryTreeMap, error) {
	ctx := context.Background()
	var query string
	interval := periodToInterval(period)
	// SQL query to join shorts and company-metadata tables
	switch viewMode {
	case shortsv1alpha1.ViewMode_CURRENT_CHANGE.String():
		query = fmt.Sprintf(currentShortsQuery, interval)
	case shortsv1alpha1.ViewMode_PERCENTAGE_CHANGE.String():
		query = fmt.Sprintf(percentageChangeQuery, interval)
	}

	rows, err := db.Query(ctx, query, limit)
	if err != nil {
		return nil, fmt.Errorf("error querying database: %v", err)
	}
	defer rows.Close()

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
