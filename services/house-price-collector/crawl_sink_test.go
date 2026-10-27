package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	connectrpc "connectrpc.com/connect"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
	"github.com/castlemilk/shorted.com.au/services/pkg/housingcrawl"
)

// TestResolveCrawlSink pins every refusal and the one legal shape of each sink.

// TestBuildPushRequest_KeyTargetAndStatus pins the request the rig sends: the key, the
// target as the job carries it, the status mapping, page meta and the blocked rule.
func TestBuildPushRequest_KeyTargetAndStatus(t *testing.T) {
	job := &agentCrawlJob{ID: "job-9", Suburb: "St Kilda", State: "VIC", Postcode: "3182", Attempts: 4}
	when := time.Date(2026, 10, 27, 1, 2, 3, 0, time.UTC)
	rows := []housingcrawl.RawListing{{Source: "rea", ListingID: "L1", Suburb: "St Kilda", State: "VIC", Postcode: "3182"}}

	req, _ := buildPushRequest(job, "rea", suburbSweep{listings: rows, status: sweepComplete, pages: 2,
		meta: PageMeta{OK: true, TotalResults: 40, TotalPages: 2, PageSize: 20, OnTargetResults: 38}}, when, "rev-1", true)

	if req.GetIdempotencyKey() != "job-9:4:rea" || req.GetAttempt() != 4 || req.GetJobId() != "job-9" {
		t.Errorf("key/attempt/job = %q/%d/%q", req.GetIdempotencyKey(), req.GetAttempt(), req.GetJobId())
	}
	if tg := req.GetTarget(); tg.GetSuburb() != "St Kilda" || tg.GetState() != "VIC" || tg.GetPostcode() != "3182" {
		t.Errorf("target = %+v, want the job's own catalog values", tg)
	}
	if req.GetSource() != pb.Source_SOURCE_REA || req.GetStatus() != pb.SweepStatus_SWEEP_STATUS_COMPLETE {
		t.Errorf("source/status = %v/%v", req.GetSource(), req.GetStatus())
	}
	if !req.GetDryRun() || req.GetCollectorRevision() != "rev-1" || req.GetContractVersion() != 1 {
		t.Errorf("dry_run/revision/contract = %v/%q/%d", req.GetDryRun(), req.GetCollectorRevision(), req.GetContractVersion())
	}
	if pm := req.GetPageMeta(); pm == nil || pm.GetOnTargetResults() != 38 || pm.GetTotalPages() != 2 {
		t.Errorf("page meta = %+v", pm)
	}
	if len(req.GetListings()) != 1 || req.GetListings()[0].GetListingId() != "L1" {
		t.Errorf("listings = %+v", req.GetListings())
	}
	if !req.GetObservedAt().AsTime().Equal(when) {
		t.Errorf("observed_at = %v, want %v", req.GetObservedAt().AsTime(), when)
	}

	// A blocked sweep goes with no rows and no meta when the meta was never read.
	blocked, _ := buildPushRequest(job, "domain", suburbSweep{listings: rows, status: sweepBlocked}, when, "rev-1", false)
	if blocked.GetStatus() != pb.SweepStatus_SWEEP_STATUS_BLOCKED || len(blocked.GetListings()) != 0 {
		t.Errorf("blocked sweep carried status %v and %d rows", blocked.GetStatus(), len(blocked.GetListings()))
	}
	if blocked.GetPageMeta() != nil {
		t.Errorf("unread page meta was sent: %+v", blocked.GetPageMeta())
	}
	if blocked.GetDryRun() {
		t.Error("a real push must not be flagged dry_run")
	}
}

// TestJobDisposition_Table is the per-job mapping. Each row is an answer the server
// gives, and the job's status and retry hold for each.

// TestIngestRoundExit pins the round exit each ingest failure ends the round with.
func TestIngestRoundExit(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"Unauthenticated is 13", connectrpc.NewError(connectrpc.CodeUnauthenticated, errors.New("x")), 13},
		{"PermissionDenied is 13", connectrpc.NewError(connectrpc.CodePermissionDenied, errors.New("x")), 13},
		{"retries exhausted is 14", &exhaustedError{err: connectrpc.NewError(connectrpc.CodeUnavailable, errors.New("x"))}, 14},
		{"contract_too_old is 15", connectrpc.NewError(connectrpc.CodeFailedPrecondition, errors.New("contract_too_old: x")), 15},
		{"a token that could not be minted is 7", &tokenError{err: errors.New("x")}, 7},
		{"not_dispatched is per-job, not an exit", connectrpc.NewError(connectrpc.CodeFailedPrecondition, errors.New("not_dispatched")), 0},
		{"nil is no exit", nil, 0},
	}
	for _, tc := range cases {
		if got := ingestRoundExit(tc.err); got != tc.want {
			t.Errorf("%s: exit = %d, want %d", tc.name, got, tc.want)
		}
	}
}

