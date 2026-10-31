package main

// crawl_server.go holds the server-side jobs of the fleet-managed housing crawl (S-SRV).
// They run on Cloud Run as this same binary, and they replace the rig's database work:
//
//   - server-enqueue (-selection delta|full) posts the suburbs to BrandBrain's crawl
//     queue with a Google ID token from this job's service account, and writes one
//     crawl_dispatch row per target BrandBrain returns. The ingest accepts a sweep only
//     for a job in that ledger, so this is the server's half of the trust boundary.
//     -dry-run and -auth-check let an operator prove a first run without writing.
//   - crawl-finalize runs the sal links, the housing MV refresh and one cache bust, but
//     only when the ingest has written since the last run. A lease row keeps overlapping
//     runs single-flight. It also prunes ingest receipts and terminal dispatch rows
//     older than 14 days.
//   - server-property-resolve is -mode property-resolve for the schedule: it treats a
//     blocked autocomplete as a logged back-off, as the rig wrapper does.
//
// A rig runs none of this. It holds no database credential.
//
// Design: docs/superpowers/specs/2026-10-27-fleet-managed-housing-crawl-design.md,
// "Where each mode runs" and "Ingest API".

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/api/idtoken"
)

const (
	// defaultBrandbrainIDTokenAudience is the audience BrandBrain's enqueue route accepts
	// for a Google-signed ID token (its BRANDBRAIN_GOOGLE_IDTOKEN_AUDIENCE).
	defaultBrandbrainIDTokenAudience = "https://api.brandbrain.dev"

	// defaultDispatchTTL is HOUSING_INGEST_DISPATCH_TTL's default. It must match the ingest
	// service's DefaultDispatchTTL, which the ingest reads back through expires_at.
	defaultDispatchTTL = 72 * time.Hour

	// crawlRetention is how long receipts and terminal dispatch rows are kept. A rig's
	// retry window is far shorter.
	crawlRetention = 14 * 24 * time.Hour

	// crawlPruneBatch bounds one DELETE, so a long prune never holds a long lock.
	crawlPruneBatch = 1000

	// crawlFinalizeCursor is the crawl_finalize_state.name this job owns.
	crawlFinalizeCursor = "crawl-finalize"

	// crawlFinalizeLease is the crawl_finalize_lease.name this job claims.
	crawlFinalizeLease = "crawl-finalize"

	// finalizeLeaseTTL must outlast a finalize run. The run's own deadline is
	// finalizeTimeout (10 min), so a lease that lapses mid-run would let a second run in.
	finalizeLeaseTTL = 15 * time.Minute

	// crawlWatermarkMargin keeps the cursor this far behind the run start. A push's receipt
	// is stamped at transaction start and becomes visible only at commit (ingest/store.go),
	// so a push still in flight at run start can carry a created_at before the newest
	// receipt the run saw. The margin assumes no push runs longer than this.
	crawlWatermarkMargin = 10 * time.Minute

	// serverRunHost is crawl_run_status.host for the server's rows. A rig's rows use its
	// hostname, so the (run_type, host) primary key never collides.
	serverRunHost = "server"
)

// smokeEnqueuePriority ranks a smoke job above the queue's default order (0), so the
// rig's next drain claims it before the scheduled work. BrandBrain claims priority DESC then
// created_at ASC and accepts any integer, so 100 is claimed ahead of the default 5. An enqueue
// onto an existing pending job keeps that job's priority, which is why selectSmokeTarget skips
// suburbs that are already queued.
const smokeEnqueuePriority = 100

// smokeRunIDPattern is the run id a smoke run writes to its ledger rows: the admin tool
// generates smoke-<UTC ts>-<8 hex>, and a manual run gets smoke-<UTC ts> from serverRunID.
var smokeRunIDPattern = regexp.MustCompile(`^smoke-[0-9]{8}T[0-9]{6}Z(-[a-f0-9]{8})?$`)

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
	// crawl_dispatch.source is CHECK-constrained to rea or domain. A combined "both" job
	// would be refused by the ledger, so refuse it up front.
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

