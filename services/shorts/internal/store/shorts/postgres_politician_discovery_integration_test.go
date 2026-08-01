//go:build integration

package shorts

// Integration checks for the register DISCOVERY layer. Like the explorer suite
// beside it, these run against an EXISTING database and never start a
// container: what they smoke is the live corpus and the published MVs, which is
// where every defect this layer can have actually lives.

import (
	"context"
	"testing"
	"time"
)

// The rail's whole claim is the ordering: the companies no other member
// currently declares come FIRST, and their count is 1. If the corpus-wide count
// were computed per-member (or over all history rather than current
// declarations) every count would be 1 and the rail would be meaningless.
func TestDistinctiveHoldingsPutSoleDeclarerCompaniesFirst(t *testing.T) {
	pool, cleanup := openPoliticianExplorerIntegrationDB(t)
	defer cleanup()
	ctx := context.Background()
	store := &postgresStore{db: pool}

	// The corpus fact the rail rests on, measured independently here.
	var soleDeclarerCompanies int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM (
		    SELECT stock_code
		    FROM mv_register_public_holdings
		    WHERE stock_code IS NOT NULL AND currently_declared
		    GROUP BY stock_code
		    HAVING count(DISTINCT politician_id) = 1
		) sole`).Scan(&soleDeclarerCompanies); err != nil {
		t.Fatalf("count sole-declarer companies: %v", err)
	}
	if soleDeclarerCompanies == 0 {
		t.Skip("no sole-declarer companies in this database")
	}
	t.Logf("corpus sole-declarer companies: %d", soleDeclarerCompanies)

	// A member who declares at least one of them, discovered rather than pinned
	// so the test survives a re-extraction.
	var slug string
	if err := pool.QueryRow(ctx, `
		WITH corpus AS (
		    SELECT stock_code, count(DISTINCT politician_id) AS declarers
		    FROM mv_register_public_holdings
		    WHERE stock_code IS NOT NULL AND currently_declared
		    GROUP BY stock_code
		)
		SELECT h.slug
		FROM mv_register_public_holdings h
		JOIN corpus c ON c.stock_code = h.stock_code
		WHERE h.currently_declared AND h.stock_code IS NOT NULL AND c.declarers = 1
		GROUP BY h.slug
		ORDER BY count(*) DESC, h.slug
		LIMIT 1`).Scan(&slug); err != nil {
		t.Fatalf("find a member with a sole-declarer holding: %v", err)
	}

	result, err := store.ListDistinctiveHoldings(slug)
	if err != nil {
		t.Fatalf("ListDistinctiveHoldings(%q): %v", slug, err)
	}
	if result.CanonicalSlug != slug {
		t.Errorf("canonicalSlug = %q, want the stored %q", result.CanonicalSlug, slug)
	}
	if len(result.Holdings) == 0 {
		t.Fatalf("%s declares sole-declarer companies but the rail is empty", slug)
	}
	if result.Holdings[0].CorpusDeclarerCount != 1 {
		t.Errorf("%s first holding declarer count = %d, want the sole-declarer companies first",
			slug, result.Holdings[0].CorpusDeclarerCount)
	}

	previous := int32(0)
	for i, holding := range result.Holdings {
		if holding.CorpusDeclarerCount < previous {
			t.Errorf("holding %d (%s) count %d follows %d — the ordering is not ascending",
				i, holding.StockCode, holding.CorpusDeclarerCount, previous)
		}
		previous = holding.CorpusDeclarerCount
		if holding.CorpusDeclarerCount < 1 {
			t.Errorf("%s: declarer count %d excludes the declaring member themself",
				holding.StockCode, holding.CorpusDeclarerCount)
		}
		if !holding.CurrentlyDeclared {
			t.Errorf("%s: rail carries a row that is not currently declared", holding.StockCode)
		}
		if holding.StockCode == "" {
			t.Error("rail carries a row with no stock code; the licence gate must be re-asserted")
		}
	}
	// The cap is a cap, and the remainder is reported rather than dropped.
	if len(result.Holdings) > distinctiveHoldingsCap {
		t.Errorf("holdings = %d, want at most the %d cap", len(result.Holdings), distinctiveHoldingsCap)
	}

	// Every count must equal the independent corpus-wide count for that code.
	for _, holding := range result.Holdings {
		var want int32
		if err := pool.QueryRow(ctx, `
			SELECT count(DISTINCT politician_id)::INTEGER
			FROM mv_register_public_holdings
			WHERE stock_code = $1 AND currently_declared`, holding.StockCode).Scan(&want); err != nil {
			t.Fatalf("reference declarer count for %s: %v", holding.StockCode, err)
		}
		if holding.CorpusDeclarerCount != want {
			t.Errorf("%s declarer count = %d, want the corpus-wide %d",
				holding.StockCode, holding.CorpusDeclarerCount, want)
		}
	}
}

// The weekly strip and the feed beneath it describe ONE population. If the
// buckets did not sum to the window's event total, the chart and the list on
// the same page would disagree about how much happened.
func TestActivityWeeksSumToTheWindowsEventTotal(t *testing.T) {
	pool, cleanup := openPoliticianExplorerIntegrationDB(t)
	defer cleanup()
	ctx := context.Background()
	store := &postgresStore{db: pool}

	for _, windowDays := range []int32{30, 90, 180, 365} {
		activity, err := store.GetRegisterActivity(windowDays)
		if err != nil {
			t.Fatalf("GetRegisterActivity(%d): %v", windowDays, err)
		}
		if activity.WindowDays != windowDays {
			t.Errorf("windowDays = %d, want %d", activity.WindowDays, windowDays)
		}

		// The reference total is ListRegisterChanges' own event definition,
		// windowed — the two must be the same measure at two groupings.
		var wantEvents, wantAdded, wantRemoved, wantMembers int32
		if err := pool.QueryRow(ctx, registerEventsCTE+`
			SELECT count(*)::INTEGER,
			       count(*) FILTER (WHERE kind = 'added')::INTEGER,
			       count(*) FILTER (WHERE kind = 'removed')::INTEGER,
			       count(DISTINCT politician_id)::INTEGER
			FROM events
			WHERE changed_on >= CURRENT_DATE - $1::INTEGER`, windowDays).
			Scan(&wantEvents, &wantAdded, &wantRemoved, &wantMembers); err != nil {
			t.Fatalf("reference event totals (%d): %v", windowDays, err)
		}

		var added, removed int32
		seen := map[string]bool{}
		for _, week := range activity.Weeks {
			added += week.AddedCount
			removed += week.RemovedCount
			if seen[week.WeekStart] {
				t.Errorf("window %d: week %s appears twice", windowDays, week.WeekStart)
			}
			seen[week.WeekStart] = true
			day, err := time.Parse("2006-01-02", week.WeekStart)
			if err != nil {
				t.Errorf("window %d: week_start %q is not a date: %v", windowDays, week.WeekStart, err)
				continue
			}
			// Monday-anchored, as the label promises.
			if day.Weekday() != time.Monday {
				t.Errorf("window %d: week_start %s is a %s, want a Monday", windowDays, week.WeekStart, day.Weekday())
			}
		}
		if added+removed != wantEvents || added != wantAdded || removed != wantRemoved {
			t.Errorf("window %d: weekly buckets sum to %d added / %d removed, want %d / %d (total %d)",
				windowDays, added, removed, wantAdded, wantRemoved, wantEvents)
		}
		t.Logf("window %dd: %d events (%d added / %d removed) across %d weeks, %d members",
			windowDays, wantEvents, wantAdded, wantRemoved, len(activity.Weeks), wantMembers)

		// The most-active rail is the same events, grouped by member.
		if len(activity.ActiveMembers) > activeMembersCap {
			t.Errorf("window %d: active members = %d, want at most %d",
				windowDays, len(activity.ActiveMembers), activeMembersCap)
		}
		previous := int32(1 << 30)
		for _, member := range activity.ActiveMembers {
			if member.EventCount > previous {
				t.Errorf("window %d: active members are not ordered by count (%d after %d)",
					windowDays, member.EventCount, previous)
			}
			previous = member.EventCount
			var want int32
			if err := pool.QueryRow(ctx, registerEventsCTE+`
				SELECT count(*)::INTEGER FROM events
				WHERE slug = $1 AND changed_on >= CURRENT_DATE - $2::INTEGER`,
				member.Slug, windowDays).Scan(&want); err != nil {
				t.Fatalf("reference member event count: %v", err)
			}
			if member.EventCount != want {
				t.Errorf("window %d: %s event count = %d, want %d",
					windowDays, member.Slug, member.EventCount, want)
			}
		}
	}
}

// BOTH sides of a declarer-count change must be dated-only, evaluated with the
// identical predicate at two dates. This is the failure the industry-movement
// fix already caught once: ~80% of currently-declared rows are undated, so an
// undated-inclusive "now" against a dated-only baseline reports every company
// as gaining declarers, and the abs() ordering then ranks the rail by that
// artefact.
func TestDeclarerCountChangesAreDatedOnBothSides(t *testing.T) {
	pool, cleanup := openPoliticianExplorerIntegrationDB(t)
	defer cleanup()
	ctx := context.Background()
	store := &postgresStore{db: pool}

	const windowDays = int32(90)
	activity, err := store.GetRegisterActivity(windowDays)
	if err != nil {
		t.Fatalf("GetRegisterActivity: %v", err)
	}

	// The undated population is large enough that an asymmetric predicate would
	// be obvious; assert the premise so the test cannot silently go vacuous.
	var undatedCurrent, current int32
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE currently_declared AND NOT declared_from_known)::INTEGER,
		       count(*) FILTER (WHERE currently_declared)::INTEGER
		FROM mv_register_public_holdings`).Scan(&undatedCurrent, &current); err != nil {
		t.Fatalf("undated population: %v", err)
	}
	if activity.UndatedCurrentCount != undatedCurrent {
		t.Errorf("undatedCurrentCount = %d, want %d", activity.UndatedCurrentCount, undatedCurrent)
	}
	t.Logf("undated currently-declared rows: %d of %d (%.1f%%)",
		undatedCurrent, current, 100*float64(undatedCurrent)/float64(max(current, 1)))

	type pair struct{ now, then int32 }
	reference := map[string]pair{}
	rows, err := pool.Query(ctx, `
		SELECT stock_code,
		       count(DISTINCT politician_id) FILTER (
		           WHERE declared_from_known
		             AND declared_from <= CURRENT_DATE
		             AND (declared_to IS NULL OR declared_to > CURRENT_DATE)
		       )::INTEGER,
		       count(DISTINCT politician_id) FILTER (
		           WHERE declared_from_known
		             AND declared_from <= CURRENT_DATE - $1::INTEGER
		             AND (declared_to IS NULL OR declared_to > CURRENT_DATE - $1::INTEGER)
		       )::INTEGER
		FROM mv_register_public_holdings
		WHERE stock_code IS NOT NULL
		GROUP BY stock_code`, windowDays)
	if err != nil {
		t.Fatalf("reference declarer counts: %v", err)
	}
	for rows.Next() {
		var code string
		var p pair
		if err := rows.Scan(&code, &p.now, &p.then); err != nil {
			rows.Close()
			t.Fatalf("scan reference declarer counts: %v", err)
		}
		reference[code] = p
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("reference declarer counts: %v", err)
	}

	moved := 0
	for _, p := range reference {
		if p.now != p.then {
			moved++
		}
	}
	t.Logf("companies whose dated declarer count moved in %dd: %d of %d", windowDays, moved, len(reference))

	if len(activity.DeclarerCountChanges) > declarerCountChangeCap {
		t.Errorf("declarer count changes = %d, want at most %d",
			len(activity.DeclarerCountChanges), declarerCountChangeCap)
	}
	if moved < declarerCountChangeCap && len(activity.DeclarerCountChanges) != moved {
		t.Errorf("declarer count changes = %d, want the %d companies that actually moved",
			len(activity.DeclarerCountChanges), moved)
	}

	previous := int32(1 << 30)
	for _, change := range activity.DeclarerCountChanges {
		want, ok := reference[change.StockCode]
		if !ok {
			t.Errorf("%s is not in the dated-symmetric reference", change.StockCode)
			continue
		}
		if change.DeclarersNow != want.now || change.DeclarersAtWindowStart != want.then {
			t.Errorf("%s = (%d now, %d at window start), want the dated-symmetric (%d, %d)",
				change.StockCode, change.DeclarersNow, change.DeclarersAtWindowStart, want.now, want.then)
		}
		if change.DeclarersNow == change.DeclarersAtWindowStart {
			t.Errorf("%s reports a change with identical counts", change.StockCode)
		}
		delta := change.DeclarersNow - change.DeclarersAtWindowStart
		if delta < 0 {
			delta = -delta
		}
		if delta > previous {
			t.Errorf("%s: rail is not ordered by absolute movement (%d after %d)", change.StockCode, delta, previous)
		}
		previous = delta
	}
}

