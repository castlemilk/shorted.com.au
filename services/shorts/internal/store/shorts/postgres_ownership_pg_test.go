package shorts

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The ownership reads against a real Postgres, before and after 000137.
// SHORTS_TEST_POSTGRES_URL names a disposable server (the test creates and
// drops a database on it).
func TestOwnershipReadsAgainstPostgres(t *testing.T) {
	adminURL := os.Getenv("SHORTS_TEST_POSTGRES_URL")
	if adminURL == "" {
		t.Skip("SHORTS_TEST_POSTGRES_URL not set; skipping the real-Postgres ownership test")
	}
	for _, shared := range []string{"supabase", "pooler", ":6543"} {
		if strings.Contains(adminURL, shared) {
			t.Fatalf("refusing a shared or pooled database (%q): this test creates and drops databases", shared)
		}
	}
	ctx := context.Background()
	pool := fundamentalsTestDatabase(t, ctx, adminURL)
	s := &postgresStore{db: pool}
	exec := func(sql string) {
		t.Helper()
		_, err := pool.Exec(ctx, sql)
		require.NoError(t, err)
	}
	exec(ownershipTestBaseSchema)

	t.Run("without 000137 every read is empty, never an error", func(t *testing.T) {
		insts, err := s.OwnershipInstitutions(ctx)
		require.NoError(t, err)
		assert.Empty(t, insts)
		holdings, err := s.CurrentSubstantialHoldings(ctx, OwnershipFilter{})
		require.NoError(t, err)
		assert.Empty(t, holdings)
		notices, err := s.SubstantialNotices(ctx, OwnershipFilter{StockCode: "ZIP"}, 10)
		require.NoError(t, err)
		assert.Empty(t, notices)
		stats, err := s.NoticeStats(ctx)
		require.NoError(t, err)
		assert.Zero(t, stats.Parsed)
		fh, err := s.LatestFundHoldings(ctx, OwnershipFilter{})
		require.NoError(t, err)
		assert.Empty(t, fh)
		funds, err := s.OwnershipFunds(ctx, "")
		require.NoError(t, err)
		assert.Empty(t, funds)
		counts, err := s.NoticeCountsByStock(ctx)
		require.NoError(t, err)
		assert.Empty(t, counts)
		attempts, err := s.AttemptOutcomes(ctx)
		require.NoError(t, err)
		assert.Empty(t, attempts)
	})

	migration, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "migrations", "000137_add_ownership.up.sql"))
	require.NoError(t, err)
	exec(string(migration))
	exec(ownershipTestSeed)

	t.Run("current holdings: the latest notice per holder, a ceasing drops it", func(t *testing.T) {
		holdings, err := s.CurrentSubstantialHoldings(ctx, OwnershipFilter{StockCode: "ZIP"})
		require.NoError(t, err)
		require.Len(t, holdings, 2)
		byKey := map[string]SubstantialHoldingRow{}
		for _, h := range holdings {
			byKey[h.HolderKey] = h
		}
		art := byKey["australian-retirement-trust"]
		assert.Equal(t, "super_fund", art.Kind)
		assert.InDelta(t, 6.2, art.PresentPct, 1e-9, "the 604 after the 603")
		require.NotNil(t, art.PreviousPct)
		assert.Equal(t, "604", art.Form)
		assert.Equal(t, "corporate", byKey["asx:CBA"].Kind)
		_, jpm := byKey["jpmorgan"]
		assert.False(t, jpm, "JPMorgan's latest ZIP notice is a 605")
	})

	t.Run("notices newest first, with kinds", func(t *testing.T) {
		notices, err := s.SubstantialNotices(ctx, OwnershipFilter{StockCode: "ZIP"}, 10)
		require.NoError(t, err)
		require.Len(t, notices, 5)
		assert.Equal(t, "2026-10-16", notices[0].AnnouncedOn)
		holder, err := s.SubstantialNotices(ctx, OwnershipFilter{HolderKey: "jpmorgan"}, 10)
		require.NoError(t, err)
		require.Len(t, holder, 2)
		assert.True(t, holder[0].Ceased)
		assert.Equal(t, "bank_broker", holder[0].Kind)
	})

	t.Run("notice stats count parsed and withheld", func(t *testing.T) {
		stats, err := s.NoticeStats(ctx)
		require.NoError(t, err)
		assert.Equal(t, 5, stats.Parsed)
		assert.Equal(t, 1, stats.Withheld)
		assert.Equal(t, "2026-10-16", stats.LatestAnnounced)
		assert.Equal(t, 2, stats.PerHolder["australian-retirement-trust"].Notices)
	})

	t.Run("notice counts and attempt outcomes, whole-table, per stock", func(t *testing.T) {
		counts, err := s.NoticeCountsByStock(ctx)
		require.NoError(t, err)
		assert.Equal(t, map[string]int{"ZIP": 5}, counts, "every seeded notice is ZIP's")
		attempts, err := s.AttemptOutcomes(ctx)
		require.NoError(t, err)
		got := map[string]int{}
		for _, a := range attempts {
			got[a.StockCode+"|"+a.Outcome] = a.Count
		}
		assert.Equal(t, map[string]int{"ZIP|parsed": 1, "ZIP|no_text": 1}, got)
	})

	t.Run("fund holdings read each fund's newest snapshot only", func(t *testing.T) {
		fh, err := s.LatestFundHoldings(ctx, OwnershipFilter{StockCode: "ZIP"})
		require.NoError(t, err)
		require.Len(t, fh, 1)
		assert.Equal(t, "2026-10-15", fh[0].AsAt)
		require.NotNil(t, fh[0].Units)
		assert.InDelta(t, 2000, *fh[0].Units, 1e-9)
	})

	t.Run("funds, short positions and companies", func(t *testing.T) {
		funds, err := s.OwnershipFunds(ctx, "australian-retirement-trust")
		require.NoError(t, err)
		require.Len(t, funds, 1)
		require.NotNil(t, funds[0].Size)
		shorts, err := s.LatestShortPositions(ctx)
		require.NoError(t, err)
		assert.InDelta(t, 9.5, shorts["ZIP"].Pct, 1e-9, "the newest report line")
		assert.InDelta(t, 1.3e9, shorts["ZIP"].Issued, 1)
		companies, err := s.OwnershipCompanies(ctx)
		require.NoError(t, err)
		assert.Equal(t, "Zip Co Limited", companies["ZIP"].Name)
		require.NotNil(t, companies["ZIP"].MarketCap)
		assert.InDelta(t, 1.5e9, *companies["ZIP"].MarketCap, 1)
	})

	// Production's market_cap is text, with an empty string for a missing
	// value: a bare ::float8 cast failed every ownership read (22P02).
	t.Run("a text market_cap with empty and non-numeric values reads as unknown", func(t *testing.T) {
		exec(`ALTER TABLE "company-metadata" ALTER COLUMN market_cap TYPE text USING market_cap::text`)
		exec(`INSERT INTO "company-metadata" VALUES ('EMP', 'Empty Cap Ltd', 'Materials', ''), ('NA1', 'No Cap Ltd', 'Materials', 'N/A')`)
		companies, err := s.OwnershipCompanies(ctx)
		require.NoError(t, err)
		require.NotNil(t, companies["ZIP"].MarketCap)
		assert.InDelta(t, 1.5e9, *companies["ZIP"].MarketCap, 1)
		assert.Nil(t, companies["EMP"].MarketCap)
		assert.Nil(t, companies["NA1"].MarketCap)
		assert.Equal(t, "Empty Cap Ltd", companies["EMP"].Name)
	})
}

