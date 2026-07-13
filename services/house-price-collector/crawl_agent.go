package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
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
	token         string // BRANDBRAIN_AGENT_TOKEN
	agentID       string // CRAWL_AGENT_ID (identifies this rig in the queue)
	maxJobs       int    // CRAWL_AGENT_MAX_JOBS — safety cap per run
}

func loadAgentConfig() agentConfig {
	host, _ := os.Hostname()
	if host == "" {
		host = "collector"
	}
	return agentConfig{
		brandbrainURL: strings.TrimRight(os.Getenv("BRANDBRAIN_AGENT_URL"), "/"),
		token:         os.Getenv("BRANDBRAIN_AGENT_TOKEN"),
		agentID:       envStr("CRAWL_AGENT_ID", "housing-"+host),
		maxJobs:       envInt("CRAWL_AGENT_MAX_JOBS", 20),
	}
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
	NeedsRewarm   bool   `json:"needs_rewarm"`
	Detail        string `json:"detail,omitempty"`
}

type brandbrainAgentClient struct {
	url     string
	token   string
	agentID string
	http    *http.Client
}

func newBrandbrainAgentClient(cfg agentConfig) *brandbrainAgentClient {
	return &brandbrainAgentClient{
		url: cfg.brandbrainURL, token: cfg.token, agentID: cfg.agentID,
		http: &http.Client{Timeout: 30 * time.Second},
	}
}

func (c *brandbrainAgentClient) do(ctx context.Context, method, path string, body, out any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal request: %w", err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.url+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("X-Agent-ID", c.agentID)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return fmt.Errorf("brandbrain %s %s: %d %s", method, path, resp.StatusCode, strings.TrimSpace(string(rb)))
	}
	if out != nil && len(rb) > 0 {
		return json.Unmarshal(rb, out)
	}
	return nil
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
// BRANDBRAIN_AGENT_TOKEN, CRAWL_ENQUEUE_SOURCE (default both), CRAWL_ENQUEUE_TIER
// (default listings).
func runEnqueue(ctx context.Context, _ *pgxpool.Pool) {
	acfg := loadAgentConfig()
	if acfg.brandbrainURL == "" || acfg.token == "" {
		log.Printf("[enqueue] BRANDBRAIN_AGENT_URL + BRANDBRAIN_AGENT_TOKEN required — nothing to do")
		return
	}
	source := envStr("CRAWL_ENQUEUE_SOURCE", "both")
	tier := envStr("CRAWL_ENQUEUE_TIER", "listings")

	jobs := make([]crawlEnqueueInput, 0, len(crawlTargets))
	for _, t := range crawlTargets {
		jobs = append(jobs, crawlEnqueueInput{
			Kind: "housing", Suburb: t.Display, State: t.State, Postcode: t.Postcode,
			Source: source, Tier: tier,
		})
	}

	client := newBrandbrainAgentClient(acfg)
	n, err := client.enqueue(ctx, jobs)
	if err != nil {
		log.Printf("[enqueue] error: %v", err)
		return
	}
	log.Printf("[enqueue] enqueued %d new job(s) of %d target(s) (source=%s tier=%s)", n, len(jobs), source, tier)
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
func runAgent(ctx context.Context, pool *pgxpool.Pool) bool {
	acfg := loadAgentConfig()
	if acfg.brandbrainURL == "" || acfg.token == "" {
		log.Printf("[agent] BRANDBRAIN_AGENT_URL + BRANDBRAIN_AGENT_TOKEN required — nothing to do")
		return false
	}

	cfg := loadListingsConfig()
	var fetcher crawlFetcher
	if cfg.fixtureDir != "" {
		fetcher = &fileFetcher{dir: cfg.fixtureDir}
		log.Printf("[agent] FIXTURE mode: reading pages from %s (no browser)", cfg.fixtureDir)
	} else {
		f, err := newCrawlFetcher(cfg.crawlConfig)
		if err != nil {
			log.Printf("[agent] crawl fetcher init failed (%v) — aborting (non-fatal)", err)
			return false
		}
		fetcher = f
	}
	defer fetcher.Close()

	client := newBrandbrainAgentClient(acfg)
	log.Printf("[agent] start: agent=%s brandbrain=%s maxJobs=%d dryRun=%v", acfg.agentID, acfg.brandbrainURL, acfg.maxJobs, cfg.dryRun)

	anyRewarm := false
	wroteAny := false
	done := 0
	for i := 0; i < acfg.maxJobs; i++ {
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
		summary, status, errMsg, wrote := crawlAgentJob(ctx, pool, fetcher, cfg, job)
		wroteAny = wroteAny || wrote
		if summary.NeedsRewarm {
			anyRewarm = true
		}
		if err := client.submit(ctx, job.ID, status, &summary, errMsg); err != nil {
			log.Printf("[agent] submit error (job=%s): %v", job.ID, err)
		}
		log.Printf("[agent] job %s %s/%s → %s: listings=%d events=%d blocked=%d", job.ID, job.Suburb, job.Tier, status, summary.Listings, summary.Events, summary.BlockedSweeps)
		done++
	}

	// Refresh MVs + sal-link once at the end of the run (not per job).
	if wroteAny && !cfg.dryRun {
		if _, err := linkSuburbSalCodes(ctx, pool); err != nil {
			log.Printf("[agent] suburb sal_code link failed: %v", err)
		}
		if _, err := linkListingSalCodes(ctx, pool); err != nil {
			log.Printf("[agent] listing sal_code link failed: %v", err)
		}
		if err := refreshHousingMV(ctx, pool); err != nil {
			log.Printf("[agent] mv refresh failed: %v", err)
		}
	}
	log.Printf("[agent] done: processed %d job(s)", done)
	if anyRewarm {
		log.Printf("[agent] REWARM REQUIRED: a sweep tripped the circuit breaker — re-warm the crawl Chrome profile")
	}
	return anyRewarm
}

// crawlAgentJob runs one claimed suburb job (listings tier) and returns the
// counts-only summary, the terminal status, an optional error, and whether it
// wrote anything (to gate the end-of-run MV refresh).
func crawlAgentJob(ctx context.Context, pool *pgxpool.Pool, fetcher htmlFetcher, cfg listingsConfig, job *agentCrawlJob) (crawlJobSummary, string, string, bool) {
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

	lc := &listingsCrawler{fetcher: fetcher, cfg: cfg}
	reaEvents := lc.crawlSuburbSource(ctx, pool, t, "rea", t.reaSearchURL, &lc.reaBlocks, runTs)
	domEvents := lc.crawlSuburbSource(ctx, pool, t, "domain", t.domainSearchURL, &lc.domBlocks, runTs)

	s := lc.stats
	summary := crawlJobSummary{
		Suburbs:       1,
		Listings:      s.seen,
		Events:        reaEvents + domEvents,
		BlockedSweeps: s.blockedSweeps,
		NeedsRewarm:   needsRewarm(cfg.maxConsecBlocks, lc.reaBlocks, lc.domBlocks),
	}

	// Nothing seen and something blocked ⇒ the suburb was blocked/poisoned: fail
	// the job so it can be retried later (it wrote nothing).
	if s.seen == 0 && s.blockedSweeps > 0 {
		summary.Detail = "all sweeps blocked"
		return summary, "failed", "all sweeps blocked", false
	}
	return summary, "succeeded", "", !cfg.dryRun && s.seen > 0
}
