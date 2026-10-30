package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/oauth2"
)

// crawl_agent.go is the `-mode agent` poller: instead of iterating a static suburb
// list, the collector POLLS the brandbrain-native crawl queue for ONE suburb at a
// time, runs the existing per-suburb listings sweep, writes to shorted's DB as
// usual, and reports a COUNTS-ONLY summary back to brandbrain. Multiple pollers
// claiming from the one queue fan suburbs out via SKIP LOCKED. brandbrain owns the
// queue + tracking; no listing rows / addresses / PII ever cross to brandbrain.
//
// Auth: BRANDBRAIN_AGENT_URL plus either BRANDBRAIN_AGENT_TOKEN (a scoped
// brandbrain agent token) or the co-located control API. Missing required queue
// infrastructure is fatal (exit 7), so an unattended scheduler cannot report a
// successful empty drain when the agent was never configured.

type agentConfig struct {
	brandbrainURL string // BRANDBRAIN_AGENT_URL, e.g. https://api.brandbrain.dev
	token         string // BRANDBRAIN_AGENT_TOKEN (optional seed; auto-refreshed on 401)
	agentID       string // CRAWL_AGENT_ID (identifies this rig in the queue)
	maxJobs       int    // CRAWL_AGENT_MAX_JOBS — safety cap per run
	controlURL    string // loopback macOS-agent control API for on-401 token refresh (optional)
	controlSecret string // matching X-Agent-Control-Secret
	// workloadTokens is set on a cycle's rounds (CRAWL_TOKEN_SOURCE=workload). Workload tokens
	// are then minted with workloadSecret, and the control secret is never read or sent.
	workloadTokens bool
	workloadSecret string // BRANDBRAIN_WORKLOAD_TOKEN_SECRET, the per-cycle secret. Never logged.
	// proxy is set on a cycle's rounds. The queue (claim, renew, submit) then goes through the
	// loopback agent proxy at brandbrainURL, with the per-cycle secret as the bearer (token). The
	// round holds no BrandBrain credential, cannot refresh a token, and never exports a session.
	proxy bool
}

// agentProxyURLEnv names the loopback agent proxy a cycle hands its rounds. The URL is
// exactly http://127.0.0.1:<port>/control/v1/agent-proxy; nothing else is accepted.
const (
	agentProxyURLEnv = "BRANDBRAIN_AGENT_PROXY_URL"
	agentProxyPath   = "/control/v1/agent-proxy"
	// The cycle's env names that a round must never receive: a BrandBrain credential, or the
	// direct BrandBrain URL that would invite a round to bypass the proxy.
	agentTokenEnv = "BRANDBRAIN_AGENT_TOKEN"
	agentURLEnv   = "BRANDBRAIN_AGENT_URL"
)

var agentProxyURLRe = regexp.MustCompile(`^http://127\.0\.0\.1:([0-9]{1,5})/control/v1/agent-proxy$`)

// parseAgentProxyURL returns the canonical proxy URL and its loopback port, or "", "" when raw
// is not exactly the loopback proxy URL. Host, scheme, path, query and port are all exact.
func parseAgentProxyURL(raw string) (string, string) {
	m := agentProxyURLRe.FindStringSubmatch(raw)
	if m == nil {
		return "", ""
	}
	port := validControlPort(m[1])
	if port == "" || port != m[1] {
		return "", ""
	}
	return "http://127.0.0.1:" + port + agentProxyPath, port
}

// isCycleChild reports whether this process was started by a cycle: the cycle passes the
// round-only events fd and its cycle id, and no hand-run process has both.
func isCycleChild(getenv func(string) string) bool {
	fd, err := strconv.Atoi(strings.TrimSpace(getenv(crawlEventsFDEnv)))
	return err == nil && fd >= 3 && strings.TrimSpace(getenv("CRAWL_CYCLE_ID")) != ""
}

// resolveRoundTokenSource decides how a round authenticates. CRAWL_TOKEN_SOURCE=workload is
// honoured only inside a cycle child, and then the proxy URL and the per-cycle secret are
// required. Set by hand on any other run it is refused, never treated as the legacy path.
func resolveRoundTokenSource(getenv func(string) string) (bool, string) {
	v := strings.TrimSpace(getenv(tokenSourceEnv))
	switch {
	case v == "":
		return false, ""
	case v != tokenSourceWorkload:
		return false, fmt.Sprintf("%s=%q is not a known token source", tokenSourceEnv, v)
	case !isCycleChild(getenv):
		return false, fmt.Sprintf("%s=workload is set only by a collector cycle; a plain -mode agent run must not set it", tokenSourceEnv)
	}
	return true, ""
}