// TestRoundExit_ShortCircuitsTheLoop: a round-level answer from the ingest stops the
// round after its job is submitted, and the exit is the round's, whatever else ran.
func TestRoundExit_ShortCircuitsTheLoop(t *testing.T) {
	cl := &stubCallLog{}
	fi := &stubIngest{log: cl, authErr: func(string) error {
		return connectrpc.NewError(connectrpc.CodeUnauthenticated, errors.New("no"))
	}}
	ingest := stubServe(t, fi)
	bb := &stubBrandbrain{log: cl, job: stubJob()}
	bbSrv := httptest.NewServer(bb)
	t.Cleanup(bbSrv.Close)

	// Every token is refused, so the round ends on the first job.
	ir := newStubIngestRound(crawlSinkIngest, ingest, bbSrv.URL, stubTokens("tok-s"), nil)
	res := runStubRound(context.Background(), ir, stubDomainFetcher(), stubListingsConfig())
	if res.roundExit != exitIngestAuthRefused {
		t.Fatalf("round roundExit = %d, want %d (res %+v)", res.roundExit, exitIngestAuthRefused, res)
	}
	if got := finalExitCode(res); got != exitIngestAuthRefused {
		t.Errorf("finalExitCode = %d, want %d", got, exitIngestAuthRefused)
	}
	if len(bb.submitted) != 1 || bb.submitted[0]["status"] != "deferred" {
		t.Errorf("submit = %v, want the job deferred so the queue keeps it", bb.submitted)
	}
}

// stubServe serves fi and returns its base URL.
func stubServe(t *testing.T, fi *stubIngest) string {
	t.Helper()
	return serveStubIngest(t, fi).URL
}

// stubLegacy is a stand-in for the local diff. It records when it ran, relative to
// the call log, and answers with a fixed count or error.
type stubLegacy struct {
	log    *stubCallLog
	events int
	err    error
}

func (s *stubLegacy) write(context.Context, *listingsCrawler, CrawlTarget, string, suburbSweep, time.Time) (int, error) {
	s.log.add("legacy")
	return s.events, s.err
}

// stubShadowSweep is a five-listing sweep, the shape the shadow tests push.
func stubShadowSweep() suburbSweep {
	rows := make([]housingcrawl.RawListing, 0, 5)
	for i := 0; i < 5; i++ {
		rows = append(rows, housingcrawl.RawListing{Source: "domain", ListingID: fmt.Sprintf("L%d", i), Suburb: "Bondi", State: "NSW", Postcode: "2026"})
	}
	return suburbSweep{listings: rows, status: sweepPartial, pages: 1}
}

// stubParityLines decodes the shadow events written to buf.
func stubParityLines(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("bad event line %q: %v", line, err)
		}
		if m["event"] == "shadow" {
			out = append(out, m)
		}
	}
	return out
}