const ownershipTestBaseSchema = `
CREATE TABLE "company-metadata" (stock_code varchar(50) UNIQUE, company_name text, industry text, market_cap bigint);
CREATE TABLE shorts ("DATE" timestamp, "PRODUCT" text, "PRODUCT_CODE" text, "REPORTED_SHORT_POSITIONS" float8,
	"TOTAL_PRODUCT_IN_ISSUE" float8, "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" float8);
CREATE TABLE asx_announcements (id serial, stock_code varchar(10), announcement_date date, headline text, pdf_url text);
`

const ownershipTestSeed = `
INSERT INTO "company-metadata" VALUES ('ZIP', 'Zip Co Limited', 'Financial Services', 1500000000),
	('CBA', 'Commonwealth Bank of Australia', 'Banks', 250000000000);
INSERT INTO shorts VALUES ('2026-10-01', 'ZIP CO', 'ZIP', 1, 1.2e9, 8.0), ('2026-10-12', 'ZIP CO', 'ZIP', 1, 1.3e9, 9.5);
INSERT INTO ownership_institutions (slug, name, kind, aum_aud) VALUES
	('australian-retirement-trust', 'Australian Retirement Trust', 'super_fund', 3.5e11),
	('jpmorgan', 'JPMorgan Chase', 'bank_broker', NULL);
INSERT INTO substantial_holder_notices (announcement_url, stock_code, form, holder_name, holder_key, institution_slug,
	event_date, announced_on, previous_pct, present_pct, present_votes, ceased, parser_version) VALUES
	('u1', 'ZIP', '603', 'Australian Retirement Trust', 'australian-retirement-trust', 'australian-retirement-trust', '2026-10-14', '2026-10-15', NULL, 5.045, 62856312, false, 1),
	('u2', 'ZIP', '604', 'Australian Retirement Trust', 'australian-retirement-trust', 'australian-retirement-trust', NULL, '2026-10-16', 5.045, 6.2, NULL, false, 1),
	('u3', 'ZIP', '603', 'JPMorgan Chase & Co', 'jpmorgan', 'jpmorgan', '2026-10-01', '2026-10-03', NULL, 5.13, 63969382, false, 1),
	('u4', 'ZIP', '605', 'JPMorgan Chase & Co', 'jpmorgan', 'jpmorgan', '2026-10-08', '2026-10-10', NULL, NULL, NULL, true, 1),
	('u5', 'ZIP', '603', 'Commonwealth Bank of Australia', 'asx:CBA', NULL, '2026-09-23', '2026-09-25', NULL, 5.01, NULL, false, 1);
INSERT INTO substantial_holder_notice_attempts (announcement_url, stock_code, outcome, parser_version) VALUES
	('u1', 'ZIP', 'parsed', 1), ('u6', 'ZIP', 'no_text', 1);
INSERT INTO fund_holding_snapshots (id, institution_slug, fund_name, fund_code, source_kind, source_url, as_at) VALUES
	(1, 'vanguard', 'VAS', 'VAS', 'etf', 'x', '2026-09-30'),
	(2, 'vanguard', 'VAS', 'VAS', 'etf', 'x', '2026-10-15');
INSERT INTO fund_holdings (snapshot_id, stock_code, units, value_aud, weight_pct, match_method) VALUES
	(1, 'ZIP', 1000, 1500, 0.1, 'ticker'), (2, 'ZIP', 2000, 3000, 0.2, 'ticker');
INSERT INTO ownership_funds (fund_key, name, fund_type, institution_slug, aum_aud, source) VALUES
	('abn:1', 'Australian Retirement Trust', 'super_fund', 'australian-retirement-trust', 3.5e11, 'apra-fund-level');
`

