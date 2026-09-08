package shorts

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// These three queries are the entire public economy surface, and every one of
// them shipped broken: the SQL referenced a new placeholder while the Query()
// call still passed the old argument count, so Postgres answered "there is no
// parameter $N" and all three RPCs returned `internal` in production.
//
// Nothing caught it. The store tests assert on the query STRING, and the gate
// tests exercise the Go predicate — neither runs the SQL. This one does.
func TestEconomyQueriesExecuteAgainstARealDatabase(t *testing.T) {
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

	// Both visibilities, because the argument count is what breaks and it does
	// not depend on the flag's value.
	for _, includeInternal := range []bool{false, true} {
		if _, err := store.ListEconomicSeries("", "", "", "", "", 5, includeInternal); err != nil {
			t.Errorf("ListEconomicSeries(includeInternal=%v): %v", includeInternal, err)
		}
		if _, err := store.GetEconomicSeries([]string{"cpi.annual_change.all_groups.aus"},
			time.Now().AddDate(-2, 0, 0), 5, includeInternal); err != nil {
			t.Errorf("GetEconomicSeries(includeInternal=%v): %v", includeInternal, err)
		}
		if _, err := store.ListSeriesCorrelations("markets.short_interest_wavg.nsw", 24, 0.1, 5, includeInternal); err != nil {
			t.Errorf("ListSeriesCorrelations(includeInternal=%v): %v", includeInternal, err)
		}
	}
}

// The gate has to actually filter, not merely execute.
func TestInternalSeriesAreWithheldFromAPublicList(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}
	dbURL := getTestDatabaseURL()
	if dbURL == "" {
		t.Skip("DATABASE_URL not set, skipping integration test")
	}
	pool := createTestPool(t, dbURL)
	defer pool.Close()
	ctx := context.Background()
	store := &postgresStore{db: pool}

	const key = "zz.probe.internal.usa"
	cleanup := func() {
		_, _ = pool.Exec(ctx, `DELETE FROM economic_series WHERE series_key = $1`, key)
	}
	cleanup()
	t.Cleanup(cleanup)

	_, err := pool.Exec(ctx, `
		INSERT INTO economic_series (series_key, topic, metric, region_type, region_code,
			region_name, unit, frequency, adjustment, dimensions, source_key, licence, internal_only)
		VALUES ($1,'zz','probe','national','usa','United States','index','monthly','original','{}','t','t',true)`, key)
	require.NoError(t, err)

	seen := func(includeInternal bool) bool {
		rows, err := store.ListEconomicSeries("zz", "", "", "", "", 50, includeInternal)
		require.NoError(t, err)
		for _, r := range rows {
			if r.SeriesKey == key {
				return true
			}
		}
		return false
	}
	require.False(t, seen(false), "an internal series was returned to a public caller")
	require.True(t, seen(true), "an operator could not see the internal series")
}