// enqueueTargets posts one batch to the crawl queue and returns BrandBrain's answer for
// every target in it. It uses the client's retry and backoff and never logs the token.
func (c *brandbrainAgentClient) enqueueTargets(ctx context.Context, jobs []crawlEnqueueInput) (enqueueTargetsResponse, error) {
	var resp enqueueTargetsResponse
	if err := c.do(ctx, http.MethodPost, "/api/v1/agent/crawl-jobs", map[string]any{"jobs": jobs}, &resp); err != nil {
		return enqueueTargetsResponse{}, err
	}
	return resp, nil
}

// checkAuth proves the ID token and BrandBrain's allowlist without creating a job. It reads
// the summary route, which BrandBrain allows for Google callers (agent:crawl, limit at most
// 1000), so it is a read with no side effect.
func (c *brandbrainAgentClient) checkAuth(ctx context.Context) error {
	var resp json.RawMessage
	return c.do(ctx, http.MethodGet, "/api/v1/agent/crawl-jobs?limit=1", nil, &resp)
}

// newServerIDTokenClient builds the BrandBrain client for the server's Google ID token.
// idtoken requests format=full, so the token carries email and email_verified, which
// BrandBrain's allowlist (email=uniqueId) needs. The token is never logged.
func newServerIDTokenClient(ctx context.Context, cfg serverEnqueueConfig) (*brandbrainAgentClient, error) {
	ts, err := idtoken.NewTokenSource(ctx, cfg.audience)
	if err != nil {
		return nil, fmt.Errorf("no Google ID token source for audience %s: %w", cfg.audience, err)
	}
	return newBrandbrainIDTokenClient(cfg.brandbrainURL, ts), nil
}

// serverRun identifies one server enqueue run. RunID is written to every ledger row and to
// crawl_run_status, and the ingest's counts find the run by it.
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
// answers it and the answer matches the request. A failing batch writes nothing, and later
// batches are not sent. Re-running is safe: a deduplicated target reuses its job.
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

// checkTargetsEcho confirms BrandBrain answered for exactly what was asked: the same count,
// in request order, with the same identity, and a job id on each. The ledger takes its target
// from the request, so a short, reordered or mismatched answer must not reach it.
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

// upsertDispatchSQL writes one ledger row. A re-enqueued open job keeps its row and only has
// its expiry extended. A closed job is never reopened: the WHERE clause leaves it untouched,
// and the ingest then refuses it as dispatch_applied.
const upsertDispatchSQL = `
	INSERT INTO crawl_dispatch (job_id, run_id, selection, suburb, state, postcode, source, expires_at)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	ON CONFLICT (job_id) DO UPDATE
	SET expires_at = EXCLUDED.expires_at
	WHERE crawl_dispatch.closed_at IS NULL`

// insertDispatchIfAbsentSQL is the smoke run's ledger write. It inserts a row for a job the run
// created, and does nothing for a job already in the ledger: that job belongs to another run, so
// its run id and its expiry (72h for a scheduled job) are left as they are. upsertDispatchSQL would
// rewrite the expiry of another run's open job, shortening it to the smoke's 6 hours.
const insertDispatchIfAbsentSQL = `
	INSERT INTO crawl_dispatch (job_id, run_id, selection, suburb, state, postcode, source, expires_at)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	ON CONFLICT (job_id) DO NOTHING`

