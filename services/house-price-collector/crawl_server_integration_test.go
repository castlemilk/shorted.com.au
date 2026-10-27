package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/oauth2"
)

// Integration tests for crawl_server.go against a live Postgres. Each test runs in its
// own schema, which it drops afterwards. Run with a throwaway database, e.g.:
//
//	docker run -d --name pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=sptest -p 55439:5432 postgres:16
//	HOUSING_TEST_DB_URL='postgres://postgres:test@localhost:55439/sptest' \
//	  GOWORK=off go test ./house-price-collector/ -run 'Server|Finalize' -v
//
// Or with a testcontainers Postgres, as CI does (CGO off: gopsutil crashes a macOS test
// binary at init when cgo is on):
//
//	HOUSING_TESTCONTAINERS=1 CGO_ENABLED=0 GOWORK=off go test -tags=testcontainers ./house-price-collector/ -run 'Server|Finalize'
//
// Skips when neither is set, so `make test` stays offline.

// serverTestDDL mirrors the columns and constraints the server jobs touch, from
// migrations 000150 (crawl_dispatch, crawl_ingest_receipts), 000151
// (crawl_finalize_state) and 000089 (crawl_run_status).
const serverTestDDL = `
CREATE TABLE crawl_dispatch (
    job_id      TEXT PRIMARY KEY,
    run_id      TEXT,
    selection   TEXT,
    suburb      TEXT NOT NULL,
    state       TEXT NOT NULL,
    postcode    TEXT NOT NULL,
    source      TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '72 hours'),
    closed_at   TIMESTAMPTZ,
    CONSTRAINT crawl_dispatch_source_chk CHECK (source IN ('rea', 'domain'))
);
CREATE TABLE crawl_ingest_receipts (
    key          TEXT PRIMARY KEY,
    rig_subject  TEXT NOT NULL,
    body_sha256  BYTEA NOT NULL,
    response     JSONB NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_crawl_ingest_receipts_created_at ON crawl_ingest_receipts (created_at);
CREATE TABLE crawl_finalize_state (
    name        TEXT PRIMARY KEY,
    watermark   TIMESTAMPTZ NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE crawl_finalize_lease (
    name        TEXT PRIMARY KEY,
    holder      TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL
);
CREATE TABLE crawl_run_status (
    run_type                TEXT NOT NULL,
    host                    TEXT NOT NULL,
    run_id                  TEXT,
    started_at              TIMESTAMPTZ,
    finished_at             TIMESTAMPTZ,
    status                  TEXT,
    suburbs_selected        INT     NOT NULL DEFAULT 0,
    suburbs_done            INT     NOT NULL DEFAULT 0,
    listings_touched        INT     NOT NULL DEFAULT 0,
    events_written          INT     NOT NULL DEFAULT 0,
    blocked_count           INT     NOT NULL DEFAULT 0,
    rewarm_needed           BOOLEAN NOT NULL DEFAULT FALSE,
    freshness_oldest_hours  NUMERIC,
    detail                  TEXT,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_type, host),
    CONSTRAINT crawl_run_status_run_type_chk CHECK (run_type IN ('delta', 'full', 'agent', 'freshness')),
    CONSTRAINT crawl_run_status_status_chk CHECK (status IS NULL OR status IN ('ok', 'blocked', 'rewarm', 'partial', 'error'))
);`

// openServerTestPool gives the test a pool on a private schema with the production
// connection settings (simple protocol, as connect() sets it).
func openServerTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dbURL, err := testpostgres.Admin("HOUSING_TEST_DB_URL", "HOUSING_TESTCONTAINERS")
	if err != nil {
		t.Fatalf("start the test Postgres: %v", err)
	}
	if dbURL == "" {
		t.Skip("set HOUSING_TEST_DB_URL, or HOUSING_TESTCONTAINERS=1 with -tags=testcontainers, to run the server-job integration tests")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	schema := fmt.Sprintf("srv_test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		admin.Close()
	})

	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		t.Fatalf("parse dsn: %v", err)
	}
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	cfg.ConnConfig.OnNotice = housingNotices.handle
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	cfg.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, serverTestDDL); err != nil {
		t.Fatalf("create test tables: %v", err)
	}
	return pool
}

