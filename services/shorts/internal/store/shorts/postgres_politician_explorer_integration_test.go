//go:build integration

package shorts

import (
	"context"
	"database/sql"
	"fmt"
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

	// NULL-tolerant: min()/max() over no rows are NULL, and scanning that into a
	// plain string fails the query instead of reaching the skip three lines
	// below — so an empty database reported a test FAILURE rather than "nothing
	// to test here".
	var slugANull, slugBNull sql.NullString
	if err := pool.QueryRow(ctx, `
		SELECT min(slug), max(slug)
		FROM (
			SELECT slug
			FROM politicians
			WHERE merged_into_id IS NULL
			  AND EXISTS (SELECT 1 FROM mv_register_politician_rollup r WHERE r.slug = politicians.slug)
			ORDER BY slug
			LIMIT 2
		) candidates`).Scan(&slugANull, &slugBNull); err != nil {
		t.Fatalf("choose explorer politicians: %v", err)
	}
	slugA, slugB := slugANull.String, slugBNull.String
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

// mv_register_politician_rollup is a SNAPSHOT: a politician inserted (or
// un-merged) since the last refresh has no row in it. Under the INNER JOIN this
// query used to carry, that person vanished from the hub table and from its
// `total` altogether — a silent false-absence claim about a sitting member,
// which is worse than an honest row of zeros. They must appear with empty
// explorer figures until the next refresh fills them in.
func TestUnrefreshedPoliticianStillAppearsWithZeroCounts(t *testing.T) {
	pool, cleanup := openPoliticianExplorerIntegrationDB(t)
	defer cleanup()
	ctx := context.Background()
	store := &postgresStore{db: pool}

	const (
		slug      = "zz-explorer-unrefreshed-probe"
		name      = "Zzexplorer Unrefreshedprobe"
		personKey = "ZZEXPLORER|UNREFRESHEDPROBE"
	)
	// Insert WITHOUT refreshing the rollup: that is the whole scenario.
	if _, err := pool.Exec(ctx, `
		INSERT INTO politicians (person_key, surname, given_names, display_name, slug, first_parliament, last_parliament)
		VALUES ($1, 'Unrefreshedprobe', 'Zzexplorer', $2, $3, 48, 48)`,
		personKey, name, slug); err != nil {
		t.Fatalf("insert probe politician: %v", err)
	}
	defer func() {
		if _, err := pool.Exec(context.Background(), `DELETE FROM politicians WHERE slug = $1`, slug); err != nil {
			t.Errorf("clean up probe politician: %v", err)
		}
	}()

	var inRollup bool
	if err := pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM mv_register_politician_rollup WHERE slug = $1)`, slug).Scan(&inRollup); err != nil {
		t.Fatalf("check rollup membership: %v", err)
	}
	if inRollup {
		t.Skip("the rollup was refreshed under the test; the unrefreshed case cannot be exercised")
	}

	summaries, total, err := store.ListPoliticianSummaries("", "", "", 0, name, "name", 50, 0)
	if err != nil {
		t.Fatalf("ListPoliticianSummaries: %v", err)
	}
	if total < 1 {
		t.Fatalf("filtered total = %d, want the unrefreshed member counted", total)
	}
	var found *PoliticianSummaryRow
	for _, summary := range summaries {
		if summary.Politician.Slug == slug {
			found = summary
		}
	}
	if found == nil {
		t.Fatalf("the unrefreshed member is missing from %d summaries — the rollup join dropped them", len(summaries))
	}
	if len(found.ItemCounts) != 14 {
		t.Fatalf("item counts = %d, want all 14 buckets present and zeroed", len(found.ItemCounts))
	}
	for _, item := range found.ItemCounts {
		if item.CurrentCount != 0 || item.AllTimeCount != 0 {
			t.Errorf("item %d = (%d current, %d all-time), want zeros", item.ItemNo, item.CurrentCount, item.AllTimeCount)
		}
	}
	// Slots 14/15 (declared_listed_count / declared_property_count) fall back to
	// 0 rather than dropping the row.
	if found.Politician.DeclaredListedCount != 0 || found.Politician.DeclaredPropertyCount != 0 {
		t.Errorf("all-time counts = (%d, %d), want zeros",
			found.Politician.DeclaredListedCount, found.Politician.DeclaredPropertyCount)
	}
	if found.DistinctCompanyCount != 0 || found.PropertyCount != 0 || found.GiftsTravelCount != 0 ||
		found.LiabilityCount != 0 || found.Changes90d != 0 || found.UndatedCount != 0 {
		t.Errorf("explorer figures are non-zero for a member with no holdings: %+v", found)
	}

	// The default sort must not float them to the top: a bare NULL sorts FIRST
	// under DESC in Postgres, so the COALESCE in the ORDER BY is load-bearing.
	ranked, _, err := store.ListPoliticianSummaries("", "", "", 0, "", "declared_items", 5, 0)
	if err != nil {
		t.Fatalf("ranked ListPoliticianSummaries: %v", err)
	}
	for i, summary := range ranked {
		if summary.Politician.Slug == slug {
			t.Fatalf("the zero-count member ranked #%d by declared items", i+1)
		}
	}
}

// changes-90d must read the SAME clock as the hub's 7d/30d activity strip and a
// member's recent-changes list. It used to be a `CURRENT_DATE - 90` column
// frozen into the rollup at refresh time while both of those evaluated
// CURRENT_DATE live, so the same page disagreed with itself by a day for every
// day the refresh was late.
func TestChanges90dSharesTheStripsClock(t *testing.T) {
	pool, cleanup := openPoliticianExplorerIntegrationDB(t)
	defer cleanup()
	ctx := context.Background()
	store := &postgresStore{db: pool}

	// The frozen column is gone from the snapshot, so nothing can read it back.
	var frozenColumn int
	if err := pool.QueryRow(ctx, `
		SELECT count(*)
		FROM information_schema.columns
		WHERE table_name = 'mv_register_politician_rollup'
		  AND column_name = 'changes_90d_count'`).Scan(&frozenColumn); err != nil {
		t.Fatalf("inspect rollup columns: %v", err)
	}
	if frozenColumn != 0 {
		t.Fatal("mv_register_politician_rollup still carries a refresh-time changes_90d_count")
	}

	// Every member's live 90d count, by the strip's own event definition.
	want := map[string]int32{}
	rows, err := pool.Query(ctx, `
		SELECT p.slug, count(e.*)::INTEGER
		FROM politicians p
		LEFT JOIN (
		    SELECT politician_id FROM mv_register_public_holdings
		     WHERE declared_from_known AND declared_from >= CURRENT_DATE - 90
		    UNION ALL
		    SELECT politician_id FROM mv_register_public_holdings
		     WHERE declared_to IS NOT NULL AND declared_to >= CURRENT_DATE - 90
		) e ON e.politician_id = p.id
		WHERE p.merged_into_id IS NULL
		GROUP BY p.slug`)
	if err != nil {
		t.Fatalf("reference 90d counts: %v", err)
	}
	for rows.Next() {
		var slug string
		var count int32
		if err := rows.Scan(&slug, &count); err != nil {
			rows.Close()
			t.Fatalf("scan reference 90d count: %v", err)
		}
		want[slug] = count
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("reference 90d counts: %v", err)
	}

	summaries, _, err := store.ListPoliticianSummaries("", "", "", 0, "", "recent_changes", 50, 0)
	if err != nil {
		t.Fatalf("ListPoliticianSummaries: %v", err)
	}
	if len(summaries) == 0 {
		t.Skip("no politicians in this database")
	}
	for _, summary := range summaries {
		expected, ok := want[summary.Politician.Slug]
		if !ok {
			t.Errorf("%s is not in the live reference", summary.Politician.Slug)
			continue
		}
		if summary.Changes90d != expected {
			t.Errorf("%s changes_90d = %d, want the live %d", summary.Politician.Slug, summary.Changes90d, expected)
		}
	}

	// The strip's 30d window is a subset of the same events, so no member's 30d
	// activity may exceed their own 90d count. Under the frozen column this is
	// exactly what an aged snapshot produced.
	var strip30d, sum90d int32
	if err := pool.QueryRow(ctx, `
		SELECT count(*)::INTEGER
		FROM (
		    SELECT politician_id FROM mv_register_public_holdings
		     WHERE declared_from_known AND declared_from >= CURRENT_DATE - 30
		    UNION ALL
		    SELECT politician_id FROM mv_register_public_holdings
		     WHERE declared_to IS NOT NULL AND declared_to >= CURRENT_DATE - 30
		) e`).Scan(&strip30d); err != nil {
		t.Fatalf("strip 30d count: %v", err)
	}
	for _, count := range want {
		sum90d += count
	}
	if strip30d > sum90d {
		t.Fatalf("the strip counts %d events in 30 days but the per-member 90d columns total %d", strip30d, sum90d)
	}

	explorer, err := store.GetRegisterExplorer()
	if err != nil {
		t.Fatalf("GetRegisterExplorer: %v", err)
	}
	if explorer.Changes30d != strip30d {
		t.Fatalf("strip 30d = %d, want the live %d", explorer.Changes30d, strip30d)
	}
}

// The compare page's coverage caveat exists to say "we have read different
// parliaments for these two people". Filling both sides from the same
// corpus-wide buckets made that structurally impossible to say.
func TestCompareCoverageIsPerMemberNotCorpusWide(t *testing.T) {
	pool, cleanup := openPoliticianExplorerIntegrationDB(t)
	defer cleanup()
	ctx := context.Background()
	store := &postgresStore{db: pool}

	corpus := &PoliticianRow{}
	if err := store.loadCoverage(ctx, corpus); err != nil {
		t.Fatalf("loadCoverage: %v", err)
	}
	if len(corpus.ExtractedParliaments)+len(corpus.PartialParliaments)+len(corpus.PendingParliaments) == 0 {
		t.Skip("no register documents in this database")
	}

	// Two members whose service spans genuinely differ. The spans come from the
	// politicians row, NOT from politician_terms: terms only exist where a
	// document extracted, so picking candidates by term would pick them by the
	// same broken measure this test exists to reject.
	var slugA, slugB sql.NullString
	if err := pool.QueryRow(ctx, `
		WITH spans AS (
		    SELECT p.slug, p.first_parliament AS first_p, p.last_parliament AS last_p
		    FROM politicians p
		    WHERE p.merged_into_id IS NULL
		      AND p.first_parliament IS NOT NULL AND p.last_parliament IS NOT NULL
		)
		SELECT (SELECT slug FROM spans ORDER BY first_p, slug LIMIT 1),
		       (SELECT slug FROM spans ORDER BY first_p DESC, slug LIMIT 1)`).Scan(&slugA, &slugB); err != nil {
		t.Fatalf("choose members with different spans: %v", err)
	}
	if !slugA.Valid || !slugB.Valid || slugA.String == slugB.String {
		t.Skip("this database has no two members with different parliament spans")
	}

	comparison, err := store.ComparePoliticians(slugA.String, slugB.String)
	if err != nil {
		t.Fatalf("ComparePoliticians(%q, %q): %v", slugA.String, slugB.String, err)
	}

	// Each side is a subset of the corpus bucket, restricted to that member's
	// own parliaments.
	for _, side := range []struct {
		slug                        string
		extracted, partial, pending []int32
	}{
		{slugA.String, comparison.ExtractedParliamentsA, comparison.PartialParliamentsA, comparison.PendingParliamentsA},
		{slugB.String, comparison.ExtractedParliamentsB, comparison.PartialParliamentsB, comparison.PendingParliamentsB},
	} {
		span, err := store.loadMemberParliamentRange(ctx, side.slug)
		if err != nil {
			t.Fatalf("loadMemberParliamentRange(%q): %v", side.slug, err)
		}
		if span == nil {
			continue // unknown span: the corpus buckets stay whole, by design
		}
		for _, bucket := range [][]int32{side.extracted, side.partial, side.pending} {
			for _, parliament := range bucket {
				if !span[parliament] {
					t.Errorf("%s coverage names parliament %d, which they did not sit in", side.slug, parliament)
				}
			}
		}
	}

	same := fmt.Sprint(comparison.ExtractedParliamentsA, comparison.PartialParliamentsA, comparison.PendingParliamentsA) ==
		fmt.Sprint(comparison.ExtractedParliamentsB, comparison.PartialParliamentsB, comparison.PendingParliamentsB)
	spanA, err := store.loadMemberParliamentRange(ctx, slugA.String)
	if err != nil {
		t.Fatalf("loadMemberParliamentRange(%q): %v", slugA.String, err)
	}
	spanB, err := store.loadMemberParliamentRange(ctx, slugB.String)
	if err != nil {
		t.Fatalf("loadMemberParliamentRange(%q): %v", slugB.String, err)
	}
	differs := false
	for _, parliament := range append(append([]int32(nil), corpus.ExtractedParliaments...),
		append(append([]int32(nil), corpus.PartialParliaments...), corpus.PendingParliaments...)...) {
		if spanA[parliament] != spanB[parliament] {
			differs = true
		}
	}
	if differs && same {
		t.Fatal("two members with different covered parliaments still report identical coverage on both sides")
	}
}

// A member's coverage span must NOT be narrowed by politician_terms, because a
// term row is written only where that member's document already EXTRACTED
// (influence/aph_load.go). Intersecting a coverage bucket with it answered
// "have we read this?" twice and inverted the warning: of two members in a
// half-read parliament, the one we HAD read kept the caveat and the one still
// unread — the only one it applies to — lost it.
func TestCoverageKeepsPartialParliamentsForMembersWeHaveNotRead(t *testing.T) {
	pool, cleanup := openPoliticianExplorerIntegrationDB(t)
	defer cleanup()
	ctx := context.Background()
	store := &postgresStore{db: pool}

	// The discriminating member: their served range covers a partially-read
	// parliament for which they have no term row — i.e. their own document in
	// that parliament is one of the ones that did not parse.
	var slug sql.NullString
	var parliament sql.NullInt32
	if err := pool.QueryRow(ctx, fmt.Sprintf(`
		WITH corpus AS (
		    SELECT parliament,
		           count(*) AS docs,
		           count(*) FILTER (WHERE extract_status = 'extracted') AS extracted
		    FROM register_documents
		    WHERE parliament IS NOT NULL
		    GROUP BY parliament
		), partial AS (
		    SELECT parliament FROM corpus
		    WHERE extracted > 0 AND 100.0 * extracted / docs < %v
		)
		SELECT p.slug, x.parliament
		FROM politicians p
		JOIN partial x ON x.parliament BETWEEN p.first_parliament AND p.last_parliament
		WHERE p.merged_into_id IS NULL
		  AND NOT EXISTS (
		      SELECT 1 FROM politician_terms t
		      WHERE t.politician_id = p.id AND t.parliament = x.parliament
		  )
		ORDER BY p.slug, x.parliament
		LIMIT 1`, fullyReadPct)).Scan(&slug, &parliament); err != nil {
		t.Fatalf("choose an unread member of a partial parliament: %v", err)
	}
	if !slug.Valid || !parliament.Valid {
		t.Skip("every member of every partially-read parliament has a term row in it")
	}

	var other sql.NullString
	if err := pool.QueryRow(ctx, `
		SELECT slug FROM politicians
		WHERE merged_into_id IS NULL AND slug <> $1
		ORDER BY slug LIMIT 1`, slug.String).Scan(&other); err != nil {
		t.Fatalf("choose a comparison partner: %v", err)
	}
	if !other.Valid {
		t.Skip("only one live politician in this database")
	}

	comparison, err := store.ComparePoliticians(slug.String, other.String)
	if err != nil {
		t.Fatalf("ComparePoliticians(%q, %q): %v", slug.String, other.String, err)
	}
	found := false
	for _, p := range comparison.PartialParliamentsA {
		if p == parliament.Int32 {
			found = true
		}
	}
	if !found {
		t.Fatalf("%s sat across the %dth but their partial bucket is %v — the caveat was dropped for the member it applies to",
			slug.String, parliament.Int32, comparison.PartialParliamentsA)
	}

	// And the whole span is present, not just the read part: the range is
	// contiguous, so nothing inside it may be missing from the union of buckets.
	span, err := store.loadMemberParliamentRange(ctx, slug.String)
	if err != nil {
		t.Fatalf("loadMemberParliamentRange(%q): %v", slug.String, err)
	}
	corpus := &PoliticianRow{}
	if err := store.loadCoverage(ctx, corpus); err != nil {
		t.Fatalf("loadCoverage: %v", err)
	}
	reported := map[int32]bool{}
	for _, bucket := range [][]int32{comparison.ExtractedParliamentsA, comparison.PartialParliamentsA, comparison.PendingParliamentsA} {
		for _, p := range bucket {
			reported[p] = true
		}
	}
	for _, bucket := range [][]int32{corpus.ExtractedParliaments, corpus.PartialParliaments, corpus.PendingParliaments} {
		for _, p := range bucket {
			if span[p] && !reported[p] {
				t.Errorf("parliament %d is inside %s's span but appears in none of their coverage buckets", p, slug.String)
			}
		}
	}
}

// as_at is defined by the proto as "the newest lodgement we hold" — a fact
// about the REGISTER. It used to be served as max(refreshed_at), the moment we
// last rebuilt the snapshot, which is a fact about US: on this corpus that
// overstated currency by ten days, beside the names of individual members, and
// it advanced every night whether or not a single new statement arrived.
func TestRegisterAsAtIsTheNewestLodgementNotOurRefresh(t *testing.T) {
	pool, cleanup := openPoliticianExplorerIntegrationDB(t)
	defer cleanup()
	ctx := context.Background()
	store := &postgresStore{db: pool}

	var lodged, refreshed *time.Time
	if err := pool.QueryRow(ctx, `
		SELECT (SELECT max(lodged_date) FROM register_statements),
		       (SELECT max(refreshed_at) FROM mv_register_public_holdings)`).Scan(&lodged, &refreshed); err != nil {
		t.Fatalf("read the two clocks: %v", err)
	}
	if lodged == nil {
		t.Skip("no dated lodgement in this database")
	}

	asAt, err := store.registerAsAt(ctx)
	if err != nil {
		t.Fatalf("registerAsAt: %v", err)
	}
	if !asAt.Equal(*lodged) {
		t.Fatalf("registerAsAt = %v, want the newest lodgement %v", asAt, *lodged)
	}
	if refreshed != nil && !refreshed.Truncate(24*time.Hour).Equal(lodged.Truncate(24*time.Hour)) && asAt.Equal(*refreshed) {
		t.Fatalf("registerAsAt is still the snapshot-rebuild clock %v", *refreshed)
	}

	explorer, err := store.GetRegisterExplorer()
	if err != nil {
		t.Fatalf("GetRegisterExplorer: %v", err)
	}
	if !explorer.AsAt.Equal(*lodged) {
		t.Fatalf("explorer as_at = %v, want the newest lodgement %v", explorer.AsAt, *lodged)
	}
	if explorer.Overview == nil || !explorer.Overview.AsAt.Equal(*lodged) {
		t.Fatalf("the overview's own as-at disagrees with the explorer's")
	}
	// The refresh clock is still carried — it is a real staleness signal — just
	// not as as_at.
	if refreshed != nil && explorer.Overview.RefreshedAt.IsZero() {
		t.Fatal("the snapshot-rebuild clock was dropped instead of relocated")
	}

	var slugA, slugB sql.NullString
	if err := pool.QueryRow(ctx, `
		SELECT (SELECT slug FROM politicians WHERE merged_into_id IS NULL ORDER BY slug LIMIT 1),
		       (SELECT slug FROM politicians WHERE merged_into_id IS NULL ORDER BY slug DESC LIMIT 1)`).
		Scan(&slugA, &slugB); err != nil {
		t.Fatalf("choose politicians: %v", err)
	}
	if !slugA.Valid {
		t.Skip("no live politicians in this database")
	}

	profile, err := store.GetPoliticianExplorerProfile(slugA.String, 5)
	if err != nil {
		t.Fatalf("GetPoliticianExplorerProfile(%q): %v", slugA.String, err)
	}
	if !profile.AsAt.Equal(*lodged) {
		t.Fatalf("profile as_at = %v, want the newest lodgement %v", profile.AsAt, *lodged)
	}

	if !slugB.Valid || slugA.String == slugB.String {
		return
	}
	comparison, err := store.ComparePoliticians(slugA.String, slugB.String)
	if err != nil {
		t.Fatalf("ComparePoliticians: %v", err)
	}
	if !comparison.AsAt.Equal(*lodged) {
		t.Fatalf("compare as_at = %v, want the newest lodgement %v", comparison.AsAt, *lodged)
	}

	analytics, err := store.GetRegisterAnalytics(14, false)
	if err != nil {
		t.Fatalf("GetRegisterAnalytics: %v", err)
	}
	// The heatmap renders on the same hub page as the tiles; two "as at" dates
	// on one screen is a self-contradiction the reader cannot resolve.
	if !analytics.AsAt.Equal(*lodged) {
		t.Fatalf("analytics as_at = %v, want the same newest lodgement %v the tiles carry", analytics.AsAt, *lodged)
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

// A SENATOR HAS AN IDENTITY AND NO HOLDINGS, and every read path has to survive
// that.
//
// register-senators mints 171 people from the APH Handbook. There is no Senate
// register corpus behind them, so not one has a row in
// mv_register_public_holdings — and every explorer query in this file reaches
// its counts through that view or the rollup built from it. An INNER join
// anywhere in that chain drops them silently: the person exists, their profile
// 404s, and the hub's total quietly excludes them.
//
// This is the same failure the unrefreshed-member test guards, but arriving
// from the other direction and permanently rather than for one refresh cycle.
func TestSenatorWithNoHoldingsSurvivesEveryReadPath(t *testing.T) {
	pool, cleanup := openPoliticianExplorerIntegrationDB(t)
	defer cleanup()
	ctx := context.Background()
	store := &postgresStore{db: pool}

	var slug, displayName string
	err := pool.QueryRow(ctx, `
		SELECT p.slug, p.display_name
		FROM politicians p
		JOIN politician_terms t ON t.politician_id = p.id AND t.chamber = 'senate'
		WHERE p.merged_into_id IS NULL
		  AND NOT EXISTS (SELECT 1 FROM mv_register_public_holdings h WHERE h.politician_id = p.id)
		ORDER BY p.slug
		LIMIT 1`).Scan(&slug, &displayName)
	if err != nil {
		t.Skipf("no senator without holdings in this database (run -mode register-senators): %v", err)
	}
	t.Logf("probing %s (%s): a senate term, no declared holdings", slug, displayName)

	// 1. The profile read path.
	politician, declared, _, err := store.GetPolitician(slug)
	if err != nil {
		t.Fatalf("GetPolitician(%s): %v — a senator's profile is unreachable", slug, err)
	}
	if politician == nil || politician.Slug != slug {
		t.Fatalf("GetPolitician returned %+v", politician)
	}
	if len(declared) != 0 {
		t.Errorf("%d declared interests for a senator we hold no register volume for", len(declared))
	}

	// 2. The list read path, and the corpus total.
	summaries, total, err := store.ListPoliticianSummaries("", "", "", 0, displayName, "name", 50, 0)
	if err != nil {
		t.Fatalf("ListPoliticianSummaries: %v", err)
	}
	if total < 1 {
		t.Fatalf("the senator is not counted in the filtered total")
	}
	found := false
	for _, summary := range summaries {
		if summary.Politician.Slug == slug {
			found = true
			if len(summary.ItemCounts) != 14 {
				t.Errorf("item counts = %d, want all 14 buckets zeroed rather than absent", len(summary.ItemCounts))
			}
			if summary.DistinctCompanyCount != 0 || summary.PropertyCount != 0 {
				t.Errorf("a member with no holdings reported counts: %+v", summary)
			}
		}
	}
	if !found {
		t.Fatalf("the senator is missing from %d summaries — a join dropped them", len(summaries))
	}

	// 3. The compare read path. A senator on one side of a comparison must not
	//    error out or come back empty just because they declared nothing.
	var other string
	if err := pool.QueryRow(ctx, `
		SELECT slug FROM mv_register_politician_rollup WHERE slug <> $1 ORDER BY slug LIMIT 1`,
		slug).Scan(&other); err != nil {
		t.Fatalf("pick a comparison partner: %v", err)
	}
	comparison, err := store.ComparePoliticians(slug, other)
	if err != nil {
		t.Fatalf("ComparePoliticians(%s, %s): %v", slug, other, err)
	}
	if comparison == nil || comparison.SummaryA == nil || comparison.SummaryA.Politician.Slug != slug {
		t.Fatalf("the senator side of the comparison came back empty: %+v", comparison)
	}

	// 4. The rollup itself. Every LIVE person gets a row whether or not they
	//    declared anything — the rollup LEFT JOINs holdings onto politicians,
	//    and if that ever became an inner join this is where it shows first.
	var inRollup bool
	if err := pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM mv_register_politician_rollup WHERE slug = $1)`, slug).Scan(&inRollup); err != nil {
		t.Fatalf("rollup membership: %v", err)
	}
	if !inRollup {
		t.Errorf("%s is absent from mv_register_politician_rollup — refresh it, or the LEFT JOIN regressed", slug)
	}
}

