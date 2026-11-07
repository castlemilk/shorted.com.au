//go:build integration

package shorts

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// The relations market moves read besides their own table, with the columns
// the reads name.
const marketMovesTestBaseSchema = `
CREATE TABLE "company-metadata" (stock_code VARCHAR(50) UNIQUE, company_name TEXT);
CREATE TABLE stock_prices (stock_code VARCHAR(10), date DATE, close NUMERIC(12,4));
INSERT INTO "company-metadata" (stock_code, company_name) VALUES ('BHP', 'BHP GROUP LIMITED'), ('RIO', 'RIO TINTO LIMITED');
INSERT INTO stock_prices (stock_code, date, close) VALUES ('FMG', '2026-11-06', 18.2);
`

// marketMovesAdminURL is a server to create scratch databases on: one you
// started (SHORTS_TEST_POSTGRES_URL) or a container (MARKET_MOVES_TESTCONTAINERS=1,
// make test-market-moves-pg).
func marketMovesAdminURL(t *testing.T) string {
	t.Helper()
	adminURL, err := testpostgres.Admin("SHORTS_TEST_POSTGRES_URL", "MARKET_MOVES_TESTCONTAINERS")
	require.NoError(t, err, "start the market moves PostgreSQL container")
	if adminURL == "" {
		t.Skip("neither SHORTS_TEST_POSTGRES_URL nor MARKET_MOVES_TESTCONTAINERS=1 is set; skipping the real-Postgres market moves tests")
	}
	return adminURL
}

// marketMovesTestStore is a scratch database with 000160 applied, twice: the
// deploy replays it on every run, so a second application must succeed.
func marketMovesTestStore(t *testing.T) *postgresStore {
	t.Helper()
	adminURL := marketMovesAdminURL(t)
	for _, shared := range []string{"supabase", "pooler", ":6543"} {
		if strings.Contains(adminURL, shared) {
			t.Fatalf("refusing a shared or pooled database (%q): this test creates and drops databases", shared)
		}
	}
	ctx := context.Background()
	pool := fundamentalsTestDatabase(t, ctx, adminURL)
	_, err := pool.Exec(ctx, marketMovesTestBaseSchema)
	require.NoError(t, err)
	migration, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "migrations", "000160_market_moves.up.sql"))
	require.NoError(t, err)
	for range 2 {
		_, err = pool.Exec(ctx, string(migration))
		require.NoError(t, err, "000160 applies, and replays")
	}
	return &postgresStore{db: pool}
}

func pgMove(key string, observed time.Time) MarketMoveRecord {
	change := 4.2
	return MarketMoveRecord{
		MoveKey: key, Kind: "stock", StockCode: "BHP", RelatedCodes: []string{"RIO"},
		Direction: "up", ChangePct: &change,
		Headline: "BHP jumps 4.2% as iron ore rallies", Summary: "Iron ore futures rose overnight on stimulus.",
		Sources:      []MarketMoveSource{{Title: "Iron ore", URL: "https://example.com/a"}},
		Tags:         []string{"iron-ore"},
		Significance: 3, ObservedAt: observed, MarketDate: observed.Format("2006-01-02"),
		ContentHash: "hash-1", Actor: "test", Model: "claude-opus-5-5", RunID: "run-1",
	}
}

