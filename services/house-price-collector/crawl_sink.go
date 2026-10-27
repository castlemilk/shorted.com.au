package main

// crawl_sink.go chooses where a -mode agent sweep is written (S-FETCH). CRAWL_SINK
// selects one of three sinks, and it is read ONLY by -mode agent:
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
//	        legacy job's outcome, exit code or submit, and after shadowFailLimit
//	        consecutive failures shadow is off for the rest of the process.
//
// The push for a job happens BEFORE its submit to BrandBrain. BrandBrain's submit is
// counts-only, and no listing field goes there. Under ingest and shadow the rig sends
// listing rows, page content and the workload token to a shorted host and nowhere else
// (validateIngestURL), and it refuses the fetch routes that would send them elsewhere.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/url"
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

// shadowFailLimit is how many consecutive shadow dry-run failures switch shadow off for
// the rest of the process.
const shadowFailLimit = 3

// shadowDryRunTimeout bounds one shadow dry-run push: a single attempt, no retry. It is
// a var so tests can shorten it. Production never changes it.
var shadowDryRunTimeout = 15 * time.Second

// ingestHosts is the EXACT set of hosts the rig will push to. No suffix match: a suffix
// let a zoned IPv6 literal such as [::ffff:A.B.C.D%25.shorted.com.au] through, and Go would
// dial the literal address.
var ingestHosts = map[string]bool{
	"api.shorted.com.au":                     true,
	"housing-ingest-uiekqxovma-km.a.run.app": true,
}

var testAllowLoopbackIngest bool

type crawlSinkMode string

const (
	crawlSinkDB     crawlSinkMode = "db"
	crawlSinkIngest crawlSinkMode = "ingest"
	crawlSinkShadow crawlSinkMode = "shadow"
)

// plainHostname reports whether h is a plain DNS name: ASCII letters, digits, '.' and '-'
// only. That excludes brackets, colons, percent signs (IPv6 zones) and every other
// character a URL host can carry that is not a name.
func plainHostname(h string) bool {
	if h == "" {
		return false
	}
	for i := 0; i < len(h); i++ {
		c := h[i]
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '.', c == '-':
		default:
			return false
		}
	}
	return true
}

// validateIngestURL accepts only the pinned shorted ingest. It must be https, carry no
// userinfo, name no port other than 443, and name a plain DNS host (plainHostname) that
// is exactly one of ingestHosts. An IP literal of any kind, a zoned literal, a lookalike
// such as shorted.com.au.evil.com, and any other host, including www.shorted.com.au, is
// refused.
func validateIngestURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return errors.New("SHORTED_INGEST_URL does not parse")
	}
	if u.User != nil {
		return errors.New("SHORTED_INGEST_URL must not carry userinfo")
	}
	host := strings.ToLower(u.Hostname())
	if testAllowLoopbackIngest && u.Scheme == "http" && (host == "127.0.0.1" || host == "localhost") {
		return nil
	}
	if u.Scheme != "https" {
		return errors.New("SHORTED_INGEST_URL must be https")
	}
	if p := u.Port(); p != "" && p != "443" {
		return errors.New("SHORTED_INGEST_URL must not name a port")
	}
	if !plainHostname(host) || net.ParseIP(host) != nil {
		return errors.New("SHORTED_INGEST_URL must name a plain DNS host")
	}
	if !ingestHosts[host] {
		return errors.New("SHORTED_INGEST_URL host is not an allowed shorted ingest host")
	}
	return nil
}

// loopbackCDP reports whether a CRAWL_CDP_URL names this machine. The ingest sinks run
// the browser on the rig, so a CDP endpoint anywhere else would carry page content off
// the machine.
func loopbackCDP(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	switch strings.ToLower(u.Hostname()) {
	case "127.0.0.1", "localhost", "::1":
		return true
	default:
		return false
	}
}

// resolveCrawlSink is resolveSink without the URL, for callers that only need the verdict.
func resolveCrawlSink(mode string, getenv func(string) string) (crawlSinkMode, string) {
	sink, _, refusal := resolveSink(mode, getenv)
	return sink, refusal
}

