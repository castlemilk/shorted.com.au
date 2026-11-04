package shorts

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The insights reads against a real Postgres, before and after 000137, on the
// simple protocol production runs (fundamentalsTestDatabase sets it), so the
// array arguments are checked the way production sends them.
// SHORTS_TEST_POSTGRES_URL names a disposable server.
func TestOwnershipInsightsReadsAgainstPostgres(t *testing.T) {
	adminURL := os.Getenv("SHORTS_TEST_POSTGRES_URL")
	if adminURL == "" {
		t.Skip("SHORTS_TEST_POSTGRES_URL not set; skipping the real-Postgres insights test")
	}
	for _, shared := range []string{"supabase", "pooler", ":6543"} {
		if strings.Contains(adminURL, shared) {
			t.Fatalf("refusing a shared or pooled database (%q): this test creates and drops databases", shared)
		}
	}
	ctx := context.Background()
	pool := fundamentalsTestDatabase(t, ctx, adminURL)
	s := &postgresStore{db: pool}
	exec := func(sql string) {
		t.Helper()
		_, err := pool.Exec(ctx, sql)
		require.NoError(t, err)
	}
	exec(ownershipTestBaseSchema)

	t.Run("without 000137 every read is empty, never an error", func(t *testing.T) {
		snaps, err := s.FundSnapshots(ctx)
		require.NoError(t, err)
		assert.Empty(t, snaps)
		rows, err := s.FundSnapshotHoldings(ctx, []int64{1, 2}, "")
		require.NoError(t, err)
		assert.Empty(t, rows)
		changes, err := s.FundHoldingChanges(ctx, []FundSnapshotPair{{Group: -1, From: 1, To: 2}}, []string{"BHP"})
		require.NoError(t, err)
		assert.Empty(t, changes)
	})

	migration, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "migrations", "000137_add_ownership.up.sql"))
	require.NoError(t, err)
	exec(string(migration))
	// Two Vanguard files and one SPDR file. Between Vanguard's files BHP grows
	// by 10 million shares at a lower price, CBA is new, and WES is gone; one
	// row states a value and no shares.
	exec(`
INSERT INTO fund_holding_snapshots (id, institution_slug, fund_name, fund_code, source_kind, source_url, as_at) VALUES
 (1, 'vanguard', 'VAS', 'VAS', 'etf', 'u1', '2026-09-30'),
 (2, 'vanguard', 'VAS', 'VAS', 'etf', 'u2', '2026-10-31'),
 (3, 'state-street', 'STW', NULL, 'etf', 'u3', '2026-10-20');
INSERT INTO fund_holdings (snapshot_id, stock_code, units, value_aud, weight_pct, match_method) VALUES
 (1, 'BHP', 100000000, 4500000000, 8, 'code'),
 (1, 'WES', 5000000, 300000000, 1, 'code'),
 (1, 'XYZ', NULL, 1000000, NULL, 'isin'),
 (2, 'BHP', 110000000, 4400000000, 8, 'code'),
 (2, 'CBA', 2000000, 300000000, 1, 'code'),
 (2, 'XYZ', NULL, 1500000, NULL, 'isin'),
 (3, 'BHP', 20000000, 820000000, 9, 'code');
`)

	t.Run("snapshots are every file, oldest first", func(t *testing.T) {
		snaps, err := s.FundSnapshots(ctx)
		require.NoError(t, err)
		require.Len(t, snaps, 3)
		assert.Equal(t, []string{"2026-09-30", "2026-10-20", "2026-10-31"}, []string{snaps[0].AsAt, snaps[1].AsAt, snaps[2].AsAt})
		assert.Equal(t, "STW", snaps[1].FundName)
		assert.Equal(t, "", snaps[1].FundCode, "a NULL fund code reads empty")
		assert.Equal(t, "etf", snaps[2].SourceKind)
	})

	t.Run("holdings are the named files' rows, or one stock's", func(t *testing.T) {
		rows, err := s.FundSnapshotHoldings(ctx, []int64{2, 3}, "")
		require.NoError(t, err)
		assert.Len(t, rows, 4)
		one, err := s.FundSnapshotHoldings(ctx, []int64{1, 2, 3}, "BHP")
		require.NoError(t, err)
		assert.Len(t, one, 3)
		for _, r := range one {
			assert.Equal(t, "BHP", r.StockCode)
			require.NotNil(t, r.Units)
		}
		none, err := s.FundSnapshotHoldings(ctx, nil, "")
		require.NoError(t, err)
		assert.Empty(t, none)
	})

	t.Run("changes sum each pair's two files per group and stock", func(t *testing.T) {
		rows, err := s.FundHoldingChanges(ctx, []FundSnapshotPair{{Group: -1, From: 1, To: 2}, {Group: 4, From: 1, To: 2}}, nil)
		require.NoError(t, err)
		by := map[string]FundHoldingChangeRow{}
		for _, r := range rows {
			by[string(rune('0'+r.Group+1))+r.StockCode] = r
		}
		bhp := by["0BHP"]
		assert.InDelta(t, 100e6, bhp.UnitsFrom, 1e-6)
		assert.InDelta(t, 110e6, bhp.UnitsTo, 1e-6)
		assert.InDelta(t, 4.5e9, bhp.UnitValueFrom, 1e-3)
		assert.InDelta(t, 4.4e9, bhp.UnitValueTo, 1e-3)
		assert.True(t, bhp.HasUnitsFrom)
		assert.True(t, bhp.HasUnitsTo)
		cba := by["0CBA"]
		assert.Zero(t, cba.UnitsFrom, "a new position starts from nothing")
		assert.False(t, cba.HasUnitsFrom)
		assert.InDelta(t, 2e6, cba.UnitsTo, 1e-6)
		wes := by["0WES"]
		assert.InDelta(t, 5e6, wes.UnitsFrom, 1e-6)
		assert.Zero(t, wes.UnitsTo, "a position gone ends at nothing")
		xyz := by["0XYZ"]
		assert.InDelta(t, 1e6, xyz.ValueOnlyFrom, 1e-6)
		assert.InDelta(t, 1.5e6, xyz.ValueOnlyTo, 1e-6)
		assert.Zero(t, xyz.UnitsTo)
		assert.Contains(t, by, "5BHP", "a second group is summed apart")

		limited, err := s.FundHoldingChanges(ctx, []FundSnapshotPair{{Group: 0, From: 1, To: 2}}, []string{"CBA", "WES"})
		require.NoError(t, err)
		assert.Len(t, limited, 2)
		none, err := s.FundHoldingChanges(ctx, nil, nil)
		require.NoError(t, err)
		assert.Empty(t, none)
	})
}
