//go:build integration

package shorts

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The saved-strategy store against a live Postgres: the cap under concurrency, the
// repeat save, the variant ownership guard and replay of migration 000156. Opt in
// with STRATEGY_SAVES_TEST_DATABASE_URL, or STRATEGY_SAVES_TESTCONTAINERS=1 for one
// postgres container the package's TestMain removes:
//
//	cd services && GOWORK=off CGO_ENABLED=0 STRATEGY_SAVES_TESTCONTAINERS=1 \
//	    go test -count=1 -tags=integration,testcontainers -run StrategySaves ./shorts/internal/store/shorts/
//
// The container opt-in needs the testcontainers build tag as well; make
// test-strategy-saves-pg sets both.

// savesMigrationPath is migration 000156 as the deploy replays it. go test runs
// in the package directory; runtime.Caller would give a trimmed path under -trimpath.
const savesMigrationPath = "../../../../migrations/000156_strategy_saves.up.sql"

// savesDB returns a pool on a fresh database with no saved-strategies table yet.
// The database is dropped at cleanup.
func savesDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn, err := testpostgres.Admin("STRATEGY_SAVES_TEST_DATABASE_URL", "STRATEGY_SAVES_TESTCONTAINERS")
	require.NoError(t, err)
	if dsn == "" {
		t.Skip("set STRATEGY_SAVES_TEST_DATABASE_URL, or STRATEGY_SAVES_TESTCONTAINERS=1")
	}
	ctx := context.Background()
	name := fmt.Sprintf("ss156_%d_%d", time.Now().UnixNano()%1e9, rand.Intn(1e6))

	admin, err := pgxpool.New(ctx, dsn)
	require.NoError(t, err)
	_, err = admin.Exec(ctx, "CREATE DATABASE "+name)
	require.NoError(t, err)
	t.Cleanup(func() {
		admin.Close()
		cleanup, err := pgxpool.New(context.Background(), dsn)
		if err != nil {
			return
		}
		defer cleanup.Close()
		_, _ = cleanup.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
	})

	cfg, err := pgxpool.ParseConfig(dsn)
	require.NoError(t, err)
	cfg.ConnConfig.Database = name
	// Production's pool runs in simple protocol, which the migration file is written for.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	return pool
}

// applySavesMigration runs 000156 as psql -f does: the file's own transaction, one call.
func applySavesMigration(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	sql, err := os.ReadFile(savesMigrationPath)
	require.NoError(t, err)
	_, err = pool.Exec(context.Background(), string(sql))
	require.NoError(t, err)
}

func TestStrategySaves_MigrationReplaysCleanly(t *testing.T) {
	pool := savesDB(t)
	applySavesMigration(t, pool)
	applySavesMigration(t, pool)
	var n int
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT count(*) FROM information_schema.tables WHERE table_name = 'user_saved_strategies'`).Scan(&n))
	assert.Equal(t, 1, n)
}

func TestStrategySaves_ARepeatSaveKeepsTheFirstTime(t *testing.T) {
	pool := savesDB(t)
	applySavesMigration(t, pool)
	s := &postgresStore{db: pool}
	ctx := context.Background()

	first, err := s.SaveStrategy(ctx, "user-a", "canslim")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE user_saved_strategies SET created_at = created_at - interval '1 day'`)
	require.NoError(t, err)
	again, err := s.SaveStrategy(ctx, "user-a", "canslim")
	require.NoError(t, err)
	assert.Equal(t, "canslim", again.StrategyRef)
	assert.True(t, again.SavedAt.Before(first.SavedAt), "the stored first save time is kept, not reset by a repeat")
	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM user_saved_strategies`).Scan(&n))
	assert.Equal(t, 1, n)
}

// The cap is exact under concurrency: twenty-five saves racing for one user leave
// exactly MaxSavedStrategies rows, and the rest are refused.
func TestStrategySaves_TheCapHoldsUnderConcurrentSaves(t *testing.T) {
	pool := savesDB(t)
	applySavesMigration(t, pool)
	s := &postgresStore{db: pool}
	ctx := context.Background()

	var wg sync.WaitGroup
	var mu sync.Mutex
	saved, refused := 0, 0
	for i := range 25 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := saveRetrying(ctx, s, "user-a", fmt.Sprintf("s%02d", i))
			mu.Lock()
			defer mu.Unlock()
			switch err {
			case nil:
				saved++
			case ErrStrategySaveLimit:
				refused++
			default:
				t.Errorf("unexpected error: %v", err)
			}
		}(i)
	}
	wg.Wait()
	assert.Equal(t, MaxSavedStrategies, saved)
	assert.Equal(t, 25-MaxSavedStrategies, refused)

	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM user_saved_strategies WHERE user_id = 'user-a'`).Scan(&n))
	assert.Equal(t, MaxSavedStrategies, n)
}

// saveRetrying saves the way a caller does: a busy lock is retried, because
// nothing was written. The cap test races many saves, so a slow run may wait out
// the lock wait; that is a retry, not a lost or extra save.
func saveRetrying(ctx context.Context, s *postgresStore, uid, ref string) (StrategySaveRow, error) {
	for range 100 {
		row, err := s.SaveStrategy(ctx, uid, ref)
		if !errors.Is(err, ErrStrategySaveBusy) {
			return row, err
		}
	}
	return StrategySaveRow{}, ErrStrategySaveBusy
}

