package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// crawl_agent.go is the `-mode agent` poller: instead of iterating a static suburb
// list, the collector POLLS the brandbrain-native crawl queue for ONE suburb at a
// time, runs the existing per-suburb listings sweep, writes to shorted's DB as
// usual, and reports a COUNTS-ONLY summary back to brandbrain. Multiple pollers
// claiming from the one queue fan suburbs out via SKIP LOCKED. brandbrain owns the
// queue + tracking; no listing rows / addresses / PII ever cross to brandbrain.
//
// Auth: BRANDBRAIN_AGENT_URL + BRANDBRAIN_AGENT_TOKEN (a scoped brandbrain agent
// token). Absent either → the mode is a no-op (safe to ship dark).

type agentConfig struct {
	brandbrainURL string // BRANDBRAIN_AGENT_URL, e.g. https://api.brandbrain.dev
	token         string // BRANDBRAIN_AGENT_TOKEN (optional seed; auto-refreshed on 401)
	agentID       string // CRAWL_AGENT_ID (identifies this rig in the queue)
	maxJobs       int    // CRAWL_AGENT_MAX_JOBS — safety cap per run
	controlURL    string // loopback macOS-agent control API for on-401 token refresh (optional)
	controlSecret string // matching X-Agent-Control-Secret
}

func loadAgentConfig() agentConfig {
	host, _ := os.Hostname()
	if host == "" {
		host = "collector"
	}
	controlURL, controlSecret := loadAgentControlAuth()
	return agentConfig{
		brandbrainURL: strings.TrimRight(os.Getenv("BRANDBRAIN_AGENT_URL"), "/"),
		token:         os.Getenv("BRANDBRAIN_AGENT_TOKEN"),
		agentID:       envStr("CRAWL_AGENT_ID", "housing-"+host),
		maxJobs:       envInt("CRAWL_AGENT_MAX_JOBS", 20),
		controlURL:    controlURL,
		controlSecret: controlSecret,
	}
}

// loadAgentControlAuth locates the co-located macOS BrandBrain agent's loopback
// control API. That agent is already signed in and continuously rotates its short
// (~15 min) access token from a 30-day refresh token, so it is a durable, always-
// fresh token source — using it means -mode agent NEVER needs a hand-minted
// long-lived credential: it re-fetches a fresh token on 401 (see refreshToken).
// Port from BRANDBRAIN_CONTROL_PORT or ~/.brandbrain/diag-port; secret from
// BRANDBRAIN_CONTROL_SECRET or ~/.brandbrain/control_secret. Returns ("","") when
// unavailable → no auto-refresh, plain single-token behaviour (back-compat).
func loadAgentControlAuth() (controlURL, secret string) {
	home, _ := os.UserHomeDir()
	port := strings.TrimSpace(os.Getenv("BRANDBRAIN_CONTROL_PORT"))
	if port == "" && home != "" {
		if b, err := os.ReadFile(filepath.Join(home, ".brandbrain", "diag-port")); err == nil {
			port = digitsOnly(string(b))
		}
	}
	secret = strings.TrimSpace(os.Getenv("BRANDBRAIN_CONTROL_SECRET"))
	if secret == "" && home != "" {
		if b, err := os.ReadFile(filepath.Join(home, ".brandbrain", "control_secret")); err == nil {
			secret = strings.TrimSpace(string(b))
		}
	}
	if port == "" || secret == "" {
		return "", ""
	}
	return "http://127.0.0.1:" + port, secret
}

// digitsOnly keeps only [0-9] (mirrors the diag-port shell read `tr -dc '0-9'`).
func digitsOnly(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// agentCrawlJob is the subset of brandbrain's crawl-job DTO the poller needs.
type agentCrawlJob struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Suburb   string `json:"suburb"`
	State    string `json:"state"`
	Postcode string `json:"postcode"`
	Source   string `json:"source"`
	Tier     string `json:"tier"`
}

// crawlJobSummary is the counts-only result reported back to brandbrain. It carries
// NO listing rows / addresses / prices — only tallies. Matches brandbrain's
// domain.CrawlJobResultSummary json tags.
type crawlJobSummary struct {
	Suburbs       int    `json:"suburbs"`
	Listings      int    `json:"listings"`
	Events        int    `json:"events"`
	BlockedSweeps int    `json:"blocked_sweeps"`
	SkippedRows   int    `json:"skipped_rows,omitempty"`
	NeedsRewarm   bool   `json:"needs_rewarm"`
	Detail        string `json:"detail,omitempty"`
}

type brandbrainAgentClient struct {
	url           string
	token         string
	agentID       string
	http          *http.Client
	controlURL    string // loopback macOS-agent control API (optional token source)
	controlSecret string
}

