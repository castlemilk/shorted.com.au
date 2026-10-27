package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	connectrpc "connectrpc.com/connect"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
	"github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1/housingingestv1connect"
	"github.com/castlemilk/shorted.com.au/services/pkg/housingingest"
)

// ---------------------------------------------------------------------------
// Item 1: a deferral is only safe when nothing of the attempt was stored.
// ---------------------------------------------------------------------------

// TestDisposition_DeferOnlyWhenNothingMayHaveBeenStored pins the outcome of each answer
// against whether any push of the job may have been stored.
func TestDisposition_DeferOnlyWhenNothingMayHaveBeenStored(t *testing.T) {
	ce := func(code connectrpc.Code, msg string) error { return connectrpc.NewError(code, errors.New(msg)) }
	cases := []struct {
		name       string
		err        error
		mayApply   bool
		status     string
		noRetry    bool
		detailHint string
	}{
		{"round ended before any send defers", errRoundEnded, false, "deferred", false, ""},
		{"round ended after a stored push fails retryably", &pushFailure{err: errRoundEnded}, true, "failed", false, ""},
		{"token failure before any send defers", &tokenError{err: errors.New("no control api")}, false, "deferred", false, ""},
		{"unavailable with nothing stored defers", ce(connectrpc.CodeUnavailable, "down"), false, "deferred", false, ""},
		{"lost answer with a stored push retries as a new attempt", &exhaustedError{err: ce(connectrpc.CodeUnavailable, "down")}, true, "failed", false, ""},
		{"auth refused with nothing stored defers", ce(connectrpc.CodeUnauthenticated, "unauthenticated"), false, "deferred", false, ""},
		{"auth refused after a stored push retries", ce(connectrpc.CodeUnauthenticated, "unauthenticated"), true, "failed", false, ""},
		{"cancel before an answer defers", context.Canceled, false, "deferred", false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := jobDisposition(tc.err, tc.mayApply)
			if d.status != tc.status {
				t.Fatalf("status = %q (%q), want %q", d.status, d.errMsg, tc.status)
			}
			if d.noRetry != tc.noRetry {
				t.Errorf("noRetry = %v, want %v", d.noRetry, tc.noRetry)
			}
			if d.status == "deferred" && !strings.Contains(d.errMsg, "nothing stored") {
				t.Errorf("deferred message %q must say nothing was stored", d.errMsg)
			}
			if tc.detailHint != "" && !strings.Contains(d.errMsg, tc.detailHint) {
				t.Errorf("message %q, want it to mention %q", d.errMsg, tc.detailHint)
			}
		})
	}
}

// lossyIngest models the server's receipts. Its first lossLeft requests are stored and
// then answered Unavailable (the answer is lost). After that a known key replays when the
// body matches and answers AlreadyExists when it does not, as push.go does.
type lossyIngest struct {
	mu       sync.Mutex
	lossLeft int
	seen     map[string]string // key -> body fingerprint
	accepted []string          // keys the ingest applied for the first time
	pushKeys []string
}

func listingFingerprint(req *pb.PushSweepRequest) string {
	ids := make([]string, 0, len(req.GetListings()))
	for _, l := range req.GetListings() {
		ids = append(ids, l.GetListingId())
	}
	return strings.Join(ids, ",")
}

func (l *lossyIngest) ProbeAuth(context.Context, *connectrpc.Request[pb.ProbeAuthRequest]) (*connectrpc.Response[pb.ProbeAuthResponse], error) {
	return connectrpc.NewResponse(&pb.ProbeAuthResponse{Subject: "rig:test"}), nil
}

func (l *lossyIngest) PushSweep(_ context.Context, req *connectrpc.Request[pb.PushSweepRequest]) (*connectrpc.Response[pb.PushSweepResponse], error) {
	key, fp := req.Msg.GetIdempotencyKey(), listingFingerprint(req.Msg)
	n := int32(len(req.Msg.GetListings()))
	l.mu.Lock()
	defer l.mu.Unlock()
	l.pushKeys = append(l.pushKeys, key)
	if l.lossLeft > 0 {
		l.lossLeft--
		if _, ok := l.seen[key]; !ok {
			l.seen[key] = fp
			l.accepted = append(l.accepted, key)
		}
		return nil, connectrpc.NewError(connectrpc.CodeUnavailable, errors.New("down"))
	}
	if prev, ok := l.seen[key]; ok {
		if prev != fp {
			return nil, connectrpc.NewError(connectrpc.CodeAlreadyExists, errors.New("idempotency_key_reused"))
		}
		return connectrpc.NewResponse(&pb.PushSweepResponse{AppliedStatus: req.Msg.GetStatus(), Events: n, ListingsUpserted: n, Replayed: true}), nil
	}
	l.seen[key] = fp
	l.accepted = append(l.accepted, key)
	return connectrpc.NewResponse(&pb.PushSweepResponse{AppliedStatus: req.Msg.GetStatus(), Events: n, ListingsUpserted: n}), nil
}

func (l *lossyIngest) ReportCycle(context.Context, *connectrpc.Request[pb.ReportCycleRequest]) (*connectrpc.Response[pb.ReportCycleResponse], error) {
	return connectrpc.NewResponse(&pb.ReportCycleResponse{Recorded: true}), nil
}

// queueBB models BrandBrain's attempt rules: claim adds one attempt, a deferred submit
// takes one back, a failed submit re-pends while attempts < 3 unless no_retry, and a
// succeeded submit is terminal.
type queueBB struct {
	mu       sync.Mutex
	job      map[string]any
	pending  bool
	attempts int
	terminal bool
	submits  []map[string]any
}

func (q *queueBB) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	q.mu.Lock()
	defer q.mu.Unlock()
	switch r.URL.Path {
	case "/api/v1/agent/crawl-jobs/claim":
		if !q.pending {
			_ = json.NewEncoder(w).Encode(map[string]any{"job": nil})
			return
		}
		q.pending = false
		q.attempts++
		j := map[string]any{}
		for k, v := range q.job {
			j[k] = v
		}
		j["attempts"] = q.attempts
		j["max_attempts"] = 3
		_ = json.NewEncoder(w).Encode(map[string]any{"job": j})
	case "/api/v1/agent/crawl-jobs/renew":
		_, _ = w.Write([]byte(`{"renewed":true}`))
	case "/api/v1/agent/crawl-jobs/submit":
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		q.submits = append(q.submits, body)
		status, _ := body["status"].(string)
		noRetry, _ := body["no_retry"].(bool)
		switch status {
		case "succeeded":
			q.terminal = true
		case "failed":
			if noRetry || q.attempts >= 3 {
				q.terminal = true
			} else {
				q.pending = true
			}
		case "deferred":
			q.attempts--
			q.pending = true
		}
		_, _ = w.Write([]byte(`{}`))
	default:
		http.NotFound(w, r)
	}
}

func (q *queueBB) state() (pending, terminal bool, attempts int, submits []map[string]any) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.pending, q.terminal, q.attempts, append([]map[string]any(nil), q.submits...)
}

