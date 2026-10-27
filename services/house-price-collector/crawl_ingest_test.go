package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	connectrpc "connectrpc.com/connect"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
	"github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1/housingingestv1connect"
)

// stubCallLog orders the calls the fake ingest and the fake BrandBrain receive, so a test
// can assert that a push reached the ingest before the job was submitted.
type stubCallLog struct {
	mu      sync.Mutex
	entries []string
}

func (c *stubCallLog) add(s string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = append(c.entries, s)
}

func (c *stubCallLog) snapshot() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.entries...)
}

// indexOf returns the position of the first entry equal to s, or -1.
func (c *stubCallLog) indexOf(s string) int {
	for i, e := range c.snapshot() {
		if e == s {
			return i
		}
	}
	return -1
}

// stubIngest implements CrawlIngestServiceHandler. It records every request, answers
// PushSweep with one event per listing unless a scripted error is queued, and can
// refuse by bearer or sleep before answering.
type stubIngest struct {
	log *stubCallLog

	mu          sync.Mutex
	minContract int32
	probeErr    error
	pushErrs    []error // consumed in order by PushSweep; a nil entry is a success
	authErr     func(bearer string) error
	delay       time.Duration

	pushes  []*pb.PushSweepRequest
	bearers []string
	reports []*pb.ReportCycleRequest
}

func stubBearer(h http.Header) string {
	return strings.TrimPrefix(h.Get("Authorization"), "Bearer ")
}

func (f *stubIngest) ProbeAuth(_ context.Context, req *connectrpc.Request[pb.ProbeAuthRequest]) (*connectrpc.Response[pb.ProbeAuthResponse], error) {
	bearer := stubBearer(req.Header())
	f.log.add("probe")
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.authErr != nil {
		if err := f.authErr(bearer); err != nil {
			return nil, err
		}
	}
	if f.probeErr != nil {
		return nil, f.probeErr
	}
	return connectrpc.NewResponse(&pb.ProbeAuthResponse{Subject: "rig:test", MinContractVersion: f.minContract}), nil
}

func (f *stubIngest) PushSweep(ctx context.Context, req *connectrpc.Request[pb.PushSweepRequest]) (*connectrpc.Response[pb.PushSweepResponse], error) {
	bearer := stubBearer(req.Header())
	f.mu.Lock()
	f.bearers = append(f.bearers, bearer)
	f.pushes = append(f.pushes, req.Msg)
	var authErr, scripted error
	if f.authErr != nil {
		authErr = f.authErr(bearer)
	}
	if authErr == nil && len(f.pushErrs) > 0 {
		scripted = f.pushErrs[0]
		f.pushErrs = f.pushErrs[1:]
	}
	delay := f.delay
	f.mu.Unlock()
	f.log.add("push:" + req.Msg.GetIdempotencyKey())
	if delay > 0 {
		if err := sleepCtx(ctx, delay); err != nil {
			return nil, err
		}
	}
	if authErr != nil {
		return nil, authErr
	}
	if scripted != nil {
		return nil, scripted
	}
	n := int32(len(req.Msg.GetListings()))
	return connectrpc.NewResponse(&pb.PushSweepResponse{
		AppliedStatus:    req.Msg.GetStatus(),
		Events:           n,
		ListingsUpserted: n,
	}), nil
}

func (f *stubIngest) ReportCycle(_ context.Context, req *connectrpc.Request[pb.ReportCycleRequest]) (*connectrpc.Response[pb.ReportCycleResponse], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reports = append(f.reports, req.Msg)
	return connectrpc.NewResponse(&pb.ReportCycleResponse{Recorded: true}), nil
}

// pushCount returns how many PushSweep calls the fake has received.
func (f *stubIngest) pushCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.pushes)
}

func serveStubIngest(t *testing.T, f *stubIngest) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	path, h := housingingestv1connect.NewCrawlIngestServiceHandler(f)
	mux.Handle(path, h)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// stubBrandbrain serves the claim, renew and submit endpoints. It hands out one job
// and then an empty queue, counts renewals, and records each submit body.
type stubBrandbrain struct {
	log *stubCallLog
	job map[string]any

	mu        sync.Mutex
	claimed   bool
	renews    int
	submitted []map[string]any
}