func newBrandbrainAgentClient(cfg agentConfig) *brandbrainAgentClient {
	return &brandbrainAgentClient{
		url: cfg.brandbrainURL, token: cfg.token, agentID: cfg.agentID,
		http:       &http.Client{Timeout: 30 * time.Second},
		controlURL: cfg.controlURL, controlSecret: cfg.controlSecret,
	}
}

// canRefresh reports whether an expired token can be transparently replaced from
// the co-located macOS agent's control API (see loadAgentControlAuth).
func (c *brandbrainAgentClient) canRefresh() bool {
	return c.controlURL != "" && c.controlSecret != ""
}

// do sends a request and, on a 401 (the short access token expired mid-run),
// transparently re-fetches a fresh token from the local agent control API and
// retries ONCE — so an unattended batch never dies of token expiry and never
// needs a hand-minted long-lived credential.
func (c *brandbrainAgentClient) do(ctx context.Context, method, path string, body, out any) error {
	var payload []byte
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal request: %w", err)
		}
		payload = b
	}

	// Bounded retry with jittered backoff on TRANSIENT failures: a network/TLS/
	// timeout error (roundtrip err), or a 5xx (brandbrain 502s are known at >2
	// workers). A 401 triggers a ONE-SHOT token refresh; any other 4xx is terminal
	// and not retried. Every endpoint here (claim/submit/enqueue) is idempotent
	// (submit keys on job_id), so retrying is safe — this is what stops a single
	// TLS handshake timeout from losing a completed suburb's counts.
	const maxAttempts = 4
	refreshed := false
	var rb []byte
	var status int
	var err error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(agentBackoff(attempt)):
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		rb, status, err = c.roundtrip(ctx, method, path, payload)
		if err != nil {
			continue // transient transport error — retry
		}
		if status == http.StatusUnauthorized && c.canRefresh() && !refreshed {
			refreshed = true
			if tok, rerr := c.refreshToken(ctx); rerr != nil {
				log.Printf("[agent] token refresh failed: %v", rerr)
			} else if tok != "" && tok != c.token {
				c.token = tok
				log.Printf("[agent] access token expired — refreshed from local agent, retrying")
				attempt-- // a refresh retry shouldn't consume a backoff attempt
				continue
			}
		}
		if status >= 500 {
			continue // transient server error (e.g. brandbrain 502) — retry
		}
		break // 2xx, or a terminal 4xx
	}
	if err != nil {
		return err
	}
	if status >= 300 {
		return fmt.Errorf("brandbrain %s %s: %d %s", method, path, status, strings.TrimSpace(string(rb)))
	}
	if out != nil && len(rb) > 0 {
		return json.Unmarshal(rb, out)
	}
	return nil
}

// agentBackoff returns a jittered exponential backoff for retry attempt N (>=1):
// ~0.5s, 1s, 2s, … capped at 8s, plus up to +50% jitter.
func agentBackoff(attempt int) time.Duration {
	base := 500 * time.Millisecond * time.Duration(int64(1)<<uint(attempt-1))
	if base > 8*time.Second {
		base = 8 * time.Second
	}
	return base + time.Duration(rand.Int63n(int64(base/2)+1))
}

// roundtrip performs a single authenticated request and returns the (bounded)
// body + status. The 401-refresh policy lives in do, so this stays a pure send.
func (c *brandbrainAgentClient) roundtrip(ctx context.Context, method, path string, payload []byte) ([]byte, int, error) {
	var rdr io.Reader
	if payload != nil {
		rdr = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.url+path, rdr)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("X-Agent-ID", c.agentID)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	rb, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return rb, resp.StatusCode, nil
}

// refreshToken pulls the co-located macOS agent's CURRENT access token from its
// loopback control API (the same source get-bb-token.sh uses). The agent keeps
// this token continuously valid off its 30-day refresh token, so this needs no
// stored long-lived credential — it just re-reads whatever is fresh right now.
func (c *brandbrainAgentClient) refreshToken(ctx context.Context) (string, error) {
	if !c.canRefresh() {
		return "", fmt.Errorf("local agent control API not configured")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.controlURL+"/control/v1/auth/session/export", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("X-Agent-Control-Secret", c.controlSecret)
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	rb, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("agent control export: %d %s", resp.StatusCode, strings.TrimSpace(string(rb)))
	}
	var out struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(rb, &out); err != nil {
		return "", fmt.Errorf("agent control export: %w", err)
	}
	if out.AccessToken == "" {
		return "", fmt.Errorf("agent control export: empty access_token (agent signed out?)")
	}
	return out.AccessToken, nil
}

