package shorts

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// read_by (migration 000154) against a real Postgres: a schema without the column
// reads every notice as the parser's and counts no model reads, and with it a model's
// notice is served as "model". SHORTS_TEST_POSTGRES_URL names a disposable server.
func TestNoticeReadByAgainstPostgres(t *testing.T) {
	adminURL := os.Getenv("SHORTS_TEST_POSTGRES_URL")
	if adminURL == "" {
		t.Skip("SHORTS_TEST_POSTGRES_URL not set; skipping the real-Postgres read_by test")
	}
	for _, shared := range []string{"supabase", "pooler", ":6543"} {
		if strings.Contains(adminURL, shared) {
			t.Fatalf("refusing a shared or pooled database (%q): this test creates and drops databases", shared)
		}
	}
	ctx := context.Background()
	pool := fundamentalsTestDatabase(t, ctx, adminURL)
	exec := func(sql string) {
		t.Helper()
		_, err := pool.Exec(ctx, sql)
		require.NoError(t, err)
	}
	exec(ownershipTestBaseSchema)
	exec(readFileT(t, "000137_add_ownership.up.sql"))
	exec(ownershipTestSeed)

	t.Run("without 000154 every notice reads as the parser's and nothing is emptied", func(t *testing.T) {
		s := &postgresStore{db: pool}
		notices, err := s.SubstantialNotices(ctx, OwnershipFilter{StockCode: "ZIP"}, 10)
		require.NoError(t, err)
		require.NotEmpty(t, notices, "a missing column must not empty the feed")
		for _, n := range notices {
			assert.Equal(t, "parser", n.ReadBy)
		}
		stats, err := s.NoticeStats(ctx)
		require.NoError(t, err)
		assert.Zero(t, stats.ReadByModel)
		assert.Equal(t, 5, stats.Parsed)
	})

	exec(readFileT(t, "000154_notice_read_by.up.sql"))
	exec(`INSERT INTO substantial_holder_notices (announcement_url, stock_code, form, holder_name, holder_key,
		announced_on, present_pct, parser_version, read_by)
		VALUES ('https://example.test/model-read', 'ZIP', '604', 'Model Read Holder', 'model-read-holder',
		        '2026-10-20', 6.1, 1, 'model')`)

	t.Run("with 000154 a model's notice is served as model and counted", func(t *testing.T) {
		s := &postgresStore{db: pool}
		notices, err := s.SubstantialNotices(ctx, OwnershipFilter{StockCode: "ZIP"}, 10)
		require.NoError(t, err)
		require.Len(t, notices, 6)
		assert.Equal(t, "model", notices[0].ReadBy, "newest first: the model's notice")
		assert.Equal(t, "parser", notices[1].ReadBy)
		page, err := s.SubstantialNoticesPage(ctx, NoticeFilter{StockCode: "ZIP"}, "", "", 10)
		require.NoError(t, err)
		assert.Equal(t, "model", page[0].ReadBy, "the page reads the same columns")
		stats, err := s.NoticeStats(ctx)
		require.NoError(t, err)
		assert.Equal(t, 1, stats.ReadByModel)
		assert.Equal(t, 6, stats.Parsed)
	})

	t.Run("an absent answer is re-probed once its TTL has passed, not before", func(t *testing.T) {
		// A store that answered absent before 000154 was applied: inside the TTL it keeps
		// reading 'parser' without a query, past it the probe finds the column.
		s := &postgresStore{db: pool}
		s.readBy.Store(readByAbsent)
		s.readByAbsentAt.Store(time.Now().Add(-time.Minute).UnixNano())
		assert.Equal(t, "'parser'", s.noticeReadBy(ctx), "inside the TTL the absent answer is kept")
		s.readByAbsentAt.Store(time.Now().Add(-readByAbsentTTL - time.Second).UnixNano())
		assert.Equal(t, "h.read_by", s.noticeReadBy(ctx), "past the TTL the probe runs and finds read_by")
		assert.Equal(t, int32(readByPresent), s.readBy.Load())
	})

	t.Run("the constraint refuses any other reader", func(t *testing.T) {
		_, err := pool.Exec(ctx, `INSERT INTO substantial_holder_notices (announcement_url, stock_code, form, holder_key,
			announced_on, parser_version, read_by) VALUES ('https://example.test/bad', 'ZIP', '605', 'k', '2026-10-20', 1, 'gemini')`)
		assert.Error(t, err)
	})
}

// An absent answer inside its TTL is served without a query: the store has no database here,
// so a probe would panic on the nil pool and the test would fail.
func TestNoticeReadByAbsentIsTrustedWithinTTL(t *testing.T) {
	s := &postgresStore{}
	s.readBy.Store(readByAbsent)
	s.readByAbsentAt.Store(time.Now().UnixNano())
	assert.Equal(t, "'parser'", s.noticeReadBy(context.Background()))
}

// readFileT reads a migration from the repository's migrations directory.
func readFileT(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "migrations", name))
	require.NoError(t, err)
	return string(b)
}