// writeDispatchRows commits one batch's ledger rows in one transaction. The suburb is the
// catalog display name from the request, and state is uppercased.
func writeDispatchRows(ctx context.Context, pool *pgxpool.Pool, sent []crawlEnqueueInput, got []enqueueTargetItem, run serverRun, expires time.Time) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := writeDispatchRowsTx(ctx, tx, upsertDispatchSQL, sent, got, run, expires); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// writeDispatchRowsTx writes one ledger row per target on tx, with the given statement. A smoke run
// uses insertDispatchIfAbsentSQL: an existing row keeps its run id AND its expiry.
func writeDispatchRowsTx(ctx context.Context, tx pgx.Tx, sql string, sent []crawlEnqueueInput, got []enqueueTargetItem, run serverRun, expires time.Time) error {
	for i, t := range got {
		s := sent[i]
		if _, err := tx.Exec(ctx, sql,
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
	return nil
}

// recordServerRun writes the crawl_run_status row for a run that finished, or stopped part
// way. It is best-effort and never fails the enqueue. A run whose first batch was refused
// leaves no row. A run with no error writes one even when it enqueued nothing.
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

// recordEmptySelection writes a finished run row with zero counts when a delta selection
// is empty. Without it, crawl_run_status has no delta row for the run, and the freshness
// sentinel's "delta not finished in 30h" check trips on a healthy day.
func recordEmptySelection(pool *pgxpool.Pool, run serverRun) {
	recordServerRun(pool, run, 0, serverEnqueueResult{}, nil)
}

// serverEnqueueOpts are the -mode server-enqueue flags.
type serverEnqueueOpts struct {
	Selection string
	DryRun    bool // select and build, log the counts, send nothing, write nothing
	Limit     int  // post at most this many targets; 0 means no limit
	AuthCheck bool // prove the ID token and the allowlist with a read, then exit
	// Suburb and RunID are for -selection smoke only (see runSmokeEnqueue).
	Suburb string
	RunID  string
}

// runServerEnqueue is -mode server-enqueue. Exit codes: 0 ok (including an empty delta
// selection and a dry run), 7 any failure, matching -mode enqueue.
func runServerEnqueue(ctx context.Context, pool *pgxpool.Pool, opts serverEnqueueOpts) int {
	sel := strings.ToLower(strings.TrimSpace(opts.Selection))
	if sel != "delta" && sel != "full" && sel != "smoke" {
		log.Printf("[server-enqueue] fatal: -selection must be delta, full or smoke (got %q)", opts.Selection)
		return 7
	}
	if opts.Limit < 0 {
		log.Printf("[server-enqueue] fatal: -limit must be 0 (no limit) or a positive count (got %d)", opts.Limit)
		return 7
	}
	cfg, err := loadServerEnqueueConfig()
	if err != nil {
		log.Printf("[server-enqueue] fatal: %v", err)
		return 7
	}

	if opts.AuthCheck {
		client, err := newServerIDTokenClient(ctx, cfg)
		if err != nil {
			log.Printf("[server-enqueue] auth-check FAILED: %v", err)
			return 7
		}
		if err := client.checkAuth(ctx); err != nil {
			log.Printf("[server-enqueue] auth-check FAILED (no jobs were created): %v", err)
			return 7
		}
		log.Printf("[server-enqueue] auth-check OK: BrandBrain accepted the ID token for audience %s; no jobs were created", cfg.audience)
		return 0
	}

	if sel == "smoke" {
		return runSmokeEnqueue(ctx, pool, opts, cfg)
	}

	targets, err := selectEnqueueTargets(ctx, pool, sel == "delta")
	if err != nil {
		log.Printf("[server-enqueue] fatal: %v", err)
		return 7
	}
	if opts.Limit > 0 && len(targets) > opts.Limit {
		log.Printf("[server-enqueue] -limit %d: posting the first %d of %d selected target(s)", opts.Limit, opts.Limit, len(targets))
		targets = targets[:opts.Limit]
	}
	now := time.Now().UTC()
	run := serverRun{Selection: sel, RunID: serverRunID(sel, now), Now: now, TTL: cfg.dispatchTTL, Batch: cfg.batch}

	if len(targets) == 0 {
		log.Printf("[server-enqueue] %s: no targets selected — nothing to enqueue", sel)
		if !opts.DryRun {
			recordEmptySelection(pool, run)
		}
		return 0
	}
	jobs := buildEnqueueJobs(targets, cfg.sources, cfg.tier)

	if opts.DryRun {
		batches := (len(jobs) + cfg.batch - 1) / cfg.batch
		log.Printf("[server-enqueue] DRY RUN run %s: %d target(s) × %d source(s) = %d job(s) in %d batch(es) of %d; nothing sent, nothing written",
			run.RunID, len(targets), len(cfg.sources), len(jobs), batches, cfg.batch)
		return 0
	}

	client, err := newServerIDTokenClient(ctx, cfg)
	if err != nil {
		log.Printf("[server-enqueue] fatal: %v", err)
		return 7
	}
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

// smokeDispatchTTL is the expiry of a smoke run's ledger rows. A smoke that the rig never drains fails
// as expired in hours, not after the scheduled jobs' three days.
const smokeDispatchTTL = 6 * time.Hour

// smokeAdvisoryLock names the transaction-scoped advisory lock that serialises smoke runs. The lock
// is taken before the target is chosen and held until the ledger rows commit, so two smokes can
// never pick the same suburb or interleave their writes. A transaction lock works through the
// transaction pooler (port 6543), which the server's DATABASE_URL is.
const smokeAdvisoryLock = "hashtext('crawl-smoke')"

// runSmokeEnqueue is -selection smoke: enqueue ONE catalog suburb, for both portals, at
// smokeEnqueuePriority, under a run id the caller chose (the admin smoke tool) or a generated one.
//
// BrandBrain answers with every target, created or deduplicated onto a job another run made. The
// ledger takes a row for EVERY target: a row for a job this run created carries this run's id; a row
// for a deduplicated job already exists under another run, and is left alone (insertDispatchIfAbsentSQL).
// So a retried enqueue is a no-op, nothing is left unledgered, and the job's expiry is never changed.
// Whether the smoke was deduplicated is decided by the admin tool from the ledger and BrandBrain, not
// by an exit code. The run exits 0 once BrandBrain has answered and the rows have committed.
//
// It writes no crawl_run_status row: that table's run_type is CHECKed to delta, full, agent and
// freshness, so the freshness sentinel does not see a smoke run. Exit 0 ok, 7 failure.
func runSmokeEnqueue(ctx context.Context, pool *pgxpool.Pool, opts serverEnqueueOpts, cfg serverEnqueueConfig) int {
	runID := strings.TrimSpace(opts.RunID)
	if runID == "" {
		runID = serverRunID("smoke", time.Now())
	}
	if !smokeRunIDPattern.MatchString(runID) {
		log.Printf("[server-enqueue] fatal: -run-id must be smoke-<UTC ts> with an optional -<8 hex> suffix (got %q)", opts.RunID)
		return 7
	}
	if opts.DryRun {
		target, err := selectSmokeTarget(ctx, pool, opts.Suburb)
		if err != nil {
			log.Printf("[server-enqueue] fatal: %v", err)
			return 7
		}
		log.Printf("[server-enqueue] DRY RUN smoke %s: suburb %s (%s %s) × %d source(s) at priority %d; nothing sent, nothing written",
			runID, target.Suburb, target.State, target.Postcode, len(cfg.sources), smokeEnqueuePriority)
		return 0
	}
	client, err := newServerIDTokenClient(ctx, cfg)
	if err != nil {
		log.Printf("[server-enqueue] fatal: %v", err)
		return 7
	}

	// One transaction holds the lock from the target choice to the ledger commit.
	tx, err := pool.Begin(ctx)
	if err != nil {
		log.Printf("[server-enqueue] smoke fatal (run %s): begin: %v", runID, err)
		return 7
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock("+smokeAdvisoryLock+")"); err != nil {
		log.Printf("[server-enqueue] smoke fatal (run %s): advisory lock: %v", runID, err)
		return 7
	}

	target, err := selectSmokeTarget(ctx, pool, opts.Suburb)
	if err != nil {
		log.Printf("[server-enqueue] fatal: %v", err)
		return 7
	}
	jobs := buildEnqueueJobs([]CrawlTarget{target}, cfg.sources, cfg.tier)
	for i := range jobs {
		jobs[i].Priority = smokeEnqueuePriority
	}
	run := serverRun{Selection: "smoke", RunID: runID, Now: time.Now().UTC(), TTL: smokeDispatchTTL, Batch: cfg.batch}

	resp, err := client.enqueueTargets(ctx, jobs)
	if err == nil {
		err = checkTargetsEcho(jobs, resp.Targets)
	}
	if err != nil {
		log.Printf("[server-enqueue] smoke fatal (run %s): %v", runID, err)
		return 7
	}
	if err := writeDispatchRowsTx(ctx, tx, insertDispatchIfAbsentSQL, jobs, resp.Targets, run, run.Now.Add(run.TTL)); err != nil {
		log.Printf("[server-enqueue] smoke fatal (run %s): dispatch write: %v", runID, err)
		return 7
	}
	if err := tx.Commit(ctx); err != nil {
		log.Printf("[server-enqueue] smoke fatal (run %s): commit: %v", runID, err)
		return 7
	}
	created := 0
	for _, t := range resp.Targets {
		if t.Created {
			created++
		}
	}
	log.Printf("[server-enqueue] smoke run %s: suburb %s: %d job(s) created, %d deduplicated onto pending jobs of another run; ledger written; priority %d",
		runID, target.Suburb, created, len(resp.Targets)-created, smokeEnqueuePriority)
	return 0
}


// selectSmokeTarget returns the catalog suburb a smoke run enqueues. The queue dedupes an enqueue
// onto an existing pending job and keeps that job's priority, so a suburb with an open ledger row
// is already queued and cannot be smoked at the smoke priority. See chooseSmokeTarget.
func selectSmokeTarget(ctx context.Context, pool *pgxpool.Pool, suburb string) (CrawlTarget, error) {
	queued, err := queuedSuburbSlugs(ctx, pool)
	if err != nil {
		return CrawlTarget{}, fmt.Errorf("smoke queue check failed: %w", err)
	}
	var fresh []suburbFreshness
	if strings.TrimSpace(suburb) == "" {
		fresh, err = queryCatalogFreshness(ctx, pool, crawlTargets, loadDeltaConfig().churnDays)
		if err != nil {
			return CrawlTarget{}, fmt.Errorf("smoke target freshness query failed: %w", err)
		}
	}
	return chooseSmokeTarget(suburb, queued, fresh)
}

// queuedSuburbSlugs returns the catalog slugs that have an open ledger row (not closed, not
// expired) for either portal. Every pending BrandBrain job is dispatched, so these are queued.
func queuedSuburbSlugs(ctx context.Context, pool *pgxpool.Pool) (map[string]bool, error) {
	rows, err := pool.Query(ctx, `SELECT DISTINCT lower(replace(suburb, ' ', '-')) FROM crawl_dispatch
		WHERE closed_at IS NULL AND expires_at > now()`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var slug string
		if err := rows.Scan(&slug); err != nil {
			return nil, err
		}
		out[slug] = true
	}
	return out, rows.Err()
}

// chooseSmokeTarget is the pure decision. An explicit suburb must be a catalog slug and must
// not be queued: a queued suburb would dedupe onto its existing job at that job's priority. With
// no suburb, the stalest catalog suburb that is not queued is chosen (fresh is then required).
func chooseSmokeTarget(suburb string, queued map[string]bool, fresh []suburbFreshness) (CrawlTarget, error) {
	want := strings.ToLower(strings.TrimSpace(suburb))
	if want != "" {
		for _, t := range crawlTargets {
			if t.Suburb != want {
				continue
			}
			if queued[want] {
				return CrawlTarget{}, fmt.Errorf("-suburb %q already has open crawl jobs, so a smoke enqueue would dedupe onto them at their priority; refused", suburb)
			}
			return t, nil
		}
		return CrawlTarget{}, fmt.Errorf("-suburb %q is not a catalog suburb slug", suburb)
	}
	var free []suburbFreshness
	for _, f := range fresh {
		if !queued[f.Target.Suburb] {
			free = append(free, f)
		}
	}
	t, ok := pickStalest(free)
	if !ok {
		return CrawlTarget{}, errors.New("every catalog suburb has open crawl jobs; there is nothing to smoke at the smoke priority")
	}
	return t, nil
}

// pickStalest returns the suburb crawled longest ago. A never-crawled suburb beats any
// crawled one; ties keep the first in catalog order.
func pickStalest(fresh []suburbFreshness) (CrawlTarget, bool) {
	best := -1
	for i, f := range fresh {
		if best < 0 || staler(f.LastCrawled, fresh[best].LastCrawled) {
			best = i
		}
	}
	if best < 0 {
		return CrawlTarget{}, false
	}
	return fresh[best].Target, true
}

// staler reports whether a last crawl at a is older than one at b. nil means never crawled.
func staler(a, b *time.Time) bool {
	switch {
	case a == nil:
		return b != nil
	case b == nil:
		return false
	default:
		return a.Before(*b)
	}
}

// serverPropertyResolveExit maps the resolver's exit code for the server schedule. Exit 3
// means the autocomplete blocked us. The rig wrapper (run-housing-property-resolve.sh) treats
// that as a designed back-off and exits 0. Cloud Run would retry the job twice into the same
// endpoint, so the server does the same: it logs a warning and succeeds. Other codes pass.
func serverPropertyResolveExit(rc int) int {
	if rc == 3 {
		log.Printf("[property-resolve] WARN: the autocomplete blocked this run; backing off until the next scheduled run (exit 0, as the rig wrapper does)")
		return 0
	}
	return rc
}

// runServerPropertyResolve is -mode server-property-resolve, the schedule's mode.
func runServerPropertyResolve(ctx context.Context, pool *pgxpool.Pool) int {
	return serverPropertyResolveExit(runPropertyResolve(ctx, pool))
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
			return refreshHousingMVChecked(ctx, pool)
		},
		revalidate: pingRevalidate,
	}
}

// refreshHousingMVChecked runs refresh_housing_materialized_views() and fails if any view
// was skipped. The function turns a per-view failure into RAISE WARNING 'Skipping <view>: …'
// and still returns OK (migration 000127). Without this check a partial refresh looks like a
// success, and the cache bust and the watermark would move past data that never refreshed.
// Notices are captured on the one connection the call runs on.
func refreshHousingMVChecked(ctx context.Context, pool *pgxpool.Pool) error {
	var skipped []string
	restore := housingNotices.capture(func(n *pgconn.Notice) {
		if v, ok := skippedMVView(n); ok {
			skipped = append(skipped, v)
		}
	})
	defer restore()

	// The same statement refreshHousingMV runs: the override is scoped to this implicit
	// transaction, which is safe on the transaction pooler.
	if _, err := pool.Exec(ctx, `SET LOCAL statement_timeout = 0;
		SELECT refresh_housing_materialized_views()`); err != nil {
		return err
	}
	if len(skipped) > 0 {
		return fmt.Errorf("refresh_housing_materialized_views skipped %d view(s): %s", len(skipped), strings.Join(skipped, ", "))
	}
	return nil
}

// noticeSink routes server NOTICE and WARNING messages to the one capture in progress. The
// pool sets OnNotice to handle (connect in store.go, and the test pools), because pgx has no
// per-call hook. With no capture active, a notice is dropped, as pgx does by default.
type noticeSink struct {
	mu sync.Mutex
	fn func(*pgconn.Notice)
}

var housingNotices noticeSink

func (s *noticeSink) handle(_ *pgconn.PgConn, n *pgconn.Notice) {
	s.mu.Lock()
	fn := s.fn
	s.mu.Unlock()
	if fn != nil {
		fn(n)
	}
}

// capture routes notices to fn until the returned function is called. Captures do not nest.
func (s *noticeSink) capture(fn func(*pgconn.Notice)) (restore func()) {
	s.mu.Lock()
	s.fn = fn
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		s.fn = nil
		s.mu.Unlock()
	}
}

