//go:build integration

package shorts

import (
	"context"
	"fmt"
	"testing"
	"time"

	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// referenceSparklines is what FetchTimeSeriesData returned before the
// decimation moved into SQL: the full series read in date order, min and max
// kept by strict comparison (so the FIRST date of a tied extreme), the latest
// point, and referenceDecimatePoints over the full series.
func referenceSparklines(t *testing.T, pool *pgxpool.Pool, codes []string, interval string) map[string]*stocksv1alpha1.TimeSeriesData {
	t.Helper()
	rows, err := pool.Query(context.Background(), fmt.Sprintf(`
		SELECT "PRODUCT_CODE", "DATE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"::float8
		FROM shorts
		WHERE "PRODUCT_CODE" = ANY($1)
		    AND "DATE" > (SELECT MAX("DATE") FROM shorts) - INTERVAL '%s'
		    AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
		ORDER BY "PRODUCT_CODE", "DATE" ASC`, interval), codes)
	require.NoError(t, err)
	defer rows.Close()
	out := map[string]*stocksv1alpha1.TimeSeriesData{}
	series := map[string][]*stocksv1alpha1.TimeSeriesPoint{}
	for rows.Next() {
		var code string
		var date time.Time
		var pct float64
		require.NoError(t, rows.Scan(&code, &date, &pct))
		p := &stocksv1alpha1.TimeSeriesPoint{Timestamp: timestamppb.New(date), ShortPosition: pct}
		series[code] = append(series[code], p)
		d, ok := out[code]
		if !ok {
			out[code] = &stocksv1alpha1.TimeSeriesData{ProductCode: code, Min: p, Max: p}
			continue
		}
		if pct < d.Min.ShortPosition {
			d.Min = p
		}
		if pct > d.Max.ShortPosition {
			d.Max = p
		}
	}
	require.NoError(t, rows.Err())
	for code, points := range series {
		if len(points) < 2 {
			delete(out, code)
			continue
		}
		out[code].Points = referenceDecimatePoints(points, topShortsSparklineMaxPoints)
		out[code].LatestShortPosition = points[len(points)-1].ShortPosition
	}
	return out
}

// sparklineSeriesLengths straddle the 60-point cap and reach a decade of
// trading days; the value pattern repeats, so the minimum and maximum are tied
// across many dates.
var sparklineSeriesLengths = []int{1, 2, 3, 59, 60, 61, 62, 119, 121, 250, 1234, 2537}

func seedSparklineSeries(t *testing.T, pool *pgxpool.Pool) []string {
	t.Helper()
	var codes []string
	for i, n := range sparklineSeriesLengths {
		code := fmt.Sprintf("ZS%02d", i)
		codes = append(codes, code)
		_, err := pool.Exec(context.Background(), `
			INSERT INTO shorts ("PRODUCT_CODE", "PRODUCT", "DATE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS")
			SELECT $1::text, $1::text || ' TEST ORDINARY', date_trunc('day', now()) - (k * interval '1 day'),
			       0.01 + ((k * 7) % 13) / 1000.0
			FROM generate_series(0, $2::int - 1) k`, code, n)
		require.NoError(t, err)
	}
	// A zero day is not a point (PERCENT > 0), in both readers.
	_, err := pool.Exec(context.Background(), `
		UPDATE shorts SET "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" = 0
		WHERE "PRODUCT_CODE" = 'ZS09' AND "DATE" = date_trunc('day', now()) - interval '17 days'`)
	require.NoError(t, err)
	return codes
}

// The SQL decimation returns exactly the sparkline the Go decimation built from
// the full series: the same points, the same min and max (first date of a
// tie), the same latest value, and no sparkline for a single-point series.
func TestFetchTimeSeriesData_SparklinesMatchTheFullSeriesDecimation(t *testing.T) {
	pool, cleanup := setupTestDatabase(t)
	defer cleanup()
	codes := seedSparklineSeries(t, pool)

	for _, period := range []string{"MAX", "5Y", "1Y", "6M", "3M", "1M"} {
		got, _, err := FetchTimeSeriesData(pool, 10, 0, period, false, codes...)
		require.NoError(t, err, period)
		want := referenceSparklines(t, pool, codes, periodToInterval(period))
		require.Len(t, got, len(want), "%s: one sparkline per series of 2+ points", period)
		for _, g := range got {
			w, ok := want[g.ProductCode]
			require.True(t, ok, "%s: unexpected sparkline %s", period, g.ProductCode)
			require.Len(t, g.Points, len(w.Points), "%s %s: point count", period, g.ProductCode)
			for i := range w.Points {
				assert.True(t, w.Points[i].Timestamp.AsTime().Equal(g.Points[i].Timestamp.AsTime()),
					"%s %s point %d: %v, want %v", period, g.ProductCode, i, g.Points[i].Timestamp.AsTime(), w.Points[i].Timestamp.AsTime())
				assert.Equal(t, w.Points[i].ShortPosition, g.Points[i].ShortPosition, "%s %s point %d value", period, g.ProductCode, i)
			}
			assert.True(t, w.Min.Timestamp.AsTime().Equal(g.Min.Timestamp.AsTime()), "%s %s: min date", period, g.ProductCode)
			assert.Equal(t, w.Min.ShortPosition, g.Min.ShortPosition, "%s %s: min", period, g.ProductCode)
			assert.True(t, w.Max.Timestamp.AsTime().Equal(g.Max.Timestamp.AsTime()), "%s %s: max date", period, g.ProductCode)
			assert.Equal(t, w.Max.ShortPosition, g.Max.ShortPosition, "%s %s: max", period, g.ProductCode)
			assert.Equal(t, w.LatestShortPosition, g.LatestShortPosition, "%s %s: latest", period, g.ProductCode)
			assert.LessOrEqual(t, len(g.Points), topShortsSparklineMaxPoints)
		}
	}
}
