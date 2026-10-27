package main

// crawl_server.go holds the server-side jobs of the fleet-managed housing crawl
// (S-SRV). They run on Cloud Run as this same job, and they replace the rig's
// database work:
//
//   - server-enqueue (-selection delta|full) posts the suburbs to BrandBrain's crawl
//     queue, with a Google ID token from this job's service account, and writes one
//     crawl_dispatch row per target BrandBrain returns. The ingest service accepts a
//     sweep only for a job in that ledger, so this is the server's half of the trust
//     boundary. It also opens the crawl_run_status row that the ingest's counts land in.
//   - crawl-finalize runs the sal links, the housing MV refresh and one cache bust,
//     but only when the ingest has written since the last run (a watermark in
//     crawl_finalize_state). It also prunes ingest receipts older than 14 days.
//
// A rig runs none of this. It holds no database credential.
//
// Design: docs/superpowers/specs/2026-10-27-fleet-managed-housing-crawl-design.md,
// "Where each mode runs" and "Ingest API".

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/api/idtoken"
)

const (
	// defaultBrandbrainIDTokenAudience is the audience BrandBrain's enqueue route
	// accepts for a Google-signed ID token (its BRANDBRAIN_GOOGLE_IDTOKEN_AUDIENCE).
	defaultBrandbrainIDTokenAudience = "https://api.brandbrain.dev"

	// defaultDispatchTTL is HOUSING_INGEST_DISPATCH_TTL's default. It must match
	// the ingest service's DefaultDispatchTTL, which the ingest reads back through
	// expires_at. services/shorts/internal/ingest is not importable from here.
	defaultDispatchTTL = 72 * time.Hour

	// crawlReceiptRetention is how long an applied push's idempotency receipt is kept.
	// A rig's retry window is far shorter than this.
	crawlReceiptRetention = 14 * 24 * time.Hour

	// crawlReceiptPruneBatch bounds one DELETE, so a long prune never holds a long lock.
	crawlReceiptPruneBatch = 1000

	// crawlFinalizeCursor is the crawl_finalize_state.name this job owns.
	crawlFinalizeCursor = "crawl-finalize"

	// serverRunHost is crawl_run_status.host for the server's rows. A rig's rows use
	// its hostname, so the (run_type, host) primary key never collides.
	serverRunHost = "server"
)

// serverEnqueueConfig is what -mode server-enqueue reads from the environment.
type serverEnqueueConfig struct {
	brandbrainURL string        // BRANDBRAIN_AGENT_URL, e.g. https://api.brandbrain.dev
	audience      string        // BRANDBRAIN_IDTOKEN_AUDIENCE
	dispatchTTL   time.Duration // HOUSING_INGEST_DISPATCH_TTL
	sources       []string      // CRAWL_ENQUEUE_SOURCE: rea and domain only
	tier          string        // CRAWL_ENQUEUE_TIER
	batch         int           // CRAWL_ENQUEUE_BATCH
}

func loadServerEnqueueConfig() (serverEnqueueConfig, error) {
	cfg := serverEnqueueConfig{
		brandbrainURL: strings.TrimRight(strings.TrimSpace(os.Getenv("BRANDBRAIN_AGENT_URL")), "/"),
		audience:      envStr("BRANDBRAIN_IDTOKEN_AUDIENCE", defaultBrandbrainIDTokenAudience),
		dispatchTTL:   defaultDispatchTTL,
		sources:       enqueueSources(envStr("CRAWL_ENQUEUE_SOURCE", "split")),
		tier:          envStr("CRAWL_ENQUEUE_TIER", "listings"),
		batch:         envInt("CRAWL_ENQUEUE_BATCH", 40),
	}
	if cfg.brandbrainURL == "" {
		return cfg, errors.New("BRANDBRAIN_AGENT_URL is required")
	}
	if raw := strings.TrimSpace(os.Getenv("HOUSING_INGEST_DISPATCH_TTL")); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil || d <= 0 {
			return cfg, errors.New("HOUSING_INGEST_DISPATCH_TTL must be a positive duration, such as 72h")
		}
		cfg.dispatchTTL = d
	}
	// crawl_dispatch.source is CHECK-constrained to rea or domain. A combined "both"
	// job would be refused by the ledger, so refuse it up front.
	for _, src := range cfg.sources {
		if src != "rea" && src != "domain" {
			return cfg, fmt.Errorf("CRAWL_ENQUEUE_SOURCE must be split, rea or domain for server-enqueue (got %q)", src)
		}
	}
	if cfg.batch < 1 {
		cfg.batch = 40
	}
	return cfg, nil
}

