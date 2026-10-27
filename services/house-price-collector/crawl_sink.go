package main

// crawl_sink.go chooses where a -mode agent sweep is written (S-FETCH). CRAWL_SINK
// selects one of three sinks:
//
//	db      (default) the local diff into the database, exactly as before. The
//	        launchd wrappers on Gamma-64 and BrandBrain 1.33.10's bundled collector run
//	        this way, and nothing about it changes.
//	ingest  PUSH each sweep to shorted's CrawlIngestService. No DATABASE_URL, no pool.
//	        The server does the database work: upsert, diff, sal-link, MV refresh,
//	        revalidate (crawl-finalize). The round also skips the resume snapshot,
//	        because the server's dispatch decides what is crawled.
//	shadow  the db diff unchanged, plus a dry-run push of the same sweep. Parity is
//	        recorded per sweep in the events stream. A shadow failure never changes the
//	        legacy job's outcome, exit code or submit.
//
// The push for a job happens BEFORE its submit to BrandBrain. BrandBrain's submit is
// counts-only, and no listing field goes there.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	connectrpc "connectrpc.com/connect"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/castlemilk/shorted.com.au/services/gen/proto/go/housingingest/v1"
	"github.com/castlemilk/shorted.com.au/services/pkg/housingingest"
)

// crawlSinkEnv names the env var that selects the sink.
const crawlSinkEnv = "CRAWL_SINK"

// exitSinkRefused is the exit code for a refused CRAWL_SINK or a missing or conflicting
// environment: 8, the environment-broken code. Only an operator can fix it.
const exitSinkRefused = exitCrawlEnvBroken

type crawlSinkMode string

const (
	crawlSinkDB     crawlSinkMode = "db"
	crawlSinkIngest crawlSinkMode = "ingest"
	crawlSinkShadow crawlSinkMode = "shadow"
)

// resolveCrawlSink validates CRAWL_SINK against the mode being run and the
// environment. It returns the sink, or a non-empty reason to refuse to start (the
// caller exits exitSinkRefused). The rules, all of them refusals:
//   - an unknown CRAWL_SINK value;
//   - ingest or shadow outside -mode agent (only the agent path has a sink);
//   - ingest without SHORTED_INGEST_URL, or with DATABASE_URL set. A rig that carries a
//     database URL could dual-write, so ingest refuses rather than ignore it;
//   - shadow without SHORTED_INGEST_URL or DATABASE_URL (it needs both).
func resolveCrawlSink(mode string, getenv func(string) string) (crawlSinkMode, string) {
	raw := strings.TrimSpace(getenv(crawlSinkEnv))
	if raw == "" {
		return crawlSinkDB, ""
	}
	sink := crawlSinkMode(raw)
	switch sink {
	case crawlSinkDB:
		return crawlSinkDB, ""
	case crawlSinkIngest, crawlSinkShadow:
	default:
		return "", fmt.Sprintf("%s must be db, ingest or shadow (got %q)", crawlSinkEnv, raw)
	}
	if mode != "agent" {
		return "", fmt.Sprintf("%s=%s applies only to -mode agent", crawlSinkEnv, sink)
	}
	if strings.TrimSpace(getenv("SHORTED_INGEST_URL")) == "" {
		return "", fmt.Sprintf("%s=%s needs SHORTED_INGEST_URL", crawlSinkEnv, sink)
	}
	hasDB := strings.TrimSpace(getenv("DATABASE_URL")) != ""
	if sink == crawlSinkIngest && hasDB {
		return "", crawlSinkEnv + "=ingest refuses to start with DATABASE_URL set: a rig must not hold a database URL"
	}
	if sink == crawlSinkShadow && !hasDB {
		return "", crawlSinkEnv + "=shadow needs DATABASE_URL: the legacy diff still runs"
	}
	return sink, ""
}

// errRoundEnded is the answer for a sweep that was not pushed because the round
// already ended with a round-level exit (13, 14, 15 or 7).
var errRoundEnded = errors.New("round ended before this sweep was pushed")

// errQuarantined is the answer when the server held the sweep back. The rig must not
// retry it, so it is a per-job failure.
var errQuarantined = errors.New("quarantined")