// fakeBrandbrain stands in for BrandBrain's enqueue route. It answers in request order.
// A target listed in existing is deduplicated onto that job id, as BrandBrain does for
// a pending job. statusFor, when set and non-zero for a call (1-based), refuses it.
type fakeBrandbrain struct {
	srv         *httptest.Server
	mu          sync.Mutex
	calls       int
	authHeaders []string
	agentHeader []string
	// mangle, when set before a call, rewrites the reply's targets: a short, reordered or
	// otherwise wrong answer from BrandBrain. Set it before the request is made.
	mangle func([]enqueueTargetItem) []enqueueTargetItem
}

func newFakeBrandbrain(t *testing.T, existing map[string]string, statusFor func(call int) int) *fakeBrandbrain {
	t.Helper()
	fb := &fakeBrandbrain{}
	fb.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		fb.mu.Lock()
		fb.calls++
		call := fb.calls
		fb.authHeaders = append(fb.authHeaders, r.Header.Get("Authorization"))
		fb.agentHeader = append(fb.agentHeader, r.Header.Get("X-Agent-ID"))
		fb.mu.Unlock()

		if statusFor != nil {
			if code := statusFor(call); code != 0 {
				http.Error(w, "refused by the fake", code)
				return
			}
		}
		var req struct {
			Jobs []crawlEnqueueInput `json:"jobs"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		resp := enqueueTargetsResponse{Targets: []enqueueTargetItem{}, JobIDs: []string{}}
		for _, j := range req.Jobs {
			key := dedupKey(j.Suburb, j.State, j.Postcode, j.Source)
			item := enqueueTargetItem{Suburb: j.Suburb, State: j.State, Postcode: j.Postcode, Source: j.Source}
			if id, ok := existing[key]; ok {
				item.JobID, item.Created = id, false
			} else {
				item.JobID = fakeJobID(j)
				item.Created = true
				resp.JobIDs = append(resp.JobIDs, item.JobID)
				resp.Enqueued++
			}
			resp.Targets = append(resp.Targets, item)
		}
		if fb.mangle != nil {
			resp.Targets = fb.mangle(resp.Targets)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(fb.srv.Close)
	return fb
}

func dedupKey(suburb, state, postcode, source string) string {
	return strings.ToLower(strings.TrimSpace(suburb)) + "|" + strings.ToUpper(strings.TrimSpace(state)) + "|" +
		strings.TrimSpace(postcode) + "|" + strings.ToLower(strings.TrimSpace(source))
}

func fakeJobID(j crawlEnqueueInput) string {
	return "job-" + strings.ToLower(strings.ReplaceAll(j.Suburb, " ", "-")) + "-" +
		strings.ToLower(j.State) + "-" + j.Postcode + "-" + strings.ToLower(j.Source)
}

func (fb *fakeBrandbrain) callCount() int {
	fb.mu.Lock()
	defer fb.mu.Unlock()
	return fb.calls
}

// dispatchRow is one ledger row, read back.
type dispatchRow struct {
	Suburb, State, Postcode, Source, RunID, Selection string
	Expires                                           time.Time
	Closed                                            *time.Time
}

func readDispatch(t *testing.T, pool *pgxpool.Pool, jobID string) (dispatchRow, bool) {
	t.Helper()
	var d dispatchRow
	err := pool.QueryRow(context.Background(), `
		SELECT suburb, state, postcode, source, COALESCE(run_id,''), COALESCE(selection,''), expires_at, closed_at
		FROM crawl_dispatch WHERE job_id = $1`, jobID).
		Scan(&d.Suburb, &d.State, &d.Postcode, &d.Source, &d.RunID, &d.Selection, &d.Expires, &d.Closed)
	if errors.Is(err, pgx.ErrNoRows) {
		return dispatchRow{}, false
	}
	if err != nil {
		t.Fatalf("read dispatch %s: %v", jobID, err)
	}
	return d, true
}

func countRows(t *testing.T, pool *pgxpool.Pool, table string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), "SELECT count(*) FROM "+table).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return n
}

// serverTestTargets are three jobs across two suburbs. The state is lowercase on
// purpose, because the ledger must store it uppercase.
func serverTestJobs() []crawlEnqueueInput {
	return []crawlEnqueueInput{
		{Kind: "housing", Suburb: "St Kilda", State: "vic", Postcode: "3182", Source: "rea", Tier: "listings"},
		{Kind: "housing", Suburb: "St Kilda", State: "vic", Postcode: "3182", Source: "domain", Tier: "listings"},
		{Kind: "housing", Suburb: "Richmond", State: "VIC", Postcode: "3121", Source: "rea", Tier: "listings"},
	}
}

func testRun(selection string, batch int, ttl time.Duration) serverRun {
	now := time.Now().UTC()
	return serverRun{Selection: selection, RunID: serverRunID(selection, now), Now: now, TTL: ttl, Batch: batch}
}

// TestServerEnqueue_LedgerRowPerTarget_Integration: created and deduplicated targets both
// get a ledger row, with the display name, an uppercase state, the run's id, and an expiry
// from the configured TTL. The request carries the ID token and no agent id.
func TestServerEnqueue_LedgerRowPerTarget_Integration(t *testing.T) {
	pool := openServerTestPool(t)
	ctx := context.Background()

	// Richmond rea is already pending at BrandBrain under an older job id.
	fb := newFakeBrandbrain(t, map[string]string{dedupKey("Richmond", "VIC", "3121", "rea"): "job-pending-richmond"}, nil)
	client := newBrandbrainIDTokenClient(fb.srv.URL, oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "fake-token"}))

	run := testRun("delta", 2, 2*time.Hour) // batch 2 forces two calls for three jobs
	res, err := enqueueServer(ctx, pool, client, serverTestJobs(), run)
	if err != nil {
		t.Fatalf("enqueueServer: %v", err)
	}
	recordServerRun(pool, run, 2, res, nil)

	if res.Created != 2 || res.Existing != 1 {
		t.Fatalf("created=%d existing=%d, want 2 and 1", res.Created, res.Existing)
	}
	if fb.callCount() != 2 {
		t.Fatalf("BrandBrain calls = %d, want 2 batches", fb.callCount())
	}
	for i, h := range fb.authHeaders {
		if h != "Bearer fake-token" {
			t.Fatalf("call %d Authorization = %q, want the ID token bearer", i+1, h)
		}
	}
	for i, h := range fb.agentHeader {
		if h != "" {
			t.Fatalf("call %d sent X-Agent-ID %q on the Google-token path", i+1, h)
		}
	}

	if got := countRows(t, pool, "crawl_dispatch"); got != 3 {
		t.Fatalf("dispatch rows = %d, want 3 (the deduplicated target is in the ledger too)", got)
	}
	created, ok := readDispatch(t, pool, fakeJobID(serverTestJobs()[0]))
	if !ok {
		t.Fatal("created St Kilda rea job has no ledger row")
	}
	if created.Suburb != "St Kilda" {
		t.Errorf("suburb = %q, want the catalog display name", created.Suburb)
	}
	if created.State != "VIC" {
		t.Errorf("state = %q, want VIC (uppercased)", created.State)
	}
	if created.Postcode != "3182" || created.Source != "rea" {
		t.Errorf("postcode/source = %q/%q", created.Postcode, created.Source)
	}
	if created.RunID != run.RunID || created.Selection != "delta" {
		t.Errorf("run = %q selection = %q, want %q delta", created.RunID, created.Selection, run.RunID)
	}
	if d := time.Until(created.Expires); d < 110*time.Minute || d > 121*time.Minute {
		t.Errorf("expires_at is %s from now, want the 2h TTL", d.Round(time.Minute))
	}
	if created.Closed != nil {
		t.Error("a new job must not be closed")
	}

	dedup, ok := readDispatch(t, pool, "job-pending-richmond")
	if !ok {
		t.Fatal("the deduplicated target has no ledger row")
	}
	if dedup.Suburb != "Richmond" || dedup.Source != "rea" {
		t.Errorf("dedup row = %q/%q, want Richmond/rea", dedup.Suburb, dedup.Source)
	}

	// The status row is keyed by the run id, so the ingest's per-run bumps find it.
	var status, runType, host string
	var selected int
	if err := pool.QueryRow(ctx, `SELECT run_type, host, status, suburbs_selected FROM crawl_run_status WHERE run_id = $1`, run.RunID).
		Scan(&runType, &host, &status, &selected); err != nil {
		t.Fatalf("crawl_run_status row for the run: %v", err)
	}
	if runType != "delta" || host != "server" || status != "ok" || selected != 2 {
		t.Errorf("status row = %s/%s/%s selected=%d, want delta/server/ok/2", runType, host, status, selected)
	}
	if _, err := pool.Exec(ctx, `UPDATE crawl_run_status SET listings_touched = listings_touched + 5 WHERE run_id = $1`, run.RunID); err != nil {
		t.Fatalf("ingest-style bump: %v", err)
	}
}

// TestServerEnqueue_ClosedJobNeverReopened_Integration: re-enqueueing a closed job must
// not reopen it or extend its expiry, while an open job's expiry is extended.
func TestServerEnqueue_ClosedJobNeverReopened_Integration(t *testing.T) {
	pool := openServerTestPool(t)
	ctx := context.Background()
	closedAt := time.Now().Add(-time.Hour)
	if _, err := pool.Exec(ctx, `
		INSERT INTO crawl_dispatch (job_id, run_id, selection, suburb, state, postcode, source, expires_at, closed_at)
		VALUES ('job-closed', 'delta-old', 'delta', 'Richmond', 'VIC', '3121', 'rea', now() + interval '1 hour', $1),
		       ('job-open', 'delta-old', 'delta', 'Richmond', 'VIC', '3121', 'domain', now() - interval '1 hour', NULL)`, closedAt); err != nil {
		t.Fatalf("seed: %v", err)
	}
	before, _ := readDispatch(t, pool, "job-closed")

	fb := newFakeBrandbrain(t, map[string]string{
		dedupKey("Richmond", "VIC", "3121", "rea"):    "job-closed",
		dedupKey("Richmond", "VIC", "3121", "domain"): "job-open",
	}, nil)
	client := newBrandbrainIDTokenClient(fb.srv.URL, oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "fake-token"}))
	jobs := []crawlEnqueueInput{
		{Kind: "housing", Suburb: "Richmond", State: "VIC", Postcode: "3121", Source: "rea", Tier: "listings"},
		{Kind: "housing", Suburb: "Richmond", State: "VIC", Postcode: "3121", Source: "domain", Tier: "listings"},
	}
	if _, err := enqueueServer(ctx, pool, client, jobs, testRun("delta", 40, 72*time.Hour)); err != nil {
		t.Fatalf("enqueueServer: %v", err)
	}

	after, _ := readDispatch(t, pool, "job-closed")
	if after.Closed == nil {
		t.Fatal("a closed job was reopened by re-enqueue")
	}
	if !after.Expires.Equal(before.Expires) {
		t.Fatalf("closed job's expiry moved from %s to %s", before.Expires, after.Expires)
	}
	open, _ := readDispatch(t, pool, "job-open")
	if open.Expires.Before(time.Now()) {
		t.Fatalf("open job's expiry was not refreshed (still %s)", open.Expires)
	}
	if open.Closed != nil {
		t.Fatal("the open job must stay open")
	}
}

// TestServerEnqueue_RefusedWritesNothing_Integration: a refusal from BrandBrain (401 or a
// persistent 5xx) exits with an error, writes no ledger row and no status row.
func TestServerEnqueue_RefusedWritesNothing_Integration(t *testing.T) {
	for _, code := range []int{http.StatusUnauthorized, http.StatusServiceUnavailable} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			pool := openServerTestPool(t)
			fb := newFakeBrandbrain(t, nil, func(int) int { return code })
			client := newBrandbrainIDTokenClient(fb.srv.URL, oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "fake-token"}))
			run := testRun("full", 40, 72*time.Hour)

			res, err := enqueueServer(context.Background(), pool, client, serverTestJobs(), run)
			recordServerRun(pool, run, 2, res, err)
			if err == nil {
				t.Fatalf("a %d from BrandBrain must be an error", code)
			}
			if n := countRows(t, pool, "crawl_dispatch"); n != 0 {
				t.Fatalf("dispatch rows = %d after a refusal, want 0", n)
			}
			if n := countRows(t, pool, "crawl_run_status"); n != 0 {
				t.Fatalf("status rows = %d after a refusal that wrote nothing, want 0", n)
			}
		})
	}
}

// TestServerEnqueue_LaterBatchRefused_KeepsEarlierBatch_Integration: a batch BrandBrain
// answers is committed even if a later batch is refused. The refused batch writes nothing,
// and the run's status row records the error.
func TestServerEnqueue_LaterBatchRefused_KeepsEarlierBatch_Integration(t *testing.T) {
	pool := openServerTestPool(t)
	fb := newFakeBrandbrain(t, nil, func(call int) int {
		if call == 2 {
			return http.StatusUnauthorized
		}
		return 0
	})
	client := newBrandbrainIDTokenClient(fb.srv.URL, oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "fake-token"}))
	run := testRun("delta", 2, 72*time.Hour)

	res, err := enqueueServer(context.Background(), pool, client, serverTestJobs(), run)
	recordServerRun(pool, run, 3, res, err)
	if err == nil {
		t.Fatal("the refused second batch must be an error")
	}
	if fb.callCount() != 2 {
		t.Fatalf("BrandBrain calls = %d, want 2 (the refused batch was sent once)", fb.callCount())
	}
	if n := countRows(t, pool, "crawl_dispatch"); n != 2 {
		t.Fatalf("dispatch rows = %d, want the first batch's 2 and none from the refused one", n)
	}
	var status string
	if err := pool.QueryRow(context.Background(), `SELECT status FROM crawl_run_status WHERE run_id = $1`, run.RunID).Scan(&status); err != nil {
		t.Fatalf("status row: %v", err)
	}
	if status != "error" {
		t.Fatalf("status = %q, want error for a run stopped part way", status)
	}
}

// finalizeRecorder records the order of the finalize steps without a database.
type finalizeRecorder struct {
	calls  []string
	failMV error
}

func (r *finalizeRecorder) ops() finalizeOps {
	return finalizeOps{
		linkSuburb:     func(context.Context) error { r.calls = append(r.calls, "suburb"); return nil },
		linkListing:    func(context.Context) error { r.calls = append(r.calls, "listing"); return nil },
		linkPriceEvent: func(context.Context) error { r.calls = append(r.calls, "price-event"); return nil },
		refreshMV: func(context.Context) error {
			r.calls = append(r.calls, "mv")
			return r.failMV
		},
		revalidate: func(reason string) { r.calls = append(r.calls, "revalidate:"+reason) },
	}
}

func insertReceipt(t *testing.T, pool *pgxpool.Pool, key string, at time.Time) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO crawl_ingest_receipts (key, rig_subject, body_sha256, response, created_at)
		VALUES ($1, 'rig:test', '\x00', '{}', $2)`, key, at); err != nil {
		t.Fatalf("insert receipt %s: %v", key, err)
	}
}

