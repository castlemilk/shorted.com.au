package keymetrics

// Real-Postgres tests for the key-metrics write: one UPDATE per stock stamps the
// row, a good record replaces the old one, an error leaves the old row exactly as
// it was, and the universe comes back stalest first. They need a disposable
// server: a URL in KEY_METRICS_TEST_DATABASE_URL, or a container when
// KEY_METRICS_TESTCONTAINERS=1 with the testcontainers tag. Without either, the
// tests skip. make test-keymetrics-pg runs them.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// TestMain removes the container the suite starts under KEY_METRICS_TESTCONTAINERS=1.
func TestMain(m *testing.M) {
	os.Exit(testpostgres.Main(m))
}

// companyMetadataShape is the columns the job reads and writes, with the
// production types (key_metrics JSONB, key_metrics_updated_at timestamptz).
const companyMetadataShape = `
CREATE TABLE "company-metadata" (
    stock_code              VARCHAR(50) PRIMARY KEY,
    company_name            TEXT,
    key_metrics             JSONB,
    key_metrics_updated_at  TIMESTAMP WITH TIME ZONE
)`

func keyMetricsTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn, err := testpostgres.Admin("KEY_METRICS_TEST_DATABASE_URL", "KEY_METRICS_TESTCONTAINERS")
	require.NoError(t, err)
	if dsn == "" {
		t.Skip("set KEY_METRICS_TEST_DATABASE_URL, or KEY_METRICS_TESTCONTAINERS=1 with -tags=testcontainers")
	}
	ctx := context.Background()
	name := fmt.Sprintf("keymetrics_%d_%d", time.Now().UnixNano()%1e9, rand.Intn(1e6))

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
	// The production pool runs simple protocol, so the statements here must too.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	_, err = pool.Exec(ctx, companyMetadataShape)
	require.NoError(t, err)
	return pool
}

// seedStock inserts a stock with an old key_metrics value the tests can check
// was replaced or kept.
func seedStock(t *testing.T, pool *pgxpool.Pool, code string, updated *time.Time) {
	t.Helper()
	_, err := pool.Exec(context.Background(),
		`INSERT INTO "company-metadata" (stock_code, company_name, key_metrics, key_metrics_updated_at)
		 VALUES ($1, $1, '{"market_cap": 1, "stock_code": "OLD", "legacy_only": 9}'::jsonb, $2)`, code, updated)
	require.NoError(t, err)
}

func readRow(t *testing.T, pool *pgxpool.Pool, code string) (map[string]any, *time.Time) {
	t.Helper()
	var raw []byte
	var updated *time.Time
	err := pool.QueryRow(context.Background(),
		`SELECT key_metrics::text, key_metrics_updated_at FROM "company-metadata" WHERE stock_code = $1`, code).Scan(&raw, &updated)
	require.NoError(t, err)
	var m map[string]any
	require.NoError(t, json.Unmarshal(raw, &m))
	return m, updated
}

func TestKeyMetricsPGGoodRecordReplacesTheRow(t *testing.T) {
	pool := keyMetricsTestDB(t)
	seedStock(t, pool, "BHP", nil)
	st := &pgStore{pool: pool}

	metrics := map[string]any{"stock_code": "BHP", "market_cap": 290439987200.0, "pe_ratio": nil, "beta": 0.885}
	require.NoError(t, st.WriteKeyMetrics(context.Background(), "BHP", metrics))

	got, updated := readRow(t, pool, "BHP")
	require.NotNil(t, updated, "key_metrics_updated_at must be stamped")
	require.WithinDuration(t, time.Now(), *updated, time.Minute)
	require.Equal(t, "BHP", got["stock_code"], "the old row's values must be replaced")
	require.Equal(t, 0.885, got["beta"])
	require.Contains(t, got, "pe_ratio")
	require.Nil(t, got["pe_ratio"], "a null measurement is stored as JSON null, as the Python script wrote it")
	require.NotContains(t, got, "legacy_only", "no key survives from the old object")
}

func TestKeyMetricsPGNonFiniteValuesAreDroppedNotStored(t *testing.T) {
	pool := keyMetricsTestDB(t)
	seedStock(t, pool, "CBA", nil)
	st := &pgStore{pool: pool}

	require.NoError(t, st.WriteKeyMetrics(context.Background(), "CBA", map[string]any{
		"stock_code": "CBA", "beta": math.Inf(1), "eps": math.NaN(), "avg_volume": 2.0,
	}))
	got, _ := readRow(t, pool, "CBA")
	require.NotContains(t, got, "beta", "+Inf must be dropped before JSONB")
	require.NotContains(t, got, "eps", "NaN must be dropped before JSONB")
	require.Equal(t, 2.0, got["avg_volume"])
}

func TestKeyMetricsPGAnErrorLeavesTheOldRowUntouched(t *testing.T) {
	pool := keyMetricsTestDB(t)
	when := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	seedStock(t, pool, "BAD", &when)
	seedStock(t, pool, "GOOD", nil)

	// A database-side refusal on one stock: the statement fails, the row keeps its
	// old key_metrics and its old timestamp.
	_, err := pool.Exec(context.Background(), `
		CREATE FUNCTION refuse_bad() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF NEW.stock_code = 'BAD' THEN
				RAISE EXCEPTION 'refused by test trigger';
			END IF;
			RETURN NEW;
		END $$;
		CREATE TRIGGER refuse_bad BEFORE UPDATE ON "company-metadata"
		FOR EACH ROW EXECUTE FUNCTION refuse_bad();`)
	require.NoError(t, err)

	st := &pgStore{pool: pool}
	err = st.WriteKeyMetrics(context.Background(), "BAD", map[string]any{"stock_code": "BAD", "beta": 1.1})
	require.Error(t, err)

	got, updated := readRow(t, pool, "BAD")
	require.Equal(t, "OLD", got["stock_code"], "a failed write must not change key_metrics")
	require.NotNil(t, updated)
	require.True(t, updated.Equal(when), "a failed write must not move key_metrics_updated_at")

	// The next stock still writes: the failure does not poison the pool.
	require.NoError(t, st.WriteKeyMetrics(context.Background(), "GOOD", map[string]any{"stock_code": "GOOD", "beta": 0.5}))
	good, _ := readRow(t, pool, "GOOD")
	require.Equal(t, "GOOD", good["stock_code"])
}

func TestKeyMetricsPGUnknownStockIsAnError(t *testing.T) {
	pool := keyMetricsTestDB(t)
	err := (&pgStore{pool: pool}).WriteKeyMetrics(context.Background(), "NOPE", map[string]any{"stock_code": "NOPE"})
	require.ErrorContains(t, err, "stock not found")
}

func TestKeyMetricsPGUniverseIsStalestFirst(t *testing.T) {
	pool := keyMetricsTestDB(t)
	recent := time.Now().Add(-time.Hour)
	older := time.Now().Add(-72 * time.Hour)
	seedStock(t, pool, "RECENT", &recent)
	seedStock(t, pool, "OLDER", &older)
	seedStock(t, pool, "NEVER", nil)

	universe, err := (&pgStore{pool: pool}).Universe(context.Background())
	require.NoError(t, err)
	var codes []string
	for _, s := range universe {
		codes = append(codes, s.Code)
	}
	require.Equal(t, []string{"NEVER", "OLDER", "RECENT"}, codes)
}
