package shorts

import (
	"context"
	"fmt"
	"math"

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
// productCodes (variadic, optional): when supplied, the time-series fetch is
// scoped to EXACTLY these codes instead of the top-`limit` ranking — callers
// that already know their constituents (e.g. industry-crowding) avoid pulling
// every top-N stock's points. Empty = unchanged top-N behaviour.
func FetchTimeSeriesData(db *pgxpool.Pool, limit, offset int, period string, summaryOnly bool, productCodes ...string) ([]*stocksv1alpha1.TimeSeriesData, int, error) {
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
			SELECT COALESCE(NULLIF(company_name, ''), product_name), product_code, current_percent, COALESCE(industry, '')
			FROM mv_top_shorts
			WHERE product_code ~ '^[A-Z0-9]{3,4}$'
				AND product_name !~* 'ETF\M'
				AND product_name !~ '[0-9]+(\.[0-9]+)?\s*%'
				AND (total_in_issue IS NULL OR total_in_issue >= 5000000)
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
			SELECT COALESCE(NULLIF(cm.company_name, ''), ls."PRODUCT"), ls."PRODUCT_CODE", ls."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS", COALESCE(cm.industry, '')
			FROM latest_shorts ls
			LEFT JOIN "company-metadata" cm ON cm.stock_code = ls."PRODUCT_CODE"
			ORDER BY ls."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DESC
			LIMIT $1 OFFSET $2`
			rows, err = connection.Query(ctx, summaryQuery, limit, offset)
			if err != nil {
				return nil, 0, err
			}
		}
		defer rows.Close()

		result := make([]*stocksv1alpha1.TimeSeriesData, 0, limit)
		for rows.Next() {
			var productName, productCode, industry string
			var currentPercent float64
			if err := rows.Scan(&productName, &productCode, &currentPercent, &industry); err != nil {
				return nil, 0, err
			}
			result = append(result, &stocksv1alpha1.TimeSeriesData{
				ProductCode:         productCode,
				Name:                productName,
				LatestShortPosition: currentPercent,
				Industry:            industry,
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
	SELECT COALESCE(NULLIF(company_name, ''), product_name), product_code
	FROM mv_top_shorts
	WHERE product_code ~ '^[A-Z0-9]{3,4}$'
		AND product_name !~* 'ETF\M'
		AND product_name !~ '[0-9]+(\.[0-9]+)?\s*%'
		AND (total_in_issue IS NULL OR total_in_issue >= 5000000)
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
		SELECT COALESCE(NULLIF(cm.company_name, ''), ls."PRODUCT"), ls."PRODUCT_CODE"
		FROM latest_shorts ls
		LEFT JOIN "company-metadata" cm ON cm.stock_code = ls."PRODUCT_CODE"
		ORDER BY ls."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DESC
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

	// An explicit code set overrides the top-N ranking: scope the (costly)
	// time-series fetch below to exactly these codes. The top-N scan above is a
	// cheap mv_top_shorts hit, so overriding here keeps the diff minimal and the
	// existing path untouched. Names for codes outside the top-N stay empty —
	// callers that need names pair this with a summary_only request.
	if len(productCodes) > 0 {
		topShorts = productCodes
	}

	rows, err = connection.Query(ctx, fmt.Sprintf(sparklineQuery, interval), topShorts, topShortsSparklineMaxPoints)
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
		var isPoint, isMin, isMax bool
		if err := rows.Scan(&productCode, &date, &percent, &isPoint, &isMin, &isMax); err != nil {
			return nil, 0, err
		}
		if date.Status != pgtype.Present || percent.Status != pgtype.Present {
			continue
		}
		point := &stocksv1alpha1.TimeSeriesPoint{
			Timestamp:     timestamppb.New(date.Time),
			ShortPosition: percent.Float,
		}
		if isPoint {
			timeSeriesMap[productCode] = append(timeSeriesMap[productCode], point)
		}
		minMax, ok := minMaxMap[productCode]
		if !ok {
			minMax = &struct {
				min, max *stocksv1alpha1.TimeSeriesPoint
			}{}
			minMaxMap[productCode] = minMax
		}
		if isMin {
			minMax.min = point
		}
		if isMax {
			minMax.max = point
		}
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}

	// Calculate the new offset for subsequent queries
	newOffset := offset + len(topShorts)

	timeSeriesDataSlice := make([]*stocksv1alpha1.TimeSeriesData, 0)
	for _, productCode := range topShorts {
		points := timeSeriesMap[productCode]
		// Require at least 2 points to draw a meaningful line chart. The SQL
		// keeps every point of a series of up to topShortsSparklineMaxPoints,
		// so this counts the full series exactly as before.
		if len(points) >= 2 {
			minMax := minMaxMap[productCode]
			tsData := &stocksv1alpha1.TimeSeriesData{
				ProductCode: productCode,
				Name:        productNames[productCode],
				// Already decimated by sparklineQuery to a sparkline-appropriate
				// resolution: these are list sparklines (not the full per-stock
				// chart). Min/Max/Latest come from the FULL series, so the
				// markers and current value stay exact.
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

// topShortsSparklineMaxPoints caps the number of series points returned per
// stock in the top-shorts list. ~60 points renders a smooth sparkline at a
// fraction of the bytes of full daily resolution.
const topShortsSparklineMaxPoints = 60

// sparklineQuery returns each code's sparkline already decimated, plus the
// rows that hold its minimum and maximum, instead of the full daily series.
// The full series was 40.5k rows per call on prod (pg_stat_statements,
// 2026-10-21: 19,275 calls, 1.28 s mean, 95 s max, 781M rows), every one
// shipped to Go only for Go to keep 60 per code. %s is periodToInterval's
// output; $1 = the codes, $2 = topShortsSparklineMaxPoints.
//
// The sampled points are exactly the ones the Go decimation kept before it
// moved here (decimatePoints, 2026-10): a series of n <= $2 points is kept whole; a longer one
// keeps index n-1 and every floor(i * step) for i in [0, $2-2], with
// step = (n-1)/($2-1), computed in float8 exactly as Go computed it in float64.
// step > 1 there, so at most one i lands on an index, and it is within one of
// ceil(rn / step) whatever the rounding of that division: each row tests those
// three candidates (sparklineKeeps is the same test in Go, checked against the
// old decimation for every series length up to 3,000 and a sample to 20,000).
//
// The scan walks the covering index in its own order (code, date DESC), so the
// window functions need no sort. is_min / is_max flag the FIRST date holding
// the series' minimum / maximum, which is what the old ascending scan with
// strict comparisons kept.
const sparklineQuery = `
	WITH s AS (
	    SELECT "PRODUCT_CODE" AS code,
	           "DATE" AS date,
	           "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS pct,
	           count(*) OVER w AS n,
	           row_number() OVER (w ORDER BY "DATE" DESC) AS back,
	           min("PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS") OVER w AS lo,
	           max("PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS") OVER w AS hi
	    FROM shorts
	    WHERE "PRODUCT_CODE" = ANY($1)
	        AND "DATE" > (SELECT MAX("DATE") FROM shorts) - INTERVAL '%s'
	        AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
	    WINDOW w AS (PARTITION BY "PRODUCT_CODE")
	), r AS (
	    SELECT code, date, pct, n, n - back AS rn,
	           min(date) FILTER (WHERE pct = lo) OVER (PARTITION BY code) AS lo_date,
	           min(date) FILTER (WHERE pct = hi) OVER (PARTITION BY code) AS hi_date
	    FROM s
	), k AS (
	    SELECT code, date, pct, n, rn, lo_date, hi_date, step,
	           CASE WHEN n > $2::int THEN ceil(rn::float8 / step)::int END AS c
	    FROM (
	        SELECT r.*, CASE WHEN n > $2::int THEN (n - 1)::float8 / ($2::int - 1)::float8 END AS step
	        FROM r
	    ) stepped
	), picked AS (
	    SELECT code, date, pct, lo_date, hi_date,
	           (n <= $2::int OR rn = n - 1
	            OR (c - 1 BETWEEN 0 AND $2::int - 2 AND floor((c - 1)::float8 * step) = rn)
	            OR (c     BETWEEN 0 AND $2::int - 2 AND floor(c::float8 * step) = rn)
	            OR (c + 1 BETWEEN 0 AND $2::int - 2 AND floor((c + 1)::float8 * step) = rn)) AS is_point
	    FROM k
	)
	SELECT code, date, pct, is_point, date = lo_date AS is_min, date = hi_date AS is_max
	FROM picked
	WHERE is_point OR date = lo_date OR date = hi_date
	ORDER BY code, date`

// sparklineKeeps is sparklineQuery's is_point test in Go: whether index rn of
// an n-point series is one of the maxPoints the decimation keeps.
func sparklineKeeps(rn, n, maxPoints int) bool {
	if n <= maxPoints || rn == n-1 {
		return true
	}
	step := float64(n-1) / float64(maxPoints-1)
	c := int(math.Ceil(float64(rn) / step))
	for _, i := range []int{c - 1, c, c + 1} {
		if i >= 0 && i <= maxPoints-2 && int(math.Floor(float64(i)*step)) == rn {
			return true
		}
	}
	return false
}