func watermarkOf(t *testing.T, pool *pgxpool.Pool) (time.Time, bool) {
	t.Helper()
	var wm time.Time
	err := pool.QueryRow(context.Background(), `SELECT watermark FROM crawl_finalize_state WHERE name = $1`, crawlFinalizeCursor).Scan(&wm)
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, false
	}
	if err != nil {
		t.Fatalf("read watermark: %v", err)
	}
	return wm, true
}

// TestCrawlFinalize_NoOpWhenNothingChanged_Integration: with no receipt newer than the
// cursor, finalize does none of its work and leaves the cursor where it was.
func TestCrawlFinalize_NoOpWhenNothingChanged_Integration(t *testing.T) {
	pool := openServerTestPool(t)
	ctx := context.Background()
	now := time.Now().UTC()
	insertReceipt(t, pool, "old-1", now.Add(-2*time.Hour))
	cursor := now.Add(-time.Hour)
	if err := saveFinalizeWatermark(ctx, pool, cursor); err != nil {
		t.Fatalf("seed watermark: %v", err)
	}

	var rec finalizeRecorder
	ran, err := crawlFinalize(ctx, pool, rec.ops(), now)
	if err != nil {
		t.Fatalf("crawlFinalize: %v", err)
	}
	if ran || len(rec.calls) != 0 {
		t.Fatalf("ran=%v calls=%v, want no work when nothing changed", ran, rec.calls)
	}
	if wm, _ := watermarkOf(t, pool); !wm.Equal(cursor.Truncate(time.Microsecond)) {
		t.Fatalf("watermark moved to %s, want it unchanged at %s", wm, cursor)
	}
}

