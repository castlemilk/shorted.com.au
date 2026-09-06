package shorts

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// The industry timeline (#557).
//
// Forward capture shipped in #574 (migration 000118) and was reachable only as
// a single as-of scalar on GetMarketByDate. A caller could therefore read a
// label but not tell whether ANY of it was observed — and a seeded baseline
// dates the deploy, not a reclassification. Treating the first as the second
// invents a sector change that never happened.
//
// Historical sectors remain unrecoverable. This exposes what was captured; it
// does not pretend to more.
func TestIndustryHistoryTimeline(t *testing.T) {
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

	const code = "ZZIND"
	cleanup := func() {
		_, _ = pool.Exec(ctx, `DELETE FROM stock_industry_history WHERE stock_code = $1`, code)
		_, _ = pool.Exec(ctx, `DELETE FROM "company-metadata" WHERE stock_code = $1`, code)
	}
	cleanup()
	t.Cleanup(cleanup)

	_, err := pool.Exec(ctx,
		`INSERT INTO "company-metadata" (stock_code, company_name, industry)
		 VALUES ($1, 'Fixture Industries', 'Energy')`, code)
	require.NoError(t, err)

	// That INSERT fires migration 000120's trigger, which records the arriving
	// label at CURRENT_DATE. The fixture wants two rows at dates it controls, so
	// the trigger's row is cleared first — deliberately after the insert rather
	// than by disabling the trigger, so this test keeps exercising the real
	// table rather than a version of it with the capture switched off.
	_, err = pool.Exec(ctx, `DELETE FROM stock_industry_history WHERE stock_code = $1`, code)
	require.NoError(t, err)

	// A seeded baseline, then an observed reclassification a year later. The
	// order of insertion is deliberately NOT the order of observed_from, so a
	// timeline that returned insertion order rather than date order fails.
	for _, r := range []struct{ industry, from, source string }{
		{"Energy", "2027-04-02", "observed"},
		{"Materials", "2026-09-06", "seed"},
	} {
		_, err := pool.Exec(ctx, `
			INSERT INTO stock_industry_history (stock_code, industry, observed_from, source)
			VALUES ($1, $2, $3::date, $4)`, code, r.industry, r.from, r.source)
		require.NoError(t, err)
	}

	// Exercised directly rather than through GetStockDetails: that query reads
	// the enrichment columns, which the local container's seed schema does not
	// carry — three pre-existing tests in this package fail on it at HEAD for
	// the same reason. GetStockDetails does nothing to this value but assign
	// it, so the logic worth guarding is all here.
	store := &postgresStore{db: pool}
	timeline := store.industryHistory(ctx, code)

	t.Run("the whole captured timeline is returned, oldest first", func(t *testing.T) {
		require.Len(t, timeline, 2)
		require.Equal(t, "2026-09-06", timeline[0].ObservedFrom,
			"the timeline must be ordered by observed_from, not by insertion")
		require.Equal(t, "2027-04-02", timeline[1].ObservedFrom)
	})

	t.Run("seed and observed stay distinguishable", func(t *testing.T) {
		// The distinction is the whole reason this is not a single string: a
		// seed row dates the start of capture, an observed row dates a real
		// reclassification.
		require.Equal(t, "seed", timeline[0].Source)
		require.Equal(t, "Materials", timeline[0].Industry)
		require.Equal(t, "observed", timeline[1].Source)
		require.Equal(t, "Energy", timeline[1].Industry)
	})

	t.Run("a stock with no captured history returns empty, not an error", func(t *testing.T) {
		_, err := pool.Exec(ctx, `DELETE FROM stock_industry_history WHERE stock_code = $1`, code)
		require.NoError(t, err)
		require.Empty(t, store.industryHistory(ctx, code))
	})

	t.Run("a missing table degrades to empty rather than failing the stock", func(t *testing.T) {
		// The timeline is supplementary — capture began 2026-09 and usually
		// holds one seeded row — so an environment without the migration must
		// still serve the stock page.
		_, err := pool.Exec(ctx, `ALTER TABLE stock_industry_history RENAME TO stock_industry_history_hidden`)
		require.NoError(t, err)
		t.Cleanup(func() {
			_, _ = pool.Exec(context.Background(),
				`ALTER TABLE stock_industry_history_hidden RENAME TO stock_industry_history`)
		})
		require.Empty(t, store.industryHistory(ctx, code),
			"a missing table must return nothing, not panic or propagate")
	})
}