// resolveSink validates CRAWL_SINK for the mode being run. It returns the sink, the
// validated, normalised ingest URL (whitespace trimmed), and a non-empty refusal when
// the process must not start (the caller exits exitSinkRefused). The URL returned is the
// only one the round may use. Any mode other than -mode agent ignores CRAWL_SINK entirely.
// For -mode agent the refusals are:
//   - an unknown CRAWL_SINK value;
//   - ingest or shadow without a pinned SHORTED_INGEST_URL (validateIngestURL);
//   - ingest with DATABASE_URL set (a rig must not dual-write), or shadow without it;
//   - ingest without an explicit CRAWL_DRY_RUN (true or false). Unset would default to a
//     dry run, and that default must never decide what ingest does;
//   - a gateway fetch route (CRAWL_GATEWAY_URL, CRAWL_FETCH_MODE=gateway), which sends
//     every page through a BrandBrain gateway;
//   - a CRAWL_CDP_URL that is not loopback;
//   - CRAWL_TRACE or CRAWL_TRACE_DIR set to anything but false: a trace writes full portal
//     pages and screenshots to disk.
func resolveSink(mode string, getenv func(string) string) (crawlSinkMode, string, string) {
	if mode != "agent" {
		return crawlSinkDB, "", ""
	}
	raw := strings.TrimSpace(getenv(crawlSinkEnv))
	if raw == "" {
		return crawlSinkDB, "", ""
	}
	sink := crawlSinkMode(raw)
	switch sink {
	case crawlSinkDB:
		return crawlSinkDB, "", ""
	case crawlSinkIngest, crawlSinkShadow:
	default:
		return "", "", fmt.Sprintf("%s must be db, ingest or shadow (got %q)", crawlSinkEnv, raw)
	}
	ingestURL := strings.TrimSpace(getenv("SHORTED_INGEST_URL"))
	if ingestURL == "" {
		return "", "", fmt.Sprintf("%s=%s needs SHORTED_INGEST_URL", crawlSinkEnv, sink)
	}
	if err := validateIngestURL(ingestURL); err != nil {
		return "", "", fmt.Sprintf("%s=%s: %v", crawlSinkEnv, sink, err)
	}
	hasDB := strings.TrimSpace(getenv("DATABASE_URL")) != ""
	if sink == crawlSinkIngest && hasDB {
		return "", "", crawlSinkEnv + "=ingest refuses to start with DATABASE_URL set: a rig must not hold a database URL"
	}
	if sink == crawlSinkShadow && !hasDB {
		return "", "", crawlSinkEnv + "=shadow needs DATABASE_URL: the legacy diff still runs"
	}
	if sink == crawlSinkIngest {
		if dry := strings.TrimSpace(getenv("CRAWL_DRY_RUN")); dry != "true" && dry != "false" {
			return "", "", crawlSinkEnv + "=ingest needs CRAWL_DRY_RUN set explicitly to true or false"
		}
	}
	if strings.TrimSpace(getenv("CRAWL_GATEWAY_URL")) != "" || strings.EqualFold(strings.TrimSpace(getenv("CRAWL_FETCH_MODE")), "gateway") {
		return "", "", crawlSinkEnv + "=" + string(sink) + " refuses the gateway fetch route: pages would leave the rig"
	}
	if cdp := strings.TrimSpace(getenv("CRAWL_CDP_URL")); cdp != "" && !loopbackCDP(cdp) {
		return "", "", crawlSinkEnv + "=" + string(sink) + " needs a loopback CRAWL_CDP_URL"
	}
	// Any non-empty value refuses, untrimmed: "false" is not an off spelling here. The loader
	// turns tracing on for a non-empty CRAWL_TRACE_DIR and uses the value as the directory,
	// so "false" would write ./false. A non-breaking space is non-empty too.
	for _, k := range []string{"CRAWL_TRACE", "CRAWL_TRACE_DIR"} {
		if v := getenv(k); v != "" {
			return "", "", crawlSinkEnv + "=" + string(sink) + " refuses " + k + ": a trace writes full portal pages to disk"
		}
	}
	return sink, ingestURL, ""
}

