package marketdata

// Real-Postgres tests for the index sync's write: the upsert and the bounded
// clean-up share one transaction per series, and the dry run only counts. They
// need a disposable server: a URL in INDEXSYNC_TEST_DATABASE_URL, or a container
// when INDEXSYNC_TESTCONTAINERS=1 with the testcontainers tag. Without either,
// the tests skip.
//
//	cd services/jobs && INDEXSYNC_TESTCONTAINERS=1 GOWORK=off CGO_ENABLED=0 \
//	    go test -tags=testcontainers -count=1 -run IndexSyncPG ./internal/jobs/marketdata/

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// TestMain removes the container the suite starts under INDEXSYNC_TESTCONTAINERS=1.
// It starts nothing itself.
func TestMain(m *testing.M) {
	os.Exit(testpostgres.Main(m))
}

// indexPricesTable is migration 000117's index_prices, so the upsert and the
// clean-up run against the production shape and key.
const indexPricesTable = `
CREATE TABLE index_prices (
    index_code   VARCHAR(16)      NOT NULL,
    date         DATE             NOT NULL,
    open         DOUBLE PRECISION,
    high         DOUBLE PRECISION,
    low          DOUBLE PRECISION,
    close        DOUBLE PRECISION,
    volume       BIGINT,
    created_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
    CONSTRAINT index_prices_code_date_key UNIQUE (index_code, date)
)`

func indexSyncTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn, err := testpostgres.Admin("INDEXSYNC_TEST_DATABASE_URL", "INDEXSYNC_TESTCONTAINERS")
	require.NoError(t, err)
	if dsn == "" {
		t.Skip("set INDEXSYNC_TEST_DATABASE_URL, or INDEXSYNC_TESTCONTAINERS=1 with -tags=testcontainers")
	}
	ctx := context.Background()
	name := fmt.Sprintf("indexsync_%d_%d", time.Now().UnixNano()%1e9, rand.Intn(1e6))

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
	// The production pool runs simple protocol (buildDBPoolConfig), so the
	// statements here must too.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	_, err = pool.Exec(ctx, indexPricesTable)
	require.NoError(t, err)
	return pool
}

// seedIndexRows stores one close per (code, date) for each row given as
// "CODE YYYY-MM-DD close".
func seedIndexRows(t *testing.T, pool *pgxpool.Pool, rows ...string) {
	t.Helper()
	for _, r := range rows {
		var code, date string
		var close float64
		_, err := fmt.Sscanf(r, "%s %s %g", &code, &date, &close)
		require.NoError(t, err, r)
		_, err = pool.Exec(context.Background(),
			`INSERT INTO index_prices (index_code, date, close) VALUES ($1, $2, $3)`, code, date, close)
		require.NoError(t, err, r)
	}
}

// barsOn builds the response's bars for the given sessions, each closing at 100.
func barsOn(t *testing.T, dates ...string) []indexBar {
	t.Helper()
	out := make([]indexBar, 0, len(dates))
	for _, d := range dates {
		day, err := time.Parse("2006-01-02", d)
		require.NoError(t, err)
		c := 100.0
		out = append(out, indexBar{Date: day, Close: &c})
	}
	return out
}

