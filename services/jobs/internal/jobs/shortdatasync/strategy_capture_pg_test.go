package shortdatasync

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// Real-Postgres tests for migration 000155: the vintage trigger and its baseline, the replay guarantee,
// and the writer's SQL. They run against a disposable server: a URL in SHORTDATASYNC_TEST_DATABASE_URL,
// or a container when SHORTDATASYNC_TESTCONTAINERS=1 (see testmain_test.go). Each test builds its own
// DATABASE, not a schema: the trigger function pins search_path to public, exactly as production runs it,
// so a schema would not match the deploy. The database is dropped afterwards.
//
// The suite runs through the deploy gate (make test-shortdatasync-pg, in run-tests beside the alerts
// suite). Without a server the tests skip; SHORTDATASYNC_TESTCONTAINERS=1 without the testcontainers tag
// fails loudly rather than skipping.
//
//	cd services/jobs && SHORTDATASYNC_TESTCONTAINERS=1 GOWORK=off CGO_ENABLED=0 \
//	    go test -tags=testcontainers -count=1 -run 'StrategyCapture|IngestWriter' ./internal/jobs/shortdatasync/

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
	// Production's pool runs in simple protocol (platform.Connect), which the writer's statements and the
	// migrations are written for. The suite runs the same way, so a statement that passes here passes there.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
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

// TestStrategyCaptureVintagesAgainstPostgres applies 000155 twice and checks the trigger, the baseline and
// the delete rule against a live table.
func TestStrategyCaptureVintagesAgainstPostgres(t *testing.T) {
	pool := captureDB(t)
	ctx := context.Background()

	captureApply(t, pool, "000129_add_stock_fundamentals.up.sql")

	// Rows that exist before the vintage history starts become the baseline.
	seedFundamental(t, pool, "BHP", 100)
	seedFundamental(t, pool, "CBA", 200)

	captureApply(t, pool, "000155_strategy_capture.up.sql")
	require.Equal(t, 2, countVintages(t, pool, "B"), "one baseline row per existing row")

	// Replay: a second application changes nothing, adds no trigger and no baseline.
	captureApply(t, pool, "000155_strategy_capture.up.sql")
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

// TestStrategyCaptureLatestVintageWithinOneTransaction: the vintages one transaction writes share a
// captured_at, so "the latest" is the greatest (captured_at, id). The reader's order must pick the
// transaction's last write, not an intermediate state of the same row.
func TestStrategyCaptureLatestVintageWithinOneTransaction(t *testing.T) {
	pool := captureDB(t)
	ctx := context.Background()
	captureApply(t, pool, "000129_add_stock_fundamentals.up.sql")
	captureApply(t, pool, "000155_strategy_capture.up.sql")

	tx, err := pool.Begin(ctx)
	require.NoError(t, err)
	for _, stmt := range []string{
		`INSERT INTO stock_fundamentals (stock_code, period_type, period_end, currency, revenue, source)
		 VALUES ('ZZZ', 'annual', '2025-06-30', 'AUD', 1, 'yahoo-timeseries')`,
		`UPDATE stock_fundamentals SET revenue = NULL WHERE stock_code = 'ZZZ'`,
		`UPDATE stock_fundamentals SET revenue = 3 WHERE stock_code = 'ZZZ'`,
	} {
		_, err := tx.Exec(ctx, stmt)
		require.NoError(t, err)
	}
	require.NoError(t, tx.Commit(ctx))

	var distinctCaptured int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(DISTINCT captured_at) FROM stock_fundamentals_vintages WHERE stock_code = 'ZZZ'`).
		Scan(&distinctCaptured))
	require.Equal(t, 1, distinctCaptured, "one transaction, one captured_at")

	var latest string
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT row_json->>'revenue' FROM stock_fundamentals_vintages
		WHERE stock_code = 'ZZZ'
		ORDER BY captured_at DESC, id DESC LIMIT 1`).Scan(&latest))
	require.Equal(t, "3", latest, "the reader's order picks the transaction's final write")
}

