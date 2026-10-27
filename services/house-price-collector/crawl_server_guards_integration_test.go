package main

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/oauth2"
)

// Guards for the server jobs: the MV refresh's skip notices, the late-commit watermark, the
// BrandBrain reply echo, the finalize lease, the empty-run row, the dispatch-ledger prune and
// the enqueue's safe-first-run flags. The DB tests use openServerTestPool and skip without a
// Postgres, as crawl_server_integration_test.go does.

func closeTo(a, b time.Time) bool {
	d := a.Sub(b)
	return d < time.Millisecond && d > -time.Millisecond
}

// stubRefreshFunction installs a refresh_housing_materialized_views() in the test schema with the
// body given. Migration 000127's real function is not in the test schema.
func stubRefreshFunction(t *testing.T, pool *pgxpool.Pool, body string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		CREATE OR REPLACE FUNCTION refresh_housing_materialized_views() RETURNS void
		LANGUAGE plpgsql AS $fn$ BEGIN `+body+` END $fn$;`); err != nil {
		t.Fatalf("stub refresh function: %v", err)
	}
}

// TestRefreshHousingMVChecked_SkippedViewFails_Integration: 000127 reports a failed view as a
// WARNING and still returns OK. The check must turn that into an error.
func TestRefreshHousingMVChecked_SkippedViewFails_Integration(t *testing.T) {
	pool := openServerTestPool(t)
	stubRefreshFunction(t, pool, `RAISE WARNING 'Skipping mv_suburb_price_drops: boom';`)
	err := refreshHousingMVChecked(context.Background(), pool)
	if err == nil || !strings.Contains(err.Error(), "mv_suburb_price_drops") {
		t.Fatalf("a skipped view must fail the refresh and name it, got %v", err)
	}
}

func TestRefreshHousingMVChecked_CleanRefreshPasses_Integration(t *testing.T) {
	pool := openServerTestPool(t)
	stubRefreshFunction(t, pool, `RAISE NOTICE 'Refreshing mv_housing_headline';`)
	if err := refreshHousingMVChecked(context.Background(), pool); err != nil {
		t.Fatalf("a refresh with no skips must pass, got %v", err)
	}
}

// TestCrawlFinalize_SkippedRefreshHoldsCursorAndBust_Integration: a partial refresh must not bust
// the cache and must not advance the cursor, so the next run retries the same data.
func TestCrawlFinalize_SkippedRefreshHoldsCursorAndBust_Integration(t *testing.T) {
	pool := openServerTestPool(t)
	stubRefreshFunction(t, pool, `RAISE WARNING 'Skipping mv_housing_headline: boom';`)
	ctx := context.Background()
	now := time.Now().UTC()
	insertReceipt(t, pool, "a", now.Add(-5*time.Minute))

	ops := finalizeOps{
		linkSuburb:     func(context.Context) error { return nil },
		linkListing:    func(context.Context) error { return nil },
		linkPriceEvent: func(context.Context) error { return nil },
		refreshMV:      func(ctx context.Context) error { return refreshHousingMVChecked(ctx, pool) },
		revalidate:     func(string) { t.Error("the cache bust ran after a skipped view") },
	}
	if _, err := crawlFinalize(ctx, pool, ops, now); err == nil {
		t.Fatal("a skipped view must fail the finalize")
	}
	if _, ok := watermarkOf(t, pool); ok {
		t.Fatal("the cursor moved although a view was skipped")
	}
}

// TestCrawlFinalize_LateCommitIsNotSkipped_Integration: a push whose receipt is stamped at
// transaction start (created_at = now-2m) and commits after a run that saw a newer receipt
// (created_at = now-1m) must still be picked up by the next run.
func TestCrawlFinalize_LateCommitIsNotSkipped_Integration(t *testing.T) {
	pool := openServerTestPool(t)
	ctx := context.Background()
	now := time.Now().UTC()

	insertReceipt(t, pool, "fast", now.Add(-1*time.Minute))
	var rec finalizeRecorder
	if _, err := crawlFinalize(ctx, pool, rec.ops(), now); err != nil {
		t.Fatalf("first finalize: %v", err)
	}

	// The slow push: started two minutes ago, commits only now.
	insertReceipt(t, pool, "slow", now.Add(-2*time.Minute))
	rec.calls = nil
	ran, err := crawlFinalize(ctx, pool, rec.ops(), now.Add(30*time.Minute))
	if err != nil {
		t.Fatalf("second finalize: %v", err)
	}
	if !ran {
		t.Fatal("the late-committed receipt was skipped: the cursor had moved past its created_at")
	}
}

// TestCrawlFinalize_CursorHeldBehindRunStart_Integration pins the watermark rule directly.
func TestCrawlFinalize_CursorHeldBehindRunStart_Integration(t *testing.T) {
	pool := openServerTestPool(t)
	ctx := context.Background()
	now := time.Now().UTC()
	insertReceipt(t, pool, "fresh", now.Add(-30*time.Second))
	var rec finalizeRecorder
	if _, err := crawlFinalize(ctx, pool, rec.ops(), now); err != nil {
		t.Fatalf("finalize: %v", err)
	}
	wm, ok := watermarkOf(t, pool)
	if !ok || !closeTo(wm, now.Add(-crawlWatermarkMargin)) {
		t.Fatalf("cursor = %s (ok=%v), want run start minus %s", wm, ok, crawlWatermarkMargin)
	}
}

// TestRunCrawlFinalizeWith_HeldLeaseSkips_Integration: while another run holds the lease, this run
// does no work and exits 0. When the lease lapses, it takes over.
func TestRunCrawlFinalizeWith_HeldLeaseSkips_Integration(t *testing.T) {
	pool := openServerTestPool(t)
	ctx := context.Background()
	now := time.Now().UTC()
	insertReceipt(t, pool, "a", now.Add(-5*time.Minute))

	got, err := claimFinalizeLease(ctx, pool, "holder-a", finalizeLeaseTTL)
	if err != nil || !got {
		t.Fatalf("holder-a should claim a free lease: ok=%v err=%v", got, err)
	}
	if got, _ := claimFinalizeLease(ctx, pool, "holder-b", finalizeLeaseTTL); got {
		t.Fatal("holder-b claimed a lease held by holder-a")
	}

	var rec finalizeRecorder
	if rc := runCrawlFinalizeWith(ctx, pool, rec.ops(), "holder-b", now); rc != 0 {
		t.Fatalf("a held lease must exit 0, got %d", rc)
	}
	if len(rec.calls) != 0 {
		t.Fatalf("steps ran under a held lease: %v", rec.calls)
	}

	if _, err := pool.Exec(ctx, `UPDATE crawl_finalize_lease SET expires_at = now() - interval '1 second'`); err != nil {
		t.Fatalf("expire lease: %v", err)
	}
	if rc := runCrawlFinalizeWith(ctx, pool, rec.ops(), "holder-b", now); rc != 0 {
		t.Fatalf("an expired lease must be taken over and finalize, got %d", rc)
	}
	if len(rec.calls) == 0 {
		t.Fatal("the run did not finalize after the lease lapsed")
	}
	if n := countRows(t, pool, "crawl_finalize_lease"); n != 0 {
		t.Fatalf("the lease was not released after the run (%d row(s))", n)
	}
}

// TestRecordEmptySelection_WritesFinishedRow_Integration: an empty delta selection writes a
// finished run with zero counts, so the sentinel's 30h delta check stays green.
func TestRecordEmptySelection_WritesFinishedRow_Integration(t *testing.T) {
	pool := openServerTestPool(t)
	now := time.Now().UTC()
	run := serverRun{Selection: "delta", RunID: serverRunID("delta", now), Now: now, TTL: time.Hour}
	recordEmptySelection(pool, run)

	var status string
	var selected int
	var finished time.Time
	err := pool.QueryRow(context.Background(), `
		SELECT status, suburbs_selected, finished_at FROM crawl_run_status
		WHERE run_type = 'delta' AND host = 'server' AND run_id = $1`, run.RunID).Scan(&status, &selected, &finished)
	if err != nil {
		t.Fatalf("no finished run row for an empty selection: %v", err)
	}
	if status != "ok" || selected != 0 {
		t.Fatalf("row = status %q selected %d, want ok and 0", status, selected)
	}
	if time.Since(finished) > time.Minute {
		t.Fatalf("finished_at %s is not now: the sentinel reads it", finished)
	}
}

// TestPruneDispatchLedger_Integration: terminal rows older than 14 days go; terminal rows inside
// the window, and any row still open for a push, stay.
func TestPruneDispatchLedger_Integration(t *testing.T) {
	pool := openServerTestPool(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		INSERT INTO crawl_dispatch (job_id, run_id, selection, suburb, state, postcode, source, created_at, expires_at, closed_at) VALUES
		('old-closed',  'r', 'delta', 'A', 'VIC', '3000', 'rea', now() - interval '20 days', now() - interval '19 days', now() - interval '20 days'),
		('old-expired', 'r', 'delta', 'A', 'VIC', '3000', 'rea', now() - interval '20 days', now() - interval '20 days', NULL),
		('new-closed',  'r', 'delta', 'A', 'VIC', '3000', 'rea', now() - interval '5 days',  now() + interval '2 days',  now() - interval '5 days'),
		('new-expired', 'r', 'delta', 'A', 'VIC', '3000', 'rea', now() - interval '5 days',  now() - interval '5 days',  NULL),
		('open',        'r', 'delta', 'A', 'VIC', '3000', 'rea', now(),                     now() + interval '2 days',  NULL)`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	n, err := pruneDispatchLedger(ctx, pool, time.Now().UTC().Add(-crawlRetention))
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	if n != 2 {
		t.Fatalf("pruned %d, want the two rows older than 14 days", n)
	}
	var kept []string
	rows, err := pool.Query(ctx, `SELECT job_id FROM crawl_dispatch ORDER BY job_id`)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		kept = append(kept, id)
	}
	if strings.Join(kept, ",") != "new-closed,new-expired,open" {
		t.Fatalf("kept = %v, want the three rows inside the window or still open", kept)
	}
}

