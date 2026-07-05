//go:build integration

package shorts

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetShortCampaignScoreboard_IntegrationUsesMaterializedViewAndOutcomeFlags(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	pool, cleanup := setupTestDatabase(t)
	defer cleanup()

	ctx := context.Background()
	setupShortCampaignScoreboardFixtures(t, pool)

	migrationSQL, err := os.ReadFile("../../../../migrations/000070_add_short_campaigns_mv.up.sql")
	require.NoError(t, err)
	_, err = pool.Exec(ctx, string(migrationSQL))
	require.NoError(t, err)

	store := &postgresStore{db: pool}
	campaigns, total, stats, err := store.GetShortCampaignScoreboard("", 10, 0)
	require.NoError(t, err)

	require.Len(t, campaigns, 2)
	assert.Equal(t, 2, total)
	assert.Equal(t, 2, stats.CampaignsTotal)
	assert.InDelta(t, 100.0, stats.ShortsWinRate3m, 0.01)
	assert.InDelta(t, 0.0, stats.ShortsWinRate6m, 0.01)

	older := campaigns[0]
	assert.Equal(t, "AAA", older.StockCode)
	assert.Equal(t, "Alpha Materials Limited", older.CompanyName)
	assert.Equal(t, "Materials", older.Industry)
	assert.Equal(t, "https://example.com/aaa.png", older.LogoURL)
	assert.InDelta(t, 12.0, older.PeakShortPct, 0.001)
	assert.True(t, older.Has3m)
	assert.True(t, older.Has6m)
	assert.True(t, older.ShortsWon3m)
	assert.False(t, older.ShortsWon6m)
	assert.InDelta(t, 10.0, older.PriceAtPeak, 0.001)
	assert.InDelta(t, 8.0, older.Price3mAfter, 0.001)
	assert.InDelta(t, 13.0, older.Price6mAfter, 0.001)
	assert.InDelta(t, -20.0, older.Return3m, 0.001)
	assert.InDelta(t, 30.0, older.Return6m, 0.001)
	assert.InDelta(t, 6.0, older.CurrentShortPct, 0.001)
	assert.InDelta(t, 13.5, older.LatestPrice, 0.001)

	recent := campaigns[1]
	assert.Equal(t, "BBB", recent.StockCode)
	assert.Equal(t, "Beta Technology Limited", recent.CompanyName)
	assert.Equal(t, "Technology", recent.Industry)
	assert.InDelta(t, 8.0, recent.PeakShortPct, 0.001)
	assert.False(t, recent.Has3m)
	assert.False(t, recent.Has6m)
	assert.False(t, recent.ShortsWon3m)
	assert.False(t, recent.ShortsWon6m)
	assert.Equal(t, 0.0, recent.Price3mAfter)
	assert.Equal(t, 0.0, recent.Return3m)

	filtered, filteredTotal, filteredStats, err := store.GetShortCampaignScoreboard("Materials", 10, 0)
	require.NoError(t, err)
	require.Len(t, filtered, 1)
	assert.Equal(t, "AAA", filtered[0].StockCode)
	assert.Equal(t, 1, filteredTotal)
	assert.Equal(t, 1, filteredStats.CampaignsTotal)
	assert.InDelta(t, 100.0, filteredStats.ShortsWinRate3m, 0.01)
	assert.InDelta(t, 0.0, filteredStats.ShortsWinRate6m, 0.01)
}

func setupShortCampaignScoreboardFixtures(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()

	ctx := context.Background()
	_, err := pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS stock_prices (
			stock_code TEXT NOT NULL,
			date DATE NOT NULL,
			close NUMERIC NOT NULL,
			PRIMARY KEY (stock_code, date)
		);

		CREATE TABLE IF NOT EXISTS "company-metadata" (
			stock_code TEXT PRIMARY KEY,
			company_name TEXT,
			industry TEXT,
			logo_gcs_url TEXT
		);
	`)
	require.NoError(t, err)

	now := time.Now().UTC()
	olderPeak := now.AddDate(0, -9, 0)
	recentPeak := now.AddDate(0, -2, 0)

	_, err = pool.Exec(ctx, `
		INSERT INTO "company-metadata" (stock_code, company_name, industry, logo_gcs_url)
		VALUES
			('AAA', 'Alpha Materials Limited', 'Materials', 'https://example.com/aaa.png'),
			('BBB', 'Beta Technology Limited', 'Technology', 'https://example.com/bbb.png')
		ON CONFLICT (stock_code) DO UPDATE SET
			company_name = EXCLUDED.company_name,
			industry = EXCLUDED.industry,
			logo_gcs_url = EXCLUDED.logo_gcs_url;
	`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO shorts (
			"PRODUCT_CODE",
			"PRODUCT",
			"DATE",
			"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
		) VALUES
			('AAA', 'ALPHA MATERIALS LIMITED', $1, 12.0),
			('AAA', 'ALPHA MATERIALS LIMITED', $2, 6.0),
			('BBB', 'BETA TECHNOLOGY LIMITED', $3, 8.0),
			('BBB', 'BETA TECHNOLOGY LIMITED', $2, 7.0)
		ON CONFLICT ("PRODUCT_CODE", "DATE") DO UPDATE SET
			"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" =
				EXCLUDED."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS";
	`, olderPeak, now, recentPeak)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO stock_prices (stock_code, date, close)
		VALUES
			('AAA', $1, 10.0),
			('AAA', $4, 8.0),
			('AAA', $5, 13.0),
			('AAA', $2, 13.5),
			('BBB', $3, 20.0),
			('BBB', $2, 21.0)
		ON CONFLICT (stock_code, date) DO UPDATE SET
			close = EXCLUDED.close;
	`, olderPeak, now, recentPeak, olderPeak.AddDate(0, 3, 1), olderPeak.AddDate(0, 6, 1))
	require.NoError(t, err)
}