func (b *stubBrandbrain) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/api/v1/agent/crawl-jobs/claim":
		b.mu.Lock()
		job := any(nil)
		if !b.claimed && b.job != nil {
			b.claimed = true
			job = b.job
		}
		b.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"job": job})
	case "/api/v1/agent/crawl-jobs/renew":
		b.mu.Lock()
		b.renews++
		b.mu.Unlock()
		b.log.add("renew")
		_, _ = io.WriteString(w, `{"renewed":true}`)
	case "/api/v1/agent/crawl-jobs/submit":
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		b.mu.Lock()
		b.submitted = append(b.submitted, body)
		b.mu.Unlock()
		b.log.add(fmt.Sprintf("submit:%v", body["job_id"]))
		_, _ = io.WriteString(w, `{}`)
	default:
		http.NotFound(w, r)
	}
}

func (b *stubBrandbrain) renewCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.renews
}

// stubControl is the co-located agent's loopback control API. It mints workload tokens
// on /control/v1/workload-token and requires the control secret.
type stubControl struct {
	secret string
	ttl    time.Duration
	status int // non-zero forces this HTTP status

	mu    sync.Mutex
	calls int
}

func (c *stubControl) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != workloadTokenPath || r.URL.Query().Get("audience") != ingestAudience {
		http.NotFound(w, r)
		return
	}
	if r.Header.Get("X-Agent-Control-Secret") != c.secret {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	c.mu.Lock()
	c.calls++
	n := c.calls
	c.mu.Unlock()
	if c.status != 0 {
		w.WriteHeader(c.status)
		return
	}
	tok := fmt.Sprintf("eyJhbGciOi.c3R1Yg.sig%d", n)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"token":      tok,
		"expires_at": time.Now().Add(c.ttl).UTC().Format(time.RFC3339),
		"audience":   ingestAudience,
	})
}

func (c *stubControl) mintCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls
}

// stubJob is the claimed job the end-to-end tests run. Attempts 2 makes the
// idempotency key "job-1:2:domain".
func stubJob() map[string]any {
	return map[string]any{
		"id": "job-1", "kind": "housing", "suburb": "Bondi", "state": "NSW", "postcode": "2026",
		"source": "domain", "tier": "listings", "attempts": 2, "max_attempts": 5,
	}
}

// stubListingsConfig is the smallest listings config that runs one domain page.
func stubListingsConfig() listingsConfig {
	return listingsConfig{
		crawlConfig:  crawlConfig{maxConsecBlocks: 3},
		maxPages:     1,
		maxPagesHard: 1,
		sources:      map[string]bool{"rea": true, "domain": true},
		circuitTrip:  3,
		circuitBase:  time.Second,
		circuitMax:   time.Minute,
	}
}

// stubTokens returns a token source that mints one long-lived token.
func stubTokens(tok string) *workloadTokenSource {
	return &workloadTokenSource{
		fetch: func(context.Context) (string, time.Time, error) { return tok, time.Now().Add(time.Hour), nil },
		now:   time.Now,
	}
}

// newStubIngestRound builds a round against the given fakes with no real sleeps.
func newStubIngestRound(mode crawlSinkMode, ingestURL, bbURL string, tokens *workloadTokenSource, events *crawlEvents) *ingestRound {
	ir := &ingestRound{
		mode:       mode,
		client:     newIngestClient(ingestURL, tokens),
		brand:      newBrandbrainAgentClient(agentConfig{brandbrainURL: bbURL, token: "bb-token", agentID: "rig-test"}),
		events:     events,
		renewEvery: time.Hour,
		shadowOn:   mode == crawlSinkShadow,
	}
	ir.client.renew = ir.renewLease
	ir.client.sleep = func(context.Context, time.Duration) error { return nil }
	ir.client.backoff = func(int) time.Duration { return 0 }
	return ir
}

// runStubRound drives one round the way runAgentRound does: the round's roundIO over
// the real jobRunner, with the BrandBrain client as both claim and submit.
func runStubRound(ctx context.Context, ir *ingestRound, fetcher htmlFetcher, cfg listingsConfig) roundResult {
	cb := newCircuitBreaker(cfg.circuitTrip, cfg.circuitBase, cfg.circuitMax)
	rio := roundIO{
		maxJobs:   1,
		claim:     ir.brand.claim,
		allOpen:   func() (bool, time.Duration) { return false, 0 },
		runJob:    ir.jobRunner(nil, fetcher, cfg, resumeSet{}, cb, nil, nil),
		submit:    ir.brand.submit,
		pause:     func(context.Context, <-chan struct{}) {},
		blocks:    newBlockTracker(3),
		stop:      newStopSignal(),
		roundExit: ir.code,
	}
	return rio.run(withIngestRound(ctx, ir))
}