// pushFailure wraps any error the ingest sink returns, so crawlAgentJob can tell a push
// answer from a local diff error without string matching.
type pushFailure struct{ err error }

func (e *pushFailure) Error() string { return e.err.Error() }
func (e *pushFailure) Unwrap() error { return e.err }

// sweepSink receives one (suburb, source) sweep in place of the local diff. It returns
// the number of events the sweep produced, for the job's counts.
type sweepSink interface {
	write(ctx context.Context, lc *listingsCrawler, t CrawlTarget, source string, sweep suburbSweep, runTs time.Time) (int, error)
}

// legacyDBSink is the local database diff. A blocked sweep writes nothing, which is
// what the crawler has always done for one.
type legacyDBSink struct{ pool *pgxpool.Pool }

func (s legacyDBSink) write(ctx context.Context, lc *listingsCrawler, t CrawlTarget, source string, sweep suburbSweep, runTs time.Time) (int, error) {
	if sweep.status == sweepBlocked {
		return 0, nil
	}
	return lc.diffSuburb(ctx, s.pool, t, source, sweep, runTs)
}

// pushSink sends the sweep to the ingest service. Its answer decides the job.
type pushSink struct {
	ir  *ingestRound
	job *agentCrawlJob
}

func (s pushSink) write(ctx context.Context, lc *listingsCrawler, t CrawlTarget, source string, sweep suburbSweep, runTs time.Time) (int, error) {
	if s.ir.code() != 0 {
		return 0, &pushFailure{err: errRoundEnded}
	}
	resp, err := s.ir.push(ctx, s.job, source, sweep, runTs, false)
	if err != nil {
		return 0, &pushFailure{err: err}
	}
	return s.ir.absorb(lc, sweep, resp)
}

// shadowSink runs the legacy diff and a dry-run push of the same sweep. The dry run
// goes FIRST: both ends read the same database, so a dry run sent after the local write
// would see the sweep already applied and report no events. The dry run commits nothing.
type shadowSink struct {
	ir     *ingestRound
	job    *agentCrawlJob
	legacy sweepSink
}

func (s shadowSink) write(ctx context.Context, lc *listingsCrawler, t CrawlTarget, source string, sweep suburbSweep, runTs time.Time) (int, error) {
	var (
		dry    *pb.PushSweepResponse
		dryErr error
	)
	if s.ir.shadowOn {
		dry, dryErr = s.ir.push(ctx, s.job, source, sweep, runTs, true)
	}
	n, err := s.legacy.write(ctx, lc, t, source, sweep, runTs)
	if s.ir.shadowOn {
		s.ir.recordParity(s.job.ID, source, n, err, dry, dryErr)
	}
	return n, err
}

// ingestRound is the per-process state of an ingest or shadow run: the client, the
// lease renewer and the round-level exit. It is carried on the context, so the
// existing functions keep their signatures and the db path never sees it.
type ingestRound struct {
	mode       crawlSinkMode
	client     *ingestClient
	brand      *brandbrainAgentClient
	events     *crawlEvents
	renewEvery time.Duration
	// shadowOn is false when shadow's ProbeAuth failed: the legacy run goes on alone
	// and the dry runs are skipped. Shadow never ends a round.
	shadowOn bool

	mu        sync.Mutex
	exitCode  int
	exitCause error
}

type ingestRoundKey struct{}

// withIngestRound attaches the round to ctx.
func withIngestRound(ctx context.Context, ir *ingestRound) context.Context {
	return context.WithValue(ctx, ingestRoundKey{}, ir)
}

// ingestRoundFrom returns the round on ctx, or nil in the db mode.
func ingestRoundFrom(ctx context.Context) *ingestRound {
	ir, _ := ctx.Value(ingestRoundKey{}).(*ingestRound)
	return ir
}

// newIngestRound builds the round for an ingest or shadow run. The token comes from the
// co-located agent's loopback control API, the same source refreshToken uses.
func newIngestRound(mode crawlSinkMode, acfg agentConfig, ingestURL string, events *crawlEvents) *ingestRound {
	tokHTTP := &http.Client{Timeout: 15 * time.Second}
	tokens := &workloadTokenSource{
		fetch: loopbackWorkloadToken(tokHTTP, acfg.controlURL, acfg.controlSecret, time.Now),
		now:   time.Now,
	}
	ir := &ingestRound{
		mode:       mode,
		client:     newIngestClient(ingestURL, tokens),
		brand:      newBrandbrainAgentClient(acfg),
		events:     events,
		renewEvery: ingestLeaseRenewEvery,
		shadowOn:   mode == crawlSinkShadow,
	}
	ir.client.renew = ir.renewLease
	return ir
}