func TestMarketMovesAgainstPostgres(t *testing.T) {
	s := marketMovesTestStore(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 7, 3, 0, 0, 0, time.UTC)

	t.Run("a first post creates the move and reads back every field", func(t *testing.T) {
		res, err := s.UpsertMarketMove(ctx, pgMove("pg-a", base), MarketMoveLimits{})
		require.NoError(t, err)
		assert.Equal(t, MarketMoveCreated, res.Outcome)
		m := res.Move
		assert.Equal(t, "BHP Group", m.CompanyName, "served clean (cleanCompanyName)")
		assert.Equal(t, []string{"RIO"}, m.RelatedCodes)
		require.NotNil(t, m.ChangePct)
		assert.InDelta(t, 4.2, *m.ChangePct, 1e-9)
		assert.Nil(t, m.Price, "a figure not given reads back NULL, never 0")
		assert.Equal(t, []MarketMoveSource{{Title: "Iron ore", URL: "https://example.com/a"}}, m.Sources)
		assert.Equal(t, "2026-11-07", m.MarketDate)
		assert.True(t, base.Equal(m.ObservedAt))
		assert.Equal(t, 1, m.Revision)
		assert.Equal(t, MarketMovePublished, m.Status)
	})

	t.Run("the same content is unchanged; new content is a revision", func(t *testing.T) {
		res, err := s.UpsertMarketMove(ctx, pgMove("pg-a", base), MarketMoveLimits{})
		require.NoError(t, err)
		assert.Equal(t, MarketMoveUnchanged, res.Outcome)
		assert.Equal(t, 1, res.Move.Revision)

		next := pgMove("pg-a", base.Add(time.Hour))
		change := 5.1
		next.ChangePct, next.ContentHash, next.RelatedCodes = &change, "hash-2", nil
		res, err = s.UpsertMarketMove(ctx, next, MarketMoveLimits{})
		require.NoError(t, err)
		assert.Equal(t, MarketMoveUpdated, res.Outcome)
		assert.Equal(t, 2, res.Move.Revision)
		assert.InDelta(t, 5.1, *res.Move.ChangePct, 1e-9)
		assert.Empty(t, res.Move.RelatedCodes)
	})

	t.Run("the subject cannot change under a key", func(t *testing.T) {
		other := pgMove("pg-a", base)
		other.StockCode, other.ContentHash = "RIO", "hash-3"
		_, err := s.UpsertMarketMove(ctx, other, MarketMoveLimits{})
		assert.ErrorIs(t, err, ErrMarketMoveSubjectChanged)
	})

	t.Run("the revision cap", func(t *testing.T) {
		rec := pgMove("pg-a", base)
		rec.ContentHash = "hash-4"
		_, err := s.UpsertMarketMove(ctx, rec, MarketMoveLimits{MaxRevisions: 2})
		assert.ErrorIs(t, err, ErrMarketMoveRevisionCap)
	})

	t.Run("a retraction is final and idempotent", func(t *testing.T) {
		_, err := s.UpsertMarketMove(ctx, pgMove("pg-b", base.Add(2*time.Hour)), MarketMoveLimits{})
		require.NoError(t, err)
		m, err := s.RetractMarketMove(ctx, "pg-b", "wrong figure", "test")
		require.NoError(t, err)
		assert.Equal(t, MarketMoveRetracted, m.Status)
		require.NotNil(t, m.RetractedAt)
		first := *m.RetractedAt
		m, err = s.RetractMarketMove(ctx, "pg-b", "again", "test")
		require.NoError(t, err)
		assert.True(t, first.Equal(*m.RetractedAt), "the first retraction's time is kept")
		assert.Equal(t, "wrong figure", m.RetractReason)

		_, err = s.UpsertMarketMove(ctx, pgMove("pg-b", base), MarketMoveLimits{})
		assert.ErrorIs(t, err, ErrMarketMoveRetracted)

		_, err = s.RetractMarketMove(ctx, "pg-none", "", "test")
		assert.ErrorIs(t, err, ErrMarketMoveNotFound)
	})

	t.Run("the daily cap counts the market date", func(t *testing.T) {
		day := time.Date(2026, 11, 9, 1, 0, 0, 0, time.UTC)
		_, err := s.UpsertMarketMove(ctx, pgMove("cap-1", day), MarketMoveLimits{MaxPerDay: 1})
		require.NoError(t, err)
		_, err = s.UpsertMarketMove(ctx, pgMove("cap-2", day), MarketMoveLimits{MaxPerDay: 1})
		assert.ErrorIs(t, err, ErrMarketMoveDailyCap)
		// A revision of a move already filed is not a new move.
		rev := pgMove("cap-1", day)
		rev.ContentHash = "hash-rev"
		_, err = s.UpsertMarketMove(ctx, rev, MarketMoveLimits{MaxPerDay: 1})
		assert.NoError(t, err)
	})

	t.Run("the list serves published moves, newest first, by stock and by page", func(t *testing.T) {
		idx := pgMove("pg-index", base.Add(3*time.Hour))
		idx.Kind, idx.StockCode, idx.IndexCode, idx.RelatedCodes, idx.ContentHash = "index", "", "XJO", []string{"FMG"}, "hash-x"
		_, err := s.UpsertMarketMove(ctx, idx, MarketMoveLimits{})
		require.NoError(t, err)

		all, err := s.ListMarketMoves(ctx, MarketMovesFilter{Limit: 10})
		require.NoError(t, err)
		keys := []string{}
		for _, m := range all {
			keys = append(keys, m.MoveKey)
		}
		assert.Equal(t, []string{"cap-1", "pg-index", "pg-a"}, keys, "pg-b is retracted")

		fmg, err := s.ListMarketMoves(ctx, MarketMovesFilter{StockCode: "FMG", Limit: 10})
		require.NoError(t, err)
		require.Len(t, fmg, 1)
		assert.Equal(t, "pg-index", fmg[0].MoveKey, "a move naming the code among its related codes")

		before := all[0].ObservedAt
		page, err := s.ListMarketMoves(ctx, MarketMovesFilter{Limit: 10, BeforeObservedAt: &before, BeforeID: all[0].ID})
		require.NoError(t, err)
		assert.Len(t, page, 2)

		dated, err := s.ListMarketMoves(ctx, MarketMovesFilter{MarketDate: "2026-11-09", Kind: "stock", MinSignificance: 3, Limit: 10})
		require.NoError(t, err)
		require.Len(t, dated, 1)
		assert.Equal(t, "cap-1", dated[0].MoveKey)
	})

	t.Run("two first posts of one key: one lands, the other is told to retry", func(t *testing.T) {
		var wg sync.WaitGroup
		errs := make([]error, 2)
		for i := range 2 {
			wg.Go(func() {
				_, errs[i] = s.UpsertMarketMove(ctx, pgMove("race", base), MarketMoveLimits{})
			})
		}
		wg.Wait()
		ok := 0
		for _, err := range errs {
			if err == nil {
				ok++
			} else {
				assert.ErrorIs(t, err, ErrMarketMoveBusy)
			}
		}
		assert.GreaterOrEqual(t, ok, 1)
	})

	t.Run("the table's own checks hold the shape", func(t *testing.T) {
		_, err := s.db.Exec(ctx, `INSERT INTO market_moves (move_key, kind, direction, headline, summary, observed_at, market_date, content_hash, actor)
			VALUES ('no-subject', 'stock', 'up', 'A headline here', 'A summary that is long enough.', now(), current_date, 'h', 'a')`)
		var pgErr *pgconn.PgError
		require.True(t, errors.As(err, &pgErr))
		assert.Equal(t, "market_moves_subject_check", pgErr.ConstraintName)
	})

	t.Run("known codes are company-metadata or a stock price", func(t *testing.T) {
		known, err := s.KnownStockCodes(ctx, []string{"BHP", "FMG", "ZZZ"})
		require.NoError(t, err)
		assert.Equal(t, map[string]bool{"BHP": true, "FMG": true}, known)
	})
}

