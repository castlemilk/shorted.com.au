package shorts

import (
	"context"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/asxcalendar"
	"github.com/stretchr/testify/require"
)

// ASIC publishes a report for date D about four trading days later. A series
// that returns the D observation with nothing saying when it was knowable lets
// a backtest trade on it on day D — four days of lookahead, invisible from the
// outside. as_of is the server-side fix; available_from is what lets a caller
// check it.
func TestAsOfRemovesLookahead(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}
	dbURL := getTestDatabaseURL()
	if dbURL == "" {
		t.Skip("DATABASE_URL not set, skipping integration test")
	}

	pool := createTestPool(t, dbURL)
	defer pool.Close()
	store := &postgresStore{db: pool}

	var code string
	require.NoError(t, pool.QueryRow(context.Background(), `
		SELECT "PRODUCT_CODE" FROM shorts
		WHERE "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" IS NOT NULL
		GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1`).Scan(&code))

	full, err := store.GetStockData(StockDataQuery{
		ProductCode: code, Period: "MAX", FullResolution: true,
	})
	require.NoError(t, err)
	require.Greater(t, len(full.Points), 10, "need a real series to test against")

	t.Run("every point carries a publication date after its report date", func(t *testing.T) {
		for _, p := range full.Points {
			require.NotEmpty(t, p.AvailableFrom, "a point with no publication date cannot be used point-in-time")
			reported := p.Timestamp.AsTime().Format("2006-01-02")
			require.Greater(t, p.AvailableFrom, reported,
				"available_from must be strictly after the report date")
			avail, perr := time.Parse("2006-01-02", p.AvailableFrom)
			require.NoError(t, perr)
			require.True(t, asxcalendar.IsTradingDay(avail),
				"%s is not a trading day, so nothing could have been published on it", p.AvailableFrom)
		}
	})

	t.Run("as_of withholds everything not yet published", func(t *testing.T) {
		// Pick the midpoint observation's own REPORT date as the as_of. On that
		// day, that observation was not yet public — it publishes four trading
		// days later — so it must be absent.
		mid := full.Points[len(full.Points)/2]
		asOf := mid.Timestamp.AsTime().Format("2006-01-02")

		got, err := store.GetStockData(StockDataQuery{
			ProductCode: code, Period: "MAX", FullResolution: true, AsOf: asOf,
		})
		require.NoError(t, err)

		for _, p := range got.Points {
			require.LessOrEqual(t, p.AvailableFrom, asOf,
				"point dated %s (published %s) leaked into an as_of=%s query",
				p.Timestamp.AsTime().Format("2006-01-02"), p.AvailableFrom, asOf)
		}
		require.Less(t, len(got.Points), len(full.Points),
			"as_of must withhold the observations published after it")
		require.NotEmpty(t, got.Points, "as_of should still return everything already published")
	})

	t.Run("an as_of in the future changes nothing", func(t *testing.T) {
		got, err := store.GetStockData(StockDataQuery{
			ProductCode: code, Period: "MAX", FullResolution: true, AsOf: "2099-01-01",
		})
		require.NoError(t, err)
		require.Equal(t, len(full.Points), len(got.Points),
			"everything is long published by 2099")
	})

	t.Run("a malformed as_of is an error, not a silent full series", func(t *testing.T) {
		_, err := store.GetStockData(StockDataQuery{
			ProductCode: code, Period: "MAX", AsOf: "not-a-date",
		})
		require.Error(t, err, "silently ignoring as_of would reintroduce the lookahead it prevents")
	})
}

// The panel export is the surface a backtest is actually built on.
func TestStreamPanelHonoursAsOf(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}
	dbURL := getTestDatabaseURL()
	if dbURL == "" {
		t.Skip("DATABASE_URL not set, skipping integration test")
	}
	pool := createTestPool(t, dbURL)
	defer pool.Close()
	store := &postgresStore{db: pool}

	var from, to string
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT MIN("DATE")::date::text, MAX("DATE")::date::text FROM shorts`).Scan(&from, &to))

	count := func(asOf string) (int, string) {
		n := 0
		newest := ""
		require.NoError(t, store.StreamPanel(context.Background(),
			PanelQuery{From: from, To: to, AsOf: asOf}, func(r PanelRow) error {
				n++
				if r.AvailableFrom > newest {
					newest = r.AvailableFrom
				}
				return nil
			}))
		return n, newest
	}

	all, _ := count("")
	require.Positive(t, all)

	// As at the dataset's own last report date, the final few days of
	// observations were not yet published.
	limited, newestPublished := count(to)
	require.Less(t, limited, all, "as_of must withhold the unpublished tail")
	require.LessOrEqual(t, newestPublished, to,
		"no row published after the as_of date may appear")
}
