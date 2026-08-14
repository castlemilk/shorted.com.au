//go:build integration

package shorts

// Integration checks for the register DISCOVERY layer. Like the explorer suite
// beside it, these run against an EXISTING database and never start a
// container: what they smoke is the live corpus and the published MVs, which is
// where every defect this layer can have actually lives.

import (
	"context"
	"strings"
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
		activity, err := store.GetRegisterActivity(windowDays, RegisterActivityFilter{})
		if err != nil {
			t.Fatalf("GetRegisterActivity(%d): %v", windowDays, err)
		}
		if activity.WindowDays != windowDays {
			t.Errorf("windowDays = %d, want %d", activity.WindowDays, windowDays)
		}

		// The reference total is ListRegisterChanges' own event definition, over
		// the EFFECTIVE window: the Monday on or before (today - window_days), so
		// no bucket is a part-week drawn as a full one. The two must be the same
		// measure at two groupings.
		var wantEvents, wantAdded, wantRemoved, wantMembers int32
		if err := pool.QueryRow(ctx, registerEventsCTE+`
			SELECT count(*)::INTEGER,
			       count(*) FILTER (WHERE kind = 'added')::INTEGER,
			       count(*) FILTER (WHERE kind = 'removed')::INTEGER,
			       count(DISTINCT politician_id)::INTEGER
			FROM events
			WHERE changed_on >= date_trunc('week', CURRENT_DATE - $1::INTEGER)::date`, windowDays).
			Scan(&wantEvents, &wantAdded, &wantRemoved, &wantMembers); err != nil {
			t.Fatalf("reference event totals (%d): %v", windowDays, err)
		}

		// The published counts must describe the strip, not the parliament.
		if activity.FilteredEventCount != wantEvents {
			t.Errorf("window %d: filteredEventCount = %d, want %d",
				windowDays, activity.FilteredEventCount, wantEvents)
		}
		if activity.FilteredMemberCount != wantMembers {
			t.Errorf("window %d: filteredMemberCount = %d, want the distinct %d members",
				windowDays, activity.FilteredMemberCount, wantMembers)
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

// week-bars.tsx draws buckets adjacently and states a contiguity invariant, so
// a missing interior week compresses the timeline and puts a bar under the
// wrong date. Every Monday in the window must be present, quiet weeks at zero,
// and the first must be the Monday ON OR BEFORE (today - window_days) so the
// oldest bucket is a whole week rather than a stub drawn full width.
func TestActivityWeeksAreContiguousMondaysWithNoGaps(t *testing.T) {
	pool, cleanup := openPoliticianExplorerIntegrationDB(t)
	defer cleanup()
	ctx := context.Background()
	store := &postgresStore{db: pool}

	for _, windowDays := range []int32{30, 90, 180, 365} {
		activity, err := store.GetRegisterActivity(windowDays, RegisterActivityFilter{})
		if err != nil {
			t.Fatalf("GetRegisterActivity(%d): %v", windowDays, err)
		}

		// The DB's clock decides, not the test process's: the buckets are built
		// from date_trunc over CURRENT_DATE.
		var wantFirst, currentWeek time.Time
		if err := pool.QueryRow(ctx, `
			SELECT date_trunc('week', CURRENT_DATE - $1::INTEGER)::date,
			       date_trunc('week', CURRENT_DATE)::date`, windowDays).
			Scan(&wantFirst, &currentWeek); err != nil {
			t.Fatalf("window bounds (%d): %v", windowDays, err)
		}
		// 365d spans 53 Mondays (54 when the aligned start lands so that an extra
		// Monday falls inside), which is why the count is derived rather than
		// pinned — the invariant is contiguity, not a magic number.
		wantWeeks := int(currentWeek.Sub(wantFirst).Hours()/(24*7)) + 1

		if len(activity.Weeks) == 0 {
			t.Fatalf("window %d: no weekly buckets at all", windowDays)
		}
		if activity.Weeks[0].WeekStart != wantFirst.Format("2006-01-02") {
			t.Errorf("window %d: first bucket = %s, want the aligned %s",
				windowDays, activity.Weeks[0].WeekStart, wantFirst.Format("2006-01-02"))
		}
		if len(activity.Weeks) < wantWeeks {
			t.Errorf("window %d: %d buckets, want at least the %d Mondays in the window",
				windowDays, len(activity.Weeks), wantWeeks)
		}
		if windowDays == 365 && len(activity.Weeks) < 53 {
			t.Errorf("365d returned %d buckets, want the full year of weeks", len(activity.Weeks))
		}

		previous := time.Time{}
		for i, week := range activity.Weeks {
			day, err := time.Parse("2006-01-02", week.WeekStart)
			if err != nil {
				t.Fatalf("window %d: bucket %d label %q is not a date", windowDays, i, week.WeekStart)
			}
			if day.Weekday() != time.Monday {
				t.Errorf("window %d: bucket %s is a %s, want a Monday", windowDays, week.WeekStart, day.Weekday())
			}
			if i > 0 && day.Sub(previous) != 7*24*time.Hour {
				t.Errorf("window %d: %s follows %s — the series has a gap",
					windowDays, week.WeekStart, previous.Format("2006-01-02"))
			}
			previous = day
		}
		t.Logf("window %dd: %d contiguous weekly buckets from %s",
			windowDays, len(activity.Weeks), activity.Weeks[0].WeekStart)
	}
}

// The strip sits inside a FILTERED view, so its buckets and counts must be the
// filtered population's. A parliament-wide number rendered under one member's
// name is the misattribution this filter exists to prevent.
func TestActivityStripIsNarrowedByTheFilter(t *testing.T) {
	pool, cleanup := openPoliticianExplorerIntegrationDB(t)
	defer cleanup()
	ctx := context.Background()
	store := &postgresStore{db: pool}

	const windowDays = int32(365)
	var slug string
	if err := pool.QueryRow(ctx, registerEventsCTE+`
		SELECT slug FROM events
		WHERE changed_on >= date_trunc('week', CURRENT_DATE - $1::INTEGER)::date
		GROUP BY slug ORDER BY count(*) DESC, slug LIMIT 1`, windowDays).Scan(&slug); err != nil {
		t.Skipf("no dated events in the window: %v", err)
	}

	filtered, err := store.GetRegisterActivity(windowDays, RegisterActivityFilter{Slug: " " + strings.ToUpper(slug) + " "})
	if err != nil {
		t.Fatalf("filtered GetRegisterActivity: %v", err)
	}
	// The store normalises exactly as the handler does, so a shouted slug is the
	// same request.
	var wantEvents int32
	if err := pool.QueryRow(ctx, registerEventsCTE+`
		SELECT count(*)::INTEGER FROM events
		WHERE slug = $1 AND changed_on >= date_trunc('week', CURRENT_DATE - $2::INTEGER)::date`,
		slug, windowDays).Scan(&wantEvents); err != nil {
		t.Fatalf("reference filtered total: %v", err)
	}
	if filtered.FilteredEventCount != wantEvents {
		t.Errorf("filtered event count = %d, want %s's own %d", filtered.FilteredEventCount, slug, wantEvents)
	}
	if filtered.FilteredMemberCount != 1 {
		t.Errorf("filtered member count = %d, want 1 for a single-member filter", filtered.FilteredMemberCount)
	}
	var summed int32
	for _, week := range filtered.Weeks {
		summed += week.AddedCount + week.RemovedCount
	}
	if summed != wantEvents {
		t.Errorf("filtered weeks sum to %d, want %d", summed, wantEvents)
	}

	// The rails are NOT narrowed: they answer corpus-wide questions and a
	// consumer is told so on the proto.
	wide, err := store.GetRegisterActivity(windowDays, RegisterActivityFilter{})
	if err != nil {
		t.Fatalf("unfiltered GetRegisterActivity: %v", err)
	}
	if len(filtered.ActiveMembers) != len(wide.ActiveMembers) ||
		len(filtered.NewlyDeclaredCompanies) != len(wide.NewlyDeclaredCompanies) ||
		len(filtered.DeclarerCountChanges) != len(wide.DeclarerCountChanges) {
		t.Error("a filter narrowed the corpus-wide rails; only the strip may be filtered")
	}
	if wide.FilteredEventCount < filtered.FilteredEventCount {
		t.Errorf("unfiltered total %d is smaller than one member's %d",
			wide.FilteredEventCount, filtered.FilteredEventCount)
	}
	t.Logf("%s: %d of %d events in %dd", slug, filtered.FilteredEventCount, wide.FilteredEventCount, windowDays)
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
	activity, err := store.GetRegisterActivity(windowDays, RegisterActivityFilter{})
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
	activity, err := store.GetRegisterActivity(windowDays, RegisterActivityFilter{})
	if err != nil {
		t.Fatalf("GetRegisterActivity: %v", err)
	}

	// The reference EXCLUDES any company an undated current declaration could
	// pre-date: ~80% of current rows are undated, so first-ness against them
	// cannot be proven and is therefore not published at all.
	var wantCount int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM (
		    SELECT stock_code, min(declared_from) AS first_declared_on
		    FROM mv_register_public_holdings h
		    WHERE stock_code IS NOT NULL AND declared_from_known AND declared_from IS NOT NULL
		      AND NOT EXISTS (
		          SELECT 1 FROM mv_register_public_holdings u
		          WHERE u.stock_code = h.stock_code
		            AND u.currently_declared AND NOT u.declared_from_known
		      )
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
		// declarer_count is the SAME dated predicate as declarers_now, so the two
		// rails of one response state one measure of "how many members declare
		// this company" instead of contradicting each other.
		if err := pool.QueryRow(ctx, `
			SELECT min(declared_from),
			       (SELECT count(DISTINCT politician_id) FILTER (
			                  WHERE declared_from_known
			                    AND declared_from <= CURRENT_DATE
			                    AND (declared_to IS NULL OR declared_to > CURRENT_DATE)
			              )::INTEGER
			          FROM mv_register_public_holdings
			         WHERE stock_code = $1)
			FROM mv_register_public_holdings
			WHERE stock_code = $1 AND declared_from_known AND declared_from IS NOT NULL`,
			company.StockCode).Scan(&corpusFirst, &declarers); err != nil {
			t.Fatalf("reference first declaration for %s: %v", company.StockCode, err)
		}

		// And no surviving company may carry an undated current row at all.
		var undated int32
		if err := pool.QueryRow(ctx, `
			SELECT count(*)::INTEGER FROM mv_register_public_holdings
			WHERE stock_code = $1 AND currently_declared AND NOT declared_from_known`,
			company.StockCode).Scan(&undated); err != nil {
			t.Fatalf("undated current rows for %s: %v", company.StockCode, err)
		}
		if undated > 0 {
			t.Errorf("%s is published as newly declared but has %d undated current declarations",
				company.StockCode, undated)
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