// TestCrawlFinalize_RunsStepsInOrderAndAdvances_Integration: after ingest writes, the steps
// run in dependency order, the cache is busted once, and the cursor moves to the newest
// receipt. A second run is then a no-op.
func TestCrawlFinalize_RunsStepsInOrderAndAdvances_Integration(t *testing.T) {
	pool := openServerTestPool(t)
	ctx := context.Background()
	now := time.Now().UTC()
	insertReceipt(t, pool, "a", now.Add(-30*time.Minute))
	insertReceipt(t, pool, "b", now.Add(-10*time.Minute))

	var rec finalizeRecorder
	ran, err := crawlFinalize(ctx, pool, rec.ops(), now)
	if err != nil {
		t.Fatalf("crawlFinalize: %v", err)
	}
	if !ran {
		t.Fatal("finalize must run when the ingest has written")
	}
	want := []string{"suburb", "listing", "price-event", "mv", "revalidate:crawl-finalize"}
	if strings.Join(rec.calls, ",") != strings.Join(want, ",") {
		t.Fatalf("steps = %v, want %v", rec.calls, want)
	}
	var newest time.Time
	if err := pool.QueryRow(ctx, `SELECT max(created_at) FROM crawl_ingest_receipts`).Scan(&newest); err != nil {
		t.Fatalf("newest receipt: %v", err)
	}
	// The cursor is the newest receipt, held crawlWatermarkMargin behind the run start.
	wantCursor := newest
	if floor := now.Add(-crawlWatermarkMargin); wantCursor.After(floor) {
		wantCursor = floor
	}
	if wm, ok := watermarkOf(t, pool); !ok || !closeTo(wm, wantCursor) {
		t.Fatalf("watermark = %s (ok=%v), want %s (newest receipt %s, held behind the run start)", wm, ok, wantCursor, newest)
	}

	rec.calls = nil
	if ran, err := crawlFinalize(ctx, pool, rec.ops(), now); err != nil || ran || len(rec.calls) != 0 {
		t.Fatalf("second run: ran=%v err=%v calls=%v, want a no-op", ran, err, rec.calls)
	}
}