// errRoundEnded is the answer for a sweep that was not pushed because the round
// already ended with a round-level exit.
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

// pushSink sends the sweep to the ingest service. Its answer decides the job. A run
// with CRAWL_DRY_RUN=true pushes with dry_run=true, so the server rolls it back.
type pushSink struct {
	ir  *ingestRound
	job *agentCrawlJob
}

func (s pushSink) write(ctx context.Context, lc *listingsCrawler, t CrawlTarget, source string, sweep suburbSweep, runTs time.Time) (int, error) {
	if s.ir.code() != 0 {
		return 0, &pushFailure{err: errRoundEnded}
	}
	resp, skipped, err := s.ir.push(ctx, s.job, source, sweep, runTs, lc.cfg.dryRun, false)
	lc.stats.skippedRows += skipped
	if err != nil {
		return 0, &pushFailure{err: err}
	}
	return s.ir.absorb(lc, sweep, resp)
}

// shadowSink runs the legacy diff and a dry-run push of the same sweep. The dry run
// goes FIRST: both ends read the same database, so a dry run sent after the local write
// would see the sweep already applied and report no events. The dry run commits nothing.
// A dry run under CRAWL_DRY_RUN=true writes nothing on either side, so it does nothing.
type shadowSink struct {
	ir     *ingestRound
	job    *agentCrawlJob
	legacy sweepSink
}

func (s shadowSink) write(ctx context.Context, lc *listingsCrawler, t CrawlTarget, source string, sweep suburbSweep, runTs time.Time) (int, error) {
	if lc.cfg.dryRun {
		return 0, nil
	}
	if !s.ir.shadowIsOn() {
		return s.legacy.write(ctx, lc, t, source, sweep, runTs)
	}
	dry, _, dryErr := s.ir.push(ctx, s.job, source, sweep, runTs, true, true)
	s.ir.noteShadowResult(dryErr)
	n, err := s.legacy.write(ctx, lc, t, source, sweep, runTs)
	s.ir.recordParity(s.job.ID, source, n, err, dry, dryErr)
	return n, err
}

