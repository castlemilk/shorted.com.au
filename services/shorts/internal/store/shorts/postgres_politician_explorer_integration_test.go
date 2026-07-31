//go:build integration

package shorts

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// This integration check deliberately uses an existing database only. It never
// starts a container: the migration and the production MV refresh are what this
// test is intended to smoke.
func openPoliticianExplorerIntegrationDB(t *testing.T) (*pgxpool.Pool, func()) {
	t.Helper()
	dsn := os.Getenv("SHORTS_TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		dsn = "postgresql://admin:password@localhost:5438/shorts"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Skipf("politician explorer integration database is unavailable: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Skipf("politician explorer integration database is unavailable: %v", err)
	}
	return pool, pool.Close
}

func TestPoliticianExplorerStoreIntegration(t *testing.T) {
	pool, cleanup := openPoliticianExplorerIntegrationDB(t)
	defer cleanup()
	ctx := context.Background()

	var rollupExists, monthlyExists bool
	if err := pool.QueryRow(ctx, `
		SELECT to_regclass('mv_register_politician_rollup') IS NOT NULL,
		       to_regclass('mv_register_politician_monthly') IS NOT NULL`).Scan(&rollupExists, &monthlyExists); err != nil {
		t.Fatalf("check explorer materialized views: %v", err)
	}
	if !rollupExists || !monthlyExists {
		t.Fatalf("000104 materialized views are missing: rollup=%v monthly=%v", rollupExists, monthlyExists)
	}

	store := &postgresStore{db: pool}
	overview, err := store.GetRegisterExplorer()
	if err != nil {
		t.Fatalf("GetRegisterExplorer: %v", err)
	}
	if len(overview.HolderCounts) != 4 {
		t.Fatalf("holder counts = %d, want the four holder buckets", len(overview.HolderCounts))
	}

	summaries, total, err := store.ListPoliticianSummaries("", "", "", 0, "", "declared_items", 10, 0)
	if err != nil {
		t.Fatalf("ListPoliticianSummaries: %v", err)
	}
	if int32(len(summaries)) > total {
		t.Fatalf("summary page length %d exceeds total %d", len(summaries), total)
	}
	for _, summary := range summaries {
		if len(summary.ItemCounts) != 14 {
			t.Errorf("%s item counts = %d, want 14", summary.Politician.Slug, len(summary.ItemCounts))
		}
		if len(summary.Trend) > 12 {
			t.Errorf("%s trend points = %d, want at most 12", summary.Politician.Slug, len(summary.Trend))
		}
	}

	var slugA, slugB string
	if err := pool.QueryRow(ctx, `
		SELECT min(slug), max(slug)
		FROM (
			SELECT slug
			FROM politicians
			WHERE merged_into_id IS NULL
			  AND EXISTS (SELECT 1 FROM mv_register_politician_rollup r WHERE r.slug = politicians.slug)
			ORDER BY slug
			LIMIT 2
		) candidates`).Scan(&slugA, &slugB); err != nil {
		t.Fatalf("choose explorer politicians: %v", err)
	}
	if slugA == "" {
		t.Skip("database has no live politician rows to profile")
	}

	profile, err := store.GetPoliticianExplorerProfile(slugA, 5)
	if err != nil {
		t.Fatalf("GetPoliticianExplorerProfile(%q): %v", slugA, err)
	}
	if len(profile.ItemCounts) != 14 {
		t.Errorf("profile item counts = %d, want 14", len(profile.ItemCounts))
	}
	if len(profile.Timeline) > 60 {
		t.Errorf("profile timeline points = %d, want at most 60", len(profile.Timeline))
	}
	if len(profile.RecentChanges) > 10 {
		t.Errorf("profile recent changes = %d, want at most 10", len(profile.RecentChanges))
	}

	if slugB == "" || slugA == slugB {
		t.Skip("database has only one live politician row to compare")
	}
	comparison, err := store.ComparePoliticians(slugA, slugB)
	if err != nil {
		t.Fatalf("ComparePoliticians(%q, %q): %v", slugA, slugB, err)
	}
	if len(comparison.OnlyCompaniesA) > 20 || len(comparison.OnlyCompaniesB) > 20 {
		t.Fatalf("only-company caps exceeded: a=%d b=%d", len(comparison.OnlyCompaniesA), len(comparison.OnlyCompaniesB))
	}
}