// TestCrawlFinalize_MVFailureHoldsCursorAndBust_Integration: a failed MV refresh stops the
// run before the cache bust, and the cursor stays put so the next run retries the same data.
func TestCrawlFinalize_MVFailureHoldsCursorAndBust_Integration(t *testing.T) {
	pool := openServerTestPool(t)
	ctx := context.Background()
	now := time.Now().UTC()
	insertReceipt(t, pool, "a", now.Add(-5*time.Minute))

	rec := finalizeRecorder{failMV: errors.New("refresh blocked")}
	if _, err := crawlFinalize(ctx, pool, rec.ops(), now); err == nil {
		t.Fatal("a failed MV refresh must fail the run")
	}
	for _, c := range rec.calls {
		if strings.HasPrefix(c, "revalidate") {
			t.Fatalf("cache bust ran after a failed refresh: %v", rec.calls)
		}
	}
	if _, ok := watermarkOf(t, pool); ok {
		t.Fatal("the cursor moved although the refresh failed")
	}
}

// TestCrawlFinalize_PrunesOldReceipts_Integration: receipts older than 14 days are removed,
// and newer ones are kept.
func TestCrawlFinalize_PrunesOldReceipts_Integration(t *testing.T) {
	pool := openServerTestPool(t)
	ctx := context.Background()
	now := time.Now().UTC()
	insertReceipt(t, pool, "day-20", now.Add(-20*24*time.Hour))
	insertReceipt(t, pool, "day-15", now.Add(-15*24*time.Hour))
	insertReceipt(t, pool, "day-13", now.Add(-13*24*time.Hour))
	insertReceipt(t, pool, "day-1", now.Add(-24*time.Hour))

	var rec finalizeRecorder
	if _, err := crawlFinalize(ctx, pool, rec.ops(), now); err != nil {
		t.Fatalf("crawlFinalize: %v", err)
	}
	rows, err := pool.Query(ctx, `SELECT key FROM crawl_ingest_receipts ORDER BY key`)
	if err != nil {
		t.Fatalf("list receipts: %v", err)
	}
	defer rows.Close()
	var kept []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			t.Fatalf("scan: %v", err)
		}
		kept = append(kept, k)
	}
	if strings.Join(kept, ",") != "day-1,day-13" {
		t.Fatalf("receipts kept = %v, want day-1 and day-13 (the 14-day window), older ones pruned", kept)
	}
}