// claim returns the next suburb job, or nil when the queue is empty.
func (c *brandbrainAgentClient) claim(ctx context.Context) (*agentCrawlJob, error) {
	var resp struct {
		Job *agentCrawlJob `json:"job"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/v1/agent/crawl-jobs/claim", nil, &resp); err != nil {
		return nil, err
	}
	return resp.Job, nil
}

// submit reports a terminal result for a claimed job.
func (c *brandbrainAgentClient) submit(ctx context.Context, jobID, status string, summary *crawlJobSummary, errMsg string) error {
	return c.do(ctx, http.MethodPost, "/api/v1/agent/crawl-jobs/submit", map[string]any{
		"job_id":         jobID,
		"status":         status,
		"result_summary": summary,
		"error":          errMsg,
	}, nil)
}

// crawlEnqueueInput is one suburb to enqueue on the brandbrain queue.
type crawlEnqueueInput struct {
	Kind     string `json:"kind"`
	Suburb   string `json:"suburb"`
	State    string `json:"state"`
	Postcode string `json:"postcode"`
	Source   string `json:"source"`
	Tier     string `json:"tier"`
	Priority int    `json:"priority,omitempty"`
}

// enqueue posts suburb jobs to the queue; brandbrain skips pending duplicates.
// Returns the number actually inserted.
func (c *brandbrainAgentClient) enqueue(ctx context.Context, jobs []crawlEnqueueInput) (int, error) {
	var resp struct {
		Enqueued int `json:"enqueued"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/v1/agent/crawl-jobs", map[string]any{"jobs": jobs}, &resp); err != nil {
		return 0, err
	}
	return resp.Enqueued, nil
}

// runEnqueue is the -mode=enqueue entry point: post the curated suburb catalog to
// the brandbrain queue so pollers have work to claim. shorted stays the source of
// truth for AU suburbs; brandbrain is a generic queue. Env: BRANDBRAIN_AGENT_URL +
// BRANDBRAIN_AGENT_TOKEN, CRAWL_ENQUEUE_SOURCE (default "split" → separate rea +
// domain jobs; "rea"/"domain" for one portal; "both" for a legacy combined job),
// CRAWL_ENQUEUE_TIER (default listings).
func runEnqueue(ctx context.Context, _ *pgxpool.Pool) {
	acfg := loadAgentConfig()
	if acfg.brandbrainURL == "" || (acfg.token == "" && acfg.controlURL == "") {
		log.Printf("[enqueue] BRANDBRAIN_AGENT_URL + a token (BRANDBRAIN_AGENT_TOKEN, or a local agent control API for auto-refresh) required — nothing to do")
		return
	}
	sources := enqueueSources(envStr("CRAWL_ENQUEUE_SOURCE", "split"))
	tier := envStr("CRAWL_ENQUEUE_TIER", "listings")

	// One job per (suburb, source) so REA and Domain crawl, retry, and report
	// independently — the queue's unique-pending index is (kind,suburb,source,tier),
	// so the two coexist without collision.
	jobs := make([]crawlEnqueueInput, 0, len(crawlTargets)*len(sources))
	for _, t := range crawlTargets {
		for _, src := range sources {
			jobs = append(jobs, crawlEnqueueInput{
				Kind: "housing", Suburb: t.Display, State: t.State, Postcode: t.Postcode,
				Source: src, Tier: tier,
			})
		}
	}

	// POST in chunks: the backend enqueue does a per-row INSERT ... ON CONFLICT,
	// so a whole-catalog batch (hundreds of jobs) can exceed the edge's request
	// timeout (observed: 230 jobs → 504). Chunking keeps each request fast; the
	// unique-pending index makes every chunk idempotent, so a retry just fills
	// any gap. Overridable via CRAWL_ENQUEUE_BATCH.
	batch := envInt("CRAWL_ENQUEUE_BATCH", 40)
	if batch < 1 {
		batch = 40
	}
	client := newBrandbrainAgentClient(acfg)
	total := 0
	for i := 0; i < len(jobs); i += batch {
		end := i + batch
		if end > len(jobs) {
			end = len(jobs)
		}
		n, err := client.enqueue(ctx, jobs[i:end])
		if err != nil {
			log.Printf("[enqueue] error on batch %d-%d (%d already enqueued): %v", i, end, total, err)
			return
		}
		total += n
	}
	log.Printf("[enqueue] enqueued %d new job(s) of %d target(s) × sources=%v (tier=%s)", total, len(crawlTargets), sources, tier)
}

// enqueueSources maps CRAWL_ENQUEUE_SOURCE to the set of source jobs to create
// per suburb. The default splits each suburb into independent "rea" and "domain"
// jobs so the two portals crawl, retry, and report separately (REA is
// Kasada-gated, Domain Akamai-gated — they block independently). "rea"/"domain"
// enqueues just that portal; "both" creates one legacy combined job.
func enqueueSources(v string) []string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "rea":
		return []string{"rea"}
	case "domain":
		return []string{"domain"}
	case "both":
		return []string{"both"}
	default: // "", "split", or anything else → separate rea + domain jobs
		return []string{"rea", "domain"}
	}
}