// noticeFeedTestSeed is seventeen notices: every event, every holder kind, two
// notices sharing a release date, a URL with a "|" in it, six rises and two falls
// for the largest moves, and one notice from September.
const noticeFeedTestSeed = `
INSERT INTO ownership_institutions (slug, name, kind) VALUES
	('aaa-super', 'Aaa Super', 'super_fund'),
	('bbb-bank', 'Bbb Bank', 'bank_broker'),
	('ccc-hedge', 'Ccc Hedge', 'hedge_fund');
INSERT INTO substantial_holder_notices (announcement_url, stock_code, form, holder_name, holder_key, institution_slug,
	event_date, announced_on, previous_pct, present_pct, present_votes, ceased, parser_version) VALUES
	('n01', 'ZIP', '603', 'Aaa Super', 'aaa-super', 'aaa-super', '2026-10-05', '2026-10-06', NULL, 5.5, NULL, false, 1),
	('n02', 'ZIP', '604', 'Aaa Super', 'aaa-super', 'aaa-super', NULL, '2026-10-13', 5.5, 6.5, NULL, false, 1),
	('n03', 'ZIP', '604', 'Bbb Bank', 'bbb-bank', 'bbb-bank', NULL, '2026-10-13', 9, 7, NULL, false, 1),
	('n04', 'ZIP', '605', 'Ccc Hedge', 'ccc-hedge', 'ccc-hedge', '2026-10-08', '2026-10-13', 4, NULL, NULL, true, 1),
	('n05', 'ZIP', '604', 'Ccc Hedge', 'ccc-hedge', 'ccc-hedge', NULL, '2026-10-20', NULL, 5, NULL, false, 1),
	('n06', 'ZIP', 'nz', 'CBA', 'asx:CBA', NULL, NULL, '2026-10-22', NULL, 9, NULL, false, 1),
	('n07', 'BHP', '604', 'Mystery Holder', 'name:mystery holder', NULL, NULL, '2026-10-22', 5, 5, NULL, false, 1),
	('x|y', 'ZIP', '603', 'Bbb Bank', 'bbb-bank', 'bbb-bank', NULL, '2026-10-22', NULL, 6, NULL, false, 1),
	('n09', 'BHP', '604', 'Aaa Super', 'aaa-super', 'aaa-super', NULL, '2026-09-01', NULL, NULL, NULL, false, 1),
	('r1', 'BHP', '604', 'Aaa Super', 'aaa-super', 'aaa-super', NULL, '2026-10-21', 1, 2, NULL, false, 1),
	('r2', 'BHP', '604', 'Aaa Super', 'aaa-super', 'aaa-super', NULL, '2026-10-21', 1, 3, NULL, false, 1),
	('r3', 'BHP', '604', 'Aaa Super', 'aaa-super', 'aaa-super', NULL, '2026-10-21', 1, 4, NULL, false, 1),
	('r4', 'BHP', '604', 'Aaa Super', 'aaa-super', 'aaa-super', NULL, '2026-10-21', 1, 5, NULL, false, 1),
	('r5', 'BHP', '604', 'Aaa Super', 'aaa-super', 'aaa-super', NULL, '2026-10-21', 1, 6, NULL, false, 1),
	('r6', 'BHP', '604', 'Aaa Super', 'aaa-super', 'aaa-super', NULL, '2026-10-21', 1, 7, NULL, false, 1),
	('d1', 'BHP', '604', 'Aaa Super', 'aaa-super', 'aaa-super', NULL, '2026-10-21', 9, 8, NULL, false, 1),
	('d2', 'BHP', '604', 'Aaa Super', 'aaa-super', 'aaa-super', NULL, '2026-10-21', 9, 5, NULL, false, 1);
`