// The search index is a SECOND read path, and §8.16's lesson is that a second
// path trusting its own filter is how a row goes wrong. It is built from the
// same MV, so a senator with no holdings must still be indexed — with their
// chamber and state facets populated from politician_terms, or the explorer's
// filter rail shows 171 people as unfacetable.
func TestSenatorIsIndexableWithFacetsFromTheirTerm(t *testing.T) {
	pool, cleanup := openPoliticianExplorerIntegrationDB(t)
	defer cleanup()
	ctx := context.Background()

	var senators, faceted int
	err := pool.QueryRow(ctx, `
		WITH latest_term AS (
			SELECT DISTINCT ON (politician_id)
			       politician_id, chamber, division, state_code, party, party_ab
			FROM politician_terms
			ORDER BY politician_id, parliament DESC, term_start DESC NULLS FIRST, chamber
		),
		indexed AS (
			SELECT p.id,
			       COALESCE(max(h.chamber), max(lt.chamber), '') AS chamber,
			       COALESCE(max(h.member_state), max(lt.state_code), '') AS state_code
			FROM politicians p
			LEFT JOIN mv_register_public_holdings h ON h.politician_id = p.id
			LEFT JOIN latest_term lt ON lt.politician_id = p.id
			WHERE p.merged_into_id IS NULL
			GROUP BY p.id
		)
		SELECT count(*) FILTER (WHERE chamber = 'senate'),
		       count(*) FILTER (WHERE chamber = 'senate' AND state_code <> '')
		FROM indexed`).Scan(&senators, &faceted)
	if err != nil {
		t.Fatalf("index facet probe: %v", err)
	}
	if senators == 0 {
		t.Skip("no senators in this database (run -mode register-senators)")
	}
	t.Logf("%d senators would index, %d of them with a state facet", senators, faceted)
	if faceted != senators {
		t.Errorf("%d of %d senators would index with an EMPTY state facet", senators-faceted, senators)
	}
}