// wantSource reports whether a job that targets jobSource ("rea" | "domain" |
// "both" | "") should crawl the given portal. A blank or "both" source crawls
// every portal (legacy combined jobs stay backward-compatible); a single-source
// job crawls only its own portal.
func wantSource(portal, jobSource string) bool {
	s := strings.ToLower(strings.TrimSpace(jobSource))
	if s == "" || s == "both" {
		return true
	}
	return s == portal
}

// resolveCrawlTarget maps a claimed job to a full CrawlTarget. It prefers the
// authoritative entry in crawlTargets (which carries the Display slug + GCCSA
// Capital), falling back to a best-effort construction (Capital unknown → the
// median capital-band gate is skipped, absolute bounds still apply).
func resolveCrawlTarget(job *agentCrawlJob) (CrawlTarget, bool) {
	slug := slugifySuburb(job.Suburb)
	for _, t := range crawlTargets {
		if strings.EqualFold(t.State, job.State) && t.Postcode == job.Postcode &&
			(strings.EqualFold(t.Suburb, slug) || strings.EqualFold(t.Display, job.Suburb)) {
			return t, true
		}
	}
	return CrawlTarget{
		Suburb:   slug,
		Display:  titleCaseSuburb(job.Suburb),
		Postcode: strings.TrimSpace(job.Postcode),
		State:    strings.ToUpper(strings.TrimSpace(job.State)),
	}, false
}

func slugifySuburb(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	return strings.ReplaceAll(s, " ", "-")
}

func titleCaseSuburb(s string) string {
	fields := strings.Fields(strings.ReplaceAll(strings.TrimSpace(s), "-", " "))
	for i, f := range fields {
		if f == "" {
			continue
		}
		fields[i] = strings.ToUpper(f[:1]) + f[1:]
	}
	return strings.Join(fields, " ")
}

