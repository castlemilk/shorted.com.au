//go:build integration

package shorts

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// crawlOpsTestStore builds the ledger tables the crawl ops queries read, from the real
// migrations 000150 to 000152. Migration 000150 alters two listing tables this test does not
// need, so stand-ins with the same names let its guarded ALTERs run as they do in production.
func crawlOpsTestStore(t *testing.T) *postgresStore {
	t.Helper()
	adminURL, err := testpostgres.Admin("SHORTS_TEST_POSTGRES_URL", "CRAWL_OPS_TESTCONTAINERS")
	require.NoError(t, err, "start the crawl ops PostgreSQL container")
	if adminURL == "" {
		t.Skip("neither SHORTS_TEST_POSTGRES_URL nor CRAWL_OPS_TESTCONTAINERS=1 is set; skipping the real-Postgres crawl ops tests")
	}
	pool, cleanup := isolatedTestDatabase(t, adminURL, "crawl_ops")
	t.Cleanup(cleanup)
	ctx := context.Background()
	_, err = pool.Exec(ctx, `
		CREATE TABLE property_listings (id BIGSERIAL PRIMARY KEY);
		CREATE TABLE property_price_events (id BIGSERIAL PRIMARY KEY);`)
	require.NoError(t, err)
	for _, file := range []string{
		"000150_add_crawl_ingest.up.sql",
		"000151_add_crawl_finalize_state.up.sql",
		"000152_add_crawl_ingest_receipt_audit.up.sql",
		"000153_add_crawl_ops_indexes.up.sql",
	} {
		sql, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "migrations", file))
		require.NoError(t, err)
		_, err = pool.Exec(ctx, string(sql))
		require.NoError(t, err, file)
	}
	return &postgresStore{db: pool}
}

// seedCrawlLedger writes a small ledger: one run with an open job, a closed job, an expired
// job and a job whose id is a prefix of another's, plus receipts and a quarantine row.
func seedCrawlLedger(t *testing.T, s *postgresStore) {
	t.Helper()
	ctx := context.Background()
	_, err := s.db.Exec(ctx, `
		INSERT INTO crawl_dispatch (job_id, run_id, selection, suburb, state, postcode, source, created_at, expires_at, closed_at) VALUES
		  ('job-a',  'smoke-20261031T093000Z-0a1b2c3d', 'smoke', 'Bondi', 'NSW', '2026', 'rea',    now(), now() + interval '2 hours', NULL),
		  ('job-b',  'smoke-20261031T093000Z-0a1b2c3d', 'smoke', 'Bondi', 'NSW', '2026', 'domain', now(), now() + interval '2 hours', now()),
		  ('job-c',  'delta-20261031T080000Z',          'delta', 'Manly', 'NSW', '2095', 'rea',    now(), now() - interval '1 hour',  NULL),
		  ('job-ab', 'delta-20261031T080000Z',          'delta', 'Manly', 'NSW', '2095', 'rea',    now(), now() + interval '5 days',  NULL)`)
	require.NoError(t, err)
	_, err = s.db.Exec(ctx, `
		INSERT INTO crawl_ingest_receipts (key, rig_subject, body_sha256, response, created_at) VALUES
		  ('job-a:1:rea',  'rig:rig-1', '\x00', '{"appliedStatus":"SWEEP_STATUS_COMPLETE","listingsUpserted":4,"events":2,"delisted":1}', now() - interval '10 minutes'),
		  ('job-a:2:rea',  'rig:rig-1', '\x00', '{"appliedStatus":"SWEEP_STATUS_BLOCKED","quarantined":false,"poisoned":true}',        now() - interval '5 minutes'),
		  ('job-b:1:domain','rig:rig-2','\x00', '{"appliedStatus":"SWEEP_STATUS_PARTIAL","listingsUpserted":2,"replayed":true}',     now() - interval '3 hours'),
		  ('job-ab:1:rea', 'rig:rig-1', '\x00', '{"appliedStatus":"SWEEP_STATUS_COMPLETE","listingsUpserted":7}',                    now() - interval '1 minute'),
		  ('foreign-key',  'rig:rig-1', '\x00', '{"appliedStatus":"SWEEP_STATUS_COMPLETE","listingsUpserted":1}',                    now() - interval '1 minute')`)
	require.NoError(t, err)
	_, err = s.db.Exec(ctx, `
		INSERT INTO crawl_ingest_quarantine (receipt_key, rig_subject, job_id, reason, created_at) VALUES
		  ('job-a:2:rea', 'rig:rig-1', 'job-a', 'mass_delist', now() - interval '5 minutes'),
		  ('job-b:1:domain', 'rig:rig-2', 'job-b', 'large_moves', now() - interval '3 hours')`)
	require.NoError(t, err)
	_, err = s.db.Exec(ctx, `INSERT INTO crawl_finalize_state (name, watermark) VALUES ('crawl-finalize', now() - interval '20 minutes')`)
	require.NoError(t, err)
}

