//go:build integration

package shorts

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

// setupHousingTestDatabase spins up Postgres with the house-price schema + MV
// and seeds a mix of public (CC-BY-4.0) and proprietary (ToS-restricted) rows
// across two states so we can assert both the licence gate and the state filter.
func setupHousingTestDatabase(t *testing.T) (*pgxpool.Pool, func()) {
	t.Helper()
	ctx := context.Background()
	if adminURL := os.Getenv("SHORTS_TEST_POSTGRES_URL"); adminURL != "" {
		return setupHousingTestDatabaseFromServer(t, ctx, adminURL)
	}

	pgc, err := postgres.Run(ctx,
		"postgres:14-alpine",
		postgres.WithDatabase("housing_test"),
		postgres.WithUsername("test_user"),
		postgres.WithPassword("test_password"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(60*time.Second)),
	)
	checkDockerError(t, err)
	require.NoError(t, err, "Failed to start PostgreSQL container")

	connStr, err := pgc.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)

	pool, err := pgxpool.New(ctx, connStr)
	require.NoError(t, err)

	setupHousingSchema(t, pool)
	loadHousingTestData(t, pool)

	cleanup := func() {
		pool.Close()
		if err := pgc.Terminate(ctx); err != nil {
			t.Logf("Failed to terminate container: %v", err)
		}
	}
	return pool, cleanup
}

func setupHousingTestDatabaseFromServer(t *testing.T, ctx context.Context, adminURL string) (*pgxpool.Pool, func()) {
	t.Helper()
	admin, err := pgx.Connect(ctx, adminURL)
	require.NoError(t, err, "connect to integration PostgreSQL server")

	databaseName := fmt.Sprintf("housing_test_%d", time.Now().UnixNano())
	_, err = admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{databaseName}.Sanitize())
	require.NoError(t, err, "create isolated housing integration database")

	config, err := pgxpool.ParseConfig(adminURL)
	require.NoError(t, err)
	config.ConnConfig.Database = databaseName
	pool, err := pgxpool.NewWithConfig(ctx, config)
	require.NoError(t, err)

	setupHousingSchema(t, pool)
	loadHousingTestData(t, pool)

	cleanup := func() {
		pool.Close()
		_, dropErr := admin.Exec(ctx, "DROP DATABASE "+pgx.Identifier{databaseName}.Sanitize()+" WITH (FORCE)")
		if dropErr != nil {
			t.Logf("Failed to drop integration database: %v", dropErr)
		}
		admin.Close(ctx)
	}
	return pool, cleanup
}

func setupHousingSchema(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()

	// Mirrors services/migrations/000053 + 000054 (the licence-gated MV).
	const schema = `
	CREATE TABLE IF NOT EXISTS house_price_regions (
		region_code TEXT PRIMARY KEY,
		region_type TEXT NOT NULL,
		region_name TEXT NOT NULL,
		state_code  TEXT,
		postcode    TEXT
	);

	CREATE TABLE IF NOT EXISTS house_prices (
		id             BIGSERIAL PRIMARY KEY,
		region_code    TEXT NOT NULL REFERENCES house_price_regions(region_code),
		measure        TEXT NOT NULL,
		dwelling_type  TEXT NOT NULL DEFAULT 'all',
		period         DATE NOT NULL,
		period_freq    TEXT NOT NULL DEFAULT 'Q',
		value          DOUBLE PRECISION NOT NULL,
		unit           TEXT,
		is_preliminary BOOLEAN NOT NULL DEFAULT false,
		source         TEXT NOT NULL,
		source_licence TEXT NOT NULL DEFAULT 'CC-BY-4.0',
		content_hash   TEXT NOT NULL,
		fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
		UNIQUE (region_code, measure, dwelling_type, period, source)
	);

	-- 000054: MV excludes proprietary-tos-restricted rows.
	CREATE MATERIALIZED VIEW IF NOT EXISTS mv_housing_headline AS
	WITH ranked AS (
		SELECT
			region_code, measure, dwelling_type, period, value, unit, is_preliminary,
			value - LAG(value, 1) OVER w AS qoq_abs,
			(value / NULLIF(LAG(value, 1) OVER w, 0) - 1) * 100 AS qoq_pct,
			value - LAG(value, 4) OVER w AS yoy_abs,
			(value / NULLIF(LAG(value, 4) OVER w, 0) - 1) * 100 AS yoy_pct,
			ROW_NUMBER() OVER (
				PARTITION BY region_code, measure, dwelling_type ORDER BY period DESC
			) AS rn
		FROM house_prices
		WHERE period_freq = 'Q'
		  AND source_licence <> 'proprietary-tos-restricted'
		WINDOW w AS (PARTITION BY region_code, measure, dwelling_type ORDER BY period)
	)
	SELECT region_code, measure, dwelling_type, period, value, unit, is_preliminary,
		   qoq_abs, qoq_pct, yoy_abs, yoy_pct
	FROM ranked
	WHERE rn = 1;
	`
	_, err := pool.Exec(ctx, schema)
	require.NoError(t, err, "failed to create housing schema")
}