// runAgent is the -mode=agent entry point. Returns true if any job detected the
// browser needs a human re-warm (surfaces via exit code 3 for launchd).
// runAgent drains the brandbrain crawl queue and returns a process EXIT CODE:
// 0 = ok / nothing to do, 3 = a sweep tripped the re-warm signal, 4 = the crawl
// fetcher couldn't init (wedged/cold host Chrome — the runner should hard-recover
// Chrome and retry, same convention as -mode warmcheck).
func runAgent(ctx context.Context, pool *pgxpool.Pool) int {
	acfg := loadAgentConfig()
	if acfg.brandbrainURL == "" || (acfg.token == "" && acfg.controlURL == "") {
		log.Printf("[agent] BRANDBRAIN_AGENT_URL + a token (BRANDBRAIN_AGENT_TOKEN, or a local agent control API for auto-refresh) required — nothing to do")
		return 0
	}

	cfg := loadListingsConfig()

	// Self-warm the dedicated Chrome before crawling (in-process port of
	// run-housing-agent.sh). Only when the run will ACTUALLY drive the host Chrome
	// over CDP: selectFetcherMode mirrors newCrawlFetcher's precedence
	// (gateway > cdp > playwright), so a gateway or self-launched-playwright run —
	// which never touches our dedicated Chrome — won't waste ~60s warming one.
	// Skipped for FIXTURE runs and when CRAWL_AUTO_WARM=false. On failure, exit 4
	// so an unattended scheduler re-runs after a cooldown.
	if cfg.fixtureDir == "" && selectFetcherMode(cfg.crawlConfig) == fetcherModeCDP {
		if ccfg := loadChromeConfig(cfg.cdpURL); ccfg.autoWarm {
			deps := chromeDeps{
				reachable: chromeReachable,
				launch:    launchDedicatedChrome,
				recover:   recoverWedgedChrome,
				warmProbe: func() int { return runWarmCheck(ctx, pool) },
			}
			if err := ensureChromeWarm(ccfg, deps); err != nil {
				log.Printf("[agent] self-warm failed (%v) — exiting for re-warm (exit 4)", err)
				return 4
			}
			log.Printf("[agent] dedicated Chrome warm (self-managed)")
		}
	}

	var fetcher crawlFetcher
	if cfg.fixtureDir != "" {
		fetcher = &fileFetcher{dir: cfg.fixtureDir}
		log.Printf("[agent] FIXTURE mode: reading pages from %s (no browser)", cfg.fixtureDir)
	} else {
		f, err := newCrawlFetcher(cfg.crawlConfig)
		if err != nil {
			// The warm preflight passed but the host Chrome lost its context between
			// probe and crawl (a closed tab). Hard-recover once, then retry — mirrors
			// the shell runner's agent-rc4 retry so an unattended run self-heals.
			log.Printf("[agent] crawl fetcher init failed (%v) — hard-recovering Chrome and retrying", err)
			if selectFetcherMode(cfg.crawlConfig) == fetcherModeCDP {
				_ = recoverWedgedChrome(loadChromeConfig(cfg.cdpURL))
			}
			f, err = newCrawlFetcher(cfg.crawlConfig)
			if err != nil {
				log.Printf("[agent] crawl fetcher init failed after recovery (%v) — exit 4", err)
				return 4
			}
		}
		fetcher = f
	}
	defer fetcher.Close()

	client := newBrandbrainAgentClient(acfg)
	log.Printf("[agent] start: agent=%s brandbrain=%s maxJobs=%d dryRun=%v", acfg.agentID, acfg.brandbrainURL, acfg.maxJobs, cfg.dryRun)
	if acfg.controlURL != "" {
		log.Printf("[agent] token auto-refresh ENABLED via local agent control API — an expired token is re-fetched mid-run (no minted credential needed)")
	}

	// Checkpoint/resume (see crawl_resume.go): OFF unless
	// CRAWL_LISTINGS_RESUME_WINDOW_H is set. Loaded once for the whole run.
	rs, resumeErr := loadResumeSnapshot(ctx, pool, cfg.resumeWindow)
	if resumeErr != nil {
		log.Printf("[agent] resume snapshot load failed (%v) — resume disabled for this run", resumeErr)
	} else if cfg.resumeWindow > 0 {
		log.Printf("[agent] resume window=%s — %d (source,suburb) pair(s) loaded", cfg.resumeWindow, len(rs))
	}

	// Per-source circuit breaker (crawl_circuit.go): persists across suburbs so a
	// portal that starts serving block pages (Akamai errors.edgesuite.net, Kasada
	// stubs) is backed off exponentially and SKIPPED during its cooldown instead
	// of being hammered on every suburb — while the healthy portal keeps crawling.
	// This is the state the per-job listingsCrawler (rebuilt each suburb) can't
	// hold, which is why Domain-only blocking previously ran unthrottled.
	cb := newCircuitBreaker(cfg.circuitTrip, cfg.circuitBase, cfg.circuitMax)
	circuitSources := []string{"rea", "domain"}

	// Optional LIVE telemetry stream (crawl_telemetry.go): off unless CRAWL_TELEMETRY
	// is set. Created once per run so the co-located macOS agent UI can tail
	// per-listing extraction + failures in-flight.
	tel := newTelemetryWriter(loadTelemetryConfig())
	defer tel.Close()

	anyRewarm := false
	wroteAny := false
	done := 0
	consecBlocked := 0
	for i := 0; i < acfg.maxJobs; i++ {
		// If EVERY source is circuit-open, the whole session is blocked: stop
		// claiming (leaving those suburbs pending for the next warm run) rather
		// than burn the queue on jobs that would crawl nothing.
		if allOpen, rem := cb.allOpen(circuitSources, time.Now().UTC()); allOpen {
			log.Printf("[agent] all sources circuit-open (session blocked) — stopping to protect the queue; longest backoff %s", rem.Round(time.Second))
			anyRewarm = true
			break
		}
		job, err := client.claim(ctx)
		if err != nil {
			log.Printf("[agent] claim error: %v", err)
			break
		}
		if job == nil {
			log.Printf("[agent] no more jobs")
			break
		}
		if done > 0 {
			jitterSleep(ctx, cfg.minDelay, cfg.maxDelay)
		}
		summary, status, errMsg, wrote := crawlAgentJob(ctx, pool, fetcher, cfg, job, rs, cb, tel)
		wroteAny = wroteAny || wrote
		if summary.NeedsRewarm {
			anyRewarm = true
		}
		// A DRY run must NOT submit: submit is terminal in the queue, so a dry run
		// reporting "succeeded" would CONSUME the pending job without persisting
		// anything (it wouldn't re-serve to a real run until it went stale). Skip
		// the submit — the claim's lease simply expires and the job re-pends. The
		// rest of the loop (logging, block-detection) runs unchanged either way.
		if !cfg.dryRun {
			// Report on a DETACHED context (+ its own retries in do): reporting the
			// result of ALREADY-COMPLETED work must not be killed by the crawl deadline
			// (ctx) firing between the write and the submit — that would orphan the
			// job in the queue and lose the counts.
			subCtx, subCancel := context.WithTimeout(context.Background(), 45*time.Second)
			if err := client.submit(subCtx, job.ID, status, &summary, errMsg); err != nil {
				log.Printf("[agent] submit error (job=%s): %v", job.ID, err)
			}
			subCancel()
		}
		dry := ""
		if cfg.dryRun {
			dry = " DRY(not submitted)"
		}
		log.Printf("[agent] job %s %s/%s → %s: listings=%d events=%d blocked=%d skipped=%d%s", job.ID, job.Suburb, job.Tier, status, summary.Listings, summary.Events, summary.BlockedSweeps, summary.SkippedRows, dry)
		done++

		// A job that wrote no events off a blocked/poisoned sweep means the browser
		// session has gone cold — Kasada/Akamai serving stubs or poison, or an IP
		// throttle after several heavy sweeps. The submit above marked it failed.
		// Two such jobs in a row ⇒ the session is degraded, so STOP claiming and
		// flag a re-warm (exit 3) instead of burning the rest of the still-PENDING
		// queue on a session that will keep returning blocked — those un-claimed
		// suburbs stay pending for the next warm run, and (since brandbrain PR
		// #168) the two that already blocked auto-re-pend too while
		// attempts<max_attempts, so a later warm run retries them for free.
		// (Observed live: New Farm then Toowong both blocked back-to-back once
		// the session throttled.)
		if status == "failed" && summary.Events == 0 && summary.BlockedSweeps > 0 {
			consecBlocked++
			if consecBlocked >= 2 {
				log.Printf("[agent] %d consecutive blocked sweeps — session degraded; stopping to re-warm before the queue is burned", consecBlocked)
				anyRewarm = true
				break
			}
		} else {
			consecBlocked = 0
		}
	}

	// Refresh MVs + sal-link once at the end of the run (not per job) — on a
	// DETACHED context, same reason as submit above: finalizing ALREADY-COMMITTED
	// writes must not die with the run deadline. Observed live: the deadline fired
	// mid-batch and took the sal-link, the MV refresh AND the revalidate ping with
	// it, leaving fresh data invisible on /price-drops until an unrelated later run.
	if wroteAny && !cfg.dryRun {
		finCtx, finCancel := context.WithTimeout(context.Background(), finalizeTimeout)
		if _, err := linkSuburbSalCodes(finCtx, pool); err != nil {
			log.Printf("[agent] suburb sal_code link failed: %v", err)
		}
		if _, err := linkListingSalCodes(finCtx, pool); err != nil {
			log.Printf("[agent] listing sal_code link failed: %v", err)
		}
		if _, err := linkPriceEventSalCodes(finCtx, pool); err != nil {
			log.Printf("[agent] price-event sal_code link failed: %v", err)
		}
		if err := refreshHousingMV(finCtx, pool); err != nil {
			log.Printf("[agent] mv refresh failed: %v", err)
		} else {
			// Data changed (wroteAny) + MVs refreshed → bust the web tier's
			// long-TTL housing caches now. Best-effort, never fails the run.
			pingRevalidate("agent")
		}
		finCancel()
	}
	log.Printf("[agent] done: processed %d job(s)", done)
	if anyRewarm {
		log.Printf("[agent] REWARM REQUIRED: a sweep tripped the circuit breaker — re-warm the crawl Chrome profile")
		return 3
	}
	return 0
}