// stubDomainFetcher serves one domain search page of five listings for Bondi.
func stubDomainFetcher() htmlFetcher {
	return &pagedFetcher{pages: map[string]string{
		bondi.domainSearchURL(1): domainPageHTML([]string{"a", "b", "c", "d", "e"}, "2026"),
	}}
}

// TestIngestRound_PushesBeforeSubmit_AndSubmitIsCountsOnly is the end-to-end check of
// an ingest round: the push carries the idempotency key and the job's target, it
// reaches the ingest before the job is submitted, and the submit body holds counts and
// nothing else. It runs with a nil pool, so the ingest path must never open or use one.
func TestIngestRound_PushesBeforeSubmit_AndSubmitIsCountsOnly(t *testing.T) {
	cl := &stubCallLog{}
	fi := &stubIngest{log: cl}
	ingest := serveStubIngest(t, fi)
	bb := &stubBrandbrain{log: cl, job: stubJob()}
	bbSrv := httptest.NewServer(bb)
	t.Cleanup(bbSrv.Close)

	ir := newStubIngestRound(crawlSinkIngest, ingest.URL, bbSrv.URL, stubTokens("tok-e2e"), nil)
	res := runStubRound(context.Background(), ir, stubDomainFetcher(), stubListingsConfig())

	if res.processed != 1 || res.succeeded != 1 {
		t.Fatalf("round = processed %d succeeded %d, want 1/1 (res=%+v)", res.processed, res.succeeded, res)
	}
	if fi.pushCount() != 1 {
		t.Fatalf("pushes = %d, want exactly one (the domain sweep)", fi.pushCount())
	}
	push := fi.pushes[0]
	if got, want := push.GetIdempotencyKey(), "job-1:2:domain"; got != want {
		t.Errorf("idempotency key = %q, want %q", got, want)
	}
	if got := push.GetTarget(); got.GetSuburb() != "Bondi" || got.GetState() != "NSW" || got.GetPostcode() != "2026" {
		t.Errorf("target = %+v, want the job's own suburb, state and postcode", got)
	}
	if push.GetSource() != pb.Source_SOURCE_DOMAIN || push.GetDryRun() {
		t.Errorf("source=%v dry_run=%v, want SOURCE_DOMAIN and dry_run=false", push.GetSource(), push.GetDryRun())
	}
	if len(push.GetListings()) != 5 {
		t.Errorf("listings on the push = %d, want the 5 the page carries", len(push.GetListings()))
	}
	if push.GetContractVersion() != 1 {
		t.Errorf("contract_version = %d, want 1", push.GetContractVersion())
	}
	if got := fi.bearers; len(got) != 1 || got[0] != "tok-e2e" {
		t.Errorf("bearers = %v, want the one minted workload token", got)
	}

	pushAt, submitAt := cl.indexOf("push:job-1:2:domain"), cl.indexOf("submit:job-1")
	if pushAt < 0 || submitAt < 0 || pushAt > submitAt {
		t.Fatalf("call order %v: the push must reach the ingest before the submit", cl.snapshot())
	}

	if len(bb.submitted) != 1 {
		t.Fatalf("submits = %d, want 1", len(bb.submitted))
	}
	summary, ok := bb.submitted[0]["result_summary"].(map[string]any)
	if !ok {
		t.Fatalf("submit has no result_summary: %v", bb.submitted[0])
	}
	allowed := map[string]bool{"suburbs": true, "listings": true, "events": true, "blocked_sweeps": true,
		"skipped_rows": true, "needs_rewarm": true, "detail": true}
	for k := range summary {
		if !allowed[k] {
			t.Errorf("submit result_summary carries %q, which is not a count", k)
		}
	}
	raw, _ := json.Marshal(bb.submitted[0])
	for _, leak := range []string{"listing_id", "display_addr", "listing_url", "agency", "price_display"} {
		if bytes.Contains(raw, []byte(leak)) {
			t.Errorf("submit body carries listing field %q", leak)
		}
	}
}