// TestShadow_DryRunFirstAndLegacyOutcomeUnchanged: the dry run is sent with
// dry_run=true and BEFORE the local write, and a failed dry run never changes the
// legacy result.
func TestShadow_DryRunFirstAndLegacyOutcomeUnchanged(t *testing.T) {
	cl := &stubCallLog{}
	fi := &stubIngest{log: cl}
	ingest := stubServe(t, fi)
	bbSrv := httptest.NewServer(&stubBrandbrain{log: cl})
	t.Cleanup(bbSrv.Close)

	var buf bytes.Buffer
	ir := newStubIngestRound(crawlSinkShadow, ingest, bbSrv.URL, stubTokens("tok-sh"), stubEventsTo(&buf))
	job := &agentCrawlJob{ID: "job-sh", Suburb: "Bondi", State: "NSW", Postcode: "2026", Attempts: 1}
	legacy := &stubLegacy{log: cl, events: 5}
	sink := shadowSink{ir: ir, job: job, legacy: legacy}

	n, err := sink.write(context.Background(), &listingsCrawler{}, bondi, "domain", stubShadowSweep(), time.Now())
	if err != nil || n != 5 {
		t.Fatalf("shadow write = (%d, %v), want the legacy's (5, nil)", n, err)
	}
	if fi.pushCount() != 1 || !fi.pushes[0].GetDryRun() {
		t.Fatalf("pushes = %d (dry_run=%v), want one dry run", fi.pushCount(), fi.pushes[0].GetDryRun())
	}
	if push, legacyAt := cl.indexOf("push:job-sh:1:domain"), cl.indexOf("legacy"); push < 0 || legacyAt < 0 || push > legacyAt {
		t.Fatalf("order %v: the dry run must read before the local write", cl.snapshot())
	}
	lines := stubParityLines(t, &buf)
	if len(lines) != 1 || lines[0]["parity"] != "match" {
		t.Fatalf("parity events = %v, want one match", lines)
	}

	// The dry run fails: the legacy result stands, and the failure is parity, not a job error.
	down := connectrpc.NewError(connectrpc.CodeUnavailable, errors.New("down"))
	fi.pushErrs = []error{down, down, down}
	legacy.err = nil
	n, err = sink.write(context.Background(), &listingsCrawler{}, bondi, "domain", stubShadowSweep(), time.Now())
	if err != nil || n != 5 {
		t.Fatalf("a failed dry run changed the legacy result to (%d, %v)", n, err)
	}
	// A failing local write is returned exactly as the db sink would return it.
	legacy.err = errors.New("diff failed")
	if _, err := sink.write(context.Background(), &listingsCrawler{}, bondi, "domain", stubShadowSweep(), time.Now()); err == nil || err.Error() != "diff failed" {
		t.Fatalf("legacy error = %v, want the legacy's own error", err)
	}
}

// TestShadow_ParityNamesNotDispatched: a dispatch the ledger does not know is recorded
// as not_dispatched parity, and it is not an error for the job.
func TestShadow_ParityNamesNotDispatched(t *testing.T) {
	cl := &stubCallLog{}
	fi := &stubIngest{log: cl, pushErrs: []error{connectrpc.NewError(connectrpc.CodeFailedPrecondition, errors.New("not_dispatched"))}}
	ingest := stubServe(t, fi)
	bbSrv := httptest.NewServer(&stubBrandbrain{log: cl})
	t.Cleanup(bbSrv.Close)

	var buf bytes.Buffer
	ir := newStubIngestRound(crawlSinkShadow, ingest, bbSrv.URL, stubTokens("tok-nd"), stubEventsTo(&buf))
	sink := shadowSink{ir: ir, job: &agentCrawlJob{ID: "job-nd", Suburb: "Bondi", State: "NSW", Postcode: "2026", Attempts: 1},
		legacy: &stubLegacy{log: cl, events: 5}}
	if _, err := sink.write(context.Background(), &listingsCrawler{}, bondi, "domain", stubShadowSweep(), time.Now()); err != nil {
		t.Fatalf("not_dispatched in shadow surfaced as an error: %v", err)
	}
	lines := stubParityLines(t, &buf)
	if len(lines) != 1 || lines[0]["parity"] != "not_dispatched" || lines[0]["push_reason"] != "not_dispatched" {
		t.Fatalf("parity = %v, want not_dispatched with the server's reason", lines)
	}
	if strings.Contains(buf.String(), "Bondi") {
		t.Errorf("the shadow event names the suburb: %s", buf.String())
	}
}

// TestParityReason keeps only the ingest's own reasons, and never echoes anything else.
func TestParityReason(t *testing.T) {
	cases := map[string]string{
		"not_dispatched":          "not_dispatched",
		"dispatch_applied":        "dispatch_applied",
		"contract_too_old: x":     "contract_too_old",
		"Bondi street listing 12": "",
	}
	for msg, want := range cases {
		if got := parityReason(connectrpc.NewError(connectrpc.CodeFailedPrecondition, errors.New(msg))); got != want {
			t.Errorf("parityReason(%q) = %q, want %q", msg, got, want)
		}
	}
}

// TestLegacyDBSink_BlockedWritesNothing mirrors the db path: a blocked sweep never
// reaches the diff. It is checked without a pool because the sink returns before it.
func TestLegacyDBSink_BlockedWritesNothing(t *testing.T) {
	n, err := legacyDBSink{}.write(context.Background(), &listingsCrawler{}, bondi, "domain",
		suburbSweep{status: sweepBlocked}, time.Now())
	if n != 0 || err != nil {
		t.Fatalf("blocked sweep through the legacy sink = (%d, %v), want (0, nil)", n, err)
	}
}