// code returns the round-level exit code, or 0 while the round can go on.
func (ir *ingestRound) code() int {
	if ir == nil {
		return 0
	}
	ir.mu.Lock()
	defer ir.mu.Unlock()
	return ir.exitCode
}

// fail ends the round with code. The first failure wins, and the reason is logged.
// Only the ingest sink ends a round. A shadow failure is not a round failure.
func (ir *ingestRound) fail(code int, cause error) {
	ir.mu.Lock()
	defer ir.mu.Unlock()
	if ir.exitCode != 0 {
		return
	}
	ir.exitCode = code
	ir.exitCause = cause
	log.Printf("[ingest] round ends with exit %d: %v", code, cause)
}

// probe runs ProbeAuth once per process. For ingest a failure ends the round with its
// exit code, and a contract mismatch is 15. For shadow it only disables the dry runs.
func (ir *ingestRound) probe(ctx context.Context) int {
	resp, err := ir.client.probe(ctx)
	if err == nil && resp.GetMinContractVersion() > housingingest.ContractVersion {
		err = fmt.Errorf("contract_too_old: server requires contract %d, this collector sends %d",
			resp.GetMinContractVersion(), housingingest.ContractVersion)
		if ir.mode == crawlSinkShadow {
			ir.shadowOn = false
			log.Printf("[shadow] ProbeAuth: %v — dry-run pushes disabled; the legacy run continues", err)
			return 0
		}
		ir.fail(exitIngestContract, err)
		return exitIngestContract
	}
	if err != nil {
		if ir.mode == crawlSinkShadow {
			ir.shadowOn = false
			log.Printf("[shadow] ProbeAuth failed: %v — dry-run pushes disabled; the legacy run continues", err)
			return 0
		}
		code := ingestRoundExit(err)
		if code == 0 {
			code = exitIngestUnavailable
		}
		ir.fail(code, err)
		return code
	}
	log.Printf("[ingest] ProbeAuth ok: contract %d accepted (min %d), subject verified", housingingest.ContractVersion, resp.GetMinContractVersion())
	return 0
}

// sinkFor returns the sink for one claimed job. Nil means the local diff, as before.
func (ir *ingestRound) sinkFor(pool *pgxpool.Pool, job *agentCrawlJob) sweepSink {
	switch ir.mode {
	case crawlSinkIngest:
		return pushSink{ir: ir, job: job}
	case crawlSinkShadow:
		return shadowSink{ir: ir, job: job, legacy: legacyDBSink{pool: pool}}
	default:
		return nil
	}
}

// jobRunner is the round's runJob: one claimed job, run under the BrandBrain lease
// renewal for the whole job (both sources and their pushes). In db mode the round is
// nil and the job runs as it always has.
func (ir *ingestRound) jobRunner(pool *pgxpool.Pool, fetcher htmlFetcher, cfg listingsConfig, rs resumeSet, cb *crawlCircuitBreaker, tel *telemetryWriter, events *crawlEvents) func(ctx context.Context, job *agentCrawlJob) (crawlJobSummary, string, string, bool, time.Duration) {
	return func(ctx context.Context, job *agentCrawlJob) (crawlJobSummary, string, string, bool, time.Duration) {
		if ir != nil {
			stop := ir.startLeaseRenewal(ctx, job.ID)
			defer stop()
		}
		return crawlAgentJob(ctx, pool, fetcher, cfg, job, rs, cb, tel, events)
	}
}

// writesLocally reports whether this round's sweeps still reach the local database.
// Upserting a region is a local write, so it runs in db and shadow only.
func (ir *ingestRound) writesLocally() bool {
	return ir == nil || ir.mode != crawlSinkIngest
}