func TestCrawlOpsCountsOpenAndExpiringDispatches(t *testing.T) {
	s := crawlOpsTestStore(t)
	seedCrawlLedger(t, s)
	open, soon, err := s.CrawlDispatchOpen(context.Background())
	require.NoError(t, err)
	// job-a and job-ab are open (job-ab expires in five days). job-b is closed, job-c expired.
	assert.Equal(t, int64(2), open)
	assert.Equal(t, int64(1), soon, "only job-a expires within 24 hours")
}

func TestCrawlOpsGroupsReceiptsByPortalStatusAndSuburb(t *testing.T) {
	s := crawlOpsTestStore(t)
	seedCrawlLedger(t, s)
	ctx := context.Background()

	groups, err := s.CrawlReceiptGroups(ctx, time.Now().Add(-time.Hour), "", nil)
	require.NoError(t, err)
	got := map[string]int64{}
	for _, g := range groups {
		got[g.Source+"|"+g.AppliedStatus+"|"+g.Suburb] = g.Count
	}
	assert.Equal(t, int64(1), got["rea|SWEEP_STATUS_COMPLETE|Bondi"], "job-a's COMPLETE, ten minutes old")
	assert.Equal(t, int64(1), got["rea|SWEEP_STATUS_COMPLETE|Manly"], "job-ab's COMPLETE, one minute old")
	assert.Equal(t, int64(1), got["rea|SWEEP_STATUS_BLOCKED|Bondi"])
	assert.Equal(t, int64(1), got["unknown|SWEEP_STATUS_COMPLETE|"], "a receipt with no ledger row reads as unknown, not dropped")
	assert.NotContains(t, got, "domain|SWEEP_STATUS_PARTIAL|Bondi", "job-b's receipt is three hours old")

	blocked, err := s.CrawlReceiptGroups(ctx, time.Now().Add(-24*time.Hour), "", []string{"SWEEP_STATUS_BLOCKED", "SWEEP_STATUS_PARTIAL"})
	require.NoError(t, err)
	require.Len(t, blocked, 2, "the status filter keeps only the failing receipts: job-a BLOCKED and job-b PARTIAL")
	for _, g := range blocked {
		assert.Contains(t, []string{"SWEEP_STATUS_BLOCKED", "SWEEP_STATUS_PARTIAL"}, g.AppliedStatus)
	}

	forRig2, err := s.CrawlReceiptGroups(ctx, time.Now().Add(-24*time.Hour), "rig:rig-2", nil)
	require.NoError(t, err)
	require.Len(t, forRig2, 1, "the rig filter keeps one rig's receipts")
	assert.Equal(t, "domain", forRig2[0].Source)
}

func TestCrawlOpsQuarantineReasonsAndWatermark(t *testing.T) {
	s := crawlOpsTestStore(t)
	seedCrawlLedger(t, s)
	ctx := context.Background()
	reasons, err := s.CrawlQuarantineReasons(ctx, time.Now().Add(-24*time.Hour), "rig:rig-1")
	require.NoError(t, err)
	require.Len(t, reasons, 1)
	assert.Equal(t, "mass_delist", reasons[0].Reason)

	w, u, ok, err := s.CrawlFinalizeWatermark(ctx)
	require.NoError(t, err)
	assert.True(t, ok)
	assert.False(t, w.IsZero())
	assert.False(t, u.IsZero())

	_, err = s.db.Exec(ctx, `DELETE FROM crawl_finalize_state`)
	require.NoError(t, err)
	_, _, ok, err = s.CrawlFinalizeWatermark(ctx)
	require.NoError(t, err)
	assert.False(t, ok, "no finalize has run: the cursor is absent, not zero")
}