// enqueueTargetsResponse is BrandBrain's enqueue reply. Targets is additive and has one
// entry per requested job, in request order. A duplicate of a pending job reports that
// job's id with created=false.
type enqueueTargetsResponse struct {
	Enqueued int                  `json:"enqueued"`
	JobIDs   []string             `json:"job_ids"`
	Targets  []enqueueTargetItem `json:"targets"`
}

type enqueueTargetItem struct {
	Suburb   string `json:"suburb"`
	State    string `json:"state"`
	Postcode string `json:"postcode"`
	Source   string `json:"source"`
	JobID    string `json:"job_id"`
	Created  bool   `json:"created"`
}

// enqueueTargets posts one batch to the crawl queue and returns BrandBrain's answer
// for every target in it. It uses the client's retry and its 5xx backoff, and never
// logs the token.
func (c *brandbrainAgentClient) enqueueTargets(ctx context.Context, jobs []crawlEnqueueInput) (enqueueTargetsResponse, error) {
	var resp enqueueTargetsResponse
	if err := c.do(ctx, http.MethodPost, "/api/v1/agent/crawl-jobs", map[string]any{"jobs": jobs}, &resp); err != nil {
		return enqueueTargetsResponse{}, err
	}
	return resp, nil
}

// serverRun identifies one server enqueue run. RunID is written to every ledger row
// and to crawl_run_status, and the ingest's counts find the run by it.
type serverRun struct {
	Selection string // delta | full
	RunID     string // delta-<UTC ts> or full-<UTC ts>
	Now       time.Time
	TTL       time.Duration
	Batch     int
}

func serverRunID(selection string, now time.Time) string {
	return selection + "-" + now.UTC().Format("20060102T150405Z")
}

// serverEnqueueResult counts what one run did. Created are jobs BrandBrain made. Existing
// are targets it deduplicated onto a pending job. Both get a ledger row.
type serverEnqueueResult struct {
	Created  int
	Existing int
}

// enqueueServer posts jobs in batches and writes one crawl_dispatch row for every target
// BrandBrain returns, created or deduplicated. A batch is written only after BrandBrain
// answers it and the answer matches the request. A failing batch writes nothing, and
// later batches are not sent. Re-running is safe: a deduplicated target reuses its job.
func enqueueServer(ctx context.Context, pool *pgxpool.Pool, client *brandbrainAgentClient, jobs []crawlEnqueueInput, run serverRun) (serverEnqueueResult, error) {
	var res serverEnqueueResult
	batch := run.Batch
	if batch < 1 {
		batch = 40
	}
	expires := run.Now.Add(run.TTL)
	for i := 0; i < len(jobs); i += batch {
		end := min(i+batch, len(jobs))
		chunk := jobs[i:end]
		resp, err := client.enqueueTargets(ctx, chunk)
		if err != nil {
			return res, fmt.Errorf("batch %d-%d: %w", i, end, err)
		}
		if err := checkTargetsEcho(chunk, resp.Targets); err != nil {
			return res, fmt.Errorf("batch %d-%d: %w", i, end, err)
		}
		if err := writeDispatchRows(ctx, pool, chunk, resp.Targets, run, expires); err != nil {
			return res, fmt.Errorf("batch %d-%d: dispatch write: %w", i, end, err)
		}
		for _, t := range resp.Targets {
			if t.Created {
				res.Created++
			} else {
				res.Existing++
			}
		}
	}
	return res, nil
}