func indexDates(t *testing.T, pool *pgxpool.Pool, code string) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT to_char(date, 'YYYY-MM-DD') FROM index_prices WHERE index_code = $1 ORDER BY date`, code)
	require.NoError(t, err)
	defer rows.Close()
	var out []string
	for rows.Next() {
		var d string
		require.NoError(t, rows.Scan(&d))
		out = append(out, d)
	}
	require.NoError(t, rows.Err())
	return out
}

// The response spans Fri 2026-10-30 to Thu 2026-11-05 and carries 30 Oct, 2 Nov
// and 5 Nov. The stored XJO rows around it are:
//
//	kept, before the window:     29 Oct (Thu)
//	kept, in the response:       30 Oct (Fri), 2 Nov (Mon), 5 Nov (Thu)
//	removed, weekend in window:  31 Oct (Sat), 1 Nov (Sun)
//	removed, not in response:    3 Nov (Tue), 4 Nov (Wed): a holiday the response lacks
//	kept, after the window:      6 Nov (Fri), 7 Nov (Sat)
//
// XAO has rows in the same dates, which must all survive a clean-up of XJO.
var windowSeed = []string{
	"XJO 2026-10-29 1",
	"XJO 2026-10-30 1",
	"XJO 2026-10-31 1",
	"XJO 2026-11-01 1",
	"XJO 2026-11-02 1",
	"XJO 2026-11-03 1",
	"XJO 2026-11-04 1",
	"XJO 2026-11-05 1",
	"XJO 2026-11-06 1",
	"XJO 2026-11-07 1",
	"XAO 2026-10-31 1",
	"XAO 2026-11-01 1",
	"XAO 2026-11-03 1",
}

// Rows outside the fetched window survive, weekend and holiday rows inside it go,
// the response's own rows are written, and another series is never touched.
func TestIndexSyncPGReplaceKeepsRowsOutsideTheWindow(t *testing.T) {
	pool := indexSyncTestDB(t)
	ctx := context.Background()
	seedIndexRows(t, pool, windowSeed...)
	bars := barsOn(t, "2026-10-30", "2026-11-02", "2026-11-05")
	bars[2].Close = ptrFloat(555) // 5 Nov is re-fetched with a new close

	written, removed, err := replaceIndexBars(ctx, pool, "XJO", bars)
	require.NoError(t, err)
	require.Equal(t, int64(3), written)
	require.Equal(t, int64(4), removed, "31 Oct, 1 Nov, 3 Nov and 4 Nov")

	require.Equal(t, []string{
		"2026-10-29", "2026-10-30", "2026-11-02", "2026-11-05", "2026-11-06", "2026-11-07",
	}, indexDates(t, pool, "XJO"))

	var close float64
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT close FROM index_prices WHERE index_code = 'XJO' AND date = '2026-11-05'`).Scan(&close))
	require.Equal(t, 555.0, close, "the response's value replaces the stored one")

	require.Equal(t, []string{"2026-10-31", "2026-11-01", "2026-11-03"}, indexDates(t, pool, "XAO"),
		"another series keeps every row")

	// A second run of the same response has nothing left to remove.
	_, removed, err = replaceIndexBars(ctx, pool, "XJO", bars)
	require.NoError(t, err)
	require.Equal(t, int64(0), removed)
}

// A response that carries no sessions writes and removes nothing.
func TestIndexSyncPGEmptyResponseDeletesNothing(t *testing.T) {
	pool := indexSyncTestDB(t)
	seedIndexRows(t, pool, windowSeed...)
	before := indexDates(t, pool, "XJO")

	written, removed, err := replaceIndexBars(context.Background(), pool, "XJO", nil)
	require.NoError(t, err)
	require.Equal(t, int64(0), written)
	require.Equal(t, int64(0), removed)
	require.Equal(t, before, indexDates(t, pool, "XJO"))
}

// The dry run counts what the write would remove, with the same bounds, and
// writes nothing: no row is removed and no value is updated.
func TestIndexSyncPGDryRunCountsAndWritesNothing(t *testing.T) {
	pool := indexSyncTestDB(t)
	ctx := context.Background()
	seedIndexRows(t, pool, windowSeed...)
	before := indexDates(t, pool, "XJO")
	bars := barsOn(t, "2026-10-30", "2026-11-02", "2026-11-05")

	would, err := countStaleIndexRows(ctx, pool, "XJO", bars)
	require.NoError(t, err)
	require.Equal(t, int64(4), would)
	require.Equal(t, before, indexDates(t, pool, "XJO"), "a dry run removes nothing")

	// The count agrees with the write it previews.
	_, removed, err := replaceIndexBars(ctx, pool, "XJO", bars)
	require.NoError(t, err)
	require.Equal(t, would, removed)
}

func ptrFloat(v float64) *float64 { return &v }
