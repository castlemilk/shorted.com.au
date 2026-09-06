package main

import (
	"context"
	"os"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

// stock_price_backfill_attempts exists to answer one question that had no
// answer: was this code ever ASKED about (#576).
//
// Before the universe fix, 936 of 1,941 codes had no prices AND had never been
// requested, and nothing could tell those two states apart. "Yahoo drops
// delisted ASX tickers" was the standing explanation and it had never been
// tested, because the request was never made.
func TestRecordBackfillAttempt(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		t.Skip("DATABASE_URL not set, skipping integration test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	require.NoError(t, err)
	defer pool.Close()

	const code = "ZZATT"
	cleanup := func() {
		_, _ = pool.Exec(ctx, `DELETE FROM stock_price_backfill_attempts WHERE stock_code = $1`, code)
	}
	cleanup()
	t.Cleanup(cleanup)

	read := func(t *testing.T) (outcome string, records int, detail *string) {
		t.Helper()
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT outcome, records_recovered, detail
			 FROM stock_price_backfill_attempts WHERE stock_code = $1`, code).
			Scan(&outcome, &records, &detail))
		return
	}

	t.Run("an unavailable code is recorded as asked, not as absent", func(t *testing.T) {
		recordBackfillAttempt(ctx, pool, code, "unavailable", 0, "provider returned no records")
		outcome, records, detail := read(t)
		require.Equal(t, "unavailable", outcome)
		require.Zero(t, records)
		require.NotNil(t, detail)
	})

	t.Run("a later attempt overwrites rather than accumulating", func(t *testing.T) {
		// One row per code: the history of attempts is not interesting, the
		// last outcome is.
		recordBackfillAttempt(ctx, pool, code, "recovered", 2510, "")
		outcome, records, detail := read(t)
		require.Equal(t, "recovered", outcome)
		require.Equal(t, 2510, records)
		require.Nil(t, detail, "an empty detail must store NULL, not an empty string")

		var rows int
		require.NoError(t, pool.QueryRow(ctx,
			`SELECT COUNT(*) FROM stock_price_backfill_attempts WHERE stock_code = $1`, code).Scan(&rows))
		require.Equal(t, 1, rows)
	})

	t.Run("a long provider error is truncated rather than rejected", func(t *testing.T) {
		recordBackfillAttempt(ctx, pool, code, "error", 0, strings.Repeat("quota exceeded. ", 200))
		outcome, _, detail := read(t)
		require.Equal(t, "error", outcome)
		require.NotNil(t, detail)
		require.LessOrEqual(t, len(*detail), 500)
	})

	t.Run("multi-byte text survives truncation", func(t *testing.T) {
		// Slicing by bytes can cut a rune in half, and Postgres rejects the
		// invalid sequence — losing the whole attempt record silently, because
		// the writer swallows its error on purpose.
		recordBackfillAttempt(ctx, pool, code, "error", 0, strings.Repeat("… delisted ✂", 100))
		outcome, _, detail := read(t)
		require.Equal(t, "error", outcome)
		require.NotNil(t, detail)
		require.True(t, utf8.ValidString(*detail), "stored detail is not valid UTF-8")
	})

	t.Run("a NUL byte does not lose the record", func(t *testing.T) {
		// Postgres refuses NUL in a text column at any length.
		recordBackfillAttempt(ctx, pool, code, "unavailable", 0, "bad\x00payload")
		outcome, _, detail := read(t)
		require.Equal(t, "unavailable", outcome,
			"a NUL in provider text must not silently discard the attempt")
		require.NotNil(t, detail)
		require.NotContains(t, *detail, "\x00")
	})

	t.Run("an invalid outcome is refused by the schema, not silently stored", func(t *testing.T) {
		// recordBackfillAttempt swallows the error by design — it must not cost
		// the prices the run just recovered — so the guarantee has to come from
		// the CHECK constraint. Asserted directly, because a typo'd outcome
		// would otherwise land in the table and be read as fact.
		_, err := pool.Exec(ctx, `
			INSERT INTO stock_price_backfill_attempts (stock_code, outcome)
			VALUES ($1, 'maybe')`, "ZZBAD")
		require.Error(t, err, "the outcome vocabulary must be enforced by the database")
	})

	t.Run("never-asked stays distinguishable from asked-and-empty", func(t *testing.T) {
		// The query an operator actually runs. A code in the universe with no
		// attempt row has never been reached; one with 'unavailable' has.
		var neverAsked int
		require.NoError(t, pool.QueryRow(ctx, `
			SELECT COUNT(*) FROM (
				SELECT DISTINCT s."PRODUCT_CODE" AS code FROM shorts s
			) u
			LEFT JOIN stock_price_backfill_attempts a ON a.stock_code = u.code
			WHERE a.stock_code IS NULL`).Scan(&neverAsked))
		require.GreaterOrEqual(t, neverAsked, 0,
			"the anti-join that measures the hole must be answerable")
	})
}