// checkTargetsEcho confirms BrandBrain answered for exactly what was asked: the same
// count, in request order, with the same identity, and a job id on each. The ledger
// takes its target from the request, so a mismatched answer must not reach it.
func checkTargetsEcho(sent []crawlEnqueueInput, got []enqueueTargetItem) error {
	if len(got) != len(sent) {
		return fmt.Errorf("brandbrain answered %d target(s) for %d requested", len(got), len(sent))
	}
	for i, t := range got {
		s := sent[i]
		if !strings.EqualFold(strings.TrimSpace(t.Suburb), strings.TrimSpace(s.Suburb)) ||
			!strings.EqualFold(strings.TrimSpace(t.State), strings.TrimSpace(s.State)) ||
			strings.TrimSpace(t.Postcode) != strings.TrimSpace(s.Postcode) ||
			!strings.EqualFold(strings.TrimSpace(t.Source), strings.TrimSpace(s.Source)) {
			return fmt.Errorf("brandbrain target %d does not match the request", i)
		}
		if strings.TrimSpace(t.JobID) == "" {
			return fmt.Errorf("brandbrain target %d has no job_id", i)
		}
	}
	return nil
}

// upsertDispatchSQL writes one ledger row. A re-enqueued open job keeps its row and only
// has its expiry extended. A closed job is never reopened: the WHERE clause leaves it
// untouched, and the ingest then refuses it as dispatch_applied.
const upsertDispatchSQL = `
	INSERT INTO crawl_dispatch (job_id, run_id, selection, suburb, state, postcode, source, expires_at)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	ON CONFLICT (job_id) DO UPDATE
	SET expires_at = EXCLUDED.expires_at
	WHERE crawl_dispatch.closed_at IS NULL`