// TestEnqueueServer_ShortOrReorderedReply_WritesNothing_Integration: a reply that is short, or
// that names the right suburbs in a different order, must write no ledger row. Removing the
// echo check lets both through and fails this test.
func TestEnqueueServer_ShortOrReorderedReply_WritesNothing_Integration(t *testing.T) {
	cases := map[string]func([]enqueueTargetItem) []enqueueTargetItem{
		"short": func(in []enqueueTargetItem) []enqueueTargetItem { return in[:len(in)-1] },
		"reordered": func(in []enqueueTargetItem) []enqueueTargetItem {
			out := append([]enqueueTargetItem(nil), in...)
			for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
				out[i], out[j] = out[j], out[i]
			}
			return out
		},
	}
	for name, mangle := range cases {
		t.Run(name, func(t *testing.T) {
			pool := openServerTestPool(t)
			fb := newFakeBrandbrain(t, nil, nil)
			fb.mangle = mangle
			client := newBrandbrainIDTokenClient(fb.srv.URL, oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "fake-token"}))
			_, err := enqueueServer(context.Background(), pool, client, serverTestJobs(), testRun("delta", 40, time.Hour))
			if err == nil {
				t.Fatalf("a %s reply must be refused", name)
			}
			if n := countRows(t, pool, "crawl_dispatch"); n != 0 {
				t.Fatalf("%s reply wrote %d ledger row(s), want 0", name, n)
			}
		})
	}
}