// "Newly declared" is the CORPUS-WIDE minimum known start date. A company one
// member has declared since 2019 is not new because a second member declared it
// last week, and an undated row can make nothing new because it carries no date.
func TestNewlyDeclaredCompaniesUseTheCorpusWideMinimumDate(t *testing.T) {
	pool, cleanup := openPoliticianExplorerIntegrationDB(t)
	defer cleanup()
	ctx := context.Background()
	store := &postgresStore{db: pool}

	const windowDays = int32(180)
	activity, err := store.GetRegisterActivity(windowDays)
	if err != nil {
		t.Fatalf("GetRegisterActivity: %v", err)
	}

	var wantCount int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM (
		    SELECT stock_code, min(declared_from) AS first_declared_on
		    FROM mv_register_public_holdings
		    WHERE stock_code IS NOT NULL AND declared_from_known AND declared_from IS NOT NULL
		    GROUP BY stock_code
		) f
		WHERE f.first_declared_on >= CURRENT_DATE - $1::INTEGER`, windowDays).Scan(&wantCount); err != nil {
		t.Fatalf("reference newly-declared count: %v", err)
	}
	if len(activity.NewlyDeclaredCompanies) != wantCount {
		t.Errorf("newly declared companies = %d, want %d",
			len(activity.NewlyDeclaredCompanies), wantCount)
	}
	t.Logf("companies first declared within %dd: %d", windowDays, wantCount)
	if wantCount == 0 {
		t.Skip("no company was first declared inside the window in this database")
	}

	cutoff := time.Now().AddDate(0, 0, -int(windowDays))
	for _, company := range activity.NewlyDeclaredCompanies {
		// The date served must BE the corpus-wide minimum, not this window's.
		var corpusFirst time.Time
		var declarers int32
		if err := pool.QueryRow(ctx, `
			SELECT min(declared_from),
			       (SELECT count(DISTINCT politician_id)::INTEGER
			          FROM mv_register_public_holdings
			         WHERE stock_code = $1 AND currently_declared)
			FROM mv_register_public_holdings
			WHERE stock_code = $1 AND declared_from_known AND declared_from IS NOT NULL`,
			company.StockCode).Scan(&corpusFirst, &declarers); err != nil {
			t.Fatalf("reference first declaration for %s: %v", company.StockCode, err)
		}
		if got := corpusFirst.Format("2006-01-02"); company.FirstDeclaredOn != got {
			t.Errorf("%s first declared on %s, want the corpus-wide minimum %s",
				company.StockCode, company.FirstDeclaredOn, got)
		}
		if company.DeclarerCount != declarers {
			t.Errorf("%s declarer count = %d, want the currently-declaring %d",
				company.StockCode, company.DeclarerCount, declarers)
		}
		day, err := time.Parse("2006-01-02", company.FirstDeclaredOn)
		if err != nil {
			t.Errorf("%s: first_declared_on %q is not a date", company.StockCode, company.FirstDeclaredOn)
			continue
		}
		if day.Before(cutoff.AddDate(0, 0, -1)) {
			t.Errorf("%s first declared %s, outside the %d-day window", company.StockCode, company.FirstDeclaredOn, windowDays)
		}
	}

	// The register's own clock rides on the response, and it is the newest
	// lodgement, not the moment we last rebuilt the snapshot.
	var lodged, refreshed *time.Time
	if err := pool.QueryRow(ctx, `SELECT max(lodged_date) FROM register_statements`).Scan(&lodged); err != nil {
		t.Fatalf("newest lodgement: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT max(refreshed_at) FROM mv_register_public_holdings`).Scan(&refreshed); err != nil {
		t.Fatalf("snapshot clock: %v", err)
	}
	if lodged != nil && !activity.AsAt.Equal(*lodged) {
		t.Errorf("asAt = %v, want the newest lodgement %v", activity.AsAt, *lodged)
	}
	if refreshed != nil && activity.AsAt.Equal(*refreshed) && lodged != nil && !lodged.Equal(*refreshed) {
		t.Errorf("asAt is the snapshot-rebuild clock %v, not the register's", *refreshed)
	}
}

// A merged-away member has no live row, so the discovery rail must refuse the
// retired slug rather than resolve it to somebody.
func TestDistinctiveHoldingsRefuseAnUnknownSlug(t *testing.T) {
	pool, cleanup := openPoliticianExplorerIntegrationDB(t)
	defer cleanup()
	store := &postgresStore{db: pool}

	if _, err := store.ListDistinctiveHoldings("definitely-not-a-member-9f3a"); err == nil {
		t.Fatal("an unknown slug returned a result; it must be a no-rows error the handler maps to 404")
	}
}