// ingestRound is the per-process state of an ingest or shadow run: the client, the
// lease renewer, the round-level exit and the shadow circuit. It is carried on the
// context, so the existing functions keep their signatures and the db path never sees it.
type ingestRound struct {
	mode       crawlSinkMode
	client     *ingestClient
	brand      *brandbrainAgentClient
	events     *crawlEvents
	renewEvery time.Duration

	mu        sync.Mutex
	shadowOn  bool // false once shadow's probe failed or its circuit tripped
	shadowCnt int  // consecutive shadow dry-run failures
	exitCode  int
	exitCause error
	invalidN  int             // consecutive InvalidArgument answers (C4)
	mayApply  map[string]bool // jobs with a push that may have been stored (crawl_sink disposition)
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
	tokens := &workloadTokenSource{
		fetch: loopbackWorkloadToken(noRedirectHTTPClient(controlCallTimeout), acfg.controlURL, acfg.controlSecret, time.Now),
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
func (ir *ingestRound) fail(code int, cause error) {
	ir.mu.Lock()
	defer ir.mu.Unlock()
	if ir.exitCode != 0 {
		return
	}
	ir.exitCode = code
	ir.exitCause = cause
	log.Printf("[ingest] round ends with exit %d: %s", code, errCodeWord(cause))
}

// shadowIsOn reports whether shadow dry runs are still being sent.
func (ir *ingestRound) shadowIsOn() bool {
	ir.mu.Lock()
	defer ir.mu.Unlock()
	return ir.shadowOn
}

// disableShadow turns shadow's dry runs off for the rest of the process.
func (ir *ingestRound) disableShadow(reason string) {
	ir.mu.Lock()
	defer ir.mu.Unlock()
	if ir.shadowOn {
		ir.shadowOn = false
		log.Printf("[shadow] %s — dry-run pushes disabled; the legacy run continues", reason)
	}
}

// isShadowFailure reports whether a dry-run error says ingest is failing. A definitive
// per-sweep answer (a refusal, a missing dispatch, a validation error) is not one: the
// ingest answered, and the answer is parity, not an outage.
func isShadowFailure(err error) bool {
	if err == nil {
		return false
	}
	if code, ok := errCode(err); ok {
		switch code {
		case connectrpc.CodeFailedPrecondition, connectrpc.CodeAlreadyExists,
			connectrpc.CodeInvalidArgument, connectrpc.CodeResourceExhausted:
			return false
		}
	}
	return true
}

// noteShadowResult counts consecutive shadow failures. After shadowFailLimit in a row,
// shadow is off for the rest of the process: one log line, one event. A success resets
// the count.
func (ir *ingestRound) noteShadowResult(err error) {
	ir.mu.Lock()
	if !isShadowFailure(err) {
		ir.shadowCnt = 0
		ir.mu.Unlock()
		return
	}
	ir.shadowCnt++
	n := ir.shadowCnt
	trip := ir.shadowOn && n >= shadowFailLimit
	if trip {
		ir.shadowOn = false
	}
	ir.mu.Unlock()
	if trip {
		log.Printf("[shadow] circuit open: %d consecutive dry-run failures (%s); shadow is off for the rest of this process, the legacy write continues", n, errCodeWord(err))
		ir.events.shadowCircuit(n)
	}
}

// attemptKey names one attempt of one job. The flag is per attempt: a retry claims a
// new attempt with new idempotency keys, so an earlier attempt's stored push says
// nothing about it. Keying by job alone once made a rate-limited attempt 2 fail after
// attempt 1's 503.
func attemptKey(job *agentCrawlJob) string {
	return fmt.Sprintf("%s:%d", job.ID, job.Attempts)
}

// markMayApply records that an attempt had a push that may have been stored. Such an
// attempt is never deferred, because its key may already be in the receipts.
func (ir *ingestRound) markMayApply(attempt string) {
	ir.mu.Lock()
	defer ir.mu.Unlock()
	if ir.mayApply == nil {
		ir.mayApply = map[string]bool{}
	}
	ir.mayApply[attempt] = true
}

// jobMayApply reports whether an attempt had a push that may have been stored.
func (ir *ingestRound) jobMayApply(attempt string) bool {
	if ir == nil {
		return false
	}
	ir.mu.Lock()
	defer ir.mu.Unlock()
	return ir.mayApply[attempt]
}

// probe runs ProbeAuth once per process. For ingest a failure ends the round with its
// exit code, and a contract mismatch is 15. For shadow it only disables the dry runs.
func (ir *ingestRound) probe(ctx context.Context) int {
	resp, err := ir.client.probe(ctx)
	if err == nil && resp.GetMinContractVersion() > housingingest.ContractVersion {
		err = fmt.Errorf("contract_too_old: server requires contract %d, this collector sends %d",
			resp.GetMinContractVersion(), housingingest.ContractVersion)
		if ir.mode == crawlSinkShadow {
			ir.disableShadow("ProbeAuth: contract too old")
			return 0
		}
		ir.fail(exitIngestContract, err)
		return exitIngestContract
	}
	if err != nil {
		if ir.mode == crawlSinkShadow {
			ir.disableShadow("ProbeAuth failed (" + errCodeWord(err) + ")")
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

// push builds and sends one sweep, and returns the number of listings sanitising
// dropped. dry sets dry_run on the request. once selects the shadow form: one attempt,
// bounded by shadowDryRunTimeout, no retry, no lease renewal. The ingest form retries,
// records its outcome as events, and ends the round on a round-level answer.
func (ir *ingestRound) push(ctx context.Context, job *agentCrawlJob, source string, sweep suburbSweep, runTs time.Time, dry, once bool) (*pb.PushSweepResponse, int, error) {
	req, skipped := buildPushRequest(job, source, sweep, runTs, collectorRevisionForPush(), dry)
	if once {
		dctx, cancel := context.WithTimeout(ctx, shadowDryRunTimeout)
		defer cancel()
		resp, err := ir.client.pushSweepOnce(dctx, req)
		return resp, skipped, err
	}
	resp, mayApply, err := ir.client.pushSweep(ctx, req)
	if mayApply && !dry {
		ir.markMayApply(attemptKey(job))
	}
	if err != nil {
		ir.noteIngestFailure(job.ID, source, err)
		return nil, skipped, err
	}
	ir.noteIngestOK(job.ID, source, resp)
	return resp, skipped, nil
}

// noteIngestFailure records one failed ingest push: the round-level exit if the answer
// is one, the ingest_error event, and the consecutive-InvalidArgument count (C4). Three
// InvalidArgument answers in a row mean the collector and the server disagree about the
// schema, so the round ends with 15 and the drift alarm fires.
func (ir *ingestRound) noteIngestFailure(jobID, source string, err error) {
	ir.events.ingestError(jobID, source, errCodeWord(err))
	if code := ingestRoundExit(err); code != 0 {
		ir.fail(code, err)
	}
	if code, ok := errCode(err); ok && code == connectrpc.CodeInvalidArgument {
		ir.mu.Lock()
		ir.invalidN++
		n := ir.invalidN
		ir.mu.Unlock()
		if n >= 3 {
			ir.fail(exitIngestContract, errors.New("schema drift: 3 consecutive sweeps rejected as invalid"))
		}
		return
	}
	ir.mu.Lock()
	ir.invalidN = 0
	ir.mu.Unlock()
}

// noteIngestOK records one accepted push: the ingest_ok event, and a reset of the
// consecutive-InvalidArgument count.
func (ir *ingestRound) noteIngestOK(jobID, source string, resp *pb.PushSweepResponse) {
	ir.mu.Lock()
	ir.invalidN = 0
	ir.mu.Unlock()
	ir.events.ingestOK(jobID, source, appliedName(resp.GetAppliedStatus()), resp.GetReplayed())
}

// absorb folds one applied push into the job's stats. It returns the events the sweep
// produced, or a pushFailure when the server held the sweep back.
func (ir *ingestRound) absorb(lc *listingsCrawler, sweep suburbSweep, resp *pb.PushSweepResponse) (int, error) {
	lc.stats.pushedUpserted += int(resp.GetListingsUpserted())
	lc.stats.pushedDelisted += int(resp.GetDelisted())
	lc.stats.skippedRows += int(resp.GetSkippedRows())
	if resp.GetReplayed() {
		log.Printf("[ingest] %s: the server replayed a stored answer (already applied)", appliedName(resp.GetAppliedStatus()))
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
		log.Printf("[ingest] ReportCycle failed (best-effort): %s", errCodeWord(err))
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

// buildPushRequest is the collector's sweep turned into a PushSweepRequest, and the
// number of listings sanitising dropped. The target is the job's own suburb, state and
// postcode, as BrandBrain carries them. Everything is clamped to the server's caps
// before it is sent: listings past the cap, and pages past the cap, downgrade a
// COMPLETE sweep to PARTIAL, and so does any dropped listing, because an absent listing
// would be read as delisted. A blocked sweep goes with no rows, and a dry run is flagged
// so the server rolls it back.
func buildPushRequest(job *agentCrawlJob, source string, sweep suburbSweep, runTs time.Time, revision string, dry bool) (*pb.PushSweepRequest, int) {
	status := housingingest.StatusEnum(sweep.status.lib())
	pages := sweep.pages
	downgrade := false
	if pages > housingingest.MaxPagesPerSweep {
		pages = housingingest.MaxPagesPerSweep
		downgrade = true
	}
	req := &pb.PushSweepRequest{
		IdempotencyKey:    fmt.Sprintf("%s:%d:%s", job.ID, job.Attempts, source),
		JobId:             job.ID,
		Attempt:           int32(job.Attempts),
		Target:            &pb.Target{Suburb: job.Suburb, State: job.State, Postcode: job.Postcode},
		Source:            housingingest.SourceEnum(source),
		Pages:             int32(pages),
		ObservedAt:        timestamppb.New(runTs),
		CollectorRevision: revision,
		ContractVersion:   housingingest.ContractVersion,
		DryRun:            dry,
	}
	skipped := 0
	if sweep.meta.OK {
		req.PageMeta = &pb.PageMeta{
			TotalResults:    int32(sweep.meta.TotalResults),
			TotalPages:      int32(sweep.meta.TotalPages),
			PageSize:        int32(sweep.meta.PageSize),
			OnTargetResults: int32(sweep.meta.OnTargetResults),
		}
	}
	if sweep.status != sweepBlocked {
		kept, dropped, overflow := housingingest.SanitizeListings(housingingest.FromRawListings(sweep.listings), source)
		req.Listings = kept
		skipped = dropped
		if overflow || dropped > 0 {
			downgrade = true
		}
	}
	if downgrade && status == pb.SweepStatus_SWEEP_STATUS_COMPLETE {
		status = pb.SweepStatus_SWEEP_STATUS_PARTIAL
	}
	req.Status = status
	return req, skipped
}

// collectorRevisionForPush is the revision this binary reports to the ingest.
func collectorRevisionForPush() string {
	info, _ := debug.ReadBuildInfo()
	return resolveCollectorVersion(collectorRevision, info, runtime.Version()).Revision
}

// dispCategory is how a push answer decides a job. The categories are what the rig
// can know about the server's storage:
//
//	dispSucceed   the data already landed (dispatch_applied)
//	dispPermanent the server decided, and retrying cannot change it: no_retry
//	dispNotStored the server refused before storing, or no answer reached us at all
//	              for a round-level reason; the job is deferred only if nothing from
//	              the job may have been stored
//	dispUnknown   the outcome is unknown: retry with a new attempt if anything was
//	              sent, else defer
type dispCategory int

const (
	dispSucceed dispCategory = iota
	dispPermanent
	dispNotStored
	dispUnknown
)

// jobDispositionRule is one row of the per-job table. The reason matches the server's
// fixed message for a FailedPrecondition, ResourceExhausted or other code. A reason
// ending in "*" is a prefix match. An empty reason matches any message for that code.
type jobDispositionRule struct {
	code   connectrpc.Code
	reason string
	cat    dispCategory
	msg    string
	detail string
}

// jobDispositionTable is the design's per-job mapping ("Outcome mapping") and the
// dispatch answers push.go defines. It is read top to bottom and the first match wins.
var jobDispositionTable = []jobDispositionRule{
	{connectrpc.CodeFailedPrecondition, "dispatch_applied", dispSucceed, "", "applied by an earlier attempt"},
	{connectrpc.CodeFailedPrecondition, "not_dispatched", dispPermanent, "ingest: job not dispatched by the server", ""},
	{connectrpc.CodeFailedPrecondition, "dispatch_expired", dispPermanent, "ingest: dispatch expired before an attempt applied", ""},
	{connectrpc.CodeFailedPrecondition, "target_mismatch", dispPermanent, "ingest: target does not match the dispatch", ""},
	{connectrpc.CodeFailedPrecondition, "contract_too_old*", dispNotStored, "ingest: collector contract too old", ""},
	{connectrpc.CodeAlreadyExists, "", dispPermanent, "ingest: idempotency key reused with a different body", ""},
	{connectrpc.CodeInvalidArgument, "", dispPermanent, "ingest: sweep rejected", ""},
	// The per-rig rate limit is an answer that stores nothing, so the job goes back on
	// the queue. Any other ResourceExhausted is the server's body-size limit, which is
	// permanent for the same sweep.
	{connectrpc.CodeResourceExhausted, rateLimitedMessage, dispNotStored, "ingest: rate limited", ""},
	{connectrpc.CodeResourceExhausted, "", dispPermanent, "ingest: sweep too large for the server's request limit", ""},
	{connectrpc.CodeUnauthenticated, "", dispNotStored, "ingest: auth refused", ""},
	{connectrpc.CodePermissionDenied, "", dispNotStored, "ingest: auth refused", ""},
	{connectrpc.CodeUnimplemented, "", dispNotStored, "ingest: endpoint not implemented", ""},
	{connectrpc.CodeNotFound, "", dispNotStored, "ingest: endpoint not found", ""},
	{connectrpc.CodeCanceled, "", dispUnknown, "ingest push cancelled before it was answered", ""},
	{connectrpc.CodeUnavailable, "", dispUnknown, "ingest unavailable", ""},
	{connectrpc.CodeDeadlineExceeded, "", dispUnknown, "ingest call timed out", ""},
	{connectrpc.CodeInternal, "", dispUnknown, "ingest internal error", ""},
}

// pushDisposition is what a job reports to BrandBrain for one push answer.
type pushDisposition struct {
	status     string // succeeded | failed | deferred
	errMsg     string
	detail     string // counts-only text for the job summary
	retryAfter time.Duration
	noRetry    bool
}

// ruleMatches reports whether a table row matches a Connect code and message.
func ruleMatches(r jobDispositionRule, code connectrpc.Code, msg string) bool {
	if r.code != code {
		return false
	}
	switch {
	case r.reason == "":
		return true
	case strings.HasSuffix(r.reason, "*"):
		return strings.HasPrefix(msg, strings.TrimSuffix(r.reason, "*"))
	default:
		return r.reason == msg
	}
}

// jobDisposition is the per-job answer for one push error, given whether any push of
// the job may have been stored (mayApply). A deferral is only safe when nothing of the
// job's current attempt was stored: the queue refunds the attempt, so the next claim
// reuses its idempotency keys, and a stored key with a different body answers
// AlreadyExists. Otherwise the job is submitted failed (retryable), and the next claim
// gets a new attempt and new keys. A permanent answer is failed with no_retry.
func jobDisposition(err error, mayApply bool) pushDisposition {
	if err == nil {
		return pushDisposition{status: "succeeded"}
	}
	if errors.Is(err, errQuarantined) {
		return pushDisposition{status: "failed", errMsg: "ingest: sweep quarantined (held for review, not retried)", noRetry: true}
	}
	var (
		cat  = dispUnknown
		msg  = "ingest push failed"
		detl string
	)
	var ex *exhaustedError
	if errors.As(err, &ex) {
		err = ex.err
	}
	var te *tokenError
	switch {
	case errors.Is(err, errRoundEnded):
		cat, msg = dispNotStored, "ingest round ended before this sweep was pushed"
	case errors.As(err, &te):
		cat, msg = dispNotStored, "workload token unavailable, sweep not sent"
	default:
		if code, ok := errCode(err); ok {
			found := false
			for _, r := range jobDispositionTable {
				if ruleMatches(r, code, connectMessage(err)) {
					cat, msg, detl, found = r.cat, r.msg, r.detail, true
					break
				}
			}
			if !found {
				msg = "ingest rejected: " + code.String()
			}
		} else if errors.Is(err, context.Canceled) {
			msg = "ingest push cancelled before it was answered"
		} else {
			msg = "ingest unreachable"
		}
	}
	switch cat {
	case dispSucceed:
		return pushDisposition{status: "succeeded", detail: detl}
	case dispPermanent:
		return pushDisposition{status: "failed", errMsg: msg, noRetry: true}
	default:
		if mayApply {
			return pushDisposition{status: "failed", errMsg: "retrying with a new attempt: " + msg}
		}
		return pushDisposition{status: "deferred", errMsg: "deferred, nothing stored for this attempt: " + msg, retryAfter: ingestDeferRetryAfter}
	}
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

// appliedName is the lowercase name of an applied sweep status, for events.
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