// Item 1, end to end: the lost answer must not reuse its key. Round 1 stores the sweep
// and loses every answer, so the job is submitted failed (retryable). Round 2 claims
// attempt 2, pushes under job-1:2:domain with a different body, and succeeds. Reusing
// job-1:1:domain would answer AlreadyExists.
func TestQueueLostAnswerRetriesWithANewAttemptAndKey(t *testing.T) {
	ing := &lossyIngest{lossLeft: 3, seen: map[string]string{}}
	ingestSrv := httptest.NewServer(mustMux(ing))
	t.Cleanup(ingestSrv.Close)
	q := &queueBB{job: stubJob(), pending: true}
	bbSrv := httptest.NewServer(q)
	t.Cleanup(bbSrv.Close)

	ir := newStubIngestRound(crawlSinkIngest, ingestSrv.URL, bbSrv.URL, stubTokens("tok-1"), nil)
	runStubRound(context.Background(), ir, stubDomainFetcher(), stubListingsConfig())

	pending, terminal, attempts, submits := q.state()
	if terminal || !pending || attempts != 1 {
		t.Fatalf("after the lost round: pending=%v terminal=%v attempts=%d, want re-pended at attempt 1", pending, terminal, attempts)
	}
	if len(submits) != 1 || submits[0]["status"] != "failed" || submits[0]["no_retry"] != nil {
		t.Fatalf("first submit = %v, want a retryable failed", submits)
	}

	ir2 := newStubIngestRound(crawlSinkIngest, ingestSrv.URL, bbSrv.URL, stubTokens("tok-2"), nil)
	runStubRound(context.Background(), ir2, pagedFetcherFor(bondi.domainSearchURL(1), domainPageHTML([]string{"f", "g", "h", "i", "j"}, "2026")), stubListingsConfig())

	_, terminal, attempts, submits = q.state()
	if !terminal || attempts != 2 {
		t.Fatalf("after the retry: terminal=%v attempts=%d, want terminal at attempt 2", terminal, attempts)
	}
	if got := submits[len(submits)-1]["status"]; got != "succeeded" {
		t.Fatalf("second submit status = %v, want succeeded (a reused key would answer AlreadyExists)", got)
	}
	ing.mu.Lock()
	defer ing.mu.Unlock()
	if !contains(ing.accepted, "job-1:2:domain") {
		t.Fatalf("the retry was not applied under its new key; accepted=%v pushes=%v", ing.accepted, ing.pushKeys)
	}
}

// Item 1: a deferred job whose push never left the rig keeps its attempt, so its next
// claim reuses the same key with nothing stored under it, and that push succeeds.
func TestQueueDeferredBeforeSendReusesAnUnstoredKey(t *testing.T) {
	ing := &lossyIngest{seen: map[string]string{}}
	ingestSrv := httptest.NewServer(mustMux(ing))
	t.Cleanup(ingestSrv.Close)
	q := &queueBB{job: stubJob(), pending: true}
	bbSrv := httptest.NewServer(q)
	t.Cleanup(bbSrv.Close)

	ir := newStubIngestRound(crawlSinkIngest, ingestSrv.URL, bbSrv.URL, stubTokens("unused"), nil)
	ir.client.tokens = &workloadTokenSource{
		fetch: func(context.Context) (string, time.Time, error) { return "", time.Time{}, errors.New("no control api") },
		now:   time.Now,
	}
	runStubRound(context.Background(), ir, stubDomainFetcher(), stubListingsConfig())
	if pending, _, attempts, submits := q.state(); !pending || attempts != 0 || submits[0]["status"] != "deferred" {
		t.Fatalf("token failure before any send: pending=%v attempts=%d submits=%v, want deferred with the attempt refunded", pending, attempts, submits)
	}

	ir2 := newStubIngestRound(crawlSinkIngest, ingestSrv.URL, bbSrv.URL, stubTokens("tok"), nil)
	runStubRound(context.Background(), ir2, stubDomainFetcher(), stubListingsConfig())
	_, terminal, attempts, submits := q.state()
	if !terminal || attempts != 1 || submits[len(submits)-1]["status"] != "succeeded" {
		t.Fatalf("after the deferral: terminal=%v attempts=%d last=%v, want the same attempt applied", terminal, attempts, submits[len(submits)-1])
	}
	ing.mu.Lock()
	defer ing.mu.Unlock()
	if !contains(ing.accepted, "job-1:1:domain") {
		t.Fatalf("accepted = %v, want job-1:1:domain applied once", ing.accepted)
	}
}

func mustMux(h housingingestv1connect.CrawlIngestServiceHandler) http.Handler {
	mux := http.NewServeMux()
	path, handler := housingingestv1connect.NewCrawlIngestServiceHandler(h)
	mux.Handle(path, handler)
	return mux
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// pagedFetcherFor serves one page for one URL.
func pagedFetcherFor(url, html string) htmlFetcher {
	return &pagedFetcher{pages: map[string]string{url: html}}
}

// Item 1: notStoredErr is the only basis for deferral. A rate limit, an auth refusal and
// an unknown dispatch are answers that store nothing. A lost answer and a dispatch that
// already applied are not.
func TestNotStoredErr(t *testing.T) {
	ce := func(code connectrpc.Code, msg string) error { return connectrpc.NewError(code, errors.New(msg)) }
	cases := map[string]struct {
		err  error
		want bool
	}{
		"rate limited":       {ce(connectrpc.CodeResourceExhausted, "rate_limited"), true},
		"oversize":           {ce(connectrpc.CodeResourceExhausted, "message too large"), false},
		"unauthenticated":    {ce(connectrpc.CodeUnauthenticated, "unauthenticated"), true},
		"not dispatched":     {ce(connectrpc.CodeFailedPrecondition, "not_dispatched"), true},
		"dispatch applied":   {ce(connectrpc.CodeFailedPrecondition, "dispatch_applied"), false},
		"invalid sweep":      {ce(connectrpc.CodeInvalidArgument, "sweep_invalid"), true},
		"unavailable (lost)": {ce(connectrpc.CodeUnavailable, "down"), false},
		"transport":          {errors.New("connection reset"), false},
	}
	for name, tc := range cases {
		if got := notStoredErr(tc.err); got != tc.want {
			t.Errorf("%s: notStoredErr = %v, want %v", name, got, tc.want)
		}
	}
}

// ---------------------------------------------------------------------------
// Item 2: no_retry on permanent answers, applied-earlier is a success.
// ---------------------------------------------------------------------------

func TestDisposition_PermanentAnswersAreNoRetry(t *testing.T) {
	ce := func(code connectrpc.Code, msg string) error { return connectrpc.NewError(code, errors.New(msg)) }
	permanent := map[string]error{
		"quarantined":        &pushFailure{err: errQuarantined},
		"not_dispatched":     ce(connectrpc.CodeFailedPrecondition, "not_dispatched"),
		"dispatch_expired":   ce(connectrpc.CodeFailedPrecondition, "dispatch_expired"),
		"target_mismatch":    ce(connectrpc.CodeFailedPrecondition, "target_mismatch"),
		"invalid argument":   ce(connectrpc.CodeInvalidArgument, "sweep_invalid"),
		"already exists":     ce(connectrpc.CodeAlreadyExists, "idempotency_key_reused"),
		"oversize (no rate)": ce(connectrpc.CodeResourceExhausted, "message larger than limit"),
	}
	for name, err := range permanent {
		for _, mayApply := range []bool{false, true} {
			d := jobDisposition(err, mayApply)
			if d.status != "failed" || !d.noRetry {
				t.Errorf("%s (mayApply=%v): %+v, want failed with no_retry", name, mayApply, d)
			}
		}
	}
	if d := jobDisposition(ce(connectrpc.CodeFailedPrecondition, "dispatch_applied"), true); d.status != "succeeded" || d.detail != "applied by an earlier attempt" || d.noRetry {
		t.Errorf("dispatch_applied = %+v, want succeeded with the counts-only detail", d)
	}
}

// Item 2: the submit body carries no_retry only when the job's summary asks for it.
func TestSubmitSendsNoRetryOnlyWhenAsked(t *testing.T) {
	var bodies []map[string]any
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		mu.Lock()
		bodies = append(bodies, b)
		mu.Unlock()
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(srv.Close)
	c := newBrandbrainAgentClient(agentConfig{brandbrainURL: srv.URL, token: "t", agentID: "rig"})
	ctx := context.Background()
	if err := c.submit(ctx, "job-a", "failed", &crawlJobSummary{noRetry: true}, "x", 0); err != nil {
		t.Fatal(err)
	}
	if err := c.submit(ctx, "job-b", "failed", &crawlJobSummary{}, "x", 0); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if bodies[0]["no_retry"] != true {
		t.Errorf("permanent submit body = %v, want no_retry true", bodies[0])
	}
	if _, present := bodies[1]["no_retry"]; present {
		t.Errorf("retryable submit body carries no_retry: %v", bodies[1])
	}
	raw, _ := json.Marshal(bodies[0])
	if bytes.Contains(raw, []byte("noRetry")) {
		t.Errorf("the in-process noRetry field leaked into the body: %s", raw)
	}
}

// ---------------------------------------------------------------------------
// Item 3: CRAWL_SINK is read only by -mode agent. Subprocess tests run the real main.
// ---------------------------------------------------------------------------

// childEnv is the environment a subprocess collector runs with: the caller's, minus every
// variable that could change the sink, the ingest, or the database, plus an empty HOME.
func childEnv(t *testing.T, extra ...string) []string {
	t.Helper()
	var env []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(k, "CRAWL_") || strings.HasPrefix(k, "SHORTED_") ||
			strings.HasPrefix(k, "BRANDBRAIN_") || k == "DATABASE_URL" || k == "HOME" || k == "REVALIDATION_URL" {
			continue
		}
		env = append(env, kv)
	}
	env = append(env, "HOME="+t.TempDir(), "HPC_CHILD_RUN=1")
	return append(env, extra...)
}