// The notices feed against Postgres: the event SQL against Event, the keyset
// page, the filters, the weekly aggregate and the largest moves. It runs on the
// same disposable server as TestOwnershipReadsAgainstPostgres.
func TestOwnershipNoticeFeedAgainstPostgres(t *testing.T) {
	adminURL := os.Getenv("SHORTS_TEST_POSTGRES_URL")
	if adminURL == "" {
		t.Skip("SHORTS_TEST_POSTGRES_URL not set; skipping the real-Postgres notices feed test")
	}
	for _, shared := range []string{"supabase", "pooler", ":6543"} {
		if strings.Contains(adminURL, shared) {
			t.Fatalf("refusing a shared or pooled database (%q): this test creates and drops databases", shared)
		}
	}
	ctx := context.Background()
	pool := fundamentalsTestDatabase(t, ctx, adminURL)
	s := &postgresStore{db: pool}
	exec := func(sql string) {
		t.Helper()
		_, err := pool.Exec(ctx, sql)
		require.NoError(t, err)
	}
	exec(ownershipTestBaseSchema)

	t.Run("without 000137 the feed reads empty, never an error", func(t *testing.T) {
		rows, err := s.SubstantialNoticesPage(ctx, NoticeFilter{}, "", "", 10)
		require.NoError(t, err)
		assert.Empty(t, rows)
		n, err := s.CountSubstantialNotices(ctx, NoticeFilter{})
		require.NoError(t, err)
		assert.Zero(t, n)
		act, err := s.NoticeActivity(ctx, NoticeFilter{})
		require.NoError(t, err)
		assert.Empty(t, act.Weeks)
		assert.Empty(t, act.Rises)
		assert.Empty(t, act.Falls)
	})

	migration, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "migrations", "000137_add_ownership.up.sql"))
	require.NoError(t, err)
	exec(string(migration))
	exec(noticeFeedTestSeed)

	// The newest first, the announcement URL breaking the tie of one release date.
	wantOrder := []string{"x|y", "n07", "n06", "r6", "r5", "r4", "r3", "r2", "r1", "d2", "d1", "n05", "n04", "n03", "n02", "n01", "n09"}

	t.Run("the event SQL agrees with Event for every notice", func(t *testing.T) {
		all, err := s.SubstantialNoticesPage(ctx, NoticeFilter{}, "", "", 100)
		require.NoError(t, err)
		require.Len(t, all, len(wantOrder))
		goEvent := map[string]string{}
		for _, n := range all {
			goEvent[n.AnnouncementURL] = n.Event()
		}
		rows, err := pool.Query(ctx, `SELECT h.announcement_url, `+noticeEventSQL+` FROM substantial_holder_notices h`)
		require.NoError(t, err)
		defer rows.Close()
		seen := 0
		for rows.Next() {
			var url, sqlEvent string
			require.NoError(t, rows.Scan(&url, &sqlEvent))
			assert.Equal(t, goEvent[url], sqlEvent, "event of %s", url)
			seen++
		}
		require.NoError(t, rows.Err())
		assert.Equal(t, len(wantOrder), seen)
		assert.Equal(t, "increased", goEvent["r1"])
		assert.Equal(t, "decreased", goEvent["d1"])
		assert.Equal(t, "ceased", goEvent["n04"])
		assert.Equal(t, "changed", goEvent["n05"], "a 604 with no previous figure")
		assert.Equal(t, "changed", goEvent["n07"], "a 604 whose figures are equal")
		assert.Equal(t, "changed", goEvent["n09"], "a 604 with neither figure")
		assert.Equal(t, "nz", goEvent["n06"])
	})

	t.Run("the kind is the institution's, corporate, or unclassified", func(t *testing.T) {
		kinds := map[string]string{}
		all, err := s.SubstantialNoticesPage(ctx, NoticeFilter{}, "", "", 100)
		require.NoError(t, err)
		for _, n := range all {
			kinds[n.AnnouncementURL] = n.Kind
		}
		assert.Equal(t, "bank_broker", kinds["n03"])
		assert.Equal(t, "hedge_fund", kinds["n05"])
		assert.Equal(t, "corporate", kinds["n06"])
		assert.Equal(t, "unclassified", kinds["n07"])
	})

	t.Run("the keyset pages every notice once, in order, cursor by cursor", func(t *testing.T) {
		for _, pageSize := range []int{1, 4} {
			var got []string
			cursorDate, cursorURL := "", ""
			for pages := 0; pages < len(wantOrder); pages++ {
				page, err := s.SubstantialNoticesPage(ctx, NoticeFilter{}, cursorDate, cursorURL, pageSize+1)
				require.NoError(t, err)
				if len(page) > pageSize {
					page = page[:pageSize]
				}
				for _, n := range page {
					got = append(got, n.AnnouncementURL)
				}
				if len(page) == 0 {
					break
				}
				last := page[len(page)-1]
				cursorDate, cursorURL = last.AnnouncedOn, last.AnnouncementURL
			}
			assert.Equal(t, wantOrder, got, "page size %d", pageSize)
		}
	})

	t.Run("the filters narrow each other and the total, the cursor aside", func(t *testing.T) {
		count := func(f NoticeFilter) int {
			t.Helper()
			n, err := s.CountSubstantialNotices(ctx, f)
			require.NoError(t, err)
			return n
		}
		assert.Equal(t, 17, count(NoticeFilter{}))
		assert.Equal(t, 16, count(NoticeFilter{Since: "2026-10-01"}), "September's notice is outside")
		assert.Equal(t, 7, count(NoticeFilter{Event: "increased"}))
		assert.Equal(t, 3, count(NoticeFilter{Event: "decreased"}))
		assert.Equal(t, 2, count(NoticeFilter{Event: "became"}))
		assert.Equal(t, 3, count(NoticeFilter{Event: "changed"}))
		assert.Equal(t, 2, count(NoticeFilter{Kind: "bank_broker"}))
		assert.Equal(t, 1, count(NoticeFilter{Kind: "corporate"}))
		assert.Equal(t, 10, count(NoticeFilter{StockCode: "BHP"}))
		assert.Equal(t, 11, count(NoticeFilter{HolderKey: "aaa-super"}))
		assert.Equal(t, 7, count(NoticeFilter{Since: "2026-10-01", Event: "increased", HolderKey: "aaa-super"}),
			"n02 and r1 to r6 are Aaa Super's increases")

		page, err := s.SubstantialNoticesPage(ctx, NoticeFilter{Event: "decreased"}, "", "", 10)
		require.NoError(t, err)
		var decreased []string
		for _, n := range page {
			decreased = append(decreased, n.AnnouncementURL)
		}
		assert.Equal(t, []string{"d2", "d1", "n03"}, decreased, "newest release first")
	})

	t.Run("the window's weeks and its largest moves", func(t *testing.T) {
		act, err := s.NoticeActivity(ctx, NoticeFilter{Since: "2026-10-01"})
		require.NoError(t, err)
		var weeks []string
		for _, w := range act.Weeks {
			weeks = append(weeks, w.WeekStart)
		}
		assert.Equal(t, []string{"2026-10-05", "2026-10-12", "2026-10-19"}, weeks,
			"only the weeks that hold notices; the service fills the rest")
		total := NoticeWeekRow{}
		for _, w := range act.Weeks {
			total.Became += w.Became
			total.Increased += w.Increased
			total.Decreased += w.Decreased
			total.Changed += w.Changed
			total.Ceased += w.Ceased
			total.NZ += w.NZ
		}
		assert.Equal(t, 2, total.Became)
		assert.Equal(t, 7, total.Increased)
		assert.Equal(t, 3, total.Decreased)
		assert.Equal(t, 2, total.Changed)
		assert.Equal(t, 1, total.Ceased)
		assert.Equal(t, 1, total.NZ)

		var rises, falls []string
		for _, n := range act.Rises {
			rises = append(rises, n.AnnouncementURL)
		}
		for _, n := range act.Falls {
			falls = append(falls, n.AnnouncementURL)
		}
		assert.Equal(t, []string{"r6", "r5", "r4", "r3", "r2"}, rises, "the five largest rises, the ties at +1 left out")
		assert.Equal(t, []string{"d2", "n03", "d1"}, falls, "the falls, largest first")
	})

	t.Run("the largest moves: both figures stated, ranked by size, then date, code and URL", func(t *testing.T) {
		moves, err := s.NoticeLargestMoves(ctx, "2026-10-01", "2026-10-31", "", 10)
		require.NoError(t, err)
		var urls []string
		for _, m := range moves {
			urls = append(urls, m.AnnouncementURL)
		}
		// Size 6, 5, then the two 4s: r4 before d2 by URL, as the same date and code tie.
		// Then 3, the 2s (r2 by its later date before n03), and the 1s (r1 before d1 by
		// URL, then n02 by its earlier date). Not ranked: n01, n06, n09, x|y and n07 (no
		// change or a figure missing), n04 (a 605 and a cessation), n05 (no previous figure).
		assert.Equal(t, []string{"r6", "r5", "r4", "d2", "r3", "r2", "n03", "r1", "d1", "n02"}, urls)

		capped, err := s.NoticeLargestMoves(ctx, "2026-10-01", "2026-10-31", "", 3)
		require.NoError(t, err)
		require.Len(t, capped, 3, "the limit caps the ranking")
		assert.Equal(t, "r6", capped[0].AnnouncementURL)

		byKind, err := s.NoticeLargestMoves(ctx, "2026-10-01", "2026-10-31", "super_fund", 10)
		require.NoError(t, err)
		for _, m := range byKind {
			assert.Equal(t, "Aaa Super", m.HolderName, "a kind keeps the holders of that kind only")
		}
		assert.NotEmpty(t, byKind)

		inWindow, err := s.NoticeLargestMoves(ctx, "2026-10-14", "2026-10-31", "", 10)
		require.NoError(t, err)
		var late []string
		for _, m := range inWindow {
			late = append(late, m.AnnouncementURL)
		}
		assert.NotContains(t, late, "n03", "released 13 October, before the window's start")
		assert.NotContains(t, late, "n02")
	})

	t.Run("a whole-register window keeps September's week", func(t *testing.T) {
		act, err := s.NoticeActivity(ctx, NoticeFilter{})
		require.NoError(t, err)
		var weeks []string
		for _, w := range act.Weeks {
			weeks = append(weeks, w.WeekStart)
		}
		assert.Equal(t, []string{"2026-08-31", "2026-10-05", "2026-10-12", "2026-10-19"}, weeks)
	})
}