// crawlAgentJob runs one claimed suburb job (listings tier) and returns the
// counts-only summary, the terminal status, an optional error, and whether it
// wrote anything (to gate the end-of-run MV refresh). rs is the (optional —
// may be nil) resume snapshot loaded once for the whole -mode agent run; a
// source within the resume window is skipped for this job (logged, never
// silently) rather than swept again.
func crawlAgentJob(ctx context.Context, pool *pgxpool.Pool, fetcher htmlFetcher, cfg listingsConfig, job *agentCrawlJob, rs resumeSet, cb *crawlCircuitBreaker, tel *telemetryWriter) (crawlJobSummary, string, string, bool) {
	// Medians-in-agent-mode is a follow-up; the standalone `-mode crawl` path
	// still serves the median tier. Fail such a job clearly rather than silently.
	if strings.EqualFold(job.Tier, "medians") {
		return crawlJobSummary{Suburbs: 1, Detail: "medians tier not yet supported in agent mode"}, "failed", "medians tier not supported in agent mode (use -mode crawl)", false
	}

	t, _ := resolveCrawlTarget(job)
	runTs := time.Now().UTC()

	if !cfg.dryRun {
		if err := upsertRegions(ctx, pool, listingRegionObs([]CrawlTarget{t})); err != nil {
			return crawlJobSummary{Suburbs: 1, Detail: "region upsert failed"}, "failed", "region upsert: " + err.Error(), false
		}
	}

	lc := &listingsCrawler{fetcher: fetcher, cfg: cfg, tel: tel}
	var reaEvents, domEvents int
	var reaErr, domErr error
	var skippedRea, skippedDomain bool
	// A job may target a single portal (source="rea"/"domain") or both
	// (source="both"/"" — legacy combined job). Skip the portal this job doesn't
	// own so REA and Domain can run as independent jobs with their own status,
	// retries, and circuit-breaker state.
	if !wantSource("rea", job.Source) {
		skippedRea = true
	} else if rs.shouldSkipTarget("rea", t, runTs, cfg.resumeWindow) {
		skippedRea = true
		log.Printf("[agent] %s rea: skipped (swept within the resume window)", t.Display)
	} else if open, rem := cb.skip("rea", runTs); open {
		skippedRea = true
		log.Printf("[agent] %s rea: SKIPPED — circuit open (portal blocking), backing off %s", t.Display, rem.Round(time.Second))
	} else {
		reaEvents, reaErr = lc.crawlSuburbSource(ctx, pool, t, "rea", t.reaSearchURL, &lc.reaBlocks, runTs)
		if opened, cd := cb.record("rea", lc.reaBlocks > 0, runTs); opened {
			log.Printf("[agent] rea circuit OPEN after %d consecutive blocked sweep(s) — backing off %s before probing again", cb.circuit("rea").consec, cd.Round(time.Second))
		}
	}
	if !wantSource("domain", job.Source) {
		skippedDomain = true
	} else if rs.shouldSkipTarget("domain", t, runTs, cfg.resumeWindow) {
		skippedDomain = true
		log.Printf("[agent] %s domain: skipped (swept within the resume window)", t.Display)
	} else if open, rem := cb.skip("domain", runTs); open {
		skippedDomain = true
		log.Printf("[agent] %s domain: SKIPPED — circuit open (portal blocking), backing off %s", t.Display, rem.Round(time.Second))
	} else {
		domEvents, domErr = lc.crawlSuburbSource(ctx, pool, t, "domain", t.domainSearchURL, &lc.domBlocks, runTs)
		if opened, cd := cb.record("domain", lc.domBlocks > 0, runTs); opened {
			log.Printf("[agent] domain circuit OPEN after %d consecutive blocked sweep(s) — backing off %s before probing again", cb.circuit("domain").consec, cd.Round(time.Second))
		}
	}

	s := lc.stats
	summary := crawlJobSummary{
		Suburbs:       1,
		Listings:      s.seen,
		Events:        reaEvents + domEvents,
		BlockedSweeps: s.blockedSweeps,
		SkippedRows:   s.skippedRows,
		NeedsRewarm:   needsRewarm(cfg.maxConsecBlocks, lc.reaBlocks, lc.domBlocks),
	}
	if skippedRea && skippedDomain {
		summary.Detail = "both sources skipped (swept within the resume window)"
		return summary, "succeeded", "", false
	}

	// A blocked/poisoned sweep is DISCARDED wholesale — crawlSuburbSource writes
	// nothing for a blocked sweep even when earlier pages already collected real
	// listings — so raw `seen` can be >0 while zero events were written. Gate the
	// terminal status on EVENTS WRITTEN, not `seen`: a blocked sweep that produced
	// no events got no usable data, so mark the job FAILED rather than banking a
	// silent no-data "success". (Observed live: QLD suburbs collected page 1, hit a
	// mid-sweep poison gate → seen=118, events=0, and were wrongly reported
	// "succeeded".) NOTE: since brandbrain PR #168 a submitted "failed" AUTO-
	// RE-PENDS in the queue while attempts<max_attempts (same as a lease-expired
	// job), so a failed suburb gets free retries in later warm sessions; only a
	// suburb that exhausts max_attempts stays terminally failed until the next
	// full `-mode enqueue` or a targeted re-enqueue.
	// A diff (persist) error takes precedence over the counts-only outcome: the
	// sweep saw listings but couldn't write them, so the suburb MUST re-crawl.
	// Reporting "succeeded" here (as the old code did — crawlSuburbSource
	// swallowed the error and returned 0) banked a silent no-data run: 0 events
	// is indistinguishable from a clean no-change sweep, so the job was marked
	// done and the suburb wasn't re-served until the next full enqueue.
	status, detail, errMsg := agentJobTerminal(summary.Events, s.blockedSweeps, s.skippedRows, firstErr(reaErr, domErr))
	if status == "failed" {
		summary.Detail = detail
		// The job re-crawls, but a SIBLING source may already have committed real
		// events (e.g. REA persisted; only Domain's diff errored). Gate the
		// end-of-run sal_code link + MV refresh on whether anything was actually
		// committed (summary.Events), not a blanket false — otherwise freshly
		// written data is left unlinked/unrefreshed until an unrelated later run.
		// A blocked-sweep failure has Events==0, so it still returns false.
		return summary, "failed", errMsg, !cfg.dryRun && summary.Events > 0
	}
	return summary, "succeeded", "", !cfg.dryRun && s.seen > 0
}