func loadHousingTestData(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()

	const regions = `
	INSERT INTO house_price_regions (region_code, region_type, region_name, state_code) VALUES
		('SUBURB:VIC-RICHMOND', 'suburb', 'RICHMOND', 'VIC'),
		('SUBURB:SA-NORWOOD',   'suburb', 'NORWOOD',  'SA'),
		('SUBURB:VIC-CROWNLAND','suburb', 'CROWNLAND','VIC')`
	_, err := pool.Exec(ctx, regions)
	require.NoError(t, err)

	// One public + one proprietary observation per public region, plus a region
	// (CROWNLAND) whose ONLY data is proprietary — it must never be listed.
	const facts = `
	INSERT INTO house_prices
		(region_code, measure, dwelling_type, period, period_freq, value, unit, source, source_licence, content_hash) VALUES
		-- RICHMOND (VIC): public + proprietary
		('SUBURB:VIC-RICHMOND','median_price','house','2024-03-31','Q', 1200000, 'AUD', 'vg_vic',      'CC-BY-4.0',                 'h1'),
		('SUBURB:VIC-RICHMOND','median_price','house','2024-06-30','Q', 1250000, 'AUD', 'vg_vic',      'CC-BY-4.0',                 'h2'),
		('SUBURB:VIC-RICHMOND','median_price','house','2024-06-30','Q', 9999999, 'AUD', 'crawl_domain','proprietary-tos-restricted','h3'),
		-- NORWOOD (SA): public + proprietary
		('SUBURB:SA-NORWOOD','median_price','house','2024-03-31','Q', 900000, 'AUD', 'vg_sa',       'CC-BY',                     'h4'),
		('SUBURB:SA-NORWOOD','median_price','house','2024-06-30','Q', 950000, 'AUD', 'vg_sa',       'CC-BY',                     'h5'),
		('SUBURB:SA-NORWOOD','median_price','house','2024-06-30','Q', 8888888,'AUD', 'crawl_rea',   'proprietary-tos-restricted','h6'),
		-- CROWNLAND (VIC): proprietary ONLY
		('SUBURB:VIC-CROWNLAND','median_price','house','2024-06-30','Q', 7777777,'AUD','crawl_domain','proprietary-tos-restricted','h7')`
	_, err = pool.Exec(ctx, facts)
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `REFRESH MATERIALIZED VIEW mv_housing_headline`)
	require.NoError(t, err)
}

