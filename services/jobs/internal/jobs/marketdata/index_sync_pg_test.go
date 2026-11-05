package marketdata

// Real-Postgres test for the weekend clean-up the index sync runs after each
// series is written. It needs a disposable server: a URL in
// INDEXSYNC_TEST_DATABASE_URL, or a container when INDEXSYNC_TESTCONTAINERS=1
// with the testcontainers tag. Without either, the test skips.
//
//	cd services/jobs && INDEXSYNC_TESTCONTAINERS=1 GOWORK=off CGO_ENABLED=0 \
//	    go test -tags=testcontainers -count=1 -run WeekendIndexBars ./internal/jobs/marketdata/

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// TestMain removes the container the suite starts under INDEXSYNC_TESTCONTAINERS=1.
// It starts nothing itself.
func TestMain(m *testing.M) {
	os.Exit(testpostgres.Main(m))
}

// indexPricesTable carries the columns the upsert and the clean-up touch, with
// the production primary key, so the statements run against the same shape.
const indexPricesTable = `
CREATE TABLE index_prices (
	index_code text NOT NULL,
	date date NOT NULL,
	open numeric, high numeric, low numeric, close numeric,
	volume bigint,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (index_code, date)
)`

func weekendTestDB(t *testing.T) *pgxpool.Pool {
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
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	_, err = pool.Exec(ctx, indexPricesTable)
	require.NoError(t, err)
	return pool
}

// The clean-up removes the weekend rows of the one series it is asked about and
// keeps every weekday row, including the Monday that the old dating had filed
// under its Sunday.
func TestDeleteWeekendIndexBarsRemovesOnlyWeekendRowsOfOneSeries(t *testing.T) {
	pool := weekendTestDB(t)
	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		INSERT INTO index_prices (index_code, date, close) VALUES
		 ('XJO', '2026-10-31', 8800), -- Saturday
		 ('XJO', '2026-11-01', 8886.8), -- Sunday: Monday's close under the old dating
		 ('XJO', '2026-11-02', 8886.8), -- Monday
		 ('XJO', '2026-11-03', 8900),   -- Tuesday
		 ('XAO', '2026-11-01', 9000)    -- another series' weekend row is not this series' to delete`)
	require.NoError(t, err)

	removed, err := deleteWeekendIndexBars(ctx, pool, "XJO")
	require.NoError(t, err)
	require.Equal(t, int64(2), removed)

	var n int
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FROM index_prices WHERE index_code = 'XJO'`).Scan(&n))
	require.Equal(t, 2, n, "Monday and Tuesday must remain")

	require.NoError(t, pool.QueryRow(ctx,
		`SELECT count(*) FROM index_prices WHERE index_code = 'XAO' AND date = '2026-11-01'`).Scan(&n))
	require.Equal(t, 1, n, "a different series keeps its row")

	// A second run finds nothing left to remove.
	removed, err = deleteWeekendIndexBars(ctx, pool, "XJO")
	require.NoError(t, err)
	require.Equal(t, int64(0), removed)
}
