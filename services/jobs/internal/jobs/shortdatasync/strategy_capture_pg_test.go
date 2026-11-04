//go:build testcontainers

package shortdatasync

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// Real-Postgres tests for migration 000154 (architecture 9.1): the vintage trigger and its baseline, the
// replay guarantee, and the writer's SQL. They run against a disposable server: a URL in
// SHORTDATASYNC_TEST_DATABASE_URL, or a container when SHORTDATASYNC_TESTCONTAINERS=1. Each test builds its
// own DATABASE, not a schema: 000154's trigger function pins search_path to public, exactly as production
// runs it, so a schema would not match the deploy. The database is dropped afterwards.
//
//	SHORTDATASYNC_TESTCONTAINERS=1 GOWORK=off go test -tags=testcontainers ./internal/jobs/shortdatasync/ -run StrategyCapture -v
//
// Without a server the tests skip. Without the testcontainers tag the package does not link testcontainers.

func TestMain(m *testing.M) { os.Exit(testpostgres.Main(m)) }

const captureMigrationsDir = "../../../../migrations"

// captureDB returns a pool on a fresh database, whose public schema is the default search_path, as in
// production. The database is dropped at cleanup.
func captureDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn, err := testpostgres.Admin("SHORTDATASYNC_TEST_DATABASE_URL", "SHORTDATASYNC_TESTCONTAINERS")
	require.NoError(t, err)
	if dsn == "" {
		t.Skip("set SHORTDATASYNC_TEST_DATABASE_URL, or SHORTDATASYNC_TESTCONTAINERS=1 with -tags=testcontainers")
	}
	ctx := context.Background()
	name := fmt.Sprintf("sc154_%d_%d", time.Now().UnixNano()%1e9, rand.Intn(1e6))

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
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	return pool
}

// captureApply runs one migration file on the pool, as the deploy does (psql -f: one statement at a time,
// the file's own BEGIN and COMMIT).
func captureApply(t *testing.T, pool *pgxpool.Pool, name string) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(captureMigrationsDir, name))
	require.NoError(t, err, name)
	_, err = pool.Exec(context.Background(), string(b))
	require.NoError(t, err, "applying %s", name)
}

// countVintages returns the vintage rows for one op.
func countVintages(t *testing.T, pool *pgxpool.Pool, op string) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT count(*) FROM stock_fundamentals_vintages WHERE op = $1`, op).Scan(&n))
	return n
}

// seedFundamental writes one annual row, the shape the picks vendor upsert writes.
func seedFundamental(t *testing.T, pool *pgxpool.Pool, code string, revenue float64) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, revenue, source)
		VALUES ($1, 'annual', '2025-06-30', 'AUD', $2, 'yahoo-timeseries')`, code, revenue)
	require.NoError(t, err)
}

// TestStrategyCaptureVintagesAgainstPostgres applies 000154 twice and checks the trigger, the baseline and
// the delete rule against a live table.
func TestStrategyCaptureVintagesAgainstPostgres(t *testing.T) {
	pool := captureDB(t)
	ctx := context.Background()

	captureApply(t, pool, "000129_add_stock_fundamentals.up.sql")

	// Rows that exist before the vintage history starts become the baseline.
	seedFundamental(t, pool, "BHP", 100)
	seedFundamental(t, pool, "CBA", 200)

	captureApply(t, pool, "000154_strategy_capture.up.sql")
	require.Equal(t, 2, countVintages(t, pool, "B"), "one baseline row per existing row")

	// Replay: a second application changes nothing, adds no trigger and no baseline.
	captureApply(t, pool, "000154_strategy_capture.up.sql")
	require.Equal(t, 2, countVintages(t, pool, "B"), "a replay must not repeat the baseline")
	var triggers int
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT count(*) FROM pg_trigger
		WHERE tgrelid = 'stock_fundamentals'::regclass AND tgname = 'trg_fundamentals_vintage' AND NOT tgisinternal`).
		Scan(&triggers))
	require.Equal(t, 1, triggers, "a replay must not create a second trigger")

	// An identical upsert that only moves the provenance timestamps writes no vintage.
	_, err := pool.Exec(ctx, `
		INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, revenue, source)
		VALUES ('BHP', 'annual', '2025-06-30', 'AUD', 100, 'yahoo-timeseries')
		ON CONFLICT (stock_code, period_type, period_end) DO UPDATE SET
		    revenue = EXCLUDED.revenue, source_fetched_at = now(), updated_at = now()`)
	require.NoError(t, err)
	require.Equal(t, 0, countVintages(t, pool, "U"), "an identical upsert adds no vintage")

	// A changed value is one U row, carrying the new values.
	_, err = pool.Exec(ctx, `
		INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, revenue, source)
		VALUES ('BHP', 'annual', '2025-06-30', 'AUD', 111, 'yahoo-timeseries')
		ON CONFLICT (stock_code, period_type, period_end) DO UPDATE SET revenue = EXCLUDED.revenue, updated_at = now()`)
	require.NoError(t, err)
	require.Equal(t, 1, countVintages(t, pool, "U"), "a changed value adds one update row")

	// A new key is one I row.
	seedFundamental(t, pool, "WBC", 300)
	require.Equal(t, 1, countVintages(t, pool, "I"))

	// A delete writes one D row per deleted row, carrying the row it deleted.
	_, err = pool.Exec(ctx, `DELETE FROM stock_fundamentals WHERE stock_code IN ('CBA', 'WBC')`)
	require.NoError(t, err)
	require.Equal(t, 2, countVintages(t, pool, "D"), "one delete row per deleted row")
	var deletedCode string
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT row_json->>'stock_code' FROM stock_fundamentals_vintages
		WHERE op = 'D' AND stock_code = 'CBA'`).Scan(&deletedCode))
	require.Equal(t, "CBA", deletedCode)
}

// TestStrategyCaptureFilingPurgeAgainstPostgres mirrors the nightly purge's shape: a DELETE of many rows in
// one statement writes exactly one D row per deleted row.
func TestStrategyCaptureFilingPurgeAgainstPostgres(t *testing.T) {
	pool := captureDB(t)
	ctx := context.Background()

	captureApply(t, pool, "000129_add_stock_fundamentals.up.sql")
	captureApply(t, pool, "000154_strategy_capture.up.sql")

	for i := range 5 {
		_, err := pool.Exec(ctx, `
			INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, revenue, source)
			VALUES ($1, 'annual', '2025-06-30', 'AUD', $2, 'asx-filing-extraction')`,
			fmt.Sprintf("X%02d", i), float64(i))
		require.NoError(t, err)
	}
	require.Equal(t, 5, countVintages(t, pool, "I"))

	tag, err := pool.Exec(ctx, `DELETE FROM stock_fundamentals WHERE source = 'asx-filing-extraction'`)
	require.NoError(t, err)
	require.EqualValues(t, 5, tag.RowsAffected())
	require.Equal(t, 5, countVintages(t, pool, "D"), "one D row per row the purge deletes")
}