// TestHousingLicenceGate_Overview asserts GetHousingOverview (which reads the
// 000054-gated MV) never surfaces proprietary-tos-restricted values.
func TestHousingLicenceGate_Overview(t *testing.T) {
	pool, cleanup := setupHousingTestDatabase(t)
	defer cleanup()
	s := &postgresStore{db: pool}

	rows, err := s.GetHousingOverview("suburb")
	require.NoError(t, err)
	require.NotEmpty(t, rows)

	for _, r := range rows {
		assert.NotEqual(t, 9999999.0, r.Value, "proprietary VIC value leaked into overview")
		assert.NotEqual(t, 8888888.0, r.Value, "proprietary SA value leaked into overview")
		assert.NotEqual(t, 7777777.0, r.Value, "proprietary-only region leaked into overview")
	}

	// The public latest (2024-06-30) values should be present.
	var richmond, norwood float64
	for _, r := range rows {
		switch r.RegionCode {
		case "SUBURB:VIC-RICHMOND":
			richmond = r.Value
		case "SUBURB:SA-NORWOOD":
			norwood = r.Value
		}
	}
	assert.InDelta(t, 1250000.0, richmond, 0.5, "expected public RICHMOND median")
	assert.InDelta(t, 950000.0, norwood, 0.5, "expected public NORWOOD median")
}

// TestHousingLicenceGate_Series asserts GetHousePriceSeries excludes the
// proprietary point while keeping the public points.
func TestHousingLicenceGate_Series(t *testing.T) {
	pool, cleanup := setupHousingTestDatabase(t)
	defer cleanup()
	s := &postgresStore{db: pool}

	res, err := s.GetHousePriceSeries("SUBURB:VIC-RICHMOND", "median_price", "house")
	require.NoError(t, err)
	require.NotNil(t, res)

	// Two public points (Mar + Jun), no proprietary 9,999,999 point.
	assert.Len(t, res.Points, 2, "expected only the 2 public points")
	for _, p := range res.Points {
		assert.NotEqual(t, 9999999.0, p.Value, "proprietary point leaked into series")
	}
}

// TestHousingLicenceGate_Regions asserts ListHousingRegions excludes a region
// whose only data is proprietary, and that listed regions report a public
// latest-median (not the proprietary value).
func TestHousingLicenceGate_Regions(t *testing.T) {
	pool, cleanup := setupHousingTestDatabase(t)
	defer cleanup()
	s := &postgresStore{db: pool}

	rows, err := s.GetHousingRegions("suburb", "", "", 0)
	require.NoError(t, err)

	codes := map[string]float64{}
	for _, r := range rows {
		codes[r.RegionCode] = r.LatestValue
	}
	assert.Contains(t, codes, "SUBURB:VIC-RICHMOND")
	assert.Contains(t, codes, "SUBURB:SA-NORWOOD")
	assert.NotContains(t, codes, "SUBURB:VIC-CROWNLAND", "proprietary-only region must not be listed")

	assert.InDelta(t, 1250000.0, codes["SUBURB:VIC-RICHMOND"], 0.5, "latest median must be public value")
	assert.InDelta(t, 950000.0, codes["SUBURB:SA-NORWOOD"], 0.5, "latest median must be public value")
}

// TestHousingRegions_StateFilter asserts a state_code filter returns only that
// state's regions (the /housing/suburbs state-filter bug).
func TestHousingRegions_StateFilter(t *testing.T) {
	pool, cleanup := setupHousingTestDatabase(t)
	defer cleanup()
	s := &postgresStore{db: pool}

	vic, err := s.GetHousingRegions("suburb", "VIC", "", 0)
	require.NoError(t, err)
	require.NotEmpty(t, vic)
	for _, r := range vic {
		assert.Equal(t, "VIC", r.StateCode, "VIC filter returned a non-VIC region: %s", r.RegionCode)
	}

	sa, err := s.GetHousingRegions("suburb", "SA", "", 0)
	require.NoError(t, err)
	require.NotEmpty(t, sa)
	for _, r := range sa {
		assert.Equal(t, "SA", r.StateCode, "SA filter returned a non-SA region: %s", r.RegionCode)
	}

	// VIC and SA must be disjoint, not "identical mixed results".
	assert.NotEqual(t, len(vic)+len(sa), 0)
	for _, v := range vic {
		for _, a := range sa {
			assert.NotEqual(t, v.RegionCode, a.RegionCode, "state filters overlap")
		}
	}
}