// TestStrategyCaptureFilingPurgeAgainstPostgres mirrors the nightly purge's shape: a DELETE of many rows in
// one statement writes exactly one D row per deleted row.
func TestStrategyCaptureFilingPurgeAgainstPostgres(t *testing.T) {
	pool := captureDB(t)
	ctx := context.Background()

	captureApply(t, pool, "000129_add_stock_fundamentals.up.sql")
	captureApply(t, pool, "000155_strategy_capture.up.sql")

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

// captureShorts creates the part of shorts the writer's capture SQL reads and writes: the columns and the
// (DATE, PRODUCT_CODE) unique key the upsert conflicts on. It is not the production table, which holds
// more columns and indexes, but the capture statements do not depend on those.
func captureShorts(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		CREATE TABLE shorts (
		    "DATE" timestamp, "PRODUCT" text, "PRODUCT_CODE" text,
		    "REPORTED_SHORT_POSITIONS" double precision, "TOTAL_PRODUCT_IN_ISSUE" double precision,
		    "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" double precision,
		    UNIQUE ("DATE", "PRODUCT_CODE"))`)
	require.NoError(t, err)
}

// TestIngestWriterAgainstPostgres runs the writer's own statements against a live table: the recount
// counts a padded legacy row, the upsert keeps the first observation and the first mode, and the
// revision insert writes the stored and file values.
func TestIngestWriterAgainstPostgres(t *testing.T) {
	pool := captureDB(t)
	ctx := context.Background()
	captureApply(t, pool, "000129_add_stock_fundamentals.up.sql")
	captureApply(t, pool, "000155_strategy_capture.up.sql")
	captureShorts(t, pool)
	store := &pgStore{db: pool}

	day := time.Date(2026, 2, 3, 0, 0, 0, 0, time.UTC)
	// BHP and CBA are present; WBT is stored under a padded legacy code, which counts as present.
	for _, code := range []string{"BHP", "CBA", "WBT "} {
		_, err := pool.Exec(ctx, `INSERT INTO shorts ("DATE", "PRODUCT", "PRODUCT_CODE") VALUES ($1, 'x', $2)`, day, code)
		require.NoError(t, err)
	}
	shortsRows := func() int {
		var n int
		require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM shorts`).Scan(&n))
		return n
	}
	before := shortsRows()

	// The daily load recorded four codes; PLS is not in shorts yet.
	require.NoError(t, store.RecordIngest(ctx, ingestRecord{
		ReportDate: day, Codes: []string{"BHP", "CBA", "WBT", "PLS"}, SourceFile: "a.csv", Mode: modeDaily,
	}))
	var fileRows, loaded int
	var mode, lastMode string
	var firstAt, lastAt time.Time
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT file_rows, loaded_rows, mode, last_mode, first_ingested_at, last_ingested_at
		FROM asic_report_ingests WHERE report_date = $1`, day).
		Scan(&fileRows, &loaded, &mode, &lastMode, &firstAt, &lastAt))
	require.Equal(t, 4, fileRows)
	require.Equal(t, 3, loaded, "PLS is absent and the padded WBT counts as present")
	require.Equal(t, modeDaily, mode)
	require.Equal(t, modeDaily, lastMode)

	// Reconcile repairs PLS. Its recount is complete, its first observation and first mode are kept.
	_, err := pool.Exec(ctx, `INSERT INTO shorts ("DATE", "PRODUCT", "PRODUCT_CODE") VALUES ($1, 'x', 'PLS')`, day)
	require.NoError(t, err)
	require.NoError(t, store.RecordIngest(ctx, ingestRecord{
		ReportDate: day, Codes: []string{"BHP", "CBA", "WBT", "PLS"}, SourceFile: "a.csv", Mode: modeReconcile,
	}))
	var firstAgain time.Time
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT file_rows, loaded_rows, mode, last_mode, first_ingested_at, last_ingested_at
		FROM asic_report_ingests WHERE report_date = $1`, day).
		Scan(&fileRows, &loaded, &mode, &lastMode, &firstAgain, &lastAt))
	require.Equal(t, 4, loaded, "the recount is complete once reconcile has written PLS")
	require.Equal(t, modeDaily, mode, "the first mode is kept")
	require.Equal(t, modeReconcile, lastMode, "the latest mode is recorded")
	require.True(t, firstAt.Equal(firstAgain), "first_ingested_at is the first observation and is kept")
	require.Equal(t, before+1, shortsRows(), "recording an ingest writes no shorts row beyond the repair itself")

	// A file that parsed to no codes records file_rows NULL: its completeness is unknown, not complete.
	require.NoError(t, store.RecordIngest(ctx, ingestRecord{ReportDate: day.AddDate(0, 0, 1), Mode: modeDaily}))
	var emptyFileRows *int
	var emptyComplete *bool
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT file_rows, loaded_rows >= file_rows FROM asic_report_ingests WHERE report_date = $1`,
		day.AddDate(0, 0, 1)).Scan(&emptyFileRows, &emptyComplete))
	require.Nil(t, emptyFileRows, "a file with no codes has no file_rows, so it is never complete")
	require.Nil(t, emptyComplete, "loaded_rows >= NULL is NULL, not a pass")

	// Revisions: one row, the stored values beside the file's, a NULL stored value kept as NULL.
	old := 999.0
	revision := revisionRecord{
		Date: day, Code: "BHP", OldPositions: &old, NewPositions: 1000, OldShares: nil, NewShares: 5000,
		OldPercent: nil, NewPercent: 0.42,
	}
	unwritten, err := store.InsertRevisions(ctx, []revisionRecord{revision})
	require.NoError(t, err)
	require.Empty(t, unwritten)
	var oldPos *float64
	var newPos, newPct float64
	var oldShares *float64
	require.NoError(t, pool.QueryRow(ctx, `
		SELECT old_positions, new_positions, old_shares, new_percent
		FROM shorts_revisions WHERE product_code = 'BHP'`).Scan(&oldPos, &newPos, &oldShares, &newPct))
	require.NotNil(t, oldPos)
	require.Equal(t, 999.0, *oldPos)
	require.Equal(t, 1000.0, newPos)
	require.Nil(t, oldShares, "a NULL stored value stays NULL")
	require.Equal(t, 0.42, newPct)

	// The row's own upsert failed after the revision landed, so the next run finds the same difference and
	// writes the same revision again. It must not add a second row.
	unwritten, err = store.InsertRevisions(ctx, []revisionRecord{revision})
	require.NoError(t, err)
	require.Empty(t, unwritten)
	require.Equal(t, 1, revisionRows(t, pool, "BHP"), "a repeated revision is recorded once")

	// A later, different change to the same code is a new revision, and a move back is too.
	later := revisionRecord{Date: day, Code: "BHP", OldPositions: new(1000.0), NewPositions: 999, NewShares: 5000}
	_, err = store.InsertRevisions(ctx, []revisionRecord{later, revision})
	require.NoError(t, err)
	require.Equal(t, 3, revisionRows(t, pool, "BHP"), "each change in order is kept, even a move back to an old value")
}

// revisionRows counts the shorts_revisions rows for one code.
func revisionRows(t *testing.T, pool *pgxpool.Pool, code string) int {
	t.Helper()
	var n int
	require.NoError(t, pool.QueryRow(context.Background(),
		`SELECT count(*) FROM shorts_revisions WHERE product_code = $1`, code).Scan(&n))
	return n
}