// TestCheckTargetsEcho_WrongPostcode: a same-suburb reply with a different postcode is a different
// target. The ledger must not accept it.
func TestCheckTargetsEcho_WrongPostcode(t *testing.T) {
	sent := []crawlEnqueueInput{{Kind: "housing", Suburb: "Richmond", State: "VIC", Postcode: "3121", Source: "rea", Tier: "listings"}}
	got := []enqueueTargetItem{{Suburb: "Richmond", State: "VIC", Postcode: "3141", Source: "rea", JobID: "j"}}
	if err := checkTargetsEcho(sent, got); err == nil {
		t.Fatal("a wrong postcode must be refused")
	}
}

// TestServerPropertyResolveExit: a blocked autocomplete is a logged back-off, as the rig wrapper
// treats it. Other codes are not hidden.
func TestServerPropertyResolveExit(t *testing.T) {
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(prev)

	if got := serverPropertyResolveExit(3); got != 0 {
		t.Fatalf("blocked (3) must exit 0 on the server, got %d", got)
	}
	if !strings.Contains(buf.String(), "WARN") {
		t.Fatalf("a blocked run must log a WARN line, got %q", buf.String())
	}
	for _, rc := range []int{0, 7} {
		if got := serverPropertyResolveExit(rc); got != rc {
			t.Fatalf("exit %d must pass through, got %d", rc, got)
		}
	}
}

