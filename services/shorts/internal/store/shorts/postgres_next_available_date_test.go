package shorts

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// GetMarketByDate's next_date used to come from the 90 most recent dates, so a
// date older than those reported the oldest of them as its next date (on
// 2026-09-26, 2015-03-02 said 2026-05-18). GetNextAvailableDate answers from the
// whole dataset, which is what these assertions pin: they compare it with the
// dataset's own ordering, not with a page of it.
func TestGetNextAvailableDateAnswersFromTheWholeDataset(t *testing.T) {
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
	ctx := context.Background()

	// The store reads mv_available_dates when it exists; make it current so
	// the expectation below (from shorts itself) is the one it must match.
	_, _ = pool.Exec(ctx, `REFRESH MATERIALIZED VIEW mv_available_dates`)

	var dates []time.Time
	rows, err := pool.Query(ctx, `SELECT DISTINCT "DATE"::date FROM shorts ORDER BY 1`)
	require.NoError(t, err)
	for rows.Next() {
		var d time.Time
		require.NoError(t, rows.Scan(&d))
		dates = append(dates, d)
	}
	require.NoError(t, rows.Err())
	if len(dates) < 2 {
		t.Skip("not enough seeded dates to have a next date")
	}
	day := func(d time.Time) string { return d.Format("2006-01-02") }

	// The OLDEST date is the one the old derivation got wrong whenever the
	// dataset held more than 90 dates.
	next, err := store.GetNextAvailableDate(day(dates[0]))
	require.NoError(t, err)
	require.Equal(t, day(dates[1]), next, "the next date after the oldest is the second oldest")

	// A date with no data (a weekend, a holiday, a gap) names the first date
	// after it that has some.
	if gap := dates[1].Sub(dates[0]); gap > 24*time.Hour {
		next, err = store.GetNextAvailableDate(day(dates[0].AddDate(0, 0, 1)))
		require.NoError(t, err)
		require.Equal(t, day(dates[1]), next)
	}

	// Nothing follows the latest date.
	next, err = store.GetNextAvailableDate(day(dates[len(dates)-1]))
	require.NoError(t, err)
	require.Empty(t, next)
}