// push builds and sends one sweep. A round-level failure ends the round here, so the
// caller only has to classify the per-job part.
func (ir *ingestRound) push(ctx context.Context, job *agentCrawlJob, source string, sweep suburbSweep, runTs time.Time, dry bool) (*pb.PushSweepResponse, error) {
	req := buildPushRequest(job, source, sweep, runTs, collectorRevisionForPush(), dry)
	resp, err := ir.client.pushSweep(ctx, req)
	if err != nil {
		if ir.mode == crawlSinkIngest {
			if code := ingestRoundExit(err); code != 0 {
				ir.fail(code, err)
			}
		}
		return nil, err
	}
	return resp, nil
}

// absorb folds one applied push into the job's stats. It returns the events the sweep
// produced, or a pushFailure when the server held the sweep back.
func (ir *ingestRound) absorb(lc *listingsCrawler, sweep suburbSweep, resp *pb.PushSweepResponse) (int, error) {
	lc.stats.pushedUpserted += int(resp.GetListingsUpserted())
	lc.stats.pushedDelisted += int(resp.GetDelisted())
	lc.stats.skippedRows += int(resp.GetSkippedRows())
	if resp.GetReplayed() {
		log.Printf("[ingest] %s: the server replayed a stored answer (already applied)", resp.GetAppliedStatus())
	}
	if resp.GetQuarantined() {
		lc.stats.pushedQuarantined++
		return 0, &pushFailure{err: errQuarantined}
	}
	if resp.GetAppliedStatus() == pb.SweepStatus_SWEEP_STATUS_BLOCKED && sweep.status != sweepBlocked {
		// The server downgraded a sweep the rig called COMPLETE or PARTIAL (poisoned,
		// or no gated listing). Count it as blocked, as a local block would be.
		lc.stats.blockedSweeps++
	}
	return int(resp.GetEvents()), nil
}

// recordParity writes one shadow event: the legacy diff's count against the dry run's.
// It names outcomes and counts only, never a suburb or a listing.
func (ir *ingestRound) recordParity(jobID, source string, legacyEvents int, legacyErr error, dry *pb.PushSweepResponse, dryErr error) {
	ev := shadowParity{
		JobID:        jobID,
		Source:       source,
		LegacyEvents: legacyEvents,
		LegacyFailed: legacyErr != nil,
	}
	switch {
	case dryErr != nil:
		ev.PushError = connectCodeName(dryErr)
		ev.PushReason = parityReason(dryErr)
		ev.Parity = "push_error"
		if ev.PushReason == "not_dispatched" {
			ev.Parity = "not_dispatched"
		}
	case legacyErr != nil:
		ev.Parity = "legacy_error"
	default:
		ev.DryEvents = int(dry.GetEvents())
		ev.DryQuarantined = dry.GetQuarantined()
		ev.DryPoisoned = dry.GetPoisoned()
		ev.DryApplied = appliedName(dry.GetAppliedStatus())
		ev.Parity = "match"
		if ev.DryQuarantined || ev.DryPoisoned || legacyEvents != ev.DryEvents {
			ev.Parity = "diverge"
		}
	}
	ir.events.shadowParity(ev)
}

// startLeaseRenewal renews the job's BrandBrain lease every renewEvery until the
// returned stop is called. stop waits for the goroutine to finish. A renewal failure
// is logged and the job goes on: the lease is 10 minutes, and a missed renewal is
// recoverable.
func (ir *ingestRound) startLeaseRenewal(ctx context.Context, jobID string) (stop func()) {
	rctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		t := time.NewTicker(ir.renewEvery)
		defer t.Stop()
		for {
			select {
			case <-rctx.Done():
				return
			case <-t.C:
				if err := ir.renewLease(rctx, jobID); err != nil {
					log.Printf("[agent] lease renewal failed (job=%s): %v — continuing", jobID, err)
				}
			}
		}
	}()
	return func() {
		cancel()
		<-done
	}
}

// renewLease extends the job's BrandBrain lease. It is the same call for the renewer
// and for the ingest client's retries.
func (ir *ingestRound) renewLease(ctx context.Context, jobID string) error {
	return ir.brand.renew(ctx, jobID)
}

