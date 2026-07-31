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

// "Properties" counts DECLARED REAL-ESTATE ENTRIES (item 3), not the suburbs the
// resolver managed to place. Counting distinct sal_code published the resolver's
// hit rate as the member's holdings: members with 13-18 currently-declared
// entries read as 0, and the hub tile read 38 against 1,248 item-3 rows.
func TestRegisterPropertyCountsAreDeclaredEntriesNotResolvedSuburbs(t *testing.T) {
	pool, cleanup := openPoliticianExplorerIntegrationDB(t)
	defer cleanup()
	ctx := context.Background()

	var mismatched int
	if err := pool.QueryRow(ctx, `
		SELECT count(*)
		FROM mv_register_politician_rollup r
		WHERE r.property_count <> (
		    SELECT count(*)
		    FROM mv_register_public_holdings h
		    WHERE h.politician_id = r.politician_id
		      AND h.item_no = 3
		      AND h.currently_declared
		)`).Scan(&mismatched); err != nil {
		t.Fatalf("compare rollup property counts: %v", err)
	}
	if mismatched != 0 {
		t.Fatalf("%d rollup rows disagree with their currently-declared item-3 row count", mismatched)
	}

	// The discriminating case: a member whose item-3 rows resolved to NO suburb
	// at all. Under the sal_code measure they reported zero properties while
	// declaring several.
	var unresolvedDeclarers, declaredWithoutSuburb int
	if err := pool.QueryRow(ctx, `
		SELECT count(*),
		       COALESCE(sum(r.property_count), 0)::INTEGER
		FROM mv_register_politician_rollup r
		WHERE r.property_count > 0
		  AND NOT EXISTS (
		      SELECT 1
		      FROM mv_register_public_holdings h
		      WHERE h.politician_id = r.politician_id
		        AND h.item_no = 3
		        AND h.currently_declared
		        AND h.sal_code IS NOT NULL
		  )`).Scan(&unresolvedDeclarers, &declaredWithoutSuburb); err != nil {
		t.Fatalf("count unresolved property declarers: %v", err)
	}
	if unresolvedDeclarers == 0 {
		t.Skip("every item-3 row in this database resolved to a suburb; nothing to discriminate")
	}
	if declaredWithoutSuburb == 0 {
		t.Fatalf("%d members declare item-3 entries with no resolved suburb but report 0 properties",
			unresolvedDeclarers)
	}

	// The hub-wide tile must count the same thing the per-member column does.
	store := &postgresStore{db: pool}
	explorer, err := store.GetRegisterExplorer()
	if err != nil {
		t.Fatalf("GetRegisterExplorer: %v", err)
	}
	var hubItem3, distinctSuburbs int32
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE item_no = 3 AND currently_declared)::INTEGER,
		       count(DISTINCT sal_code) FILTER (WHERE currently_declared AND sal_code IS NOT NULL)::INTEGER
		FROM mv_register_public_holdings`).Scan(&hubItem3, &distinctSuburbs); err != nil {
		t.Fatalf("hub-wide item-3 count: %v", err)
	}
	if explorer.PropertyCount != hubItem3 {
		t.Fatalf("hub property count = %d, want the %d currently-declared item-3 rows", explorer.PropertyCount, hubItem3)
	}
	if distinctSuburbs < hubItem3 && explorer.PropertyCount == distinctSuburbs {
		t.Fatalf("hub property count fell back to the %d resolved suburbs", distinctSuburbs)
	}
}

// Industry movement must be dated-symmetric. ~80% of currently-declared rows are
// undated, so an undated-inclusive "now" against a dated-only "90 days ago"
// reported every industry as growing by its undated population — an artefact
// that `ORDER BY abs(...)` then ranked the list by.
func TestRegisterIndustryMovementIsDatedSymmetric(t *testing.T) {
	pool, cleanup := openPoliticianExplorerIntegrationDB(t)
	defer cleanup()
	ctx := context.Background()

	type movement struct{ current, ago int32 }
	reference := map[string]movement{}
	rows, err := pool.Query(ctx, `
		SELECT btrim(industry),
		       count(DISTINCT stock_code) FILTER (
		           WHERE declared_from_known
		             AND declared_from <= CURRENT_DATE
		             AND (declared_to IS NULL OR declared_to > CURRENT_DATE)
		       )::INTEGER,
		       count(DISTINCT stock_code) FILTER (
		           WHERE declared_from_known
		             AND declared_from <= CURRENT_DATE - 90
		             AND (declared_to IS NULL OR declared_to > CURRENT_DATE - 90)
		       )::INTEGER
		FROM mv_register_public_holdings
		WHERE stock_code IS NOT NULL AND industry IS NOT NULL AND btrim(industry) <> ''
		GROUP BY btrim(industry)`)
	if err != nil {
		t.Fatalf("reference industry movement: %v", err)
	}
	for rows.Next() {
		var industry string
		var m movement
		if err := rows.Scan(&industry, &m.current, &m.ago); err != nil {
			rows.Close()
			t.Fatalf("scan reference movement: %v", err)
		}
		reference[industry] = m
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("reference industry movement: %v", err)
	}
	if len(reference) == 0 {
		t.Skip("no resolved industries in this database")
	}

	store := &postgresStore{db: pool}
	explorer, err := store.GetRegisterExplorer()
	if err != nil {
		t.Fatalf("GetRegisterExplorer: %v", err)
	}

	quiet := 0
	for _, trend := range explorer.IndustryTrends {
		want, ok := reference[trend.Industry]
		if !ok {
			t.Errorf("industry %q is not in the dated-symmetric reference", trend.Industry)
			continue
		}
		if trend.CurrentCount != want.current || trend.Count90dAgo != want.ago {
			t.Errorf("industry %q movement = (%d, %d), want the dated-symmetric (%d, %d)",
				trend.Industry, trend.CurrentCount, trend.Count90dAgo, want.current, want.ago)
		}
		if trend.CurrentCount == trend.Count90dAgo {
			quiet++
		}
	}

	// An industry with no dated activity across the window reports NO movement.
	// This is the assertion the shipped query failed: Materials read 52-vs-27
	// when the dated truth was 27-vs-27.
	referenceQuiet := 0
	for _, m := range reference {
		if m.current == m.ago {
			referenceQuiet++
		}
	}
	if referenceQuiet == 0 {
		t.Skip("every industry in this database moved in the last 90 dated days")
	}
	if len(explorer.IndustryTrends) > 0 && quiet == 0 && referenceQuiet == len(reference) {
		t.Fatal("no industry moved in the dated window, yet every reported trend claims movement")
	}
}

// Politician.declared_listed_count / declared_property_count must not depend on
// which rpc served the row. Every other read path fills them from
// politicianSelect's ALL-TIME distinct counts; the explorer summary now reads
// the rollup columns that replicate that projection.
func TestPoliticianCountsAgreeAcrossReadPaths(t *testing.T) {
	pool, cleanup := openPoliticianExplorerIntegrationDB(t)
	defer cleanup()
	ctx := context.Background()
	store := &postgresStore{db: pool}

	// The rollup's all-time columns must equal politicianSelect's own subquery.
	var drifted int
	if err := pool.QueryRow(ctx, `
		SELECT count(*)
		FROM mv_register_politician_rollup r
		JOIN politicians p ON p.id = r.politician_id
		WHERE r.alltime_company_count <> (
		        SELECT count(DISTINCT stock_code) FILTER (WHERE stock_code IS NOT NULL)
		        FROM mv_register_public_holdings h WHERE h.politician_id = p.id)
		   OR r.alltime_suburb_count <> (
		        SELECT count(DISTINCT sal_code) FILTER (WHERE sal_code IS NOT NULL)
		        FROM mv_register_public_holdings h WHERE h.politician_id = p.id)`).Scan(&drifted); err != nil {
		t.Fatalf("compare rollup all-time counts: %v", err)
	}
	if drifted != 0 {
		t.Fatalf("%d rollup rows drifted from politicianSelect's all-time counts", drifted)
	}

	// Sample the members where current and all-time genuinely differ — those are
	// the rows that diverged between the two rpcs.
	slugRows, err := pool.Query(ctx, `
		SELECT slug
		FROM mv_register_politician_rollup
		WHERE alltime_company_count <> distinct_company_count
		ORDER BY (alltime_company_count - distinct_company_count) DESC, slug
		LIMIT 5`)
	if err != nil {
		t.Fatalf("choose divergent politicians: %v", err)
	}
	var slugs []string
	for slugRows.Next() {
		var slug string
		if err := slugRows.Scan(&slug); err != nil {
			slugRows.Close()
			t.Fatalf("scan divergent slug: %v", err)
		}
		slugs = append(slugs, slug)
	}
	slugRows.Close()
	if len(slugs) == 0 {
		t.Skip("no member in this database has retired holdings, so the paths cannot diverge")
	}

	for _, slug := range slugs {
		canonical, _, _, err := store.GetPolitician(slug)
		if err != nil {
			t.Fatalf("GetPolitician(%q): %v", slug, err)
		}
		profile, err := store.GetPoliticianExplorerProfile(slug, 5)
		if err != nil {
			t.Fatalf("GetPoliticianExplorerProfile(%q): %v", slug, err)
		}
		if profile.Politician.DeclaredListedCount != canonical.DeclaredListedCount {
			t.Errorf("%s declared_listed_count = %d via the explorer, %d via GetPolitician",
				slug, profile.Politician.DeclaredListedCount, canonical.DeclaredListedCount)
		}
		if profile.Politician.DeclaredPropertyCount != canonical.DeclaredPropertyCount {
			t.Errorf("%s declared_property_count = %d via the explorer, %d via GetPolitician",
				slug, profile.Politician.DeclaredPropertyCount, canonical.DeclaredPropertyCount)
		}

		// The currently-declared figures are still carried, on the summary's own
		// fields, and are genuinely different numbers for these members.
		summaries, _, err := store.ListPoliticianSummaries("", "", "", 0, canonical.DisplayName, "name", 50, 0)
		if err != nil {
			t.Fatalf("ListPoliticianSummaries(%q): %v", canonical.DisplayName, err)
		}
		for _, summary := range summaries {
			if summary.Politician.Slug != slug {
				continue
			}
			if summary.Politician.DeclaredListedCount != canonical.DeclaredListedCount {
				t.Errorf("%s declared_listed_count = %d via ListPoliticianSummaries, %d via GetPolitician",
					slug, summary.Politician.DeclaredListedCount, canonical.DeclaredListedCount)
			}
			if summary.DistinctCompanyCount > summary.Politician.DeclaredListedCount {
				t.Errorf("%s currently-declared companies (%d) exceed the all-time count (%d)",
					slug, summary.DistinctCompanyCount, summary.Politician.DeclaredListedCount)
			}
		}
	}
}

// The 12-month sparkline window is anchored on the snapshot's own newest month.
// A CURRENT_DATE window silently shortens as the MV ages and eventually returns
// nothing while the count tiles beside it keep rendering.
func TestSummaryTrendWindowIsAnchoredOnTheSnapshot(t *testing.T) {
	pool, cleanup := openPoliticianExplorerIntegrationDB(t)
	defer cleanup()
	ctx := context.Background()
	store := &postgresStore{db: pool}

	var latestMonth string
	var monthCount int32
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(to_char(max(month), 'YYYY-MM'), ''), count(DISTINCT month)::INTEGER
		FROM mv_register_politician_monthly`).Scan(&latestMonth, &monthCount); err != nil {
		t.Fatalf("read monthly snapshot bounds: %v", err)
	}
	if latestMonth == "" {
		t.Skip("monthly snapshot is empty")
	}

	var slug string
	if err := pool.QueryRow(ctx, `
		SELECT p.slug
		FROM mv_register_politician_monthly m
		JOIN politicians p ON p.id = m.politician_id
		GROUP BY p.slug
		HAVING max(m.declared_count) > 0
		ORDER BY max(m.declared_count) DESC, p.slug
		LIMIT 1`).Scan(&slug); err != nil {
		t.Skipf("no politician with a dated timeline: %v", err)
	}

	summary := &PoliticianSummaryRow{Politician: &PoliticianRow{Slug: slug}}
	if err := store.loadSummaryTrends(ctx, []*PoliticianSummaryRow{summary}, []string{slug}, 12); err != nil {
		t.Fatalf("loadSummaryTrends: %v", err)
	}
	want := int(monthCount)
	if want > 12 {
		want = 12
	}
	if len(summary.Trend) != want {
		t.Fatalf("trend points = %d, want %d", len(summary.Trend), want)
	}
	if got := summary.Trend[len(summary.Trend)-1].Month; got != latestMonth {
		t.Fatalf("newest trend point = %s, want the snapshot's own newest month %s", got, latestMonth)
	}

	// Run the production SQL against a snapshot aged by 30 months. Anchored on
	// max(month) it still yields a full window; the old CURRENT_DATE anchor
	// returned nothing at all.
	const aged = `(SELECT politician_id, (month - INTERVAL '30 months')::DATE AS month, declared_count
	                FROM mv_register_politician_monthly)`
	agedRows, err := pool.Query(ctx, summaryTrendQuery(aged), []string{slug}, int32(12))
	if err != nil {
		t.Fatalf("aged snapshot query: %v", err)
	}
	agedPoints := 0
	for agedRows.Next() {
		agedPoints++
	}
	agedRows.Close()
	if err := agedRows.Err(); err != nil {
		t.Fatalf("aged snapshot query: %v", err)
	}
	if agedPoints != want {
		t.Fatalf("aged snapshot yielded %d trend points, want %d — the window is still wall-clock anchored", agedPoints, want)
	}

	var wallClockPoints int32
	if err := pool.QueryRow(ctx, `
		SELECT count(*)::INTEGER
		FROM (`+aged+`) m
		JOIN politicians p ON p.id = m.politician_id
		WHERE p.slug = $1
		  AND m.month >= (date_trunc('month', CURRENT_DATE) - INTERVAL '11 months')::DATE`, slug).Scan(&wallClockPoints); err != nil {
		t.Fatalf("wall-clock control query: %v", err)
	}
	if wallClockPoints != 0 {
		t.Fatalf("control: a wall-clock window over a 30-month-old snapshot returned %d points, expected 0", wallClockPoints)
	}
}