// skippedMVView returns the view named by a `Skipping <view>: …` notice.
func skippedMVView(n *pgconn.Notice) (string, bool) {
	if n == nil || !strings.HasPrefix(n.Message, "Skipping ") {
		return "", false
	}
	name, _, _ := strings.Cut(strings.TrimPrefix(n.Message, "Skipping "), ":")
	name = strings.TrimSpace(name)
	return name, name != ""
}

// loadFinalizeWatermark returns the cursor, or nil when no finalize has succeeded.
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

// newestReceiptAfter returns the newest ingest receipt after the cursor. ok is false when the
// ingest has written nothing since. A nil cursor means "never finalized", so every receipt
// counts. The query uses the created_at index.
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

// saveFinalizeWatermark moves the cursor forward. GREATEST keeps a slower concurrent run from
// moving it backwards.
func saveFinalizeWatermark(ctx context.Context, pool *pgxpool.Pool, watermark time.Time) error {
	_, err := pool.Exec(ctx, `
		INSERT INTO crawl_finalize_state (name, watermark, updated_at)
		VALUES ($1, $2, now())
		ON CONFLICT (name) DO UPDATE
		SET watermark  = GREATEST(crawl_finalize_state.watermark, EXCLUDED.watermark),
		    updated_at = now()`, crawlFinalizeCursor, watermark)
	return err
}

