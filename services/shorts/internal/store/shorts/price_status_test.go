package shorts

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// priceStatus is the whole point of #576's second half, so its table is stated
// exhaustively rather than sampled. The pairing that matters is the two ways a
// row can have no price, which every earlier response collapsed into one.
func TestPriceStatusTable(t *testing.T) {
	for _, c := range []struct {
		name              string
		priced, attempted bool
		want              string
	}{
		{"priced and attempted", true, true, PriceStatusPriced},
		{"priced without an attempt row", true, false, PriceStatusPriced},
		{"no price, provider was asked", false, true, PriceStatusUnavailable},
		{"no price, never asked", false, false, PriceStatusUnattempted},
	} {
		t.Run(c.name, func(t *testing.T) {
			require.Equal(t, c.want, priceStatus(c.priced, c.attempted))
		})
	}
}

func TestPriceStatusNeverConflatesTheTwoEmptyStates(t *testing.T) {
	// The regression this guards is a one-character one: returning the same
	// string for both unpriced cases restores exactly the ambiguity that let
	// 936 codes go unexamined, and every other assertion here would still pass.
	require.NotEqual(t,
		priceStatus(false, true),
		priceStatus(false, false),
		"asked-and-empty must not report the same status as never-asked")
}

// The store must actually join the attempts table, not default the flag.
func TestPriceStatusOnTheUniverseRow(t *testing.T) {
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

	const (
		date        = "2018-02-14"
		priced      = "ZZPRC"
		askedEmpty  = "ZZASK"
		neverAsked  = "ZZNEV"
	)
	codes := []string{priced, askedEmpty, neverAsked}
	cleanup := func() {
		for _, c := range codes {
			_, _ = pool.Exec(ctx, `DELETE FROM shorts WHERE "PRODUCT_CODE" = $1`, c)
			_, _ = pool.Exec(ctx, `DELETE FROM stock_prices WHERE stock_code = $1`, c)
			_, _ = pool.Exec(ctx, `DELETE FROM stock_price_backfill_attempts WHERE stock_code = $1`, c)
		}
	}
	cleanup()
	t.Cleanup(cleanup)

	for _, c := range codes {
		_, err := pool.Exec(ctx, `
			INSERT INTO shorts ("DATE", "PRODUCT", "PRODUCT_CODE",
				"REPORTED_SHORT_POSITIONS", "TOTAL_PRODUCT_IN_ISSUE",
				"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS")
			VALUES ($1::date, $2 || ' ORDINARY FULLY PAID', $2, 1000, 100000, 1.0)`, date, c)
		require.NoError(t, err)
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO stock_prices (stock_code, date, close, volume)
		VALUES ($1, $2::date, 4.20, 9000)
		ON CONFLICT (stock_code, date) DO NOTHING`, priced, date)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO stock_price_backfill_attempts (stock_code, outcome, records_recovered)
		VALUES ($1, 'unavailable', 0)`, askedEmpty)
	require.NoError(t, err)

	store := &postgresStore{db: pool}
	stocks, _, err := store.GetMarketByDate(date, 5000, 0, true, false)
	require.NoError(t, err)

	got := map[string]string{}
	for _, s := range stocks {
		got[s.ProductCode] = s.PriceStatus
	}

	require.Equal(t, PriceStatusPriced, got[priced])
	require.Equal(t, PriceStatusUnavailable, got[askedEmpty],
		"a code with an attempt row and no price must report the gap as final")
	require.Equal(t, PriceStatusUnattempted, got[neverAsked],
		"a code nobody has fetched must not be reported as unavailable")

	t.Run("every row is labelled", func(t *testing.T) {
		// An empty status is worse than a wrong one: it reads as "no opinion"
		// and a caller cannot tell it from a field they forgot to request.
		for _, s := range stocks {
			require.NotEmpty(t, s.PriceStatus, "%s has no price_status", s.ProductCode)
		}
	})

	t.Run("price_status agrees with has_price_history", func(t *testing.T) {
		// Two fields describing the same fact must not be able to disagree.
		for _, s := range stocks {
			if s.HasPriceHistory {
				require.Equal(t, PriceStatusPriced, s.PriceStatus, "%s", s.ProductCode)
			} else {
				require.NotEqual(t, PriceStatusPriced, s.PriceStatus, "%s", s.ProductCode)
			}
		}
	})
}