// A suburb is queued while it has an open row, for either portal; a closed or expired row
// does not count. The slug matches the display name ("Bondi" is "bondi").
func TestCrawlOpsFindsOpenDispatchesBySuburbSlug(t *testing.T) {
	s := crawlOpsTestStore(t)
	seedCrawlLedger(t, s)
	ctx := context.Background()

	bondi, err := s.CrawlOpenDispatchForSuburb(ctx, "bondi")
	require.NoError(t, err)
	require.Len(t, bondi, 1, "job-a is open; job-b is closed")
	assert.Equal(t, "job-a", bondi[0].JobID)

	manly, err := s.CrawlOpenDispatchForSuburb(ctx, "manly")
	require.NoError(t, err)
	assert.Len(t, manly, 1, "job-ab is open")

	none, err := s.CrawlOpenDispatchForSuburb(ctx, "no-such-suburb")
	require.NoError(t, err)
	assert.Empty(t, none)
}

func TestCrawlOpsRowsForARunAndAJob(t *testing.T) {
	s := crawlOpsTestStore(t)
	seedCrawlLedger(t, s)
	ctx := context.Background()

	run, err := s.CrawlDispatchForRun(ctx, "smoke-20261031T093000Z-0a1b2c3d")
	require.NoError(t, err)
	require.Len(t, run, 2)
	assert.Equal(t, "smoke", run[0].Selection)

	job, err := s.CrawlDispatchForJob(ctx, "job-a")
	require.NoError(t, err)
	require.NotNil(t, job)
	assert.Equal(t, "Bondi", job.Suburb)
	assert.Nil(t, job.ClosedAt)

	none, err := s.CrawlDispatchForJob(ctx, "no-such-job")
	require.NoError(t, err)
	assert.Nil(t, none, "a job with no ledger row is nil, not an error")
}

// The receipt prefix is job id plus colon: job-a must not pick up job-ab's receipts.
func TestCrawlOpsReceiptsForAJobAreExactAndCountsOnly(t *testing.T) {
	s := crawlOpsTestStore(t)
	seedCrawlLedger(t, s)
	ctx := context.Background()

	recs, err := s.CrawlReceiptsForJob(ctx, "job-a")
	require.NoError(t, err)
	require.Len(t, recs, 2)
	assert.Equal(t, "job-a:1:rea", recs[0].Key)
	assert.Equal(t, "rig:rig-1", recs[0].RigSubject, "a receipt names the rig that pushed it")
	assert.Equal(t, "SWEEP_STATUS_COMPLETE", recs[0].AppliedStatus)
	assert.Equal(t, 4, recs[0].ListingsUpserted)
	assert.Equal(t, 2, recs[0].Events)
	assert.Equal(t, 1, recs[0].Delisted)
	assert.True(t, recs[1].Poisoned)
	assert.False(t, recs[1].Replayed)

	qs, err := s.CrawlQuarantineForJob(ctx, "job-a")
	require.NoError(t, err)
	require.Len(t, qs, 1)
	assert.Equal(t, "mass_delist", qs[0].Reason)
}

// The three indexes of 000153 exist after the migration, under the names the queries and the
// migration test rely on.
func TestCrawlOpsIndexesExist(t *testing.T) {
	s := crawlOpsTestStore(t)
	for _, name := range []string{"idx_crawl_ingest_receipts_job_id", "idx_crawl_dispatch_run_id", "idx_crawl_dispatch_open_suburb"} {
		var n int
		err := s.db.QueryRow(context.Background(), `SELECT count(*) FROM pg_indexes WHERE indexname = $1`, name).Scan(&n)
		require.NoError(t, err)
		assert.Equal(t, 1, n, "index %s is missing", name)
	}
}

// Every crawl-ops read runs in a READ ONLY transaction: a write attempted inside it is refused.
func TestCrawlOpsReadsCannotWrite(t *testing.T) {
	s := crawlOpsTestStore(t)
	err := s.crawlOpsRead(context.Background(), func(tx pgx.Tx) error {
		_, err := tx.Exec(context.Background(), `INSERT INTO crawl_finalize_state (name, watermark) VALUES ('x', now())`)
		return err
	})
	require.Error(t, err, "a write inside the crawl-ops read transaction must be refused")
	assert.Contains(t, err.Error(), "read-only")
}

// The statement timeout is set on every read: a slow statement is cancelled, not held open.
func TestCrawlOpsReadsCarryTheStatementTimeout(t *testing.T) {
	s := crawlOpsTestStore(t)
	var got string
	err := s.crawlOpsRead(context.Background(), func(tx pgx.Tx) error {
		return tx.QueryRow(context.Background(), `SHOW statement_timeout`).Scan(&got)
	})
	require.NoError(t, err)
	assert.Equal(t, "5s", got)
}