// firstErr returns the first non-nil error, or nil.
func firstErr(errs ...error) error {
	for _, e := range errs {
		if e != nil {
			return e
		}
	}
	return nil
}

// agentJobTerminal decides the terminal queue status, detail, and error message
// for a completed suburb job. A diff (persist) error takes precedence — a
// transient DB failure is NOT a clean run and must NOT be reported "succeeded"
// (see crawlAgentJob). A diff-error failure carries blockedSweeps that may be 0,
// so — unlike a blocked-sweep failure — it does not count toward the re-warm /
// session-degradation budget in runAgent (which gates on BlockedSweeps>0), i.e.
// a Supabase blip never triggers a Chrome re-warm.
//
// skippedRows are individual listings dropped by diffSuburb's per-row SAVEPOINT
// on a PERMANENT error. A PARTIAL skip (events>0) is the intended graceful case →
// succeed (the good rows persisted). But an ALL-skipped sweep (events==0 &&
// skippedRows>0) means we saw listings and persisted NOTHING — a systematic
// extractor/schema problem — so fail it to surface loudly rather than bank a
// silent no-data success (same posture as the blocked-sweep gate). It is bounded
// by the queue's max_attempts, and the fix is a code change, not a re-crawl.
func agentJobTerminal(events, blockedSweeps, skippedRows int, diffErr error) (status, detail, errMsg string) {
	if diffErr != nil {
		m := "diff persist error: " + diffErr.Error()
		return "failed", m, m
	}
	if agentJobOutcome(events, blockedSweeps) == "failed" {
		return "failed", "blocked/poisoned sweep(s), no events written", "blocked sweeps, no events written"
	}
	if events == 0 && skippedRows > 0 {
		m := "all listings skipped (permanent row errors), no events written"
		return "failed", m, m
	}
	return "succeeded", "", ""
}