// reportCycle sends the round's health record to shorted, counts only, in place of
// the rig's crawl_run_status write. A failure is logged: the record is best-effort.
func (ir *ingestRound) reportCycle(rec crawlRunStatusRecord, exitCode int) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req := &pb.ReportCycleRequest{
		CycleId:  rec.RunID,
		Outcome:  cycleOutcome(rec.Status),
		ExitCode: int32(exitCode),
		Counts: &pb.CycleCounts{
			SuburbsSelected: int32(rec.SuburbsSelected),
			SuburbsDone:     int32(rec.SuburbsDone),
			ListingsTouched: int32(rec.ListingsTouched),
			EventsWritten:   int32(rec.EventsWritten),
			BlockedCount:    int32(rec.BlockedCount),
		},
	}
	if err := ir.client.reportCycle(ctx, req); err != nil {
		log.Printf("[ingest] ReportCycle failed (best-effort): %v", err)
	}
}

// cycleOutcome maps the rig's round status onto the ReportCycle vocabulary.
func cycleOutcome(status string) string {
	switch status {
	case "ok", "blocked", "partial", "cancelled", "error":
		return status
	case "rewarm", "needs_rewarm":
		return "rewarm"
	default:
		return "error"
	}
}

// buildPushRequest is the collector's sweep turned into a PushSweepRequest. The target
// is the job's own suburb, state and postcode, as BrandBrain carries them. A blocked
// sweep goes with no rows, and a dry run is flagged so the server rolls it back.
func buildPushRequest(job *agentCrawlJob, source string, sweep suburbSweep, runTs time.Time, revision string, dry bool) *pb.PushSweepRequest {
	req := &pb.PushSweepRequest{
		IdempotencyKey:    fmt.Sprintf("%s:%d:%s", job.ID, job.Attempts, source),
		JobId:             job.ID,
		Attempt:           int32(job.Attempts),
		Target:            &pb.Target{Suburb: job.Suburb, State: job.State, Postcode: job.Postcode},
		Source:            housingingest.SourceEnum(source),
		Status:            housingingest.StatusEnum(sweep.status.lib()),
		Pages:             int32(sweep.pages),
		ObservedAt:        timestamppb.New(runTs),
		CollectorRevision: revision,
		ContractVersion:   housingingest.ContractVersion,
		DryRun:            dry,
	}
	if sweep.meta.OK {
		req.PageMeta = &pb.PageMeta{
			TotalResults:    int32(sweep.meta.TotalResults),
			TotalPages:      int32(sweep.meta.TotalPages),
			PageSize:        int32(sweep.meta.PageSize),
			OnTargetResults: int32(sweep.meta.OnTargetResults),
		}
	}
	if sweep.status != sweepBlocked {
		req.Listings = housingingest.FromRawListings(sweep.listings)
	}
	return req
}

// collectorRevisionForPush is the revision this binary reports to the ingest.
func collectorRevisionForPush() string {
	info, _ := debug.ReadBuildInfo()
	return resolveCollectorVersion(collectorRevision, info, runtime.Version()).Revision
}

// jobDispositionRule is one row of the per-job table. A rule matches a Connect code,
// and for FailedPrecondition the fixed reason the server puts in the message. Round
// level answers never reach this table (ingestRoundExit handles them first).
type jobDispositionRule struct {
	code   connectrpc.Code
	reason string // "" matches any message for the code
	disp   pushDisposition
}

// pushDisposition is what a job reports to BrandBrain for one push answer.
type pushDisposition struct {
	status     string // succeeded | failed | deferred
	errMsg     string
	retryAfter time.Duration
}