// TestCheckAuth_IsAReadWithTheIDToken: -auth-check hits the summary route with the ID token, a
// GET with no body. It creates nothing.
func TestCheckAuth_IsAReadWithTheIDToken(t *testing.T) {
	var method, path, query, auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path, query, auth = r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	c := newBrandbrainIDTokenClient(srv.URL, testIDTokens())
	if err := c.checkAuth(context.Background()); err != nil {
		t.Fatalf("checkAuth: %v", err)
	}
	if method != http.MethodGet || path != "/api/v1/agent/crawl-jobs" || query != "limit=1" {
		t.Fatalf("checkAuth sent %s %s?%s, want a GET of the summary route with limit=1", method, path, query)
	}
	if auth != "Bearer test-id-token-value" {
		t.Fatalf("Authorization = %q", auth)
	}
}

func TestCheckAuth_RefusalIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "forbidden", http.StatusForbidden)
	}))
	defer srv.Close()
	c := newBrandbrainIDTokenClient(srv.URL, testIDTokens())
	if err := c.checkAuth(context.Background()); err == nil {
		t.Fatal("a refused auth-check must be an error")
	}
}

// TestRunServerEnqueue_DryRunWritesNothing_Integration: -dry-run with -limit selects and builds the
// jobs, logs the counts, and sends nothing. BrandBrain is never called and no row is written.
func TestRunServerEnqueue_DryRunWritesNothing_Integration(t *testing.T) {
	pool := openServerTestPool(t)
	fb := newFakeBrandbrain(t, nil, nil)
	t.Setenv("BRANDBRAIN_AGENT_URL", fb.srv.URL)
	t.Setenv("CRAWL_ENQUEUE_SOURCE", "split")

	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(prev)

	rc := runServerEnqueue(context.Background(), pool, serverEnqueueOpts{Selection: "full", DryRun: true, Limit: 2})
	if rc != 0 {
		t.Fatalf("dry run exit = %d, want 0", rc)
	}
	if fb.callCount() != 0 {
		t.Fatalf("dry run called BrandBrain %d time(s)", fb.callCount())
	}
	if n := countRows(t, pool, "crawl_dispatch") + countRows(t, pool, "crawl_run_status"); n != 0 {
		t.Fatalf("dry run wrote %d row(s)", n)
	}
	if !strings.Contains(buf.String(), "2 target(s) × 2 source(s) = 4 job(s)") {
		t.Fatalf("dry run did not report the limited counts; log was %q", buf.String())
	}
	if !strings.Contains(buf.String(), "DRY RUN") {
		t.Fatalf("dry run must say so in its log, got %q", buf.String())
	}
}

// TestRunServerEnqueue_AuthCheckWithoutCredentials_Fails: with no Google credentials the check
// fails with exit 7 and never reaches BrandBrain.
func TestRunServerEnqueue_AuthCheckWithoutCredentials_Fails(t *testing.T) {
	pool := openServerTestPool(t)
	fb := newFakeBrandbrain(t, nil, nil)
	t.Setenv("BRANDBRAIN_AGENT_URL", fb.srv.URL)
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", "/nonexistent/credentials.json")
	t.Setenv("HOME", t.TempDir())
	if rc := runServerEnqueue(context.Background(), pool, serverEnqueueOpts{Selection: "full", AuthCheck: true}); rc != 7 {
		t.Fatalf("auth-check without credentials exit = %d, want 7", rc)
	}
	if fb.callCount() != 0 {
		t.Fatalf("auth-check reached BrandBrain without a token")
	}
}