// TestIngestRound_LeaseIsRenewedWhileTheJobRuns covers the renewal the job runner
// starts: with a short interval and a slow push, the lease is renewed during the job.
func TestIngestRound_LeaseIsRenewedWhileTheJobRuns(t *testing.T) {
	cl := &stubCallLog{}
	fi := &stubIngest{log: cl, delay: 80 * time.Millisecond}
	ingest := serveStubIngest(t, fi)
	bb := &stubBrandbrain{log: cl, job: stubJob()}
	bbSrv := httptest.NewServer(bb)
	t.Cleanup(bbSrv.Close)

	ir := newStubIngestRound(crawlSinkIngest, ingest.URL, bbSrv.URL, stubTokens("tok-lease"), nil)
	ir.renewEvery = 5 * time.Millisecond
	res := runStubRound(context.Background(), ir, stubDomainFetcher(), stubListingsConfig())
	if res.succeeded != 1 {
		t.Fatalf("round did not succeed: %+v", res)
	}
	if n := bb.renewCount(); n < 1 {
		t.Fatalf("renewals during a slow job = %d, want at least 1", n)
	}
	before := bb.renewCount()
	time.Sleep(30 * time.Millisecond)
	if after := bb.renewCount(); after != before {
		t.Errorf("renewals kept coming after the job ended (%d then %d)", before, after)
	}
}

// TestPushSweep_RetriesThenSucceeds: Unavailable twice, then OK. The lease is renewed
// before each retry, and every attempt carries the same idempotency key.
func TestPushSweep_RetriesThenSucceeds(t *testing.T) {
	cl := &stubCallLog{}
	unavailable := connectrpc.NewError(connectrpc.CodeUnavailable, errors.New("try later"))
	fi := &stubIngest{log: cl, pushErrs: []error{unavailable, unavailable, nil}}
	ingest := serveStubIngest(t, fi)
	bb := &stubBrandbrain{log: cl}
	bbSrv := httptest.NewServer(bb)
	t.Cleanup(bbSrv.Close)

	ir := newStubIngestRound(crawlSinkIngest, ingest.URL, bbSrv.URL, stubTokens("tok-retry"), nil)
	req := &pb.PushSweepRequest{IdempotencyKey: "job-r:1:rea", JobId: "job-r", Attempt: 1, Source: pb.Source_SOURCE_REA}
	resp, _, err := ir.client.pushSweep(context.Background(), req)
	if err != nil {
		t.Fatalf("pushSweep after two Unavailable answers: %v", err)
	}
	if resp == nil {
		t.Fatal("pushSweep returned no response")
	}
	if fi.pushCount() != 3 {
		t.Errorf("attempts = %d, want 3", fi.pushCount())
	}
	for _, p := range fi.pushes {
		if p.GetIdempotencyKey() != "job-r:1:rea" {
			t.Errorf("retry changed the idempotency key to %q", p.GetIdempotencyKey())
		}
	}
	if n := bb.renewCount(); n != 2 {
		t.Errorf("lease renewals during the retries = %d, want 2 (one before each retry)", n)
	}
}

// TestPushSweep_RetriesOutlastedGivesExhausted: every attempt Unavailable -> exit 14.
func TestPushSweep_RetriesOutlastedGivesExhausted(t *testing.T) {
	cl := &stubCallLog{}
	unavailable := connectrpc.NewError(connectrpc.CodeUnavailable, errors.New("down"))
	fi := &stubIngest{log: cl, pushErrs: []error{unavailable, unavailable, unavailable}}
	ingest := serveStubIngest(t, fi)
	bb := &stubBrandbrain{log: cl}
	bbSrv := httptest.NewServer(bb)
	t.Cleanup(bbSrv.Close)

	ir := newStubIngestRound(crawlSinkIngest, ingest.URL, bbSrv.URL, stubTokens("tok-x"), nil)
	_, _, err := ir.client.pushSweep(context.Background(), &pb.PushSweepRequest{IdempotencyKey: "job-x:1:rea", JobId: "job-x", Attempt: 1})
	if err == nil {
		t.Fatal("expected an error after three Unavailable answers")
	}
	if got := ingestRoundExit(err); got != exitIngestUnavailable {
		t.Errorf("exit = %d, want %d", got, exitIngestUnavailable)
	}
	if fi.pushCount() != ingestMaxAttempts {
		t.Errorf("attempts = %d, want %d", fi.pushCount(), ingestMaxAttempts)
	}
}