// A replay of 000153 with the indexes already present takes no table lock: a receipt insert held open
// by another writer does not block it, even under a one-second lock timeout. CREATE INDEX IF NOT EXISTS
// would wait here, which is why each index is catalog-guarded.
func TestMigrationReplayTakesNoLock_Integration(t *testing.T) {
	s := crawlOpsTestStore(t)
	ctx := context.Background()

	writer, err := s.db.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = writer.Rollback(ctx) }()
	_, err = writer.Exec(ctx, `INSERT INTO crawl_ingest_receipts (key, rig_subject, body_sha256, response) VALUES ('w:1:rea','rig:rig-1','\x00','{}')`)
	require.NoError(t, err)

	replay := migrationSQL(t, "000153_add_crawl_ops_indexes.up.sql")
	replay = strings.Replace(replay, "lock_timeout = '15s'", "lock_timeout = '1s'", 1)
	_, err = s.db.Exec(ctx, replay)
	require.NoError(t, err, "a replay with the indexes present must not wait on the open insert")
}

// A replay rebuilds an index that is missing, and leaves a valid one alone.
func TestMigrationReplayRebuildsAMissingIndex_Integration(t *testing.T) {
	s := crawlOpsTestStore(t)
	ctx := context.Background()
	_, err := s.db.Exec(ctx, `DROP INDEX idx_crawl_dispatch_run_id`)
	require.NoError(t, err)
	_, err = s.db.Exec(ctx, migrationSQL(t, "000153_add_crawl_ops_indexes.up.sql"))
	require.NoError(t, err)
	var n int
	require.NoError(t, s.db.QueryRow(ctx, `SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_crawl_dispatch_run_id'`).Scan(&n))
	assert.Equal(t, 1, n, "the replay must rebuild the missing index")
}

// Each query the admin tools run uses its index on a table of realistic size. The plans are read after
// ANALYZE, so the planner has the statistics it has in prod.
func TestCrawlOpsQueriesUseTheirIndexes_Integration(t *testing.T) {
	s := crawlOpsTestStore(t)
	ctx := context.Background()
	_, err := s.db.Exec(ctx, `
		INSERT INTO crawl_dispatch (job_id, run_id, selection, suburb, state, postcode, source, created_at, expires_at, closed_at)
		SELECT 'job-'||g, 'delta-'||(g/1000), 'delta', 'Suburb '||(g % 500), 'NSW', '2000', CASE WHEN g%2=0 THEN 'rea' ELSE 'domain' END,
		       now(), now() + interval '2 days', CASE WHEN g % 3 = 0 THEN NULL ELSE now() END
		FROM generate_series(1, 20000) g;
		INSERT INTO crawl_ingest_receipts (key, rig_subject, body_sha256, response, created_at)
		SELECT 'job-'||g||':1:rea', 'rig:rig-1', '\x00', '{"appliedStatus":"SWEEP_STATUS_COMPLETE","listingsUpserted":3}', now()
		FROM generate_series(1, 20000) g;
		ANALYZE crawl_dispatch; ANALYZE crawl_ingest_receipts;`)
	require.NoError(t, err)

	cases := []struct {
		name, sql, arg, index string
	}{
		{"receipts by job", `SELECT key FROM crawl_ingest_receipts WHERE split_part(key, ':', 1) = $1 ORDER BY created_at, key`, "job-77", "idx_crawl_ingest_receipts_job_id"},
		{"ledger by run", `SELECT job_id FROM crawl_dispatch WHERE run_id = $1 ORDER BY created_at, job_id`, "delta-7", "idx_crawl_dispatch_run_id"},
		{"open rows by suburb", `SELECT job_id FROM crawl_dispatch WHERE lower(replace(suburb, ' ', '-')) = $1 AND closed_at IS NULL AND expires_at > now() ORDER BY created_at, job_id`, "suburb-42", "idx_crawl_dispatch_open_suburb"},
	}
	for _, c := range cases {
		rows, err := s.db.Query(ctx, "EXPLAIN "+c.sql, c.arg)
		require.NoError(t, err)
		var plan []string
		for rows.Next() {
			var l string
			require.NoError(t, rows.Scan(&l))
			plan = append(plan, l)
		}
		rows.Close()
		assert.Contains(t, strings.Join(plan, "\n"), c.index, "%s does not use %s:\n%s", c.name, c.index, strings.Join(plan, "\n"))
	}
}

// migrationSQL reads one migration file from services/migrations.
func migrationSQL(t *testing.T, name string) string {
	t.Helper()
	sql, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "migrations", name))
	require.NoError(t, err)
	return string(sql)
}