// pruneIngestReceipts deletes receipts created before cutoff, in batches.
func pruneIngestReceipts(ctx context.Context, pool *pgxpool.Pool, cutoff time.Time) (int64, error) {
	var total int64
	for {
		tag, err := pool.Exec(ctx, `
			DELETE FROM crawl_ingest_receipts
			WHERE key IN (SELECT key FROM crawl_ingest_receipts WHERE created_at < $1 LIMIT $2)`,
			cutoff, crawlPruneBatch)
		if err != nil {
			return total, err
		}
		n := tag.RowsAffected()
		total += n
		if n < crawlPruneBatch {
			return total, nil
		}
	}
}

// pruneDispatchLedger deletes terminal ledger rows older than cutoff: closed jobs, and open
// jobs whose expiry has passed. A row is kept while a job can still be pushed for. It is
// batched like the receipt prune.
func pruneDispatchLedger(ctx context.Context, pool *pgxpool.Pool, cutoff time.Time) (int64, error) {
	var total int64
	for {
		tag, err := pool.Exec(ctx, `
			DELETE FROM crawl_dispatch
			WHERE job_id IN (
				SELECT job_id FROM crawl_dispatch
				WHERE COALESCE(closed_at, expires_at) < $1
				  AND (closed_at IS NOT NULL OR expires_at <= now())
				LIMIT $2)`,
			cutoff, crawlPruneBatch)
		if err != nil {
			return total, err
		}
		n := tag.RowsAffected()
		total += n
		if n < crawlPruneBatch {
			return total, nil
		}
	}
}

