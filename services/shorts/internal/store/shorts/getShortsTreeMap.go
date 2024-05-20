package shorts

import (
	"context"
	"fmt"

	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/jackc/pgx/v5/pgxpool"
)

/**
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



func FetchTreeMapData(db *pgxpool.Pool, limit int32, period string) (*stocksv1alpha1.IndustryTreeMap, error) {
	ctx := context.Background()
	interval := periodToInterval(period)
	// SQL query to join shorts and company-metadata tables
	query := fmt.Sprintf(`
	WITH max_short_positions AS (
		SELECT 
			"PRODUCT_CODE",
			MAX("PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS") AS max_short_position
		FROM 
			public.shorts
		WHERE 
			"DATE" >= NOW() - INTERVAL '%s'
		GROUP BY 
			"PRODUCT_CODE"
	),
	ranked_stocks AS (
		SELECT 
			cm.industry,
			msp."PRODUCT_CODE",
			msp.max_short_position,
			ROW_NUMBER() OVER (PARTITION BY cm.industry ORDER BY msp.max_short_position DESC) AS rank
		FROM 
			max_short_positions msp
		JOIN 
			public."company-metadata" cm
		ON 
			msp."PRODUCT_CODE" = cm.stock_code
	)
	SELECT 
		industry,
		"PRODUCT_CODE",
		max_short_position
	FROM 
		ranked_stocks
	WHERE 
		rank <= $1
	ORDER BY 
		industry,
		max_short_position DESC
	`, interval)

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