// writeDispatchRows commits one batch's ledger rows in one transaction. The suburb is
// the catalog display name from the request, and state is uppercased.
func writeDispatchRows(ctx context.Context, pool *pgxpool.Pool, sent []crawlEnqueueInput, got []enqueueTargetItem, run serverRun, expires time.Time) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for i, t := range got {
		s := sent[i]
		if _, err := tx.Exec(ctx, upsertDispatchSQL,
			strings.TrimSpace(t.JobID),
			run.RunID,
			run.Selection,
			strings.TrimSpace(s.Suburb),
			strings.ToUpper(strings.TrimSpace(s.State)),
			strings.TrimSpace(s.Postcode),
			strings.ToLower(strings.TrimSpace(s.Source)),
			expires,
		); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// recordServerRun writes the crawl_run_status row for this run. It is best-effort and
// never fails the enqueue. A run that wrote nothing leaves no row, so a 401 on the first
// batch leaves no trace in the ledger or the status table.
func recordServerRun(pool *pgxpool.Pool, run serverRun, selected int, res serverEnqueueResult, runErr error) {
	if runErr != nil && res.Created+res.Existing == 0 {
		return
	}
	rec := crawlRunStatusRecord{
		RunType:         run.Selection,
		Host:            serverRunHost,
		RunID:           run.RunID,
		StartedAt:       run.Now,
		Status:          "ok",
		SuburbsSelected: selected,
		Detail:          fmt.Sprintf("enqueued %d job(s), %d already pending, %d target(s), ttl %s", res.Created, res.Existing, selected, run.TTL),
	}
	if runErr != nil {
		rec.Status = "error"
		rec.Detail = fmt.Sprintf("enqueue stopped after %d job(s): %v", res.Created+res.Existing, runErr)
	}
	writeCrawlRunStatus(rec, pool)
}

// runServerEnqueue is -mode server-enqueue. Exit codes: 0 ok (including an empty delta
// selection), 7 any failure. 7 matches -mode enqueue, so the scheduler reads it the same.
func runServerEnqueue(ctx context.Context, pool *pgxpool.Pool, selection string) int {
	sel := strings.ToLower(strings.TrimSpace(selection))
	if sel != "delta" && sel != "full" {
		log.Printf("[server-enqueue] fatal: -selection must be delta or full (got %q)", selection)
		return 7
	}
	cfg, err := loadServerEnqueueConfig()
	if err != nil {
		log.Printf("[server-enqueue] fatal: %v", err)
		return 7
	}
	// idtoken requests format=full, so the token carries email and email_verified,
	// which BrandBrain's allowlist (email=uniqueId) needs. The token is never logged.
	ts, err := idtoken.NewTokenSource(ctx, cfg.audience)
	if err != nil {
		log.Printf("[server-enqueue] fatal: no Google ID token source for audience %s: %v", cfg.audience, err)
		return 7
	}
	targets, err := selectEnqueueTargets(ctx, pool, sel == "delta")
	if err != nil {
		log.Printf("[server-enqueue] fatal: %v", err)
		return 7
	}
	if len(targets) == 0 {
		log.Printf("[server-enqueue] %s: no targets selected — nothing to enqueue", sel)
		return 0
	}
	now := time.Now().UTC()
	run := serverRun{Selection: sel, RunID: serverRunID(sel, now), Now: now, TTL: cfg.dispatchTTL, Batch: cfg.batch}
	jobs := buildEnqueueJobs(targets, cfg.sources, cfg.tier)
	client := newBrandbrainIDTokenClient(cfg.brandbrainURL, ts)

	res, err := enqueueServer(ctx, pool, client, jobs, run)
	recordServerRun(pool, run, len(targets), res, err)
	if err != nil {
		log.Printf("[server-enqueue] fatal (run %s, %d job(s) created, %d already pending before the failure): %v",
			run.RunID, res.Created, res.Existing, err)
		return 7
	}
	log.Printf("[server-enqueue] run %s: %d target(s) × %d source(s): %d job(s) created, %d already pending; dispatch ttl %s",
		run.RunID, len(targets), len(cfg.sources), res.Created, res.Existing, cfg.dispatchTTL)
	return 0
}

// finalizeOps are the steps crawl-finalize runs, in order. They are fields so a test can
// record the order and count the calls without a database.
type finalizeOps struct {
	linkSuburb     func(context.Context) error
	linkListing    func(context.Context) error
	linkPriceEvent func(context.Context) error
	refreshMV      func(context.Context) error
	revalidate     func(reason string)
}

func productionFinalizeOps(pool *pgxpool.Pool) finalizeOps {
	return finalizeOps{
		linkSuburb: func(ctx context.Context) error {
			_, err := linkSuburbSalCodes(ctx, pool)
			return err
		},
		linkListing: func(ctx context.Context) error {
			_, err := linkListingSalCodes(ctx, pool)
			return err
		},
		linkPriceEvent: func(ctx context.Context) error {
			_, err := linkPriceEventSalCodes(ctx, pool)
			return err
		},
		refreshMV: func(ctx context.Context) error {
			return refreshHousingMV(ctx, pool)
		},
		revalidate: pingRevalidate,
	}
}

// loadFinalizeWatermark returns the newest ingest receipt the last finalize covered, or
// nil when no finalize has succeeded.
func loadFinalizeWatermark(ctx context.Context, pool *pgxpool.Pool) (*time.Time, error) {
	var wm time.Time
	err := pool.QueryRow(ctx,
		`SELECT watermark FROM crawl_finalize_state WHERE name = $1`, crawlFinalizeCursor).Scan(&wm)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &wm, nil
}

// newestReceiptAfter returns the newest ingest receipt written after the watermark. ok is
// false when the ingest has written nothing since. A nil watermark means "never
// finalized", so every receipt counts. The query uses the created_at index.
func newestReceiptAfter(ctx context.Context, pool *pgxpool.Pool, watermark *time.Time) (time.Time, bool, error) {
	var newest *time.Time
	err := pool.QueryRow(ctx, `
		SELECT max(created_at) FROM crawl_ingest_receipts
		WHERE created_at > COALESCE($1::timestamptz, '-infinity'::timestamptz)`, watermark).Scan(&newest)
	if err != nil {
		return time.Time{}, false, err
	}
	if newest == nil {
		return time.Time{}, false, nil
	}
	return *newest, true, nil
}

// saveFinalizeWatermark moves the cursor forward. GREATEST keeps a slower concurrent run
// from moving it backwards.
func saveFinalizeWatermark(ctx context.Context, pool *pgxpool.Pool, watermark time.Time) error {
	_, err := pool.Exec(ctx, `
		INSERT INTO crawl_finalize_state (name, watermark, updated_at)
		VALUES ($1, $2, now())
		ON CONFLICT (name) DO UPDATE
		SET watermark  = GREATEST(crawl_finalize_state.watermark, EXCLUDED.watermark),
		    updated_at = now()`, crawlFinalizeCursor, watermark)
	return err
}

// pruneIngestReceipts deletes receipts created before cutoff, in batches. It returns how
// many it removed.
func pruneIngestReceipts(ctx context.Context, pool *pgxpool.Pool, cutoff time.Time) (int64, error) {
	var total int64
	for {
		tag, err := pool.Exec(ctx, `
			DELETE FROM crawl_ingest_receipts
			WHERE key IN (SELECT key FROM crawl_ingest_receipts WHERE created_at < $1 LIMIT $2)`,
			cutoff, crawlReceiptPruneBatch)
		if err != nil {
			return total, err
		}
		n := tag.RowsAffected()
		total += n
		if n < crawlReceiptPruneBatch {
			return total, nil
		}
	}
}

// crawlFinalize runs the finalize steps only if the ingest has written since the cursor.
// It returns whether it ran the steps. The steps run in dependency order: the suburb
// sal-link first, because the listing and price-event links copy from the region row it
// sets. The cursor moves only after the MV refresh succeeds, so a failed run is retried
// from the same point. Receipt pruning is housekeeping and only logs on failure.
func crawlFinalize(ctx context.Context, pool *pgxpool.Pool, ops finalizeOps, now time.Time) (bool, error) {
	wm, err := loadFinalizeWatermark(ctx, pool)
	if err != nil {
		return false, fmt.Errorf("read watermark: %w", err)
	}
	newest, changed, err := newestReceiptAfter(ctx, pool, wm)
	if err != nil {
		return false, fmt.Errorf("read ingest receipts: %w", err)
	}
	if !changed {
		log.Printf("[crawl-finalize] no ingest writes since the last finalize — nothing to do")
		return false, nil
	}
	steps := []struct {
		name string
		run  func(context.Context) error
	}{
		{"suburb sal_code link", ops.linkSuburb},
		{"listing sal_code link", ops.linkListing},
		{"price-event sal_code link", ops.linkPriceEvent},
		{"housing MV refresh", ops.refreshMV},
	}
	for _, step := range steps {
		if err := step.run(ctx); err != nil {
			return true, fmt.Errorf("%s: %w", step.name, err)
		}
	}
	ops.revalidate("crawl-finalize")
	if err := saveFinalizeWatermark(ctx, pool, newest); err != nil {
		return true, fmt.Errorf("save watermark: %w", err)
	}
	pruned, err := pruneIngestReceipts(ctx, pool, now.Add(-crawlReceiptRetention))
	if err != nil {
		log.Printf("[crawl-finalize] receipt prune failed (best-effort, retried next run): %v", err)
	} else {
		log.Printf("[crawl-finalize] pruned %d ingest receipt(s) older than %s", pruned, crawlReceiptRetention)
	}
	log.Printf("[crawl-finalize] finalized ingest writes up to %s", newest.Format(time.RFC3339))
	return true, nil
}

// runCrawlFinalize is -mode crawl-finalize. Exit codes: 0 ok (or nothing to do), 1 a
// finalize step failed. Like refresh, it runs on a detached context with the collector's
// finalize timeout, so a run deadline cannot kill an MV refresh for committed data.
func runCrawlFinalize(pool *pgxpool.Pool) int {
	ctx, cancel := context.WithTimeout(context.Background(), finalizeTimeout)
	defer cancel()
	if _, err := crawlFinalize(ctx, pool, productionFinalizeOps(pool), time.Now().UTC()); err != nil {
		log.Printf("[crawl-finalize] fatal: %v", err)
		return 1
	}
	return 0
}