// TestWorkloadToken_RefreshesUnderSixtySeconds: a token with less than 60s left is
// re-fetched, and one with more is served from the cache.
func TestWorkloadToken_RefreshesUnderSixtySeconds(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	fetches := 0
	life := 30 * time.Second
	src := &workloadTokenSource{
		now: func() time.Time { return now },
		fetch: func(context.Context) (string, time.Time, error) {
			fetches++
			return fmt.Sprintf("t%d", fetches), now.Add(life), nil
		},
	}
	if tok, _ := src.Token(context.Background(), false); tok != "t1" {
		t.Fatalf("first token = %q", tok)
	}
	// 30s left: under the 60s skew, so the next call re-fetches.
	if tok, _ := src.Token(context.Background(), false); tok != "t2" || fetches != 2 {
		t.Fatalf("token under 60s left = %q after %d fetches, want a re-fetch to t2", tok, fetches)
	}
	life = 5 * time.Minute
	if _, err := src.Token(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	// Plenty of life now: served from the cache, no fetch.
	if tok, _ := src.Token(context.Background(), false); tok != "t3" || fetches != 3 {
		t.Fatalf("token = %q after %d fetches", tok, fetches)
	}
	if tok, _ := src.Token(context.Background(), false); tok != "t3" || fetches != 3 {
		t.Fatalf("cached token was re-fetched: %q after %d fetches", tok, fetches)
	}
}

// TestIngestAuth_RefetchesOnceOn401AndNeverLogsTheToken: a refused token is re-fetched
// exactly once and the retry uses the new one. Nothing about the token reaches the log.
func TestIngestAuth_RefetchesOnceOn401AndNeverLogsTheToken(t *testing.T) {
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(prev) })

	cl := &stubCallLog{}
	fi := &stubIngest{log: cl, authErr: func(bearer string) error {
		if bearer == "eyJhbGciOi.c3R1Yg.sig1" {
			return connectrpc.NewError(connectrpc.CodeUnauthenticated, errors.New("unauthenticated"))
		}
		return nil
	}}
	ingest := serveStubIngest(t, fi)
	ctl := &stubControl{secret: "s3cret", ttl: 10 * time.Minute}
	ctlSrv := httptest.NewServer(ctl)
	t.Cleanup(ctlSrv.Close)
	bb := &stubBrandbrain{log: cl}
	bbSrv := httptest.NewServer(bb)
	t.Cleanup(bbSrv.Close)

	tokens := &workloadTokenSource{
		fetch: loopbackWorkloadToken(ctlSrv.Client(), ctlSrv.URL, "s3cret", time.Now),
		now:   time.Now,
	}
	ir := newStubIngestRound(crawlSinkIngest, ingest.URL, bbSrv.URL, tokens, nil)
	_, _, err := ir.client.pushSweep(context.Background(), &pb.PushSweepRequest{IdempotencyKey: "job-a:1:rea", JobId: "job-a", Attempt: 1})
	if err != nil {
		t.Fatalf("push after one refused token: %v", err)
	}
	if got := ctl.mintCount(); got != 2 {
		t.Errorf("token mints = %d, want 2 (the first, then exactly one re-fetch)", got)
	}
	if fi.bearers[0] != "eyJhbGciOi.c3R1Yg.sig1" || fi.bearers[len(fi.bearers)-1] != "eyJhbGciOi.c3R1Yg.sig2" {
		t.Errorf("bearers = %v, want the refused token then the re-fetched one", fi.bearers)
	}
	if strings.Contains(buf.String(), "c3R1Yg") {
		t.Errorf("the workload token reached the log:\n%s", buf.String())
	}
}

// TestIngestAuth_SecondRefusalIsExit13 proves a token refused twice ends the round:
// one re-fetch, no third attempt, Unauthenticated maps to exit 13.
func TestIngestAuth_SecondRefusalIsExit13(t *testing.T) {
	cl := &stubCallLog{}
	fi := &stubIngest{log: cl, authErr: func(string) error {
		return connectrpc.NewError(connectrpc.CodeUnauthenticated, errors.New("unauthenticated"))
	}}
	ingest := serveStubIngest(t, fi)
	calls := 0
	tokens := &workloadTokenSource{
		fetch: func(context.Context) (string, time.Time, error) {
			calls++
			return fmt.Sprintf("tok-%d", calls), time.Now().Add(time.Hour), nil
		},
		now: time.Now,
	}
	bbSrv := httptest.NewServer(&stubBrandbrain{log: cl})
	t.Cleanup(bbSrv.Close)
	ir := newStubIngestRound(crawlSinkIngest, ingest.URL, bbSrv.URL, tokens, nil)

	err := stubPushOnce(ir)
	if got := ingestRoundExit(err); got != exitIngestAuthRefused {
		t.Fatalf("exit for a twice-refused token = %d (err %v), want %d", got, err, exitIngestAuthRefused)
	}
	if calls != 2 {
		t.Errorf("token fetches = %d, want 2 (the first and one re-fetch)", calls)
	}
	if fi.pushCount() != 2 {
		t.Errorf("push attempts = %d, want 2 (one per token, no retry loop)", fi.pushCount())
	}
}