// claimFinalizeLeaseSQL takes the lease when it is free or has lapsed. It is a row, not an
// advisory lock, because the server's DATABASE_URL is the transaction pooler (6543), which
// does not hold a session lock across statements. The same shape as picks_run_lease.
const claimFinalizeLeaseSQL = `
	INSERT INTO crawl_finalize_lease AS l (name, holder, expires_at)
	VALUES ($1, $2, now() + ($3::int * interval '1 second'))
	ON CONFLICT (name) DO UPDATE
	SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
	WHERE l.expires_at < now()
	RETURNING holder`

// claimFinalizeLease reports whether holder now owns the finalize lease. A held lease returns
// no row, which is reported as ok=false and no error.
func claimFinalizeLease(ctx context.Context, pool *pgxpool.Pool, holder string, ttl time.Duration) (bool, error) {
	var got string
	err := pool.QueryRow(ctx, claimFinalizeLeaseSQL, crawlFinalizeLease, holder, int(ttl.Seconds())).Scan(&got)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return got == holder, nil
}

// releaseFinalizeLease frees the lease if holder still owns it. It runs on a fresh context, so
// a cancelled run still releases.
func releaseFinalizeLease(pool *pgxpool.Pool, holder string) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if _, err := pool.Exec(ctx,
		`DELETE FROM crawl_finalize_lease WHERE name = $1 AND holder = $2`, crawlFinalizeLease, holder); err != nil {
		log.Printf("[crawl-finalize] lease release failed (it expires after %s): %v", finalizeLeaseTTL, err)
	}
}