// The desk's reads against Postgres (spec section 13): the window's change per
// stock, by kind and industry and by week, the feed's industry and release-date
// filters, and the index fund snapshots. The notices' change is read twice, by
// the SQL and by Delta, so the two cannot drift. It runs on the same disposable
// server as the reads above.
func TestOwnershipDeskAgainstPostgres(t *testing.T) {
	adminURL := os.Getenv("SHORTS_TEST_POSTGRES_URL")
	if adminURL == "" {
		t.Skip("SHORTS_TEST_POSTGRES_URL not set; skipping the real-Postgres desk test")
	}
	for _, shared := range []string{"supabase", "pooler", ":6543"} {
		if strings.Contains(adminURL, shared) {
			t.Fatalf("refusing a shared or pooled database (%q): this test creates and drops databases", shared)
		}
	}
	ctx := context.Background()
	pool := fundamentalsTestDatabase(t, ctx, adminURL)
	s := &postgresStore{db: pool}
	exec := func(sql string) {
		t.Helper()
		_, err := pool.Exec(ctx, sql)
		require.NoError(t, err)
	}
	exec(ownershipTestBaseSchema)

	t.Run("without 000137 the desk reads are empty, never an error", func(t *testing.T) {
		flows, err := s.NoticeFlowByStock(ctx, "2026-07-18", "2026-10-16")
		require.NoError(t, err)
		assert.Empty(t, flows)
		dates, err := s.FundSnapshotDates(ctx)
		require.NoError(t, err)
		assert.Empty(t, dates)
		weeks, err := s.NoticeWeeklyByIndustry(ctx, "2026-07-13", "2026-10-16", "")
		require.NoError(t, err)
		assert.Empty(t, weeks)
	})

	migration, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "migrations", "000137_add_ownership.up.sql"))
	require.NoError(t, err)
	exec(string(migration))
	exec(ownershipDeskSeed)

	const from, until = "2026-07-18", "2026-10-16"

	t.Run("the window's change per stock: a ceased notice falls, a 603 rises, an equal 604 is nothing", func(t *testing.T) {
		flows, err := s.NoticeFlowByStock(ctx, from, until)
		require.NoError(t, err)
		assert.Equal(t, NoticeFlow{Notices: 2, Net: -3, Has: true}, flowOf(flows, "BHP"), "+1 and -4")
		assert.Equal(t, NoticeFlow{Notices: 2, Net: 8, Has: true}, flowOf(flows, "PLS"), "+5 from a 603 and +3 from an nz with no previous figure")
		assert.Equal(t, NoticeFlow{Notices: 1, Net: 0, Has: true}, flowOf(flows, "CBA"), "an equal 604 states no change")
		assert.Equal(t, NoticeFlow{Notices: 1, Net: 0, Has: false}, flowOf(flows, "ZIP"), "a 604 with no figures states none")
		_, outside := flows["ZIP"]
		assert.True(t, outside, "ZIP's June notice is outside the window, so only its in-window notice counts")

		// The Go mirror of the SQL, read notice by notice, gives the same sums.
		notices, err := s.SubstantialNoticesPage(ctx, NoticeFilter{Since: from, Until: until}, "", "", 100)
		require.NoError(t, err)
		sums := map[string]float64{}
		for _, n := range notices {
			if d, ok := noticeDelta(n); ok {
				sums[n.StockCode] += d
			}
		}
		for code, f := range flows {
			if f.Has {
				assert.InDelta(t, f.Net, sums[code], 1e-9, "the Go Delta and the SQL agree for %s", code)
			}
		}
	})

	t.Run("the window's change by kind and industry, split by direction, in exposure", func(t *testing.T) {
		rows, err := s.NoticeChangesByKindIndustry(ctx, from, until)
		require.NoError(t, err)
		require.Len(t, rows, 3)
		byKey := map[string]NoticeChangeRow{}
		for _, r := range rows {
			byKey[r.Kind+"|"+r.Industry+"|"+strconv.FormatBool(r.Up)] = r
		}
		superUp := byKey["super_fund|Materials|true"]
		assert.Equal(t, 2, superUp.Notices, "d1 and d4 rise")
		assert.True(t, superUp.HasExposure)
		assert.InDelta(t, 1.0/100*2e11+3.0/100*3e9, superUp.ExposureAUD, 1, "each change over 100, times its stock's market cap")
		hedgeDown := byKey["hedge_fund|Materials|false"]
		assert.Equal(t, 1, hedgeDown.Notices)
		assert.InDelta(t, -4.0/100*2e11, hedgeDown.ExposureAUD, 1)
		hedgeUp := byKey["hedge_fund|Materials|true"]
		assert.InDelta(t, 5.0/100*3e9, hedgeUp.ExposureAUD, 1)
	})

	t.Run("each industry's notices by week, with the net change they state", func(t *testing.T) {
		weeks, err := s.NoticeWeeklyByIndustry(ctx, from, until, "")
		require.NoError(t, err)
		byKey := map[string]IndustryWeekRow{}
		for _, w := range weeks {
			byKey[w.Industry+"|"+w.WeekStart] = w
		}
		require.Len(t, weeks, 4)
		first := byKey["Materials|2026-09-28"]
		assert.Equal(t, 1, first.Became)
		assert.Equal(t, 1, first.Increased)
		assert.Equal(t, 1, first.NZ)
		require.NotNil(t, first.NetPP)
		assert.InDelta(t, 9, *first.NetPP, 1e-9, "+1, +5 and +3")
		second := byKey["Materials|2026-10-05"]
		assert.Equal(t, 1, second.Ceased)
		require.NotNil(t, second.NetPP)
		assert.InDelta(t, -4, *second.NetPP, 1e-9)
		banks := byKey["Banks|2026-10-05"]
		assert.Equal(t, 1, banks.Changed)
		require.NotNil(t, banks.NetPP, "an equal 604 states a figure, a zero change")
		assert.InDelta(t, 0, *banks.NetPP, 1e-9)
		fs := byKey["Financial Services|2026-10-05"]
		assert.Equal(t, 1, fs.Changed)
		assert.Nil(t, fs.NetPP, "a 604 with no figures has no net")
	})

	t.Run("the feed filters by industry and an inclusive release date", func(t *testing.T) {
		materials, err := s.SubstantialNoticesPage(ctx, NoticeFilter{Industry: "Materials", Until: "2026-10-04"}, "", "", 50)
		require.NoError(t, err)
		var urls []string
		for _, n := range materials {
			urls = append(urls, n.AnnouncementURL)
		}
		assert.ElementsMatch(t, []string{"d1", "d3", "d4"}, urls, "BHP and PLS through 4 October")
		count, err := s.CountSubstantialNotices(ctx, NoticeFilter{Industry: "Materials", Until: "2026-10-04"})
		require.NoError(t, err)
		assert.Equal(t, 3, count)
		inclusive, err := s.CountSubstantialNotices(ctx, NoticeFilter{Industry: "Materials", Until: "2026-10-05"})
		require.NoError(t, err)
		assert.Equal(t, 4, inclusive, "until is inclusive: BHP's 5 October notice is in")
	})

	t.Run("the snapshot dates, and the fund pairs on two of them", func(t *testing.T) {
		dates, err := s.FundSnapshotDates(ctx)
		require.NoError(t, err)
		assert.Equal(t, []string{"2026-06-30", "2026-09-30", "2026-10-15"}, dates)

		pairs, err := s.FundPositionPairs(ctx, "2026-09-30", "2026-10-15")
		require.NoError(t, err)
		byKey := map[string]FundPositionPair{}
		for _, p := range pairs {
			byKey[p.StockCode+"|"+p.InstitutionSlug] = p
		}
		require.Len(t, pairs, 4, "IOZ has no file on 30 September, so it is not compared")
		zip := byKey["ZIP|vanguard"]
		assert.True(t, zip.InFrom && zip.InTo)
		require.NotNil(t, zip.FromWeight)
		require.NotNil(t, zip.ToWeight)
		assert.InDelta(t, 0.1, *zip.FromWeight, 1e-9)
		assert.InDelta(t, 0.2, *zip.ToWeight, 1e-9)
		wbc := byKey["WBC|vanguard"]
		assert.True(t, wbc.InFrom)
		assert.False(t, wbc.InTo, "held on 30 September, gone by 15 October")
		pls := byKey["PLS|vanguard"]
		assert.False(t, pls.InFrom)
		assert.True(t, pls.InTo)
		bhp := byKey["BHP|hostplus"]
		assert.True(t, bhp.InFrom && bhp.InTo, "Balanced's newest file at or before each date is the June one")
	})

	t.Run("one stock's weight in each fund, at each file, grouped by fund", func(t *testing.T) {
		series, err := s.StockFundSeries(ctx, "BHP")
		require.NoError(t, err)
		require.Len(t, series, 2)
		assert.Equal(t, "blackrock", series[0].InstitutionSlug, "ordered by institution")
		assert.Equal(t, "2026-10-15", series[0].AsAt)
		assert.Equal(t, "hostplus", series[1].InstitutionSlug)
		assert.Equal(t, "super_phd", series[1].SourceKind)
		require.NotNil(t, series[1].Weight)
		assert.InDelta(t, 0.7, *series[1].Weight, 1e-9)
	})

	// The explorer's reads over the same fixture. ASIC's shares on issue come from
	// the shorts table, so these rows are added here, after every desk assertion.
	exec(`INSERT INTO shorts ("DATE", "PRODUCT", "PRODUCT_CODE", "REPORTED_SHORT_POSITIONS", "TOTAL_PRODUCT_IN_ISSUE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS") VALUES
		('2026-06-20', 'BHP GROUP', 'BHP', 1, 2000, 1),
		('2026-10-14', 'BHP GROUP', 'BHP', 1, 1000, 1),
		('2026-10-16', 'BHP GROUP', 'BHP', 1, 1100, 1),
		('2026-06-01', 'WESTPAC', 'WBC', 1, 500, 1)`)

	t.Run("the fund files, by institution then fund then date", func(t *testing.T) {
		files, err := s.FundFiles(ctx)
		require.NoError(t, err)
		var ids []int64
		for _, f := range files {
			ids = append(ids, f.ID)
		}
		assert.Equal(t, []int64{4, 3, 1, 2}, ids, "blackrock IOZ, hostplus Balanced, then vanguard VAS on each date")
		assert.Equal(t, "blackrock", files[0].InstitutionName, "an institution with no row reads its slug")
		assert.Equal(t, "vanguard", files[2].InstitutionSlug)
	})

	t.Run("a holding is named by the company, else the file; shares come from the report on or before the file, within 30 days", func(t *testing.T) {
		plain, err := s.FundHoldingsOf(ctx, []int64{1, 3, 4}, false)
		require.NoError(t, err)
		for _, h := range plain {
			assert.Nil(t, h.SharesIssued, "shares are read only when asked")
			assert.Empty(t, h.SharesAsAt)
		}

		rows, err := s.FundHoldingsOf(ctx, []int64{1, 3, 4}, true)
		require.NoError(t, err)
		byFile := map[string]FundHoldingDetail{}
		for _, h := range rows {
			byFile[strconv.FormatInt(h.SnapshotID, 10)+"|"+h.StockCode] = h
		}
		bhpSpring := byFile["3|BHP"]
		assert.Equal(t, "BHP Group Limited", bhpSpring.SecurityName, "company-metadata's name, not the file's")
		assert.Equal(t, "Materials", bhpSpring.Industry)
		require.NotNil(t, bhpSpring.SharesIssued)
		assert.InDelta(t, 2000, *bhpSpring.SharesIssued, 1e-9, "20 June is 10 days before the 30 June file")
		assert.Equal(t, "2026-06-20", bhpSpring.SharesAsAt)

		bhpAutumn := byFile["4|BHP"]
		require.NotNil(t, bhpAutumn.SharesIssued)
		assert.InDelta(t, 1000, *bhpAutumn.SharesIssued, 1e-9, "the 14 October report, not the 16 October one that follows the file")
		assert.Equal(t, "2026-10-14", bhpAutumn.SharesAsAt)

		wbc := byFile["1|WBC"]
		assert.Equal(t, "WESTPAC", wbc.SecurityName, "not in company-metadata: the file's name")
		assert.Nil(t, wbc.SharesIssued, "a report 121 days before the file is too old to use")
		assert.Empty(t, wbc.SharesAsAt)

		zip := byFile["1|ZIP"]
		assert.Equal(t, "Zip Co Limited", zip.SecurityName)
		assert.Nil(t, zip.SharesIssued, "no ASIC row at all is nil, not zero")
	})

	t.Run("two files compared by stock: continuing, new and dropped, with each side's name", func(t *testing.T) {
		rows, err := s.FundCompareRows(ctx, 1, 2)
		require.NoError(t, err)
		byCode := map[string]FundCompareRow{}
		for _, r := range rows {
			byCode[r.StockCode] = r
		}
		require.Len(t, rows, 3)

		zip := byCode["ZIP"]
		assert.True(t, zip.InFrom && zip.InTo, "held on both dates")
		assert.Equal(t, "Zip Co Limited", zip.SecurityName)
		assert.Equal(t, "Financial Services", zip.Industry)
		require.NotNil(t, zip.FromWeight)
		require.NotNil(t, zip.ToWeight)
		assert.InDelta(t, 0.1, *zip.FromWeight, 1e-9)
		assert.InDelta(t, 0.2, *zip.ToWeight, 1e-9)

		wbc := byCode["WBC"]
		assert.True(t, wbc.InFrom && !wbc.InTo, "dropped: only on the earlier file")
		assert.Equal(t, "WESTPAC", wbc.SecurityName, "no company-metadata row: the earlier file's name")
		assert.Nil(t, wbc.ToWeight)

		pls := byCode["PLS"]
		assert.True(t, !pls.InFrom && pls.InTo, "new: only on the later file")
		assert.Equal(t, "PLS Group", pls.SecurityName)
		require.NotNil(t, pls.ToValue)
		assert.InDelta(t, 9e8, *pls.ToValue, 1)
	})

	t.Run("a kind narrows the weekly activity to the notices of holders of that kind", func(t *testing.T) {
		all, err := s.NoticeWeeklyByIndustry(ctx, from, until, "")
		require.NoError(t, err)
		supers, err := s.NoticeWeeklyByIndustry(ctx, from, until, "super_fund")
		require.NoError(t, err)
		require.Len(t, supers, 2, "Materials in the week of 28 September and Banks in the week of 5 October")
		require.Less(t, len(supers), len(all))
		byKey := map[string]IndustryWeekRow{}
		for _, w := range supers {
			byKey[w.Industry+"|"+w.WeekStart] = w
		}
		assert.Equal(t, 1, byKey["Materials|2026-09-28"].Increased, "BHP's rise by Aaa Super")
		assert.Equal(t, 0, byKey["Materials|2026-09-28"].Became, "PLS's 603 is Ccc Hedge's, not a super fund's")
		assert.Equal(t, 1, byKey["Banks|2026-10-05"].Changed)
	})
}