// loadAgentConfig is the round's config. workload is the result of resolveRoundTokenSource.
func loadAgentConfig(workload bool) agentConfig {
	if workload {
		return loadCycleAgentConfig(os.Getenv)
	}
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

// loadCycleAgentConfig is the config for -mode cycle and for a cycle's child rounds. It reads
// the loopback proxy URL (which names the control port), and the per-cycle workload secret. It
// never reads ~/.brandbrain/control_secret, BRANDBRAIN_CONTROL_SECRET, BRANDBRAIN_AGENT_TOKEN or
// BRANDBRAIN_AGENT_URL: the queue is reached through the proxy with the secret as the bearer.
// An invalid or missing proxy URL leaves brandbrainURL empty, and the callers refuse.
func loadCycleAgentConfig(getenv func(string) string) agentConfig {
	host, _ := os.Hostname()
	if host == "" {
		host = "collector"
	}
	proxyURL, port := parseAgentProxyURL(strings.TrimSpace(getenv(agentProxyURLEnv)))
	controlURL := ""
	if port != "" {
		controlURL = "http://127.0.0.1:" + port
	}
	agentID := strings.TrimSpace(getenv("CRAWL_AGENT_ID"))
	if agentID == "" {
		agentID = "housing-" + host
	}
	secret := strings.TrimSpace(getenv(workloadTokenSecretEnv))
	return agentConfig{
		brandbrainURL:  proxyURL,
		token:          secret, // the queue bearer on the proxy; empty when the secret is absent
		agentID:        agentID,
		maxJobs:        20,
		controlURL:     controlURL,
		workloadTokens: true,
		workloadSecret: secret,
		proxy:          true,
	}
}

// loadControlPort returns the loopback control port from BRANDBRAIN_CONTROL_PORT or
// ~/.brandbrain/diag-port, validated, or "" when neither names one. The port is not a secret.
func loadControlPort(getenv func(string) string) string {
	home, _ := os.UserHomeDir()
	port := strings.TrimSpace(getenv("BRANDBRAIN_CONTROL_PORT"))
	// The env value is not trusted to be a port: "1@evil.example" would name a host.
	if port == "" && home != "" {
		if b, err := os.ReadFile(filepath.Join(home, ".brandbrain", "diag-port")); err == nil {
			port = digitsOnly(string(b))
		}
	}
	return validControlPort(port)
}

// scrubWorkloadSecret removes the workload secret from this process's environment once it has
// been read into a config. Anything this process starts afterwards (Chrome, the Playwright
// driver, the install-driver step) inherits the environment, so it must not carry the secret.
func scrubWorkloadSecret() {
	_ = os.Unsetenv(workloadTokenSecretEnv)
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
	port := loadControlPort(os.Getenv)
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

// validControlPort returns s as a canonical TCP port when it is all digits in 1..65535,
// and "" otherwise. The control URL is then always http://127.0.0.1:<port>.
func validControlPort(s string) string {
	if s == "" || len(s) > 5 {
		return ""
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return ""
		}
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 || n > 65535 {
		return ""
	}
	return strconv.Itoa(n)
}

// digitsOnly keeps only [0-9] (mirrors the diag-port shell read `tr -dc '0-9'`).
// flattenWhitespace collapses any run of whitespace to a single space so a
// multi-line payload survives as one readable line.
func flattenWhitespace(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

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
	// Attempts is the claim's attempt number, the third part of the ingest idempotency
	// key (<job_id>:<attempt>:<source>). MaxAttempts is informational.
	Attempts    int `json:"attempts"`
	MaxAttempts int `json:"max_attempts"`
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
	// noRetry asks BrandBrain to make a failed job terminal (sent as no_retry on submit).
	noRetry bool `json:"-"`
}

type brandbrainAgentClient struct {
	url   string
	token string
	// proxy is set for a cycle round: the bearer is the per-cycle secret, the URL is the loopback
	// proxy, and a 401 is terminal (no refresh, no session export).
	proxy         bool
	agentID       string
	http          *http.Client
	controlURL    string // loopback macOS-agent control API (optional token source)
	controlSecret string
	// idTokens, when set, authenticates every request with a Google-signed ID token
	// instead of the agent bearer (the server's enqueue job, whose service account
	// BrandBrain allowlists). Such a client sends no X-Agent-ID and cannot refresh.
	// Tokens are never logged.
	idTokens oauth2.TokenSource
	// tokMu guards token. The renewal goroutine and the push retries share this client,
	// and a 401 rewrites the token mid-call.
	tokMu sync.Mutex
}

// newBrandbrainIDTokenClient builds a client for the server-side jobs. Each request
// carries a fresh Google ID token from ts. The bearer is the token's AccessToken,
// which is the ID token for an idtoken.NewTokenSource.
func newBrandbrainIDTokenClient(baseURL string, ts oauth2.TokenSource) *brandbrainAgentClient {
	return &brandbrainAgentClient{
		url:      strings.TrimRight(baseURL, "/"),
		http:     noRedirectHTTPClient(30 * time.Second),
		idTokens: ts,
	}
}

func newBrandbrainAgentClient(cfg agentConfig) *brandbrainAgentClient {
	return &brandbrainAgentClient{
		url: cfg.brandbrainURL, token: cfg.token, agentID: cfg.agentID,
		http:       noRedirectHTTPClient(30 * time.Second),
		controlURL: cfg.controlURL, controlSecret: cfg.controlSecret,
		proxy: cfg.proxy,
	}
}

// canRefresh reports whether an expired token can be transparently replaced from
// the co-located macOS agent's control API (see loadAgentControlAuth).
func (c *brandbrainAgentClient) canRefresh() bool {
	if c.proxy {
		return false // a cycle round never refreshes: a 401 is terminal
	}
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
	var refreshErr error
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
				refreshErr = rerr
				log.Printf("[agent] token refresh failed: %v", rerr)
			} else if tok != "" {
				// Retry even when another goroutine already installed this token: this
				// request went out with the bearer that is now stale. The refresh runs at
				// most once per call, so this cannot loop.
				if tok != c.currentToken() {
					c.setToken(tok)
					log.Printf("[agent] access token expired — refreshed from local agent, retrying")
				}
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
	if status == http.StatusUnauthorized && c.proxy {
		// Terminal for the round: the proxy refused the per-cycle secret. The round never
		// refreshes a token or exports a session, so there is nothing else to try.
		return fmt.Errorf("brandbrain %s %s: 401 from the agent proxy: the per-cycle workload secret was refused; the cycle round does not refresh", method, path)
	}
	if status == http.StatusUnauthorized && refreshErr != nil {
		// Refresh WAS available and failed — carry its reason. The common case
		// is a co-located agent that is running but signed out ("no active
		// session to export"), which is invisible from the 401 alone.
		return fmt.Errorf("brandbrain %s %s: %d %s — token refresh failed: %v "+
			"(sign the BrandBrain agent in, or mint a fresh BRANDBRAIN_AGENT_TOKEN)",
			method, path, status, strings.TrimSpace(string(rb)), refreshErr)
	}
	if status == http.StatusUnauthorized && c.idTokens != nil {
		// Terminal and operator-actionable: the job's service account is not on
		// BrandBrain's allowlist (or its uniqueId changed). Nothing here can renew it.
		return fmt.Errorf("brandbrain %s %s: 401 %s — the Google ID token was refused: "+
			"check this job's service account is on BrandBrain's allowlist (email=uniqueId)",
			method, path, strings.TrimSpace(string(rb)))
	}
	if status == http.StatusUnauthorized && !c.canRefresh() {
		// Say WHY, not just what. A 401 here is terminal and operator-actionable:
		// the static seed token is dead and this rig has no way to renew it,
		// because the co-located agent's loopback control API was not found.
		// Without this sentence the run records only "401 unauthorized", which
		// is indistinguishable from a transient blip — and that is exactly how
		// a rig sat doing zero work for 15 days (2026-08-25 → 09-09) while
		// still reporting hourly.
		return fmt.Errorf("brandbrain %s %s: %d %s — the static BRANDBRAIN_AGENT_TOKEN "+
			"cannot be refreshed: no local agent control API (set BRANDBRAIN_CONTROL_PORT + "+
			"BRANDBRAIN_CONTROL_SECRET, or run the BrandBrain agent so ~/.brandbrain/diag-port "+
			"and control_secret exist). Mint a fresh token or start the agent",
			method, path, status, strings.TrimSpace(string(rb)))
	}
	if status >= 300 {
		return fmt.Errorf("brandbrain %s %s: %d %s", method, path, status, strings.TrimSpace(string(rb)))
	}
	if out != nil && len(rb) > 0 {
		return json.Unmarshal(rb, out)
	}
	return nil
}

// currentToken returns the bearer under the token lock.
func (c *brandbrainAgentClient) currentToken() string {
	c.tokMu.Lock()
	defer c.tokMu.Unlock()
	return c.token
}

// setToken replaces the bearer under the token lock.
func (c *brandbrainAgentClient) setToken(tok string) {
	c.tokMu.Lock()
	defer c.tokMu.Unlock()
	c.token = tok
}

// agentBackoff returns a jittered exponential backoff for retry attempt N (>=1):
// ~0.5s, 1s, 2s, … capped at 8s, plus up to +50% jitter.
func agentBackoff(attempt int) time.Duration {
	base := min(500*time.Millisecond*time.Duration(int64(1)<<uint(attempt-1)), 8*time.Second)
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
	if c.idTokens != nil {
		// The error text from the token source never carries the token itself.
		tok, terr := c.idTokens.Token()
		if terr != nil {
			return nil, 0, fmt.Errorf("google id token: %w", terr)
		}
		req.Header.Set("Authorization", "Bearer "+tok.AccessToken)
	} else {
		req.Header.Set("Authorization", "Bearer "+c.currentToken())
		req.Header.Set("X-Agent-ID", c.agentID)
	}
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
	if c.proxy {
		return "", fmt.Errorf("token refresh is disabled for a cycle round")
	}
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
		// Flatten: the control API pretty-prints its JSON, and this string is
		// carried into a one-line log and into crawl_run_status.detail. Left
		// multi-line, the actual reason ("no active session to export") falls
		// off the first line and the operator sees only `404 {`.
		return "", fmt.Errorf("agent control export: %d %s", resp.StatusCode, flattenWhitespace(string(rb)))
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

// submit reports a job outcome. status is "succeeded"/"failed" (terminal) or
// "deferred" — the job was NOT attempted because the portal's circuit breaker was
// open, so it goes back on the queue with its attempt refunded and is held out of
// the claim query for retryAfter (the breaker's remaining cooldown).
func (c *brandbrainAgentClient) submit(ctx context.Context, jobID, status string, summary *crawlJobSummary, errMsg string, retryAfter time.Duration) error {
	body := map[string]any{
		"job_id":         jobID,
		"status":         status,
		"result_summary": summary,
		"error":          errMsg,
	}
	if retryAfter > 0 {
		body["retry_after_seconds"] = retryAfter.Seconds()
	}
	// no_retry makes a failed job terminal in BrandBrain. An older BrandBrain ignores it.
	if summary != nil && summary.noRetry {
		body["no_retry"] = true
	}
	return c.do(ctx, http.MethodPost, "/api/v1/agent/crawl-jobs/submit", body, nil)
}

// renew extends a claimed job's lease. The lease is 10 minutes (brandbrain), so a job
// whose sweeps and push retries run longer must renew it.
func (c *brandbrainAgentClient) renew(ctx context.Context, jobID string) error {
	return c.do(ctx, http.MethodPost, "/api/v1/agent/crawl-jobs/renew", map[string]string{"job_id": jobID}, nil)
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

// selectEnqueueTargets returns the suburbs an enqueue run posts. delta=false is the
// whole catalog. delta=true is demand-right-sizing (selectDeltaSuburbs), which may
// select none. Shared by -mode enqueue (the rig's queue) and -mode server-enqueue
// (BrandBrain through the server's ID token), so both pick the same suburbs.
func selectEnqueueTargets(ctx context.Context, pool *pgxpool.Pool, delta bool) ([]CrawlTarget, error) {
	if !delta {
		return crawlTargets, nil
	}
	dcfg := loadDeltaConfig()
	fresh, err := queryCatalogFreshness(ctx, pool, crawlTargets, dcfg.churnDays)
	if err != nil {
		return nil, fmt.Errorf("delta freshness query failed (not falling back to full enqueue): %w", err)
	}
	sel := selectDeltaSuburbs(fresh, dcfg, time.Now().UTC())
	log.Printf("[enqueue] delta selection: %d/%d suburb(s) selected — %d never-crawled, %d stale (>%s), %d churny (>=%d ev/%dd); %d capped off (NOT crawled this run)",
		len(sel.Targets), len(crawlTargets), sel.Never, sel.Stale, dcfg.ttl, sel.Churny, dcfg.churnMin, dcfg.churnDays, sel.Dropped)
	return sel.Targets, nil
}

// buildEnqueueJobs makes one job per (suburb, source) so REA and Domain crawl, retry
// and report independently. The queue's unique-pending index is
// (kind, suburb, state, postcode, source, tier), so the two coexist without collision.
// Suburb is the catalog's display name, which the ingest matches by slug.
func buildEnqueueJobs(targets []CrawlTarget, sources []string, tier string) []crawlEnqueueInput {
	jobs := make([]crawlEnqueueInput, 0, len(targets)*len(sources))
	for _, t := range targets {
		for _, src := range sources {
			jobs = append(jobs, crawlEnqueueInput{
				Kind: "housing", Suburb: t.Display, State: t.State, Postcode: t.Postcode,
				Source: src, Tier: tier,
			})
		}
	}
	return jobs
}

// runEnqueue is the -mode=enqueue entry point: post the suburb catalog to the
// brandbrain queue so pollers have work to claim. shorted stays the source of truth
// for AU suburbs; brandbrain is a generic queue. Env: BRANDBRAIN_AGENT_URL +
// BRANDBRAIN_AGENT_TOKEN, CRAWL_ENQUEUE_SOURCE (default "split" → separate rea +
// domain jobs; "rea"/"domain" for one portal; "both" for a legacy combined job),
// CRAWL_ENQUEUE_TIER (default listings).
//
// CRAWL_ENQUEUE_SELECTION picks WHICH suburbs to enqueue:
//   - "all"   (default, back-compat) — the whole catalog every run.
//   - "delta" — DEMAND-RIGHT-SIZING: only never-crawled / stale / churny suburbs,
//     ranked + capped (see selectDeltaSuburbs / crawl_delta.go). Reads freshness
//     read-only from prod; needs the pool, hence it is passed through here.
func runEnqueue(ctx context.Context, pool *pgxpool.Pool) error {
	acfg := loadAgentConfig(false)
	if acfg.brandbrainURL == "" || (acfg.token == "" && acfg.controlURL == "") {
		return fmt.Errorf("BRANDBRAIN_AGENT_URL + a token (BRANDBRAIN_AGENT_TOKEN, or a local agent control API for auto-refresh) required")
	}
	sources := enqueueSources(envStr("CRAWL_ENQUEUE_SOURCE", "split"))
	tier := envStr("CRAWL_ENQUEUE_TIER", "listings")

	// Choose the suburb set for this run. Default "all" preserves today's
	// whole-catalog behaviour; "delta" right-sizes to demand.
	delta := strings.EqualFold(strings.TrimSpace(envStr("CRAWL_ENQUEUE_SELECTION", "all")), "delta")
	targets, err := selectEnqueueTargets(ctx, pool, delta)
	if err != nil {
		return err
	}
	if len(targets) == 0 {
		log.Printf("[enqueue] delta: nothing stale/churny — queue left as-is (nothing to enqueue)")
		return nil
	}

	jobs := buildEnqueueJobs(targets, sources, tier)

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
		end := min(i+batch, len(jobs))
		n, err := client.enqueue(ctx, jobs[i:end])
		if err != nil {
			return fmt.Errorf("batch %d-%d failed (%d already enqueued): %w", i, end, total, err)
		}
		total += n
	}
	log.Printf("[enqueue] enqueued %d new job(s) of %d target(s) × sources=%v (tier=%s)", total, len(targets), sources, tier)
	return nil
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

// runAgent drains the brandbrain crawl queue and returns a process EXIT CODE:
// 0 = ok / nothing to do, 3 = a sweep tripped the re-warm signal, 4 = the crawl
// fetcher couldn't init, 7 = fatal agent infrastructure or finalizer failure,
// 8 = the crawl environment is broken, 10 = cancelled (SIGTERM/SIGINT, the events
// stream closed, or the process was orphaned), 12 = another live drainer holds
// the single-drainer lock. When CRAWL_EVENTS_FD is set, every return emits exactly
// one round_done event (see crawl_events.go).
func runAgent(ctx context.Context, pool *pgxpool.Pool) (code int) {
	events := newCrawlEventsFromEnv()
	var final roundResult
	defer func() { events.roundDone(final, code) }()

	// The signal handling is the FIRST thing this mode does (batch 1 item 1c). A SIGTERM that
	// arrives before the handler exists would kill the process with the default action, with no
	// round_done. SIGPIPE is ignored here too, so a dead events reader returns EPIPE.
	lock := newCrawlLockFromEnv()
	stop := newStopSignal()
	ctx, cancelRound := context.WithCancel(ctx)
	defer cancelRound()
	sigs := make(chan os.Signal, 2)
	removeSignals := installRoundSignals(stop, lock, sigs, os.Exit)
	defer removeSignals()
	if events != nil {
		// A broken events pipe stops the round at the next page (batch 1 item 5): the stop latch is
		// set and the fetch in flight is cancelled.
		events.onBroken = func() {
			stop.request("event-pipe")
			cancelRound()
		}
	}
	events.ready()
	ctx = withPageStop(ctx, agentPageStop(stop, cancelRound, startParentPID))

	sink, ingestURL, refusal := resolveSink("agent", os.Getenv)
	if refusal != "" {
		log.Printf("[agent] FATAL: refusing to start: %s", refusal)
		return exitSinkRefused
	}
	workload, refusal := resolveRoundTokenSource(os.Getenv)
	if refusal != "" {
		log.Printf("[agent] FATAL: refusing to start: %s", refusal)
		return exitSinkRefused
	}
	acfg := loadAgentConfig(workload)
	if acfg.workloadTokens {
		// A cycle's child round: the secret is in the config now, so this process and whatever it
		// starts must not inherit it. A round that cannot reach the queue or mint refuses as a
		// configuration error.
		scrubWorkloadSecret()
		if acfg.workloadSecret == "" {
			log.Printf("[agent] FATAL: %s is missing or empty; a cycle round cannot mint workload tokens", workloadTokenSecretEnv)
			return exitSinkRefused
		}
		if acfg.brandbrainURL == "" {
			log.Printf("[agent] FATAL: %s is missing or is not the loopback agent proxy URL (http://127.0.0.1:<port>%s)", agentProxyURLEnv, agentProxyPath)
			return exitSinkRefused
		}
	}
	if acfg.brandbrainURL == "" || (acfg.token == "" && acfg.controlURL == "") {
		log.Printf("[agent] FATAL: BRANDBRAIN_AGENT_URL + a token (BRANDBRAIN_AGENT_TOKEN, or a local agent control API for auto-refresh) required")
		return 7
	}
	if sink != crawlSinkDB {
		// ProbeAuth runs inside the round, after the lock and the signal handlers.
		ctx = withIngestRound(ctx, newIngestRound(sink, acfg, ingestURL, events))
	}

	return withCrawlLock(lock, func() int {
		return runAgentRound(ctx, pool, acfg, lock, events, stop, &final)
	})
}

// runAgentRound is one round, run while holding the single-drainer lock. The signal
// handling is installed by runAgent, before anything slow, and the stop latch is shared with it.
// It runs the Chrome preflight and fetcher setup, runs the work loop (roundIO.run), then
// finalizes and writes the health record.
func runAgentRound(ctx context.Context, pool *pgxpool.Pool, acfg agentConfig, lock *crawlLock, events *crawlEvents, stop *stopSignal, final *roundResult) int {
	// ProbeAuth (ingest and shadow) runs here, after the lock is held. A held lock still
	// exits 12, and a SIGTERM during the probe exits 10 with round_done (probeIngestRound).
	if ir := ingestRoundFrom(ctx); ir != nil {
		if code := probeIngestRound(ctx, ir, stop); code != 0 {
			return code
		}
	}

	cfg := loadListingsConfig()

	// Health-record identity for this invocation (see crawl_run_status.go). Resolved
	// up-front so the early Chrome-failure returns below can also self-report. A
	// launchd wrapper exports CRAWL_RUN_TYPE (delta|full) + a stable CRAWL_RUN_ID so
	// its several `-mode agent` rounds accumulate into one dashboard row.
	runStart := time.Now().UTC()
	runType := crawlRunType()
	runID := crawlRunID(runType)
	host := crawlHost()

	// Self-warm the dedicated Chrome before crawling (in-process port of
	// run-housing-agent.sh). Only when the run will ACTUALLY drive the host Chrome
	// over CDP: selectFetcherMode mirrors newCrawlFetcher's precedence
	// (gateway > cdp > playwright), so a gateway or self-launched-playwright run —
	// which never touches our dedicated Chrome — won't waste ~60s warming one.
	// Skipped for FIXTURE runs and when CRAWL_AUTO_WARM=false. On failure, exit 4
	// so an unattended scheduler re-runs after a cooldown.
	if cfg.fixtureDir == "" && selectFetcherMode(cfg.crawlConfig) == fetcherModeCDP {
		if ccfg := loadChromeConfig(cfg.cdpURL); ccfg.autoWarm {
			deps := chromeDepsForDefaults()
			deps.reachable = chromeReachable
			deps.launch = launchDedicatedChrome
			deps.recover = recoverWedgedChrome
			deps.warmProbe = func() int {
				events.startup("warm_probe", "start", "")
				rc := runWarmCheck(ctx, pool)
				events.startup("warm_probe", "done", warmProbeOutcome(rc))
				return rc
			}
			if err := ensureChromeWarm(ccfg, deps); err != nil {
				rc := agentExitForWarmFailure(err)
				if rc == exitCrawlEnvBroken {
					// Not a re-warm situation — the driver is missing and no scheduler
					// re-run will fix it. Say so, so the log does not send the operator
					// to the Chrome runbook (the 2026-08-13 outage).
					log.Printf("[agent] self-warm impossible (%v) — exiting %d for OPERATOR action", err, rc)
				} else {
					log.Printf("[agent] self-warm failed (%v) — exiting for re-warm (exit %d)", err, rc)
				}
				if !cfg.dryRun {
					persistRunRecord(ctx, pool, crawlRunStatusRecord{
						RunType: runType, Host: host, RunID: runID, StartedAt: runStart,
						Status: "error", Detail: runRecordDetail("self-warm failed: ", err),
					}, rc)
				}
				return rc
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
			// A missing driver fails here identically to a lost Chrome context, but
			// hard-recovering would KILL a healthy warm Chrome to fix a fault that is
			// not Chrome's. Bail before touching the browser.
			if warmCheckInitExitCode(err) == exitCrawlEnvBroken {
				log.Printf("[agent] %v (underlying: %v) — exiting %d for OPERATOR action", errCrawlEnvBroken, err, exitCrawlEnvBroken)
				if !cfg.dryRun {
					persistRunRecord(ctx, pool, crawlRunStatusRecord{
						RunType: runType, Host: host, RunID: runID, StartedAt: runStart,
						Status: "error", Detail: "crawl environment broken: " + err.Error(),
					}, exitCrawlEnvBroken)
				}
				return exitCrawlEnvBroken
			}
			// The warm preflight passed but the host Chrome lost its context between
			// probe and crawl (a closed tab). Hard-recover once, then retry — mirrors
			// the shell runner's agent-rc4 retry so an unattended run self-heals.
			log.Printf("[agent] crawl fetcher init failed (%v) — hard-recovering Chrome and retrying", err)
			if selectFetcherMode(cfg.crawlConfig) == fetcherModeCDP {
				if rerr := recoverWedgedChrome(loadChromeConfig(cfg.cdpURL)); errors.Is(rerr, errChromePortConflict) {
					// A foreign holder is an operator fault, not a Chrome one: no relaunch and no retry.
					log.Printf("[agent] %v — exiting %d for OPERATOR action", rerr, exitCrawlEnvBroken)
					if !cfg.dryRun {
						persistRunRecord(ctx, pool, crawlRunStatusRecord{
							RunType: runType, Host: host, RunID: runID, StartedAt: runStart,
							Status: "error", Detail: runRecordDetail("", rerr),
						}, exitCrawlEnvBroken)
					}
					return exitCrawlEnvBroken
				}
			}
			f, err = newCrawlFetcher(cfg.crawlConfig)
			if err != nil {
				log.Printf("[agent] crawl fetcher init failed after recovery (%v) — exit 4", err)
				if !cfg.dryRun {
					persistRunRecord(ctx, pool, crawlRunStatusRecord{
						RunType: runType, Host: host, RunID: runID, StartedAt: runStart,
						Status: "error", Detail: "crawl fetcher init failed: " + err.Error(),
					}, 4)
				}
				return 4
			}
		}
		fetcher = f
	}
	defer fetcher.Close()

	client := newBrandbrainAgentClient(acfg)
	log.Printf("[agent] start: agent=%s brandbrain=%s maxJobs=%d dryRun=%v", acfg.agentID, acfg.brandbrainURL, acfg.maxJobs, cfg.dryRun)
	if acfg.controlURL != "" && !acfg.proxy {
		log.Printf("[agent] token auto-refresh ENABLED via local agent control API — an expired token is re-fetched mid-run (no minted credential needed)")
	}

	// Checkpoint/resume (see crawl_resume.go): OFF unless
	// CRAWL_LISTINGS_RESUME_WINDOW_H is set. Loaded once for the whole run.
	// The ingest sink holds no database, so there is no snapshot to read: the server's
	// dispatch decides what is crawled. The db and shadow sinks load it as before.
	ir := ingestRoundFrom(ctx)
	rs, resumeErr := resumeSet{}, error(nil)
	if ir.writesLocally() {
		rs, resumeErr = loadResumeSnapshot(ctx, pool, cfg.resumeWindow)
	}
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
	// The state is loaded from and saved to the file (crawl_circuit_state.go), so a streak and its
	// backoff carry across the rounds and cycles of one crawl. A dry run never writes it.
	circuitPath := circuitStatePath()
	if cfg.dryRun {
		circuitPath = ""
	}
	cb := newPersistentCircuitBreaker(cfg.circuitTrip, cfg.circuitBase, cfg.circuitMax, circuitPath, time.Now().UTC())
	circuitSources := []string{"rea", "domain"}

	// Optional LIVE telemetry stream (crawl_telemetry.go): off unless CRAWL_TELEMETRY
	// is set. Created once per run so the co-located macOS agent UI can tail
	// per-listing extraction + failures in-flight.
	tel := newTelemetryWriter(loadTelemetryConfig())
	defer tel.Close()

	// Escalates only when DISTINCT suburbs block back to back (see blockTracker).
	// CRAWL_AGENT_BLOCK_TRIP defaults to 2, preserving today's threshold; a long
	// full-catalog pass, where isolated bad targets are expected, can raise it.
	blocks := newBlockTracker(envInt("CRAWL_AGENT_BLOCK_TRIP", 2))

	r := roundIO{
		maxJobs: acfg.maxJobs,
		dryRun:  cfg.dryRun,
		claim:   client.claim,
		allOpen: func() (bool, time.Duration) { return cb.allOpen(circuitSources, time.Now().UTC()) },
		runJob:  ir.jobRunner(pool, fetcher, cfg, rs, cb, tel, events),
		submit: func(_ context.Context, jobID, status string, summary *crawlJobSummary, errMsg string, retryAfter time.Duration) error {
			// Report on a DETACHED context with its own deadline: reporting the result
			// of ALREADY-COMPLETED work must not be killed by the crawl deadline firing
			// between the write and the submit — that would orphan the job in the queue
			// and lose the counts.
			subCtx, subCancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer subCancel()
			return client.submit(subCtx, jobID, status, summary, errMsg, retryAfter)
		},
		pause: func(ctx context.Context, stopped <-chan struct{}) {
			jitterSleepUntil(ctx, stopped, cfg.minDelay, cfg.maxDelay)
		},
		blocks:    blocks,
		roundExit: ir.code,
		events:    events,
		stop:      stop,
		ppid:      os.Getppid,
		startPPID: startParentPID,
		finalize: func(res *roundResult) {
			// The ingest server runs these itself (crawl-finalize), so a rig holding no
			// database has nothing to finalize.
			if !ir.writesLocally() {
				return
			}
			// Refresh MVs + sal-link once at the end of the run (not per job) — on a
			// DETACHED context, same reason as submit above: finalizing ALREADY-COMMITTED
			// writes must not die with the run deadline. Observed live: the deadline fired
			// mid-batch and took the sal-link, the MV refresh AND the revalidate ping with
			// it. Runs on a cancelled round too: committed work is finalized before exit.
			events.finalizeStarted()
			finCtx, finCancel := context.WithTimeout(context.Background(), finalizeTimeout)
			defer finCancel()
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
				res.fatalErr = true
				res.fatalDetail = "mv refresh failed: " + err.Error()
			} else {
				// Data changed (wroteAny) + MVs refreshed → bust the web tier's
				// long-TTL housing caches, now or (under the drain wrapper) once
				// when the drain ends. Best-effort, never fails the run.
				revalidateAfterCrawlWrite("agent")
			}
		},
	}
	res := r.run(ctx)
	*final = res

	code := finalExitCode(res)
	// Self-report this round's health so the residential crawl shows up as a tracked
	// scheduled job in the admin dashboard (see crawl_run_status.go). Best-effort +
	// detached; skipped for DRY runs (which never submit / persist). Rounds sharing
	// CRAWL_RUN_ID accumulate into one row for the whole launchd run.
	if !cfg.dryRun {
		runStatus := deriveCrawlRunStatus(res.events, res.blockedSweeps, res.processed, res.anyRewarm, res.fatalErr)
		detail := fmt.Sprintf("%d/%d suburbs done, %d listings, %d events, %d blocked sweep(s)",
			res.succeeded, res.processed, res.listings, res.events, res.blockedSweeps)
		if res.fatalDetail != "" {
			detail += "; " + res.fatalDetail
		}
		if res.cancelled {
			detail += "; cancelled (" + res.cancelReason + ")"
		}
		persistRunRecord(ctx, pool, crawlRunStatusRecord{
			RunType:         runType,
			Host:            host,
			RunID:           runID,
			StartedAt:       runStart,
			Status:          runStatus,
			SuburbsSelected: res.processed,
			SuburbsDone:     res.succeeded,
			ListingsTouched: res.listings,
			EventsWritten:   res.events,
			BlockedCount:    res.blockedSweeps,
			RewarmNeeded:    res.anyRewarm,
			Detail:          detail,
		}, code)
	}

	// NOTE: the drain-until-empty wrapper (deploy/housing-crawl-common.sh) parses
	// the "processed N job(s)" count out of this exact line to decide whether to
	// loop again — keep the "done: processed <N> job" shape stable.
	log.Printf("[agent] done: processed %d job(s)", res.processed)
	switch code {
	case 3:
		log.Printf("[agent] REWARM REQUIRED: a sweep tripped the circuit breaker — re-warm the crawl Chrome profile")
	case 7:
		log.Printf("[agent] FATAL: agent infrastructure or finalizer failed")
	case exitIngestAuthRefused, exitIngestUnavailable, exitIngestContract:
		log.Printf("[agent] INGEST: round ended with exit %d (see the [ingest] lines above)", code)
	case exitCrawlCancelled:
		log.Printf("[agent] CANCELLED (%s): stopped early; committed work is finalized (exit %d)", res.cancelReason, code)
	}
	return code
}

// roundResult is what one round's work loop produced. It feeds the finalize step,
// the health record, the round_done event and the exit code.
type roundResult struct {
	processed     int
	succeeded     int
	failed        int
	deferred      int
	listings      int
	events        int
	blockedSweeps int
	wroteAny      bool
	anyRewarm     bool
	fatalErr      bool
	fatalDetail   string
	cancelled     bool
	cancelReason  string
	// roundExit is the round-level ingest exit (13, 14, 15 or 7), or 0.
	roundExit int
}

// roundIO is the seam around the per-round work loop. runAgentRound wires it to
// the brandbrain client, crawlAgentJob and the circuit breaker. The tests wire
// fakes, so the loop's stop, event and submit rules run without a database, a
// browser or a queue.
type roundIO struct {
	maxJobs int
	dryRun  bool
	claim   func(ctx context.Context) (*agentCrawlJob, error)
	allOpen func() (bool, time.Duration)
	runJob  func(ctx context.Context, job *agentCrawlJob) (crawlJobSummary, string, string, bool, time.Duration)
	submit  func(ctx context.Context, jobID, status string, summary *crawlJobSummary, errMsg string, retryAfter time.Duration) error
	pause   func(ctx context.Context, stopped <-chan struct{})
	blocks  *blockTracker
	events  *crawlEvents
	stop    *stopSignal
	// ppid reports the parent PID. Nil means os.Getppid.
	ppid func() int
	// startPPID is the parent PID captured at process start (startParentPID).
	// Zero means "capture from ppid when run starts", which tests use.
	startPPID int
	// finalize runs once after the loop when the round wrote anything, cancelled or
	// not. Nil skips it. It is the MV refresh and sal-link step.
	finalize func(res *roundResult)
	// roundExit reports a round-level ingest exit (13, 14, 15 or 7), or 0. A non-zero
	// value ends the round after the job it arrived on has been submitted. Nil in tests.
	roundExit func() int
}

// run is the work loop. Events are emitted here and in submitJob, and nowhere else
// in the round: no timer, no ticker, no heartbeat.
func (r roundIO) run(ctx context.Context) roundResult {
	var res roundResult
	stop := r.stop
	if stop == nil {
		stop = newStopSignal()
	}
	ppid := r.ppid
	if ppid == nil {
		ppid = os.Getppid
	}
	startPPID := r.startPPID
	if startPPID == 0 {
		startPPID = ppid()
	}

	for i := 0; i < r.maxJobs; i++ {
		// Pause between suburbs BEFORE claiming, so the lease is not held through
		// the jitter, and a stop that lands during the pause is seen below before
		// another job is taken.
		if res.processed > 0 {
			r.pause(ctx, stop.Done())
		}
		if reason := stopReason(stop, ppid, startPPID, r.events); reason != "" {
			res.cancelled = true
			res.cancelReason = reason
			log.Printf("[agent] stop requested (%s) — not claiming another suburb", reason)
			break
		}
		// If EVERY source is circuit-open, the whole session is blocked: stop
		// claiming (leaving those suburbs pending for the next warm run) rather
		// than burn the queue on jobs that would crawl nothing.
		if allOpen, rem := r.allOpen(); allOpen {
			log.Printf("[agent] all sources circuit-open (session blocked) — stopping to protect the queue; longest backoff %s", rem.Round(time.Second))
			res.anyRewarm = true
			break
		}
		job, err := r.claim(ctx)
		if err != nil {
			log.Printf("[agent] claim error: %v", err)
			res.fatalErr = true
			res.fatalDetail = "claim failed: " + err.Error()
			break
		}
		if job == nil {
			// NOTE: the drain-until-empty wrapper (deploy/housing-crawl-common.sh)
			// greps this exact "[agent] no more jobs" line to stop looping — keep
			// the wording stable if this is ever reworded.
			log.Printf("[agent] no more jobs")
			break
		}
		r.events.claim(job.ID)
		summary, status, errMsg, wrote, retryAfter := r.runJob(ctx, job)
		res.wroteAny = res.wroteAny || wrote
		// Accumulate this suburb's counts into the round totals for the health record.
		res.listings += summary.Listings
		res.events += summary.Events
		res.blockedSweeps += summary.BlockedSweeps
		switch status {
		case "succeeded":
			res.succeeded++
		case "deferred":
			res.deferred++
		default:
			res.failed++
		}
		if summary.NeedsRewarm {
			res.anyRewarm = true
		}
		// A DRY run must NOT submit: submit is terminal in the queue, so a dry run
		// reporting "succeeded" would CONSUME the pending job without persisting
		// anything (it wouldn't re-serve to a real run until it went stale). Skip
		// the submit — the claim's lease simply expires and the job re-pends.
		if !r.dryRun {
			r.submitJob(ctx, job.ID, status, &summary, errMsg, retryAfter)
		}
		dry := ""
		if r.dryRun {
			dry = " DRY(not submitted)"
		}
		log.Printf("[agent] job %s %s/%s → %s: listings=%d events=%d blocked=%d skipped=%d%s", job.ID, job.Suburb, job.Tier, status, summary.Listings, summary.Events, summary.BlockedSweeps, summary.SkippedRows, dry)
		res.processed++

		if r.roundExit != nil {
			if code := r.roundExit(); code != 0 {
				res.roundExit = code
				log.Printf("[agent] ingest ended the round with exit %d — not claiming another job", code)
				break
			}
		}
		// A job that wrote no events off a blocked/poisoned sweep means the browser
		// session has gone cold — Kasada/Akamai serving stubs or poison, or an IP
		// throttle after several heavy sweeps. The submit above marked it failed.
		// Two such jobs in a row ⇒ the session is degraded, so STOP claiming and
		// flag a re-warm (exit 3) instead of burning the rest of the still-PENDING
		// queue on a session that will keep returning blocked. blockTracker tells a
		// cold session apart from one pathological suburb re-served by the queue by
		// suburb, so one bad target does not halt a healthy pass.
		degraded, sameSuburb := r.blocks.record(job.Suburb, status == "failed" && summary.Events == 0 && summary.BlockedSweeps > 0)
		if sameSuburb {
			log.Printf("[agent] %s blocked again — same suburb re-served, treating as a bad target rather than a cold session; continuing", job.Suburb)
		}
		if degraded {
			log.Printf("[agent] %d consecutive blocked sweeps across DIFFERENT suburbs — session degraded; stopping to re-warm before the queue is burned", r.blocks.consec)
			res.anyRewarm = true
			break
		}
	}
	// A stop can land during the last job, or during a job that then trips a
	// blocked-sweep break. The top-of-loop check cannot see either, so latch it here.
	if reason := stop.Reason(); reason != "" && !res.cancelled {
		res.cancelled = true
		res.cancelReason = reason
	}
	if res.wroteAny && r.finalize != nil {
		r.finalize(&res)
	}
	return res
}

// submitJob reports one job's outcome. A brandbrain that predates the deferred
// outcome rejects it, and the job is then sent as "failed" for this deploy window
// only (the attempt refund is lost, but the job is not orphaned in_progress).
func (r roundIO) submitJob(ctx context.Context, jobID, status string, summary *crawlJobSummary, errMsg string, retryAfter time.Duration) {
	sent := status
	if err := r.submit(ctx, jobID, status, summary, errMsg, retryAfter); err != nil {
		log.Printf("[agent] submit error (job=%s): %v", jobID, err)
		if status == "deferred" {
			log.Printf("[agent] queue rejected the deferred outcome — falling back to 'failed' (deploy brandbrain first to keep the attempt refund)")
			if err := r.submit(ctx, jobID, "failed", summary, errMsg, 0); err != nil {
				log.Printf("[agent] fallback submit error (job=%s): %v", jobID, err)
			} else {
				sent = "failed"
			}
		}
	}
	r.events.submit(jobID, sent, summary.Listings, summary.Events, summary.BlockedSweeps)
}

// stopReason returns why the loop must stop claiming, or "". A latched stop (a
// signal, or an earlier reason) stands. A process whose parent has exited (its
// PPID became 1 after starting with another parent) is orphaned, and a closed
// events stream means the parent is gone. Both latch a stop here. A process that
// started under init (PPID 1 at start, e.g. launchd) is not orphaned by that.
func stopReason(stop *stopSignal, ppid func() int, startPPID int, events *crawlEvents) string {
	if reason := stop.Reason(); reason != "" {
		return reason
	}
	if startPPID != 1 && ppid() == 1 {
		stop.request("orphaned")
	}
	if events.broken() {
		stop.request("event-pipe")
	}
	return stop.Reason()
}

// finalExitCode maps a finished round to its exit code. A cancelled round exits 10
// ahead of 3 and 0: under the wrapper, 0 starts another round and 3 retries after
// the cooldown, and a SIGTERM must mean neither. A fatal error (7) still wins,
// because it is a real fault and the wrapper must see it.
func finalExitCode(res roundResult) int {
	// A requested cancel beats every other code: round-level ingest exits (13, 14, 15,
	// 7) and the re-warm signal (3) included. A SIGTERM must mean no retry.
	if res.cancelled {
		return exitCrawlCancelled
	}
	if res.roundExit != 0 {
		return res.roundExit
	}
	return agentExitCode(res.anyRewarm, res.fatalErr, res.processed)
}

// agentExitCode keeps the existing re-warm signal highest priority. Any fatal
// queue or finalizer error is non-zero even when earlier jobs committed writes.
func agentExitCode(anyRewarm, fatalErr bool, _ int) int {
	if anyRewarm {
		return 3
	}
	if fatalErr {
		return 7
	}
	return 0
}

// crawlAgentJob runs one claimed suburb job (listings tier) and returns the
// counts-only summary, the outcome status, an optional error, whether it wrote
// anything (to gate the end-of-run MV refresh), and — for a "deferred" outcome
// only — how long the queue should hold the job before re-serving it. rs is the
// (optional — may be nil) resume snapshot loaded once for the whole -mode agent
// run; a source within the resume window is skipped for this job (logged, never
// silently) rather than swept again.
func crawlAgentJob(ctx context.Context, pool *pgxpool.Pool, fetcher htmlFetcher, cfg listingsConfig, job *agentCrawlJob, rs resumeSet, cb *crawlCircuitBreaker, tel *telemetryWriter, ev *crawlEvents) (crawlJobSummary, string, string, bool, time.Duration) {
	// Medians-in-agent-mode is a follow-up; the standalone `-mode crawl` path
	// still serves the median tier. Fail such a job clearly rather than silently.
	if strings.EqualFold(job.Tier, "medians") {
		return crawlJobSummary{Suburbs: 1, Detail: "medians tier not yet supported in agent mode"}, "failed", "medians tier not supported in agent mode (the queue does not collect medians; -mode crawl was removed)", false, 0
	}

	t, _ := resolveCrawlTarget(job)
	runTs := time.Now().UTC()

	if !cfg.dryRun && ingestRoundFrom(ctx).writesLocally() {
		if err := upsertRegions(ctx, pool, listingRegionObs([]CrawlTarget{t})); err != nil {
			return crawlJobSummary{Suburbs: 1, Detail: "region upsert failed"}, "failed", "region upsert: " + err.Error(), false, 0
		}
	}

	lc := &listingsCrawler{fetcher: fetcher, cfg: cfg, tel: tel, events: ev, jobID: job.ID, pageStop: pageStopFrom(ctx)}
	if ir := ingestRoundFrom(ctx); ir != nil {
		lc.sink = ir.sinkFor(pool, job)
	}
	var reaEvents, domEvents int
	var reaErr, domErr error
	var skippedRea, skippedDomain bool
	// cooldown is set ONLY when a source was skipped because its circuit breaker
	// was open — i.e. the portal is blocking and this job was never attempted.
	// That is the difference between "nothing to do" and "couldn't try", and it
	// decides whether the job is banked or handed back (see below).
	var cooldownRea, cooldownDomain time.Duration
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
		cooldownRea = rem
		log.Printf("[agent] %s rea: SKIPPED — circuit open (portal blocking), backing off %s", t.Display, rem.Round(time.Second))
	} else {
		ev.page(job.ID, "rea")
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
		cooldownDomain = rem
		log.Printf("[agent] %s domain: SKIPPED — circuit open (portal blocking), backing off %s", t.Display, rem.Round(time.Second))
	} else {
		ev.page(job.ID, "domain")
		domEvents, domErr = lc.crawlSuburbSource(ctx, pool, t, "domain", t.domainSearchURL, &lc.domBlocks, runTs)
		if opened, cd := cb.record("domain", lc.domBlocks > 0, runTs); opened {
			log.Printf("[agent] domain circuit OPEN after %d consecutive blocked sweep(s) — backing off %s before probing again", cb.circuit("domain").consec, cd.Round(time.Second))
			if !cfg.dryRun {
				resetDomainSessionOnTrip(fetcher, cfg.cdpURL)
			}
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
		// Nothing ran. WHY decides whether the work is done or still owed.
		//
		// If any skip was a circuit-open skip, the portal is blocking and this
		// suburb was never attempted. Reporting "succeeded" (as this did) banks a
		// no-data success: the job leaves the queue, never retries, and the
		// suburb's last-crawled never advances — so it silently stops being
		// crawled while the queue reports it done. Observed live: Unley SA last
		// produced data on 2026-08-04 and was "succeeded" into staleness for four
		// days, driving the freshness alarm, while 112 Domain jobs a day took the
		// same path. "failed" is no better — it spends one of max_attempts on a
		// sweep that never ran, so a portal blocking for a day can exhaust a job
		// outright. Defer: back on the queue, attempt refunded, held for the
		// breaker's remaining cooldown so the claim query doesn't hand it
		// straight back.
		if cool := maxDuration(cooldownRea, cooldownDomain); cool > 0 {
			summary.Detail = "not attempted: portal circuit open"
			return summary, "deferred", "circuit open (portal blocking), not attempted", false, cool
		}
		// The honest no-op: both sources were swept recently enough (or aren't
		// owned by this job), so there is genuinely nothing to do.
		summary.Detail = "both sources skipped (swept within the resume window)"
		return summary, "succeeded", "", false, 0
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
	// An ingest push answer decides the job by the per-job table (crawl_sink.go): the
	// server's counts stand in for the local diff's, and a push failure is never a
	// local diff error.
	if pf := firstPushFailure(reaErr, domErr); pf != nil {
		d := jobDisposition(pf, ingestRoundFrom(ctx).jobMayApply(attemptKey(job)))
		summary.noRetry = d.noRetry
		summary.Detail = d.errMsg
		if d.detail != "" {
			summary.Detail = d.detail
		}
		return summary, d.status, d.errMsg, false, d.retryAfter
	}
	status, detail, errMsg := agentJobTerminal(summary.Events, s.blockedSweeps, s.skippedRows, firstErr(reaErr, domErr))
	if status == "failed" {
		summary.Detail = detail
		// The job re-crawls, but a SIBLING source may already have committed real
		// events (e.g. REA persisted; only Domain's diff errored). Gate the
		// end-of-run sal_code link + MV refresh on whether anything was actually
		// committed (summary.Events), not a blanket false — otherwise freshly
		// written data is left unlinked/unrefreshed until an unrelated later run.
		// A blocked-sweep failure has Events==0, so it still returns false.
		return summary, "failed", errMsg, !cfg.dryRun && summary.Events > 0, 0
	}
	return summary, "succeeded", "", !cfg.dryRun && s.seen > 0, 0
}

// maxDuration returns the larger of two durations.
func maxDuration(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
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

// blockTracker decides when a run of blocked sweeps means the BROWSER SESSION
// has gone cold (Kasada/Akamai serving stubs, or an IP throttle) — the case
// where continuing would burn the rest of the pending queue on a session that
// will keep returning blocked — versus a single bad TARGET, which should just
// fail and be stepped over.
//
// The distinction is the suburb. A failed job re-pends immediately and claim
// hands the same one straight back, so a naive counter sees one pathological
// suburb as two blocks and halts a healthy run. Only blocks from DISTINCT
// suburbs escalate.
type blockTracker struct {
	consec int    // consecutive blocked sweeps across distinct suburbs
	last   string // suburb of the most recent blocked job
	trip   int    // distinct blocked suburbs that mean "session degraded"
}

func newBlockTracker(trip int) *blockTracker {
	if trip < 1 {
		trip = 1
	}
	return &blockTracker{trip: trip}
}

// record folds one completed job into the tracker. blocked reports whether the
// job ended blocked having written no events. It returns whether the session
// should be considered degraded (stop claiming and re-warm), and whether this
// was the same suburb blocking again (a re-served bad target, worth logging
// but never an escalation).
func (b *blockTracker) record(suburb string, blocked bool) (degraded, sameSuburb bool) {
	if !blocked {
		b.consec = 0
		b.last = ""
		return false, false
	}
	if suburb != "" && suburb == b.last {
		return false, true
	}
	b.last = suburb
	b.consec++
	return b.consec >= b.trip, false
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
	acfg := loadAgentConfig(false)
	if acfg.brandbrainURL == "" || (acfg.token == "" && acfg.controlURL == "") {
		log.Printf("[purge] BRANDBRAIN_AGENT_URL + a token (BRANDBRAIN_AGENT_TOKEN, or a local agent control API) required — nothing to do")
		return
	}
	var statuses []string
	for p := range strings.SplitSeq(envStr("PURGE_STATUSES", "pending,in_progress"), ",") {
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

// crawlStatusJob is the minimal per-row shape the MCP status tool surfaces.
type crawlStatusJob struct {
	Suburb string `json:"suburb"`
	State  string `json:"state"`
	Source string `json:"source"`
	Status string `json:"status"`
}

// crawlSummaryResult is the decoded GET /crawl-jobs response: a newest-first
// row sample + the whole-queue kind→status→count summary.
type crawlSummaryResult struct {
	Jobs    []crawlStatusJob          `json:"jobs"`
	Summary map[string]map[string]int `json:"summary"`
}

// crawlSummary fetches the queue status (whole-queue counts + a recent sample)
// from the brandbrain agent API. Used by the -mode mcp crawl_status tool.
func (c *brandbrainAgentClient) crawlSummary(ctx context.Context, limit int) (crawlSummaryResult, error) {
	if limit <= 0 {
		limit = 500
	}
	var out crawlSummaryResult
	err := c.do(ctx, http.MethodGet, fmt.Sprintf("/api/v1/agent/crawl-jobs?limit=%d", limit), nil, &out)
	return out, err
}