// crawlFinalize runs the finalize steps only if the ingest has written since the cursor, and
// returns whether it ran them. The steps run in dependency order: the suburb sal-link first,
// because the listing and price-event links copy from the region row it sets. The cursor moves
// only after the MV refresh succeeds, to min(newest receipt, runStart − crawlWatermarkMargin).
// A failed step holds the cursor and skips the cache bust. Housekeeping only logs on failure.
func crawlFinalize(ctx context.Context, pool *pgxpool.Pool, ops finalizeOps, runStart time.Time) (bool, error) {
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

	next := newest
	if floor := runStart.Add(-crawlWatermarkMargin); next.After(floor) {
		next = floor
	}
	if err := saveFinalizeWatermark(ctx, pool, next); err != nil {
		return true, fmt.Errorf("save watermark: %w", err)
	}
	cutoff := runStart.Add(-crawlRetention)
	if pruned, err := pruneIngestReceipts(ctx, pool, cutoff); err != nil {
		log.Printf("[crawl-finalize] receipt prune failed (best-effort, retried next run): %v", err)
	} else {
		log.Printf("[crawl-finalize] pruned %d ingest receipt(s) older than %s", pruned, crawlRetention)
	}
	if pruned, err := pruneDispatchLedger(ctx, pool, cutoff); err != nil {
		log.Printf("[crawl-finalize] dispatch ledger prune failed (best-effort, retried next run): %v", err)
	} else {
		log.Printf("[crawl-finalize] pruned %d terminal dispatch row(s) older than %s", pruned, crawlRetention)
	}
	log.Printf("[crawl-finalize] finalized ingest writes up to %s (cursor %s)", newest.Format(time.RFC3339), next.Format(time.RFC3339))
	return true, nil
}