// runCollector runs the collector as a subprocess with -mode mode and returns its exit
// code. A process that outlives 20 seconds is killed and reported as -1, which is not 8.
func runCollector(t *testing.T, mode string, extra ...string) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^$")
	cmd.Env = childEnv(t, append([]string{"HPC_CHILD_ARGS=-mode " + mode}, extra...)...)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	if ctx.Err() != nil {
		t.Logf("%s killed after 20s", mode)
		return -1
	}
	if err == nil {
		return 0
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	t.Fatalf("run %s: %v", mode, err)
	return 0
}

// Item 3: with CRAWL_SINK=shadow (or ingest) in the shared env file, no other mode exits 8.
func TestCrawlSinkIsIgnoredOutsideAgent(t *testing.T) {
	modes := []string{"version", "revalidate", "freshness", "property-resolve", "warmcheck", "install-driver", "listings", "enqueue", "purge"}
	for _, sink := range []string{"shadow", "ingest"} {
		for _, mode := range modes {
			if mode == "install-driver" && sink == "ingest" {
				continue // installs a driver (~14s); the shadow row already covers the refusal path
			}
			t.Run(sink+"/"+mode, func(t *testing.T) {
				code := runCollector(t, mode, "CRAWL_SINK="+sink, "SHORTED_INGEST_URL=https://api.shorted.com.au", "CRAWL_DRY_RUN=true")
				if code == exitCrawlEnvBroken {
					t.Fatalf("-mode %s with CRAWL_SINK=%s exited 8", mode, sink)
				}
			})
		}
	}
}

// Item 3 and C5: -mode agent with the db sink and no database is an environment fault
// (8), while -mode crawl is gone (1).
func TestAgentWithoutDatabaseExits8AndCrawlIsRemoved(t *testing.T) {
	if got := runCollector(t, "agent"); got != exitCrawlEnvBroken {
		t.Errorf("-mode agent with no DATABASE_URL exited %d, want %d", got, exitCrawlEnvBroken)
	}
	if got := runCollector(t, "crawl"); got != 1 {
		t.Errorf("-mode crawl exited %d, want 1 (removed)", got)
	}
}

// ---------------------------------------------------------------------------
// Item 4: the shadow dry run is one short attempt, and a circuit turns shadow off.
// ---------------------------------------------------------------------------

func TestShadowCircuitBoundsTheStallAndTrips(t *testing.T) {
	prev := shadowDryRunTimeout
	shadowDryRunTimeout = 50 * time.Millisecond
	t.Cleanup(func() { shadowDryRunTimeout = prev })

	cl := &stubCallLog{}
	fi := &stubIngest{log: cl, delay: 400 * time.Millisecond}
	ingest := serveStubIngest(t, fi)
	var events bytes.Buffer
	ir := newStubIngestRound(crawlSinkShadow, ingest.URL, "", stubTokens("tok-shadow"), stubEventsTo(&events))
	sink := shadowSink{ir: ir, job: &agentCrawlJob{ID: "job-circ", Suburb: "Bondi", State: "NSW", Postcode: "2026", Attempts: 1},
		legacy: &stubLegacy{log: cl, events: 5}}

	var durations []time.Duration
	for i := 0; i < 5; i++ {
		start := time.Now()
		n, err := sink.write(context.Background(), &listingsCrawler{}, bondi, "domain", stubShadowSweep(), time.Now())
		durations = append(durations, time.Since(start))
		if err != nil || n != 5 {
			t.Fatalf("sweep %d: legacy result (%d, %v), want (5, nil) whatever shadow does", i+1, n, err)
		}
	}
	for i := 0; i < shadowFailLimit; i++ {
		if durations[i] > shadowDryRunTimeout+250*time.Millisecond {
			t.Errorf("sweep %d took %v; a failing dry run may delay the legacy write by one short timeout only", i+1, durations[i])
		}
	}
	if fi.pushCount() != shadowFailLimit {
		t.Errorf("dry-run pushes = %d, want %d: the circuit must stop them", fi.pushCount(), shadowFailLimit)
	}
	for i := shadowFailLimit; i < 5; i++ {
		if durations[i] > 100*time.Millisecond {
			t.Errorf("sweep %d took %v after the circuit tripped; it must not wait on ingest", i+1, durations[i])
		}
	}
	if ir.shadowIsOn() {
		t.Error("shadow is still on after the circuit tripped")
	}
	if n := strings.Count(events.String(), `"type":"shadow_circuit"`) + strings.Count(events.String(), `"event":"shadow_circuit"`); n != 1 {
		t.Errorf("shadow_circuit events = %d, want exactly one: %s", n, events.String())
	}
}

// A success between failures resets the count, so intermittent failures do not trip.
func TestShadowCircuitResetsOnSuccess(t *testing.T) {
	ir := newStubIngestRound(crawlSinkShadow, "", "", stubTokens("t"), nil)
	fail := connectrpc.NewError(connectrpc.CodeUnavailable, errors.New("down"))
	for _, err := range []error{fail, fail, nil, fail, fail} {
		ir.noteShadowResult(err)
	}
	if !ir.shadowIsOn() {
		t.Fatal("two, success, two consecutive failures must not trip a three-failure circuit")
	}
}

// ---------------------------------------------------------------------------
// Item 5: ResourceExhausted is a rate limit only when the server says so.
// ---------------------------------------------------------------------------