// A save that cannot take the user's lock within the wait answers
// ErrStrategySaveBusy, writes nothing, and returns on the wait's bound rather than
// on the request's deadline. Once the holder lets go, the same save succeeds.
func TestStrategySaves_ABusyLockIsRetryableAndWritesNothing(t *testing.T) {
	pool := savesDB(t)
	applySavesMigration(t, pool)
	s := &postgresStore{db: pool}
	ctx := context.Background()

	holder, err := pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = holder.Rollback(ctx) }()
	_, err = holder.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, strategySavesLockKey+"user-a")
	require.NoError(t, err)

	start := time.Now()
	_, err = s.SaveStrategy(ctx, "user-a", "canslim")
	assert.ErrorIs(t, err, ErrStrategySaveBusy)
	assert.Less(t, time.Since(start), 4*time.Second, "the lock wait is bounded well under the request deadline")

	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM user_saved_strategies WHERE user_id = 'user-a'`).Scan(&n))
	assert.Equal(t, 0, n, "a busy save writes nothing")

	require.NoError(t, holder.Rollback(ctx))
	_, err = s.SaveStrategy(ctx, "user-a", "canslim")
	require.NoError(t, err)
}

func TestStrategySaves_ACapIsPerUser(t *testing.T) {
	pool := savesDB(t)
	applySavesMigration(t, pool)
	s := &postgresStore{db: pool}
	ctx := context.Background()
	for i := range MaxSavedStrategies {
		_, err := s.SaveStrategy(ctx, "user-a", fmt.Sprintf("s%02d", i))
		require.NoError(t, err)
	}
	_, err := s.SaveStrategy(ctx, "user-a", "one-more")
	assert.ErrorIs(t, err, ErrStrategySaveLimit)

	_, err = s.SaveStrategy(ctx, "user-b", "one-more")
	require.NoError(t, err, "another user's list is not full")
}

// A repeat save at the cap succeeds: it is not a new strategy.
func TestStrategySaves_ARepeatSaveAtTheCapSucceeds(t *testing.T) {
	pool := savesDB(t)
	applySavesMigration(t, pool)
	s := &postgresStore{db: pool}
	ctx := context.Background()
	for i := range MaxSavedStrategies {
		_, err := s.SaveStrategy(ctx, "user-a", fmt.Sprintf("s%02d", i))
		require.NoError(t, err)
	}
	_, err := s.SaveStrategy(ctx, "user-a", "s03")
	require.NoError(t, err)
}

// A variant reference resolves under its owner only. Without the variants table
// no variant is owned by anyone. The table here is a stand-in: the variants
// migration owns the real one.
func TestStrategySaves_AVariantResolvesUnderItsOwnerOnly(t *testing.T) {
	pool := savesDB(t)
	applySavesMigration(t, pool)
	s := &postgresStore{db: pool}
	ctx := context.Background()

	_, err := s.SaveStrategy(ctx, "user-a", "variant:v1")
	assert.ErrorIs(t, err, ErrStrategyRefNotFound, "no variants table: nothing is owned")

	_, err = pool.Exec(ctx, `CREATE TABLE strategy_variants (id text PRIMARY KEY, user_id text NOT NULL)`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO strategy_variants (id, user_id) VALUES ('v1', 'user-a')`)
	require.NoError(t, err)

	_, err = s.SaveStrategy(ctx, "user-a", "variant:v1")
	require.NoError(t, err)
	_, err = s.SaveStrategy(ctx, "user-b", "variant:v1")
	assert.ErrorIs(t, err, ErrStrategyRefNotFound, "another user's variant reads as not found")
	_, err = s.SaveStrategy(ctx, "user-a", "variant:no-such")
	assert.ErrorIs(t, err, ErrStrategyRefNotFound)
}

func TestStrategySaves_UnsaveRemovesOnlyTheCallersRow(t *testing.T) {
	pool := savesDB(t)
	applySavesMigration(t, pool)
	s := &postgresStore{db: pool}
	ctx := context.Background()
	_, err := s.SaveStrategy(ctx, "user-a", "canslim")
	require.NoError(t, err)
	_, err = s.SaveStrategy(ctx, "user-b", "canslim")
	require.NoError(t, err)

	require.NoError(t, s.UnsaveStrategy(ctx, "user-a", "canslim"))
	require.NoError(t, s.UnsaveStrategy(ctx, "user-a", "canslim"), "removing one not saved succeeds")

	a, err := s.ListStrategySaves(ctx, "user-a")
	require.NoError(t, err)
	assert.Empty(t, a)
	b, err := s.ListStrategySaves(ctx, "user-b")
	require.NoError(t, err)
	assert.Len(t, b, 1)
}

func TestStrategySaves_ListIsMostRecentFirst(t *testing.T) {
	pool := savesDB(t)
	applySavesMigration(t, pool)
	s := &postgresStore{db: pool}
	ctx := context.Background()
	for _, ref := range []string{"canslim", "minervini-trend-template", "zanger-breakout"} {
		_, err := s.SaveStrategy(ctx, "user-a", ref)
		require.NoError(t, err)
		time.Sleep(5 * time.Millisecond)
	}
	rows, err := s.ListStrategySaves(ctx, "user-a")
	require.NoError(t, err)
	require.Len(t, rows, 3)
	assert.Equal(t, "zanger-breakout", rows[0].StrategyRef)
	assert.Equal(t, "canslim", rows[2].StrategyRef)
}

// Without the table (before 000156 is applied) a list is empty, and a save is
// reported as the missing relation, not as a database failure.
func TestStrategySaves_AMissingTableReadsEmptyAndRefusesWrites(t *testing.T) {
	pool := savesDB(t)
	s := &postgresStore{db: pool}
	ctx := context.Background()

	rows, err := s.ListStrategySaves(ctx, "user-a")
	require.NoError(t, err)
	assert.Empty(t, rows)

	_, err = s.SaveStrategy(ctx, "user-a", "canslim")
	assert.ErrorIs(t, err, ErrRelationMissing)
}