// runCrawlFinalizeWith is the lease-guarded finalize. A held lease exits 0: the other run
// finalizes the same data. Exit 1 means a step failed.
func runCrawlFinalizeWith(ctx context.Context, pool *pgxpool.Pool, ops finalizeOps, holder string, runStart time.Time) int {
	got, err := claimFinalizeLease(ctx, pool, holder, finalizeLeaseTTL)
	if err != nil {
		log.Printf("[crawl-finalize] fatal: lease: %v", err)
		return 1
	}
	if !got {
		log.Printf("[crawl-finalize] another finalize holds the lease; exiting 0 without running")
		return 0
	}
	defer releaseFinalizeLease(pool, holder)
	if _, err := crawlFinalize(ctx, pool, ops, runStart); err != nil {
		log.Printf("[crawl-finalize] fatal: %v", err)
		return 1
	}
	return 0
}

// runCrawlFinalize is -mode crawl-finalize. It runs on a detached context with the collector's
// finalize timeout, so a run deadline cannot kill an MV refresh for committed data.
func runCrawlFinalize(pool *pgxpool.Pool) int {
	ctx, cancel := context.WithTimeout(context.Background(), finalizeTimeout)
	defer cancel()
	holder := fmt.Sprintf("%s-%d-%d", crawlHost(), os.Getpid(), time.Now().UnixNano())
	return runCrawlFinalizeWith(ctx, pool, productionFinalizeOps(pool), holder, time.Now().UTC())
}
