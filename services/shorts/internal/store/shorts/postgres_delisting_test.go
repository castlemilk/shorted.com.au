package shorts

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

// The delisting record (#576).
//
// has_price_history (#580) said a position could be OPENED. Nothing said when
// or at what value it could be CLOSED, so a constituent that left the universe
// simply stopped appearing — and a company acquired at a premium and one wound
// up at zero arrived identically, as absence.
//
// These tests use a purpose-built fixture rather than asserting over whatever
// the database happens to hold, because the interesting rows are the ones that
// are NOT in a recent cross-section, and a fixture is the only way to guarantee
// one exists.
const (
	delistFixtureLive     = "ZZLIV" // reported on both dates, priced
	delistFixtureDelisted = "ZZDEL" // reported only on the old date, priced
	delistFixtureUnpriced = "ZZUNP" // reported only on the old date, never priced

	delistOldDate = "2019-03-15"
	delistNewDate = "2019-06-14"
)

func seedDelistingFixture(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()

	cleanup := func() {
		for _, code := range []string{delistFixtureLive, delistFixtureDelisted, delistFixtureUnpriced} {
			_, _ = pool.Exec(ctx, `DELETE FROM shorts WHERE "PRODUCT_CODE" = $1`, code)
			_, _ = pool.Exec(ctx, `DELETE FROM stock_prices WHERE stock_code = $1`, code)
		}
	}
	cleanup()
	t.Cleanup(cleanup)

	// Short positions. The delisted and unpriced names appear on the old date
	// only; the live one appears on both. Plain INSERT rather than an upsert:
	// cleanup() has just deleted these codes, and the local container's `shorts`
	// table carries no (DATE, PRODUCT_CODE) unique constraint for ON CONFLICT to
	// name — prod has one, the docker seed schema does not.
	rows := []struct {
		date, code string
	}{
		{delistOldDate, delistFixtureLive},
		{delistOldDate, delistFixtureDelisted},
		{delistOldDate, delistFixtureUnpriced},
		{delistNewDate, delistFixtureLive},
	}
	for _, r := range rows {
		_, err := pool.Exec(ctx, `
			INSERT INTO shorts ("DATE", "PRODUCT", "PRODUCT_CODE",
				"REPORTED_SHORT_POSITIONS", "TOTAL_PRODUCT_IN_ISSUE",
				"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS")
			VALUES ($1::date, $2 || ' ORDINARY FULLY PAID', $2, 1000000, 100000000, 1.0)`,
			r.date, r.code)
		require.NoError(t, err)
	}

	// Prices. Enough sessions that the 20-day averages are computed, and volume
	// is non-zero so the price join does not treat them as halted.
	for _, px := range []struct {
		code  string
		close float64
	}{
		{delistFixtureLive, 12.50},
		{delistFixtureDelisted, 7.25},
	} {
		_, err := pool.Exec(ctx, `
			INSERT INTO stock_prices (stock_code, date, close, volume)
			SELECT $1, d::date, $2::numeric, 100000
			FROM generate_series($3::date - INTERVAL '10 days', $3::date, INTERVAL '1 day') d
			ON CONFLICT (stock_code, date) DO NOTHING`, px.code, px.close, delistOldDate)
		require.NoError(t, err)
	}
}

func TestDelistingRecord(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}
	dbURL := getTestDatabaseURL()
	if dbURL == "" {
		t.Skip("DATABASE_URL not set, skipping integration test")
	}
	pool := createTestPool(t, dbURL)
	defer pool.Close()
	seedDelistingFixture(t, pool)
	store := &postgresStore{db: pool}

	stocks, _, err := store.GetMarketByDate(delistOldDate, 5000, 0, true, false)
	require.NoError(t, err)
	require.NotEmpty(t, stocks)

	byCode := map[string]int{}
	for i, s := range stocks {
		byCode[s.ProductCode] = i
	}
	for _, code := range []string{delistFixtureLive, delistFixtureDelisted, delistFixtureUnpriced} {
		require.Contains(t, byCode, code,
			"%s is in the point-in-time universe at %s and must not be dropped", code, delistOldDate)
	}
	live := stocks[byCode[delistFixtureLive]]
	delisted := stocks[byCode[delistFixtureDelisted]]
	unpriced := stocks[byCode[delistFixtureUnpriced]]

	t.Run("last_reported_date is per code, not the report's own date", func(t *testing.T) {
		// The bug this guards: reading MAX("DATE") without correlating on the
		// product code gives every row the same answer — the newest report in
		// the table — which would say every constituent is still listed.
		require.Equal(t, delistNewDate, live.LastReportedDate,
			"a name still reported later must carry that later date")
		require.Equal(t, delistOldDate, delisted.LastReportedDate,
			"a name that stopped being reported must carry ITS last date, not the table's")
		require.NotEqual(t, live.LastReportedDate, delisted.LastReportedDate,
			"two rows in the same cross-section got the same last-reported date")
	})

	t.Run("every constituent carries a last reported date", func(t *testing.T) {
		// It is drawn from the row's own table, so an empty one means the join
		// broke, not that the data is missing.
		for _, s := range stocks {
			require.NotEmpty(t, s.LastReportedDate,
				"%s has no last_reported_date; the lateral is not matching", s.ProductCode)
			require.GreaterOrEqual(t, s.LastReportedDate, delistOldDate,
				"%s was reported on %s, so its last report cannot precede it",
				s.ProductCode, delistOldDate)
		}
	})

	t.Run("a delisted name is closeable when it was priced", func(t *testing.T) {
		// The whole point of the issue: an acquisition and a wind-up must stop
		// being indistinguishable.
		require.Positive(t, delisted.FinalClose,
			"a priced name that left the universe must still carry a terminal value")
		require.NotEmpty(t, delisted.FinalCloseDate)
		require.InDelta(t, 7.25, delisted.FinalClose, 0.001)
	})

	t.Run("an unpriced name says so rather than arriving as absence", func(t *testing.T) {
		require.Zero(t, unpriced.FinalClose,
			"we hold no price for this code; a non-zero terminal value would be fabricated")
		require.Empty(t, unpriced.FinalCloseDate)
		require.False(t, unpriced.HasPriceHistory)
		// Still in the universe. That is the distinction the issue is about:
		// "cannot be closed" must be reportable, not silent.
		require.Equal(t, delistFixtureUnpriced, unpriced.ProductCode)
	})

	t.Run("a priceable row always has a terminal value", func(t *testing.T) {
		// has_price_history is AS-OF and final_close is LIFETIME, so the
		// implication runs one way only: anything priced on or before the date
		// is priced at some point, but not the reverse.
		for _, s := range stocks {
			if s.HasPriceHistory {
				require.Positive(t, s.FinalClose,
					"%s is priceable as of %s but has no terminal value at all",
					s.ProductCode, delistOldDate)
				require.NotEmpty(t, s.FinalCloseDate, "%s", s.ProductCode)
			}
		}
	})

	t.Run("the terminal value is lifetime, not clipped to the query date", func(t *testing.T) {
		// live is priced only up to delistOldDate in this fixture, so its
		// terminal value and date must be the last session held for it —
		// which is what makes the field usable on the exit leg.
		require.Positive(t, live.FinalClose)
		require.NotEmpty(t, live.FinalCloseDate)
	})
}