func flowOf(flows map[string]NoticeFlow, code string) NoticeFlow {
	return flows[code]
}

// ownershipDeskSeed is the desk's notices, a stock and an institution set, and
// the fund snapshots the desk's pairs and series read.
const ownershipDeskSeed = `
INSERT INTO "company-metadata" VALUES ('BHP', 'BHP Group Limited', 'Materials', 200000000000),
	('PLS', 'PLS Group', 'Materials', 3000000000), ('CBA', 'Commonwealth Bank of Australia', 'Banks', 250000000000),
	('ZIP', 'Zip Co Limited', 'Financial Services', 1500000000);
INSERT INTO ownership_institutions (slug, name, kind) VALUES
	('aaa-super', 'Aaa Super', 'super_fund'), ('ccc-hedge', 'Ccc Hedge', 'hedge_fund');
INSERT INTO substantial_holder_notices (announcement_url, stock_code, form, holder_name, holder_key, institution_slug,
	event_date, announced_on, previous_pct, present_pct, present_votes, ceased, parser_version) VALUES
	('d1', 'BHP', '604', 'Aaa Super', 'aaa-super', 'aaa-super', NULL, '2026-10-02', 5, 6, NULL, false, 1),
	('d2', 'BHP', '605', 'Ccc Hedge', 'ccc-hedge', 'ccc-hedge', '2026-10-01', '2026-10-05', 4, NULL, NULL, true, 1),
	('d3', 'PLS', '603', 'Ccc Hedge', 'ccc-hedge', 'ccc-hedge', NULL, '2026-10-03', NULL, 5, NULL, false, 1),
	('d4', 'PLS', 'nz', 'Aaa Super', 'aaa-super', 'aaa-super', NULL, '2026-10-04', NULL, 3, NULL, false, 1),
	('d5', 'ZIP', '604', 'Aaa Super', 'aaa-super', 'aaa-super', NULL, '2026-06-01', 6, 5.5, NULL, false, 1),
	('d6', 'CBA', '604', 'Aaa Super', 'aaa-super', 'aaa-super', NULL, '2026-10-06', 5, 5, NULL, false, 1),
	('d7', 'ZIP', '604', 'Ccc Hedge', 'ccc-hedge', 'ccc-hedge', NULL, '2026-10-07', NULL, NULL, NULL, false, 1);
INSERT INTO fund_holding_snapshots (id, institution_slug, fund_name, fund_code, source_kind, source_url, as_at) VALUES
	(1, 'vanguard', 'VAS', 'VAS', 'etf', 'x', '2026-09-30'),
	(2, 'vanguard', 'VAS', 'VAS', 'etf', 'x', '2026-10-15'),
	(3, 'hostplus', 'Balanced', NULL, 'super_phd', 'x', '2026-06-30'),
	(4, 'blackrock', 'IOZ', 'IOZ', 'etf', 'x', '2026-10-15');
INSERT INTO fund_holdings (snapshot_id, stock_code, security_name, units, value_aud, weight_pct, match_method) VALUES
	(1, 'ZIP', 'ZIP CO', 1000, 1500, 0.1, 'ticker'),
	(1, 'WBC', 'WESTPAC', 500, 4000000000, 0.4, 'ticker'),
	(2, 'ZIP', 'ZIP CO', 2000, 3000, 0.2, 'ticker'),
	(2, 'PLS', 'PLS GROUP', 9000, 900000000, 0.3, 'ticker'),
	(3, 'BHP', 'BHP GROUP', 26000000, 1400000000, 0.7, 'ticker'),
	(4, 'BHP', 'BHP GROUP', 1800000, 1000000000, 0.9, 'ticker');
`

// noticeDelta is the change in voting power a notice states, in percentage points,
// as noticeDeltaSQL decides it. ok is false when the notice states no change. A
// ceased notice counts its previous figure as a fall; a notice with no previous
// figure counts its present figure as a rise (a 603); otherwise the difference.
func noticeDelta(r SubstantialNoticeRow) (float64, bool) {
	switch {
	case r.Ceased || r.Form == "605":
		if r.PreviousPct == nil {
			return 0, false
		}
		return -*r.PreviousPct, true
	case r.PreviousPct == nil:
		if r.PresentPct == nil {
			return 0, false
		}
		return *r.PresentPct, true
	case r.PresentPct == nil:
		return 0, false
	}
	return *r.PresentPct - *r.PreviousPct, true
}