// jobDispositionTable is the design's per-job mapping ("Outcome mapping"), plus the
// dispatch answers push.go defines. It is read top to bottom; the first match wins.
var jobDispositionTable = []jobDispositionRule{
	// dispatch_applied: an earlier attempt already applied this job. The job is done.
	{connectrpc.CodeFailedPrecondition, "dispatch_applied", pushDisposition{status: "succeeded"}},
	// not_dispatched: the ledger has no such job, for example a job the legacy enqueue
	// posted. The server will never take it, so it fails.
	{connectrpc.CodeFailedPrecondition, "not_dispatched", pushDisposition{status: "failed", errMsg: "ingest: job not dispatched by the server"}},
	{connectrpc.CodeFailedPrecondition, "dispatch_expired", pushDisposition{status: "failed", errMsg: "ingest: dispatch expired before an attempt applied"}},
	{connectrpc.CodeFailedPrecondition, "target_mismatch", pushDisposition{status: "failed", errMsg: "ingest: target does not match the dispatch"}},
	{connectrpc.CodeAlreadyExists, "", pushDisposition{status: "failed", errMsg: "ingest: idempotency key reused with a different body"}},
	{connectrpc.CodeInvalidArgument, "", pushDisposition{status: "failed", errMsg: "ingest: sweep rejected"}},
	// The per-rig rate limit (120 sweeps an hour) is a pacing answer, not a verdict on
	// the sweep, so the job goes back on the queue with its attempt refunded.
	{connectrpc.CodeResourceExhausted, "", pushDisposition{status: "deferred", errMsg: "ingest: rate limited", retryAfter: ingestDeferRetryAfter}},
}

// jobDisposition is the per-job answer for one push error (or nil for a pushed sweep).
// Round-level errors defer the job: the job is not at fault, and the round is ending.
func jobDisposition(err error) pushDisposition {
	if err == nil {
		return pushDisposition{status: "succeeded"}
	}
	if errors.Is(err, errRoundEnded) {
		return pushDisposition{status: "deferred", errMsg: "ingest round ended before this sweep", retryAfter: ingestDeferRetryAfter}
	}
	if errors.Is(err, errQuarantined) {
		return pushDisposition{status: "failed", errMsg: "ingest: sweep quarantined (held for review, not retried)"}
	}
	// A push cut short by cancellation was never answered. The job is not at fault, so it
	// goes back on the queue rather than failing.
	if code, ok := errCode(err); errors.Is(err, context.Canceled) || (ok && code == connectrpc.CodeCanceled) {
		return pushDisposition{status: "deferred", errMsg: "ingest push cancelled before it was answered", retryAfter: ingestDeferRetryAfter}
	}
	if ingestRoundExit(err) != 0 {
		return pushDisposition{status: "deferred", errMsg: "ingest unavailable or refused, not attempted", retryAfter: ingestDeferRetryAfter}
	}
	code, ok := errCode(err)
	if !ok {
		return pushDisposition{status: "failed", errMsg: "ingest push failed"}
	}
	msg := connectMessage(err)
	for _, r := range jobDispositionTable {
		if r.code != code {
			continue
		}
		if r.reason != "" && r.reason != msg {
			continue
		}
		return r.disp
	}
	if code == connectrpc.CodeUnavailable {
		return pushDisposition{status: "deferred", errMsg: "ingest unavailable", retryAfter: ingestDeferRetryAfter}
	}
	return pushDisposition{status: "failed", errMsg: "ingest rejected: " + code.String()}
}

// parityReasons is the fixed vocabulary a shadow event may carry from a server answer.
var parityReasons = map[string]bool{
	"not_dispatched": true, "dispatch_applied": true, "dispatch_expired": true,
	"target_mismatch": true, "contract_too_old": true,
}

// parityReason returns the server's reason for a failed call when it is one of the
// known reasons, and "" otherwise. The message is never echoed.
func parityReason(err error) string {
	msg := connectMessage(err)
	if parityReasons[msg] {
		return msg
	}
	if strings.HasPrefix(msg, "contract_too_old") {
		return "contract_too_old"
	}
	return ""
}

// connectCodeName is the Connect code of err as a lowercase word, or "" for a non-Connect
// error.
func connectCodeName(err error) string {
	if code, ok := errCode(err); ok {
		return code.String()
	}
	return ""
}

// appliedName is the lowercase name of an applied sweep status, for shadow events.
func appliedName(s pb.SweepStatus) string {
	switch s {
	case pb.SweepStatus_SWEEP_STATUS_COMPLETE:
		return "complete"
	case pb.SweepStatus_SWEEP_STATUS_PARTIAL:
		return "partial"
	case pb.SweepStatus_SWEEP_STATUS_BLOCKED:
		return "blocked"
	default:
		return ""
	}
}

// firstPushFailure returns the first pushFailure among errs, or nil.
func firstPushFailure(errs ...error) error {
	for _, e := range errs {
		var pf *pushFailure
		if errors.As(e, &pf) {
			return e
		}
	}
	return nil
}