// stubPushOnce runs one push and returns its error.
func stubPushOnce(ir *ingestRound) error {
	_, _, err := ir.client.pushSweep(context.Background(), &pb.PushSweepRequest{IdempotencyKey: "job-z:1:rea", JobId: "job-z", Attempt: 1})
	return err
}

// stubEventsTo returns an events writer that appends to buf.
func stubEventsTo(buf *bytes.Buffer) *crawlEvents {
	return newCrawlEvents(buf)
}

// stubURLPort returns the port of an httptest server URL.
func stubURLPort(t *testing.T, raw string) string {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u.Port()
}

// stubAgentEnv points runAgent at the fakes and clears any database URL, so the ingest
// sink is what runs.
func stubAgentEnv(t *testing.T, ingestURL, bbURL string, ctl *httptest.Server, secret string) {
	t.Helper()
	t.Setenv("CRAWL_SINK", "ingest")
	t.Setenv("CRAWL_DRY_RUN", "false")
	t.Setenv("SHORTED_INGEST_URL", ingestURL)
	t.Setenv("DATABASE_URL", "")
	t.Setenv("BRANDBRAIN_AGENT_URL", bbURL)
	t.Setenv("BRANDBRAIN_AGENT_TOKEN", "bb-token")
	t.Setenv("BRANDBRAIN_CONTROL_PORT", stubURLPort(t, ctl.URL))
	t.Setenv("BRANDBRAIN_CONTROL_SECRET", secret)
}

// TestRunAgent_IngestRoundExitCodes runs runAgent with the ingest sink against fakes
// that fail the ProbeAuth in each way, and checks the round's exit code.
func TestRunAgent_IngestRoundExitCodes(t *testing.T) {
	cases := []struct {
		name     string
		probeErr error
		minCon   int32
		ctlSt    int
		want     int
	}{
		{"auth refused is 13", connectrpc.NewError(connectrpc.CodeUnauthenticated, errors.New("no")), 0, 0, exitIngestAuthRefused},
		{"unavailable is 14", connectrpc.NewError(connectrpc.CodeUnavailable, errors.New("down")), 0, 0, exitIngestUnavailable},
		{"contract mismatch is 15", nil, 2, 0, exitIngestContract},
		{"token mint failure is 7", nil, 0, http.StatusInternalServerError, exitAgentInfra},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cl := &stubCallLog{}
			fi := &stubIngest{log: cl, probeErr: tc.probeErr, minContract: tc.minCon}
			ingest := serveStubIngest(t, fi)
			bbSrv := httptest.NewServer(&stubBrandbrain{log: cl})
			t.Cleanup(bbSrv.Close)
			ctl := &stubControl{secret: "ctl-secret", ttl: time.Hour, status: tc.ctlSt}
			ctlSrv := httptest.NewServer(ctl)
			t.Cleanup(ctlSrv.Close)
			stubAgentEnv(t, ingest.URL, bbSrv.URL, ctlSrv, "ctl-secret")

			if got := runAgent(context.Background(), nil); got != tc.want {
				t.Fatalf("runAgent exit = %d, want %d", got, tc.want)
			}
		})
	}
}

// TestRunAgent_IngestRefusesDatabaseURL: CRAWL_SINK=ingest with DATABASE_URL set exits 8
// before anything is claimed or contacted.
func TestRunAgent_IngestRefusesDatabaseURL(t *testing.T) {
	cl := &stubCallLog{}
	fi := &stubIngest{log: cl}
	ingest := serveStubIngest(t, fi)
	bbSrv := httptest.NewServer(&stubBrandbrain{log: cl})
	t.Cleanup(bbSrv.Close)
	ctlSrv := httptest.NewServer(&stubControl{secret: "x", ttl: time.Hour})
	t.Cleanup(ctlSrv.Close)
	stubAgentEnv(t, ingest.URL, bbSrv.URL, ctlSrv, "x")
	t.Setenv("DATABASE_URL", "postgres://admin:pw@db.example/shorts")

	if got := runAgent(context.Background(), nil); got != exitSinkRefused {
		t.Fatalf("runAgent with DATABASE_URL and ingest = %d, want %d", got, exitSinkRefused)
	}
	if len(cl.snapshot()) != 0 {
		t.Errorf("a refused rig contacted a service: %v", cl.snapshot())
	}
}