// agentJobOutcome decides the terminal queue status for a completed suburb sweep
// from its counts. Because a blocked/poisoned sweep is discarded wholesale (0
// events written) even when raw `seen` is >0 from listings collected before the
// block, the decision keys on events written: no events off a blocked sweep ⇒
// "failed" (re-queue for a warm retry), anything else ⇒ "succeeded". A legitimate
// no-change run (events==0, blockedSweeps==0) stays "succeeded".
func agentJobOutcome(events, blockedSweeps int) string {
	if events == 0 && blockedSweeps > 0 {
		return "failed"
	}
	return "succeeded"
}

type crawlPurgeRequest struct {
	Kind     string   `json:"kind,omitempty"`
	Source   string   `json:"source,omitempty"`
	Tier     string   `json:"tier,omitempty"`
	Statuses []string `json:"statuses"`
	DryRun   bool     `json:"dry_run"`
}

type crawlPurgeResponse struct {
	Purged int  `json:"purged"`
	DryRun bool `json:"dry_run"`
}

func (c *brandbrainAgentClient) purge(ctx context.Context, req crawlPurgeRequest) (crawlPurgeResponse, error) {
	var resp crawlPurgeResponse
	err := c.do(ctx, http.MethodPost, "/api/v1/agent/crawl-jobs/purge", req, &resp)
	return resp, err
}

// runPurge is the -mode=purge entry point: invalidate stale queue entries via
// the brandbrain purge endpoint, for cleaning up after a job-shape/schema
// refactor (e.g. clearing legacy source='both' jobs after the per-source split).
// Criteria from env: PURGE_SOURCE, PURGE_KIND, PURGE_TIER, PURGE_STATUSES
// (comma, default "pending,in_progress"), PURGE_DRY_RUN (default "true" — set
// "false" to actually delete). DRY-RUN by default so the operator previews the
// match count before deleting.
func runPurge(ctx context.Context, _ *pgxpool.Pool) {
	acfg := loadAgentConfig()
	if acfg.brandbrainURL == "" || (acfg.token == "" && acfg.controlURL == "") {
		log.Printf("[purge] BRANDBRAIN_AGENT_URL + a token (BRANDBRAIN_AGENT_TOKEN, or a local agent control API) required — nothing to do")
		return
	}
	var statuses []string
	for _, p := range strings.Split(envStr("PURGE_STATUSES", "pending,in_progress"), ",") {
		if p = strings.TrimSpace(p); p != "" {
			statuses = append(statuses, p)
		}
	}
	req := crawlPurgeRequest{
		Kind:     envStr("PURGE_KIND", ""),
		Source:   envStr("PURGE_SOURCE", ""),
		Tier:     envStr("PURGE_TIER", ""),
		Statuses: statuses,
		DryRun:   envStr("PURGE_DRY_RUN", "true") != "false",
	}
	resp, err := newBrandbrainAgentClient(acfg).purge(ctx, req)
	if err != nil {
		log.Printf("[purge] error: %v", err)
		return
	}
	mode := "DRY-RUN — nothing deleted (set PURGE_DRY_RUN=false to delete)"
	if !resp.DryRun {
		mode = "DELETED"
	}
	log.Printf("[purge] %s: %d job(s) matched (source=%q kind=%q tier=%q statuses=%v)",
		mode, resp.Purged, req.Source, req.Kind, req.Tier, statuses)
}
