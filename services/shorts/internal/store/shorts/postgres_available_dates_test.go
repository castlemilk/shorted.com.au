package shorts

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// GetAvailableDates returns a PAGE of dates but describes the whole dataset in
// earliest/latest/total. It used to fabricate the total — len(dates), doubled
// to limit*2 whenever the page was full — which told an integrator the dataset
// held ~90 trading dates while earliestDate said 2010 (issue #537).
func TestGetAvailableDatesTotalDescribesTheDatasetNotThePage(t *testing.T) {
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

	// The true number of distinct trading dates, computed independently.
	var distinctDates int
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT COUNT(DISTINCT "DATE") FROM shorts`).Scan(&distinctDates))
	if distinctDates < 2 {
		t.Skip("not enough seeded dates to distinguish a page from the dataset")
	}

	// Ask for a page strictly smaller than the dataset, so a page-derived count
	// and a dataset count cannot coincide.
	pageSize := distinctDates - 1
	dates, earliest, latest, total, err := store.GetAvailableDates(pageSize, "")
	require.NoError(t, err)

	require.Len(t, dates, pageSize, "should return a full page")
	require.Equal(t, distinctDates, total,
		"total must count every trading date in the dataset, not the page")
	require.NotEqual(t, pageSize*2, total,
		"total must not be the old limit*2 estimate")

	// The bounds describe the dataset too, so they must be consistent with the
	// total rather than with the page.
	require.NotEmpty(t, earliest)
	require.NotEmpty(t, latest)
	require.LessOrEqual(t, earliest, dates[len(dates)-1],
		"earliest must be at or before the oldest date on this page")
	require.Equal(t, latest, dates[0],
		"latest must equal the newest date, which the first page starts at")
}