func TestResourceExhaustedIsADeferOnlyForTheRateLimit(t *testing.T) {
	rate := connectrpc.NewError(connectrpc.CodeResourceExhausted, errors.New("rate_limited"))
	big := connectrpc.NewError(connectrpc.CodeResourceExhausted, errors.New("message is larger than the limit"))
	if d := jobDisposition(rate, false); d.status != "deferred" || d.noRetry {
		t.Errorf("rate_limited = %+v, want deferred (the sweep was never stored)", d)
	}
	if d := jobDisposition(big, false); d.status != "failed" || !d.noRetry {
		t.Errorf("an oversize sweep = %+v, want failed with no_retry (it loops forever otherwise)", d)
	}
}

// ---------------------------------------------------------------------------
// Item 6: the caps and the sanitiser on the rig, through the sweep builder.
// ---------------------------------------------------------------------------

func collectorListing(id string) *pb.Listing {
	return &pb.Listing{Source: "domain", ListingId: id, Suburb: "Bondi", State: "NSW", Postcode: "2026", Status: "for_sale", PriceKind: "fixed"}
}

func TestBuildPushRequest_OverflowAndPagesDowngradeToPartial(t *testing.T) {
	job := &agentCrawlJob{ID: "job-cap", Suburb: "Bondi", State: "NSW", Postcode: "2026", Attempts: 1}
	var rows []housingcrawlRaw
	for i := 0; i < housingingest.MaxListingsPerSweep+1; i++ {
		rows = append(rows, housingcrawlRaw{Source: "domain", ListingID: fmt.Sprintf("L%05d", i), Suburb: "Bondi", State: "NSW", Postcode: "2026"})
	}
	req, skipped := buildPushRequest(job, "domain", suburbSweep{listings: rows, status: sweepComplete, pages: housingingest.MaxPagesPerSweep + 5}, time.Now(), "rev", false)
	if len(req.GetListings()) != housingingest.MaxListingsPerSweep || skipped != 1 {
		t.Fatalf("listings = %d skipped = %d, want the cap and one skipped", len(req.GetListings()), skipped)
	}
	if req.GetStatus() != pb.SweepStatus_SWEEP_STATUS_PARTIAL {
		t.Errorf("status = %v, want PARTIAL: an over-cap COMPLETE sweep must not delist", req.GetStatus())
	}
	if req.GetPages() != housingingest.MaxPagesPerSweep {
		t.Errorf("pages = %d, want the cap %d", req.GetPages(), housingingest.MaxPagesPerSweep)
	}
}

// A dropped listing is an absent listing, and absence delists, so any drop in a COMPLETE
// sweep downgrades it. Over-cap display fields are sanitised, not dropped, so they keep it.
func TestBuildPushRequest_DropsDowngradeCompleteAndSanitisedFieldsDoNot(t *testing.T) {
	job := &agentCrawlJob{ID: "job-drop", Suburb: "Bondi", State: "NSW", Postcode: "2026", Attempts: 1}
	bad := collectorListing("")
	req, skipped := buildPushRequest(job, "domain", suburbSweep{listings: housingcrawlRows(bad), status: sweepComplete, pages: 1}, time.Now(), "rev", false)
	if skipped != 1 || req.GetStatus() != pb.SweepStatus_SWEEP_STATUS_PARTIAL {
		t.Fatalf("a dropped listing in a COMPLETE sweep: skipped=%d status=%v, want 1 and PARTIAL", skipped, req.GetStatus())
	}

	over := collectorListing("ok-1")
	over.DisplayAddr = strings.Repeat("é", 200) // 400 bytes, over the 300-byte cap
	over.PriceDisplay = strings.Repeat("x", 250)
	req, skipped = buildPushRequest(job, "domain", suburbSweep{listings: housingcrawlRows(over), status: sweepComplete, pages: 1}, time.Now(), "rev", false)
	if skipped != 0 || req.GetStatus() != pb.SweepStatus_SWEEP_STATUS_COMPLETE || len(req.GetListings()) != 1 {
		t.Fatalf("over-cap display fields: skipped=%d status=%v listings=%d, want kept COMPLETE", skipped, req.GetStatus(), len(req.GetListings()))
	}
	if got := req.GetListings()[0].GetDisplayAddr(); len(got) > housingingest.MaxAddressBytes {
		t.Errorf("display_addr is %d bytes after sanitising", len(got))
	}
}

// housingcrawlRaw is the store type a sweep carries; the alias keeps the table short.
type housingcrawlRaw = RawListing

func housingcrawlRows(l *pb.Listing) []RawListing {
	return []RawListing{{Source: l.GetSource(), ListingID: l.GetListingId(), Suburb: l.GetSuburb(), State: l.GetState(), Postcode: l.GetPostcode(),
		DisplayAddr: l.GetDisplayAddr(), PriceDisplay: l.GetPriceDisplay(), ListingURL: l.GetListingUrl()}}
}

// ---------------------------------------------------------------------------
// Item 7: the BrandBrain bearer is read and written under a lock, through a 401.
// ---------------------------------------------------------------------------