func TestListMarketMovesWithoutTheTableIsEmpty(t *testing.T) {
	pool := fundamentalsTestDatabase(t, context.Background(), marketMovesAdminURL(t))
	_, err := pool.Exec(context.Background(), marketMovesTestBaseSchema)
	require.NoError(t, err)
	s := &postgresStore{db: pool}
	rows, err := s.ListMarketMoves(context.Background(), MarketMovesFilter{Limit: 5})
	require.NoError(t, err)
	assert.Empty(t, rows)
	_, err = s.UpsertMarketMove(context.Background(), pgMove("x-1", time.Now()), MarketMoveLimits{})
	assert.ErrorIs(t, err, ErrRelationMissing, "the writer names the missing table")
}

func pgTokenHash(n int) string {
	return fmt.Sprintf("%064x", n)
}

func TestMarketMovesTokensAgainstPostgres(t *testing.T) {
	s := marketMovesTestStore(t)
	ctx := context.Background()

	t.Run("a token is stored by hash and found by it", func(t *testing.T) {
		later := time.Now().Add(90 * 24 * time.Hour).UTC().Truncate(time.Second)
		row, err := s.CreateMarketMovesToken(ctx, "routine", pgTokenHash(1), "smm_abcdef", "admin@example.com", &later)
		require.NoError(t, err)
		assert.Equal(t, "smm_abcdef", row.Prefix)
		require.NotNil(t, row.ExpiresAt)
		assert.True(t, later.Equal(*row.ExpiresAt))
		assert.True(t, row.Usable(time.Now()))

		got, found, err := s.MarketMovesTokenByHash(ctx, pgTokenHash(1))
		require.NoError(t, err)
		require.True(t, found)
		assert.Equal(t, row.ID, got.ID)
		_, found, err = s.MarketMovesTokenByHash(ctx, pgTokenHash(999))
		require.NoError(t, err)
		assert.False(t, found)
	})

	t.Run("a use is recorded at most once a minute", func(t *testing.T) {
		row, _, err := s.MarketMovesTokenByHash(ctx, pgTokenHash(1))
		require.NoError(t, err)
		require.NoError(t, s.TouchMarketMovesToken(ctx, row.ID))
		first, _, _ := s.MarketMovesTokenByHash(ctx, pgTokenHash(1))
		require.NotNil(t, first.LastUsedAt)
		require.NoError(t, s.TouchMarketMovesToken(ctx, row.ID))
		second, _, _ := s.MarketMovesTokenByHash(ctx, pgTokenHash(1))
		assert.True(t, first.LastUsedAt.Equal(*second.LastUsedAt), "a second use inside the minute writes nothing")
	})

	t.Run("revoking keeps the first revocation and the row", func(t *testing.T) {
		row, _, _ := s.MarketMovesTokenByHash(ctx, pgTokenHash(1))
		r1, err := s.RevokeMarketMovesToken(ctx, row.ID, "admin-a")
		require.NoError(t, err)
		r2, err := s.RevokeMarketMovesToken(ctx, row.ID, "admin-b")
		require.NoError(t, err)
		assert.True(t, r1.RevokedAt.Equal(*r2.RevokedAt))
		assert.Equal(t, "admin-a", r2.RevokedBy)
		assert.False(t, r2.Usable(time.Now()))
		_, err = s.RevokeMarketMovesToken(ctx, 99999, "admin")
		assert.ErrorIs(t, err, ErrMarketMovesTokenNotFound)
	})

	t.Run("the active cap is exact under concurrent creates", func(t *testing.T) {
		var wg sync.WaitGroup
		errs := make([]error, MaxActiveMarketMovesTokens+5)
		for i := range errs {
			wg.Go(func() {
				_, errs[i] = s.CreateMarketMovesToken(ctx, "burst", pgTokenHash(100+i), "smm_burst0", "admin", nil)
			})
		}
		wg.Wait()
		ok, capped := 0, 0
		for _, err := range errs {
			switch {
			case err == nil:
				ok++
			case errors.Is(err, ErrMarketMovesTokenCap):
				capped++
			default:
				t.Errorf("unexpected error: %v", err)
			}
		}
		assert.Equal(t, MaxActiveMarketMovesTokens, ok, "the revoked token does not count")
		assert.Equal(t, 5, capped)
	})

	t.Run("the list puts usable tokens first", func(t *testing.T) {
		rows, err := s.ListMarketMovesTokens(ctx)
		require.NoError(t, err)
		require.Len(t, rows, MaxActiveMarketMovesTokens+1)
		assert.Nil(t, rows[0].RevokedAt)
		assert.NotNil(t, rows[len(rows)-1].RevokedAt, "the revoked token is last")
	})

	t.Run("the table's own checks hold the shape", func(t *testing.T) {
		_, err := s.db.Exec(ctx, `INSERT INTO market_moves_tokens (name, token_hash, token_prefix, created_by) VALUES ('x', 'not-a-hash', 'smm_abcdef', 'a')`)
		var pgErr *pgconn.PgError
		require.True(t, errors.As(err, &pgErr))
		assert.Equal(t, "market_moves_tokens_hash_check", pgErr.ConstraintName)
		_, err = s.db.Exec(ctx, `INSERT INTO market_moves_tokens (name, token_hash, token_prefix, created_by, revoked_at) VALUES ('x', $1, 'smm_abcdef', 'a', now())`, pgTokenHash(7))
		require.True(t, errors.As(err, &pgErr))
		assert.Equal(t, "market_moves_tokens_revoked_check", pgErr.ConstraintName)
	})
}
