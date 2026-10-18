package shorts

import (
	"context"
	"os"
	"path/filepath"
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