func TestBrandbrainTokenSafeUnderConcurrentRenewalThrough401(t *testing.T) {
	const fresh = "bb-fresh-token"
	bb := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+fresh {
			http.Error(w, "expired", http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"renewed":true}`))
	}))
	t.Cleanup(bb.Close)
	ctl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/control/v1/auth/session/export" || r.Header.Get("X-Agent-Control-Secret") != "s" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"access_token": fresh})
	}))
	t.Cleanup(ctl.Close)

	c := newBrandbrainAgentClient(agentConfig{brandbrainURL: bb.URL, token: "bb-expired", agentID: "rig",
		controlURL: ctl.URL, controlSecret: "s"})
	var wg sync.WaitGroup
	var failures atomic.Int32
	for g := 0; g < 2; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 20; i++ {
				if err := c.renew(context.Background(), "job-race"); err != nil {
					failures.Add(1)
				}
			}
		}()
	}
	wg.Wait()
	if n := failures.Load(); n != 0 {
		t.Fatalf("%d renewals failed through the 401 refresh", n)
	}
}

// ---------------------------------------------------------------------------
// Item 8: a requested cancel beats every other code.
// ---------------------------------------------------------------------------

func TestCancelBeatsEveryRoundCode(t *testing.T) {
	for _, round := range []roundResult{
		{cancelled: true, roundExit: exitIngestAuthRefused},
		{cancelled: true, roundExit: exitIngestUnavailable},
		{cancelled: true, roundExit: exitIngestContract},
		{cancelled: true, roundExit: exitAgentInfra},
		{cancelled: true, anyRewarm: true},
		{cancelled: true, fatalErr: true},
	} {
		if got := finalExitCode(round); got != exitCrawlCancelled {
			t.Errorf("cancelled round %+v exited %d, want %d", round, got, exitCrawlCancelled)
		}
	}
}

// ---------------------------------------------------------------------------
// Item 9: ProbeAuth runs after the lock and the signal handlers.
// ---------------------------------------------------------------------------

// A held lock exits 12 before the ingest is contacted at all.
func TestProbeRunsOnlyAfterTheLock(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	lockDir := filepath.Join(t.TempDir(), "held.lockdir")
	writePid(t, lockDir, os.Getpid())
	t.Setenv(crawlLockDirEnv, lockDir)

	cl := &stubCallLog{}
	ingest := serveStubIngest(t, &stubIngest{log: cl})
	bb := httptest.NewServer(&stubBrandbrain{log: cl})
	t.Cleanup(bb.Close)
	ctl := httptest.NewServer(&stubControl{secret: "ctl", ttl: time.Hour})
	t.Cleanup(ctl.Close)
	stubAgentEnv(t, ingest.URL, bb.URL, ctl, "ctl")

	if got := runAgent(context.Background(), nil); got != exitLockHeld {
		t.Fatalf("runAgent with a held lock = %d, want %d", got, exitLockHeld)
	}
	if i := cl.indexOf("probe"); i != -1 {
		t.Fatalf("the ingest was probed (%v) while the lock was held", cl.snapshot())
	}
}

// A SIGTERM that lands during the probe exits 10 promptly, not after the probe finishes.
func TestSigtermDuringProbeExits10(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv(crawlLockDirEnv, filepath.Join(t.TempDir(), "lockdir"))

	probes := &atomic.Int32{}
	ingest := httptest.NewServer(mustMux(&probeSignalsIngest{probes: probes}))
	t.Cleanup(ingest.Close)
	cl := &stubCallLog{}
	bb := httptest.NewServer(&stubBrandbrain{log: cl})
	t.Cleanup(bb.Close)
	ctl := httptest.NewServer(&stubControl{secret: "ctl", ttl: time.Hour})
	t.Cleanup(ctl.Close)
	stubAgentEnv(t, ingest.URL, bb.URL, ctl, "ctl")

	start := time.Now()
	got := runAgent(context.Background(), nil)
	if got != exitCrawlCancelled {
		t.Fatalf("runAgent with SIGTERM during the probe = %d, want %d", got, exitCrawlCancelled)
	}
	if elapsed := time.Since(start); elapsed > 4*time.Second {
		t.Errorf("the round waited %v for the probe; a stop must cancel it", elapsed)
	}
	if n := probes.Load(); n != 1 {
		t.Errorf("probes = %d, want 1", n)
	}
}

// probeSignalsIngest sends this process a SIGTERM from inside its first ProbeAuth, then
// holds the call until the client gives up.
type probeSignalsIngest struct{ probes *atomic.Int32 }

func (p *probeSignalsIngest) ProbeAuth(ctx context.Context, _ *connectrpc.Request[pb.ProbeAuthRequest]) (*connectrpc.Response[pb.ProbeAuthResponse], error) {
	if p.probes.Add(1) == 1 {
		_ = syscall.Kill(syscall.Getpid(), syscall.SIGTERM)
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(5 * time.Second):
		return connectrpc.NewResponse(&pb.ProbeAuthResponse{}), nil
	}
}

func (p *probeSignalsIngest) PushSweep(context.Context, *connectrpc.Request[pb.PushSweepRequest]) (*connectrpc.Response[pb.PushSweepResponse], error) {
	return nil, connectrpc.NewError(connectrpc.CodeUnimplemented, errors.New("unused"))
}

func (p *probeSignalsIngest) ReportCycle(context.Context, *connectrpc.Request[pb.ReportCycleRequest]) (*connectrpc.Response[pb.ReportCycleResponse], error) {
	return nil, connectrpc.NewError(connectrpc.CodeUnimplemented, errors.New("unused"))
}

// ---------------------------------------------------------------------------
// Item 10: a blocked sweep emits suburb_done once, and listings are not streamed by a sink.
// ---------------------------------------------------------------------------

func TestBlockedSweepEmitsSuburbDoneOnceUnderASink(t *testing.T) {
	tel, path := telemetryToFile(t)
	lc := testLC()
	lc.fetcher = &errOnlyFetcher{err: errors.New("network down")}
	lc.tel = tel
	rec := &recordingSink{}
	lc.sink = rec
	blocks := 0
	if _, err := lc.crawlSuburbSource(context.Background(), nil, bondi, "domain", bondi.domainSearchURL, &blocks, time.Now()); err != nil {
		t.Fatal(err)
	}
	tel.Close()
	if n := countTelemetry(t, path, "suburb_done"); n != 1 {
		t.Fatalf("suburb_done events = %d under a sink, want 1", n)
	}
	if rec.calls != 1 {
		t.Errorf("the sink saw %d sweeps, want the blocked sweep handed to it", rec.calls)
	}
}

// Item M2b: under a sink the telemetry stream carries no listing events.
func TestSinkTelemetryCarriesNoListingEvents(t *testing.T) {
	tel, path := telemetryToFile(t)
	lc := testLC()
	lc.fetcher = &pagedFetcher{pages: map[string]string{bondi.domainSearchURL(1): domainPageHTML([]string{"a", "b", "c", "d", "e"}, "2026")}}
	lc.tel = tel
	lc.sink = &recordingSink{}
	blocks := 0
	if _, err := lc.crawlSuburbSource(context.Background(), nil, bondi, "domain", bondi.domainSearchURL, &blocks, time.Now()); err != nil {
		t.Fatal(err)
	}
	tel.Close()
	if n := countTelemetry(t, path, "listing"); n != 0 {
		t.Fatalf("listing telemetry events = %d under a sink, want 0", n)
	}
	if n := countTelemetry(t, path, "suburb_done"); n != 1 {
		t.Errorf("suburb_done = %d, want the counts still streamed", n)
	}
}

// Item M2a: under a sink, a dry run prints no listing rows, and the sink still hears of it.
func TestSinkDryRunPrintsNoListingRows(t *testing.T) {
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(prev) })

	lc := testLC()
	lc.cfg.dryRun = true
	lc.fetcher = &pagedFetcher{pages: map[string]string{bondi.domainSearchURL(1): domainPageHTML([]string{"a", "b", "c", "d", "e"}, "2026")}}
	rec := &recordingSink{}
	lc.sink = rec
	blocks := 0
	if _, err := lc.crawlSuburbSource(context.Background(), nil, bondi, "domain", bondi.domainSearchURL, &blocks, time.Now()); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(buf.String(), "[listings] DRY") {
		t.Fatalf("a sink dry run printed listing rows:\n%s", buf.String())
	}
	if rec.calls != 1 {
		t.Errorf("the sink saw %d dry-run sweeps, want 1: the sink takes the dry run", rec.calls)
	}
}

// recordingSink counts the sweeps it is handed and writes nothing.
type recordingSink struct{ calls int }

func (r *recordingSink) write(context.Context, *listingsCrawler, CrawlTarget, string, suburbSweep, time.Time) (int, error) {
	r.calls++
	return 0, nil
}

// telemetryToFile returns an enabled telemetry writer over a temp file.
func telemetryToFile(t *testing.T) (*telemetryWriter, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "telemetry.ndjson")
	return newTelemetryWriter(telemetryConfig{enabled: true, path: path, runID: "review"}), path
}

// countTelemetry counts the telemetry lines of one type.
func countTelemetry(t *testing.T, path, typ string) int {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if line == "" {
			continue
		}
		var ev map[string]any
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("bad telemetry line: %v", err)
		}
		if ev["type"] == typ {
			n++
		}
	}
	return n
}

// ---------------------------------------------------------------------------
// H1, M1, M2c, L1, C1, C2: the trust boundary and the token contract.
// ---------------------------------------------------------------------------

func TestIngestURLIsPinned(t *testing.T) {
	prev := testAllowLoopbackIngest
	testAllowLoopbackIngest = false
	t.Cleanup(func() { testAllowLoopbackIngest = prev })

	accept := []string{
		"https://housing-ingest-uiekqxovma-km.a.run.app",
		"https://api.shorted.com.au",
		"https://api.shorted.com.au:443/path",
	}
	reject := []string{
		"http://housing-ingest-uiekqxovma-km.a.run.app",
		"https://evil.example",
		"https://user:pw@api.shorted.com.au",
		"https://shorted.com.au.evil.com",
		"https://evilshorted.com.au",
		"https://shorted.com.au",
		"https://api.shorted.com.au:8443",
		"https://127.0.0.1",
		"https://[::1]",
		"http://127.0.0.1:8080",
		"https://housing-ingest-uiekqxovma-km.a.run.app.evil.com",
		"",
	}
	for _, raw := range accept {
		if err := validateIngestURL(raw); err != nil {
			t.Errorf("%s refused: %v", raw, err)
		}
	}
	for _, raw := range reject {
		if err := validateIngestURL(raw); err == nil {
			t.Errorf("%s accepted; the ingest URL must be pinned", raw)
		}
	}
}

// The loopback hook is test-only, and the environment cannot open it.
func TestIngestLoopbackOnlyThroughTheTestHook(t *testing.T) {
	prev := testAllowLoopbackIngest
	testAllowLoopbackIngest = false
	t.Cleanup(func() { testAllowLoopbackIngest = prev })
	t.Setenv("CRAWL_SINK", "ingest")
	t.Setenv("CRAWL_DRY_RUN", "false")
	t.Setenv("SHORTED_INGEST_URL", "http://127.0.0.1:9999")
	if _, refusal := resolveCrawlSink("agent", os.Getenv); refusal == "" {
		t.Fatal("an env-supplied loopback http URL was accepted")
	}
	testAllowLoopbackIngest = true
	if _, refusal := resolveCrawlSink("agent", os.Getenv); refusal != "" {
		t.Fatalf("the test hook did not open loopback: %s", refusal)
	}
}

func TestIngestSinkNeedsAnExplicitDryRun(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	base := map[string]string{"CRAWL_SINK": "ingest", "SHORTED_INGEST_URL": "https://api.shorted.com.au"}
	if _, refusal := resolveCrawlSink("agent", env(base)); refusal == "" {
		t.Error("ingest with CRAWL_DRY_RUN unset was accepted")
	}
	for _, v := range []string{"true", "false"} {
		m := map[string]string{"CRAWL_DRY_RUN": v}
		for k, val := range base {
			m[k] = val
		}
		if sink, refusal := resolveCrawlSink("agent", env(m)); refusal != "" || sink != crawlSinkIngest {
			t.Errorf("CRAWL_DRY_RUN=%s: sink=%q refusal=%q", v, sink, refusal)
		}
	}
}

// M2c: gateway routes and a non-loopback CDP endpoint are refused under ingest and shadow.
func TestSinkRefusesGatewayAndRemoteCDP(t *testing.T) {
	base := func(extra map[string]string) func(string) string {
		m := map[string]string{"CRAWL_SINK": "ingest", "SHORTED_INGEST_URL": "https://api.shorted.com.au", "CRAWL_DRY_RUN": "false"}
		for k, v := range extra {
			m[k] = v
		}
		return func(k string) string { return m[k] }
	}
	refuse := map[string]map[string]string{
		"gateway URL":         {"CRAWL_GATEWAY_URL": "http://192.168.1.5:7799"},
		"gateway fetch mode":  {"CRAWL_FETCH_MODE": "gateway"},
		"remote CDP":          {"CRAWL_CDP_URL": "http://host.docker.internal:9222"},
		"remote CDP over TLS": {"CRAWL_CDP_URL": "https://browser.example:9222"},
	}
	for name, extra := range refuse {
		if _, refusal := resolveCrawlSink("agent", base(extra)); refusal == "" {
			t.Errorf("%s was accepted under ingest", name)
		}
	}
	if sink, refusal := resolveCrawlSink("agent", base(map[string]string{"CRAWL_CDP_URL": "http://127.0.0.1:9222"})); refusal != "" || sink != crawlSinkIngest {
		t.Errorf("a loopback CDP endpoint was refused: %s", refusal)
	}
}

// L1: the control port is digits in 1..65535, and the URL is always loopback.
func TestControlPortIsAPortAndTheURLIsLoopback(t *testing.T) {
	for in, want := range map[string]string{"8080": "8080", "1": "1", "65535": "65535", "65536": "", "0": "", "1@evil.example": "", "80a": "", "": "", "123456": ""} {
		if got := validControlPort(in); got != want {
			t.Errorf("validControlPort(%q) = %q, want %q", in, got, want)
		}
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("BRANDBRAIN_CONTROL_SECRET", "s")
	t.Setenv("BRANDBRAIN_CONTROL_PORT", "1@evil.example")
	if url, _ := loadAgentControlAuth(); url != "" {
		t.Fatalf("a host smuggled in the port produced control URL %q", url)
	}
	t.Setenv("BRANDBRAIN_CONTROL_PORT", "8123")
	if url, _ := loadAgentControlAuth(); url != "http://127.0.0.1:8123" {
		t.Fatalf("control URL = %q, want the loopback port", url)
	}
}

// C1: the loopback answers the issuer's shape, and that shape is checked.
func TestLoopbackTokenContract(t *testing.T) {
	const good = "eyJhbGciOi.cGF5bG9hZA.c2ln"
	exp := time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339)
	cases := map[string]struct {
		body string
		ok   bool
	}{
		"issuer shape":      {fmt.Sprintf(`{"token":%q,"expires_at":%q,"audience":%q}`, good, exp, ingestAudience), true},
		"audience mismatch": {fmt.Sprintf(`{"token":%q,"expires_at":%q,"audience":"https://other"}`, good, exp), false},
		"no expiry":         {fmt.Sprintf(`{"token":%q,"audience":%q}`, good, ingestAudience), false},
		"old access_token":  {fmt.Sprintf(`{"access_token":%q,"expires_in":300}`, good), false},
		"malformed token":   {fmt.Sprintf(`{"token":"not a token!","expires_at":%q,"audience":%q}`, exp, ingestAudience), false},
		"two-segment token": {fmt.Sprintf(`{"token":"a.b","expires_at":%q,"audience":%q}`, exp, ingestAudience), false},
	}
	for name, tc := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(tc.body)) }))
		fetch := loopbackWorkloadToken(noRedirectHTTPClient(time.Second), srv.URL, "s", time.Now)
		tok, _, err := fetch(context.Background())
		srv.Close()
		if tc.ok != (err == nil) {
			t.Errorf("%s: err = %v, want ok=%v", name, err, tc.ok)
		}
		if err != nil && strings.Contains(err.Error(), "not a token") {
			t.Errorf("%s: the error echoes the token: %v", name, err)
		}
		if tc.ok && tok != good {
			t.Errorf("%s: token = %q", name, tok)
		}
	}
}

// C2: a malformed token is agent infrastructure (7), not an ingest outage (14).
func TestMalformedTokenExits7(t *testing.T) {
	cl := &stubCallLog{}
	ing := httptest.NewServer(mustMux(&lossyIngest{seen: map[string]string{}}))
	t.Cleanup(ing.Close)
	bb := httptest.NewServer(&stubBrandbrain{log: cl})
	t.Cleanup(bb.Close)
	exp := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	ctl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprintf(w, `{"token":"bad token","expires_at":%q,"audience":%q}`, exp, ingestAudience)
	}))
	t.Cleanup(ctl.Close)
	ir := newStubIngestRound(crawlSinkIngest, ing.URL, bb.URL, nil, nil)
	ir.client.tokens = &workloadTokenSource{fetch: loopbackWorkloadToken(noRedirectHTTPClient(time.Second), ctl.URL, "s", time.Now), now: time.Now}
	_, _, err := ir.client.pushSweep(context.Background(), &pb.PushSweepRequest{IdempotencyKey: "job-m:1:rea", JobId: "job-m", Attempt: 1})
	if got := ingestRoundExit(err); got != exitAgentInfra {
		t.Fatalf("a malformed token exited %d (err %v), want %d", got, err, exitAgentInfra)
	}
}

// M1: no HTTP client follows a redirect, so a 307 to another host or another port
// never receives the body or the bearer.
func TestNoClientFollowsARedirect(t *testing.T) {
	var targetHits atomic.Int32
	var leakedAuth atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetHits.Add(1)
		if r.Header.Get("Authorization") != "" || r.Header.Get("X-Agent-Control-Secret") != "" {
			leakedAuth.Add(1)
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(target.Close)
	targetPort := strings.Split(strings.TrimPrefix(target.URL, "http://127.0.0.1:"), "/")[0]
	redirect := func(location string) *httptest.Server {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Location", location+r.URL.Path)
			w.WriteHeader(http.StatusTemporaryRedirect)
		}))
		t.Cleanup(s.Close)
		return s
	}
	for name, location := range map[string]string{
		"other host":            "http://localhost:" + targetPort,
		"same host, other port": target.URL,
	} {
		srv := redirect(location)
		t.Run("ingest/"+name, func(t *testing.T) {
			ir := newStubIngestRound(crawlSinkIngest, srv.URL, "", stubTokens("eyJhbGciOi.c3R1Yg.sig"), nil)
			ir.client.sleep = func(context.Context, time.Duration) error { return nil }
			_, _, _ = ir.client.pushSweep(context.Background(), &pb.PushSweepRequest{IdempotencyKey: "job-r:1:rea", JobId: "job-r", Attempt: 1})
		})
		t.Run("brandbrain/"+name, func(t *testing.T) {
			c := newBrandbrainAgentClient(agentConfig{brandbrainURL: srv.URL, token: "bb-secret", agentID: "rig"})
			_ = c.renew(context.Background(), "job-r")
		})
	}
	if n := targetHits.Load(); n != 0 {
		t.Fatalf("a redirect reached the target %d time(s)", n)
	}
	if n := leakedAuth.Load(); n != 0 {
		t.Fatalf("a redirect carried a bearer or secret to the target %d time(s)", n)
	}
}

// ---------------------------------------------------------------------------
// C3, C4, C6: probe answers, schema drift, and the ingest events.
// ---------------------------------------------------------------------------

func TestProbeWrongEndpointExits8NotUnavailable(t *testing.T) {
	for _, code := range []connectrpc.Code{connectrpc.CodeUnimplemented, connectrpc.CodeNotFound} {
		cl := &stubCallLog{}
		ing := serveStubIngest(t, &stubIngest{log: cl, probeErr: connectrpc.NewError(code, errors.New("no such method"))})
		bb := httptest.NewServer(&stubBrandbrain{log: cl})
		t.Cleanup(bb.Close)
		ctl := httptest.NewServer(&stubControl{secret: "ctl", ttl: time.Hour})
		t.Cleanup(ctl.Close)
		t.Setenv("HOME", t.TempDir())
		t.Setenv(crawlLockDirEnv, filepath.Join(t.TempDir(), "lockdir"))
		stubAgentEnv(t, ing.URL, bb.URL, ctl, "ctl")
		if got := runAgent(context.Background(), nil); got != exitCrawlEnvBroken {
			t.Errorf("ProbeAuth %v exited %d, want %d", code, got, exitCrawlEnvBroken)
		}
	}
}

// C4: a single InvalidArgument is a per-job failure; three in a row end the round with 15.
func TestThreeInvalidArgumentsEndTheRoundWith15(t *testing.T) {
	ir := newStubIngestRound(crawlSinkIngest, "", "", stubTokens("tok"), nil)
	invalid := connectrpc.NewError(connectrpc.CodeInvalidArgument, errors.New("sweep_invalid"))
	ir.noteIngestFailure("job-i", "domain", invalid)
	ir.noteIngestFailure("job-i", "domain", invalid)
	if ir.code() != 0 {
		t.Fatalf("two invalid answers ended the round with %d, want none", ir.code())
	}
	ir.noteIngestOK("job-i", "domain", &pb.PushSweepResponse{})
	ir.noteIngestFailure("job-i", "domain", invalid)
	ir.noteIngestFailure("job-i", "domain", invalid)
	if ir.code() != 0 {
		t.Fatal("the count did not reset after a success")
	}
	ir.noteIngestFailure("job-i", "domain", invalid)
	if ir.code() != exitIngestContract {
		t.Fatalf("three consecutive invalid answers ended the round with %d, want %d", ir.code(), exitIngestContract)
	}
}

// C6: one ingest_ok or ingest_error per real push, naming a code word and never a message.
func TestIngestEventsNameCodesNotMessages(t *testing.T) {
	cl := &stubCallLog{}
	secretMsg := "reason includes listing 12 Secret St"
	fi := &stubIngest{log: cl, pushErrs: []error{connectrpc.NewError(connectrpc.CodeUnavailable, errors.New(secretMsg)), nil}}
	ing := serveStubIngest(t, fi)
	var events bytes.Buffer
	ir := newStubIngestRound(crawlSinkIngest, ing.URL, "", stubTokens("tok"), stubEventsTo(&events))
	ir.client.sleep = func(context.Context, time.Duration) error { return nil }
	_, _, _ = ir.client.pushSweep(context.Background(), &pb.PushSweepRequest{IdempotencyKey: "job-e:1:domain", JobId: "job-e", Attempt: 1, Source: pb.Source_SOURCE_DOMAIN})
	ir.noteIngestFailure("job-e", "domain", connectrpc.NewError(connectrpc.CodeUnavailable, errors.New(secretMsg)))
	ir.noteIngestOK("job-e", "domain", &pb.PushSweepResponse{AppliedStatus: pb.SweepStatus_SWEEP_STATUS_PARTIAL})
	out := events.String()
	if !strings.Contains(out, `"event":"ingest_error"`) || !strings.Contains(out, `"code":"unavailable"`) {
		t.Errorf("no ingest_error with the code word: %s", out)
	}
	if !strings.Contains(out, `"event":"ingest_ok"`) || !strings.Contains(out, `"applied":"partial"`) {
		t.Errorf("no ingest_ok: %s", out)
	}
	if strings.Contains(out, "Secret") {
		t.Errorf("an event carries message text: %s", out)
	}
}

// Items 1 and 5 through the table: the defer/no-retry decision the job submits.
func TestJobDispositionTableAcceptsOnlyTheDocumentedAnswers(t *testing.T) {
	if n := len(jobDispositionTable); n == 0 {
		t.Fatal("empty disposition table")
	}
	if !ruleMatches(jobDispositionRule{code: connectrpc.CodeFailedPrecondition, reason: "contract_too_old*"}, connectrpc.CodeFailedPrecondition, "contract_too_old: min 2") {
		t.Error("the contract prefix rule does not match")
	}
	if ruleMatches(jobDispositionRule{code: connectrpc.CodeFailedPrecondition, reason: "not_dispatched"}, connectrpc.CodeFailedPrecondition, "not_dispatched_x") {
		t.Error("an exact reason matched a longer message")
	}
}

// ---------------------------------------------------------------------------
// Probe and round helpers.
// ---------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Fix 1 (safety re-review): the may-apply flag belongs to one attempt.
// -----------------------------------------------------------------------------

// Attempt 1 gets three Unavailable answers, so a push may have been stored and the job
// is submitted failed. Attempts 2 and 3 are rate-limited, which stores nothing, so both
// must DEFER. A flag keyed by job ID alone would fail them, because BrandBrain claims the
// same job again straight away.
func TestMayApplyDoesNotOutliveItsAttempt(t *testing.T) {
	unavailable := connectrpc.NewError(connectrpc.CodeUnavailable, errors.New("down"))
	limited := connectrpc.NewError(connectrpc.CodeResourceExhausted, errors.New("rate_limited"))
	cl := &stubCallLog{}
	fi := &stubIngest{log: cl, pushErrs: []error{unavailable, unavailable, unavailable, limited, limited}}
	ing := serveStubIngest(t, fi)
	ir := newStubIngestRound(crawlSinkIngest, ing.URL, "", stubTokens("tok"), nil)
	cb := newCircuitBreaker(3, time.Minute, time.Hour)
	run := func(attempts int) string {
		job := &agentCrawlJob{ID: "job-1", Kind: "housing", Suburb: "Bondi", State: "NSW", Postcode: "2026",
			Source: "domain", Tier: "listings", Attempts: attempts}
		ctx := withIngestRound(context.Background(), ir) // as the real round attaches it
		_, status, _, _, _ := ir.jobRunner(nil, stubDomainFetcher(), stubListingsConfig(), resumeSet{}, cb, nil, nil)(ctx, job)
		return status
	}
	if got := run(1); got != "failed" {
		t.Fatalf("attempt 1 (503s, may be stored) = %q, want failed", got)
	}
	if got := run(2); got != "deferred" {
		t.Fatalf("attempt 2 (rate-limited, stores nothing) = %q, want deferred: attempt 1's flag leaked", got)
	}
	if got := run(3); got != "deferred" {
		t.Fatalf("attempt 3 (rate-limited, stores nothing) = %q, want deferred: attempt 1's flag leaked", got)
	}
}

// -----------------------------------------------------------------------------
// Fix 2 (safety re-review): one unusable non-identity field never pins a suburb.
// -----------------------------------------------------------------------------

// A 2,049-byte URL blanks the URL. The listing is kept and the sweep stays COMPLETE.
func TestOverCapURLKeepsTheSweepComplete(t *testing.T) {
	job := &agentCrawlJob{ID: "job-u", Suburb: "Bondi", State: "NSW", Postcode: "2026", Attempts: 1}
	l := collectorListing("L-url")
	l.ListingUrl = strings.Repeat("u", 2049)
	req, skipped := buildPushRequest(job, "domain", suburbSweep{listings: housingcrawlRows(l), status: sweepComplete, pages: 1}, time.Now(), "rev", false)
	if skipped != 0 || req.GetStatus() != pb.SweepStatus_SWEEP_STATUS_COMPLETE {
		t.Fatalf("over-cap URL: skipped=%d status=%v, want 0 and COMPLETE", skipped, req.GetStatus())
	}
	if len(req.GetListings()) != 1 || req.GetListings()[0].GetListingUrl() != "" {
		t.Fatalf("over-cap URL: listings=%d url=%q, want the listing kept with the URL blanked", len(req.GetListings()), req.GetListings()[0].GetListingUrl())
	}
}

// A full state name blanks the state. The listing is kept and the sweep stays COMPLETE.
func TestFullStateNameKeepsTheSweepComplete(t *testing.T) {
	job := &agentCrawlJob{ID: "job-s", Suburb: "Bondi", State: "NSW", Postcode: "2026", Attempts: 1}
	l := collectorListing("L-state")
	l.State = "NEW SOUTH WALES"
	req, skipped := buildPushRequest(job, "domain", suburbSweep{listings: housingcrawlRows(l), status: sweepComplete, pages: 1}, time.Now(), "rev", false)
	if skipped != 0 || req.GetStatus() != pb.SweepStatus_SWEEP_STATUS_COMPLETE || len(req.GetListings()) != 1 {
		t.Fatalf("full state name: skipped=%d status=%v listings=%d, want kept and COMPLETE", skipped, req.GetStatus(), len(req.GetListings()))
	}
	if req.GetListings()[0].GetState() != job.State {
		t.Errorf("state = %q, want the job's target state %q", req.GetListings()[0].GetState(), job.State)
	}
}

// An over-cap listing_id is the one drop: the sweep is downgraded to PARTIAL, which never
// delists, and the other listings still go.
func TestOverCapListingIDDropsAndDowngradesToPartial(t *testing.T) {
	job := &agentCrawlJob{ID: "job-i", Suburb: "Bondi", State: "NSW", Postcode: "2026", Attempts: 1}
	good := collectorListing("L-good")
	bad := collectorListing("")
	bad.ListingId = strings.Repeat("i", 201)
	rows := append(housingcrawlRows(good), housingcrawlRows(bad)...)
	req, skipped := buildPushRequest(job, "domain", suburbSweep{listings: rows, status: sweepComplete, pages: 1}, time.Now(), "rev", false)
	if skipped != 1 || req.GetStatus() != pb.SweepStatus_SWEEP_STATUS_PARTIAL || len(req.GetListings()) != 1 {
		t.Fatalf("over-cap listing_id: skipped=%d status=%v listings=%d, want 1, PARTIAL, 1", skipped, req.GetStatus(), len(req.GetListings()))
	}
}

// Fix 1b: an over-cap suburb and postcode take the job's target values too, and a URL is
// blanked (it has no target value).
func TestOverCapTargetFieldsTakeTheJobsValues(t *testing.T) {
	job := &agentCrawlJob{ID: "job-f", Suburb: "St Kilda", State: "VIC", Postcode: "3182", Attempts: 1}
	l := collectorListing("L-fill")
	l.Suburb = strings.Repeat("s", 101)
	l.Postcode = strings.Repeat("9", 11)
	l.ListingUrl = strings.Repeat("u", 2049)
	req, skipped := buildPushRequest(job, "domain", suburbSweep{listings: housingcrawlRows(l), status: sweepComplete, pages: 1}, time.Now(), "rev", false)
	if skipped != 0 || req.GetStatus() != pb.SweepStatus_SWEEP_STATUS_COMPLETE || len(req.GetListings()) != 1 {
		t.Fatalf("skipped=%d status=%v listings=%d, want kept and COMPLETE", skipped, req.GetStatus(), len(req.GetListings()))
	}
	got := req.GetListings()[0]
	// The listing's own state is within its cap, so it is kept as it was: NSW, not the job's.
	if got.GetSuburb() != "St Kilda" || got.GetPostcode() != "3182" || got.GetState() != "NSW" {
		t.Errorf("target fields = %q %q %q, want the job's St Kilda and 3182, and the in-cap state NSW kept", got.GetSuburb(), got.GetPostcode(), got.GetState())
	}
	if got.GetListingUrl() != "" {
		t.Errorf("an over-cap URL must stay blank, got %d bytes", len(got.GetListingUrl()))
	}
}
