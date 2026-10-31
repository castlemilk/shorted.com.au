package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/brandbrain"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
)

// --- fixtures -------------------------------------------------------------------------

// The fleet token, which must never reach an output. The fake never returns it, so a test
// that finds it has found a leak in the tools.
const fleetFixtureToken = "fleet-ops-SECRET-4b1d"

var fixedNow = time.Date(2026, 10, 31, 10, 0, 0, 0, time.UTC)

// fakeFleet is the BrandBrain fleet surface. It records every write, and a log request's
// command reads as pending for pendingReads polls before it answers.
type fakeFleet struct {
	mu        sync.Mutex
	rigs      []brandbrain.Rig
	details   map[string]brandbrain.RigDetail
	detailErr error
	jobs      []brandbrain.CrawlJob
	summary   []brandbrain.StatusSourceCount
	listErr   error
	// Log requests.
	logErr       error
	logText      string
	logStatus    string
	pendingReads int
	logCmdID     string
	logRequests  []string
	reads        int
	// Drains.
	drainErr  error
	drainKeys []string
	nextCmd   int
}

func (f *fakeFleet) ListRigs(context.Context) ([]brandbrain.Rig, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.rigs, nil
}

func (f *fakeFleet) GetRig(_ context.Context, id string) (*brandbrain.RigDetail, error) {
	if f.detailErr != nil {
		return nil, f.detailErr
	}
	d, ok := f.details[id]
	if !ok {
		return nil, brandbrain.ErrRigNotFound
	}
	return &d, nil
}

func (f *fakeFleet) ListRigCommands(_ context.Context, _ string) ([]brandbrain.Command, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reads++
	if f.logCmdID == "" {
		return nil, nil
	}
	if f.pendingReads > 0 {
		f.pendingReads--
		return []brandbrain.Command{{ID: f.logCmdID, Kind: brandbrain.CommandCollectRuntimeLogs, Status: "running"}}, nil
	}
	status := f.logStatus
	if status == "" {
		status = "succeeded"
	}
	return []brandbrain.Command{{ID: f.logCmdID, Kind: brandbrain.CommandCollectRuntimeLogs, Status: status,
		ResultData: &brandbrain.ResultData{RuntimeLogs: &brandbrain.RuntimeLogs{Text: f.logText}}}}, nil
}

func (f *fakeFleet) ListCrawlJobs(_ context.Context, q brandbrain.CrawlJobQuery) (*brandbrain.CrawlJobsPage, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	page := &brandbrain.CrawlJobsPage{Jobs: []brandbrain.CrawlJob{}, Summary: brandbrain.CrawlJobSummary{ByStatusSource: f.summary}}
	for _, j := range f.jobs {
		if q.ID != "" && j.ID != q.ID || q.Status != "" && j.Status != q.Status ||
			q.Source != "" && j.Source != q.Source || q.AssignedAgent != "" && j.AssignedAgent != q.AssignedAgent {
			continue
		}
		page.Jobs = append(page.Jobs, j)
	}
	if q.Limit > 0 && len(page.Jobs) > q.Limit {
		page.Jobs = page.Jobs[:q.Limit]
	}
	return page, nil
}

func (f *fakeFleet) RequestRuntimeLogs(_ context.Context, rigID, source, key string) (*brandbrain.Command, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.logErr != nil {
		return nil, f.logErr
	}
	f.logRequests = append(f.logRequests, rigID+"/"+source+"/"+key)
	f.nextCmd++
	f.logCmdID = fmt.Sprintf("cmd-%d", f.nextCmd)
	return &brandbrain.Command{ID: f.logCmdID, Status: "queued"}, nil
}

func (f *fakeFleet) RunDrain(_ context.Context, rigID, key string) (*brandbrain.Command, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.drainErr != nil {
		return nil, f.drainErr
	}
	f.drainKeys = append(f.drainKeys, rigID+"|"+key)
	f.nextCmd++
	return &brandbrain.Command{ID: fmt.Sprintf("drain-%d", f.nextCmd), Status: "queued"}, nil
}

// fakeLedger is the read-only ledger. Each map is a fixture; nothing is written.
type fakeLedger struct {
	open, soon int64
	openErr    error
	groups     []CrawlReceiptGroup
	reasons    []CrawlReasonCount
	watermark  *time.Time
	dispatch   []CrawlDispatch
	receipts   map[string][]CrawlReceipt
	quarantine map[string][]CrawlQuarantine
	runErr     error
}

func (l *fakeLedger) DispatchOpen(context.Context) (int64, int64, error) {
	return l.open, l.soon, l.openErr
}

func (l *fakeLedger) ReceiptGroups(_ context.Context, _ time.Time, _ string, statuses []string) ([]CrawlReceiptGroup, error) {
	var out []CrawlReceiptGroup
	for _, g := range l.groups {
		if len(statuses) > 0 && !hasString(statuses, g.AppliedStatus) {
			continue
		}
		out = append(out, g)
	}
	return out, nil
}

func (l *fakeLedger) QuarantineReasons(context.Context, time.Time, string) ([]CrawlReasonCount, error) {
	return l.reasons, nil
}

func (l *fakeLedger) FinalizeWatermark(context.Context) (time.Time, time.Time, bool, error) {
	if l.watermark == nil {
		return time.Time{}, time.Time{}, false, nil
	}
	return *l.watermark, *l.watermark, true, nil
}

func (l *fakeLedger) DispatchForRun(_ context.Context, run string) ([]CrawlDispatch, error) {
	if l.runErr != nil {
		return nil, l.runErr
	}
	var out []CrawlDispatch
	for _, d := range l.dispatch {
		if d.RunID == run {
			out = append(out, d)
		}
	}
	return out, nil
}

func (l *fakeLedger) DispatchForJob(_ context.Context, job string) (*CrawlDispatch, error) {
	for i := range l.dispatch {
		if l.dispatch[i].JobID == job {
			return &l.dispatch[i], nil
		}
	}
	return nil, nil
}

func (l *fakeLedger) ReceiptsForJob(_ context.Context, job string) ([]CrawlReceipt, error) {
	return l.receipts[job], nil
}

func (l *fakeLedger) QuarantineForJob(_ context.Context, job string) ([]CrawlQuarantine, error) {
	return l.quarantine[job], nil
}

func hasString(xs []string, x string) bool {
	for _, s := range xs {
		if s == x {
			return true
		}
	}
	return false
}

// fakeCrawlOpsOp is the debugging and smoke half of the operator. It is embedded in
// fakePublisher; its zero value is "not wired", which the existing tests need.
type fakeCrawlOpsOp struct {
	fleet     CrawlFleet
	ledger    CrawlOpsStore
	schedules []CrawlSchedule
	schedErr  error
	// Smoke.
	runErr    error
	runCalls  int
	runReq    jobmonitor.CrawlSmokeRequest
	execs     []*jobmonitor.ExecutionStatus
	execCalls int
	execErr   error
}

func (f *fakeCrawlOpsOp) CrawlFleet(context.Context, string) CrawlFleet {
	if f.fleet == nil {
		return nil
	}
	return f.fleet
}

func (f *fakeCrawlOpsOp) CrawlOps() CrawlOpsStore {
	if f.ledger == nil {
		return nil
	}
	return f.ledger
}

func (f *fakeCrawlOpsOp) CrawlSchedules(context.Context) ([]CrawlSchedule, error) {
	return f.schedules, f.schedErr
}

func (f *fakeCrawlOpsOp) RunCrawlSmoke(_ context.Context, req jobmonitor.CrawlSmokeRequest) (*jobmonitor.CrawlSmokeRun, error) {
	f.runCalls++
	f.runReq = req
	if f.runErr != nil {
		return nil, f.runErr
	}
	return &jobmonitor.CrawlSmokeRun{Job: jobmonitor.CrawlCollectorJobName, ExecutionName: "house-price-collector-x1", RunID: req.RunID, Suburb: req.Suburb}, nil
}

func (f *fakeCrawlOpsOp) CrawlSmokeResult(context.Context, string) (*jobmonitor.ExecutionStatus, error) {
	f.execCalls++
	if f.execErr != nil {
		return nil, f.execErr
	}
	if len(f.execs) == 0 {
		return &jobmonitor.ExecutionStatus{ExecutionName: "house-price-collector-x1", Status: "running"}, nil
	}
	st := f.execs[0]
	if len(f.execs) > 1 {
		f.execs = f.execs[1:]
	}
	return st, nil
}

// shortPolls makes every wait in the crawl tools return within a few milliseconds.
func shortPolls(t *testing.T) {
	t.Helper()
	logsWait, logsPoll, smokeW, smokePoll := crawlLogsWait, crawlPollEvery, smokeWait, smokePollEvery
	crawlLogsWait, crawlPollEvery, smokeWait, smokePollEvery = 200*time.Millisecond, time.Millisecond, 50*time.Millisecond, time.Millisecond
	t.Cleanup(func() {
		crawlLogsWait, crawlPollEvery, smokeWait, smokePollEvery = logsWait, logsPoll, smokeW, smokePoll
	})
}

// opsStack composes the admin stack with the given fleet and ledger, under a token holding
// every crawl scope.
//
// The publisher holds its own copy of the operator, so the counters a test reads are the
// returned publisher's, never the caller's value.
func opsStack(t *testing.T, op *fakeCrawlOpsOp, scopes ...string) (*httptest.Server, *fakePublisher) {
	t.Helper()
	claims := adminClaims()
	if scopes != nil {
		claims.Scopes = scopes
	}
	pub := &fakePublisher{fakeCrawlOpsOp: *op}
	return adminStack(t, stubClaims{claims: claims}, onlyAdmin("uid-admin"), pub), pub
}

// --- scope and surface ----------------------------------------------------------------

func TestCrawlOpsToolsRequireTheirScopeAndNameIt(t *testing.T) {
	cases := []struct{ tool, args, scope string }{
		{CrawlStatusTool, `{}`, ScopeCrawlRead},
		{CrawlFailuresTool, `{}`, ScopeCrawlRead},
		{CrawlJobTool, `{"job_id":"job-1"}`, ScopeCrawlRead},
		{CrawlLogsTool, `{"rig_id":"rig-1","source":"housing"}`, ScopeCrawlRead},
		{CrawlSmokeTool, `{"rig_id":"rig-1","confirm":true}`, ScopeCrawlOperate},
		{CrawlSmokeStatusTool, `{"smoke_id":"smoke-20261031T100000Z-0a1b2c3d"}`, ScopeCrawlOperate},
	}
	for _, c := range cases {
		t.Run(c.tool, func(t *testing.T) {
			fake := &fakeCrawlOpsOp{fleet: &fakeFleet{}, ledger: &fakeLedger{}}
			// A token with only news:publish: the tool must refuse by name and touch nothing.
			srv, pub := opsStack(t, fake, ScopeNewsPublish)
			res := parseToolResult(t, crawlCall(t, srv, "t", c.tool, c.args))
			assert.True(t, res.IsError, "%s was not refused", c.tool)
			assert.Contains(t, res.Text, c.scope)
			assert.Equal(t, 0, pub.runCalls)
		})
	}
}

// The read scope is not the operate scope: a read-only connection cannot run a smoke.
func TestCrawlReadDoesNotGrantSmoke(t *testing.T) {
	fake := &fakeCrawlOpsOp{fleet: &fakeFleet{}, ledger: &fakeLedger{}}
	srv, pub := opsStack(t, fake, ScopeCrawlRead)
	res := parseToolResult(t, crawlCall(t, srv, "t", CrawlSmokeTool, `{"rig_id":"rig-1","confirm":true}`))
	assert.True(t, res.IsError)
	assert.Contains(t, res.Text, ScopeCrawlOperate)
	assert.Equal(t, 0, pub.runCalls)
	assert.Empty(t, fake.fleet.(*fakeFleet).drainKeys)
}

func TestCrawlOpsToolsAreAdminOnlyAndOnlySmokeIsAWrite(t *testing.T) {
	admin := toolNames(t, NewAdminServer(&fakePublisher{}))
	for _, name := range []string{CrawlStatusTool, CrawlFailuresTool, CrawlJobTool, CrawlLogsTool, CrawlSmokeTool, CrawlSmokeStatusTool} {
		require.NotNil(t, admin[name], "%s is not on the admin server", name)
	}
	assert.True(t, admin[CrawlStatusTool].Annotations.ReadOnlyHint)
	assert.True(t, admin[CrawlFailuresTool].Annotations.ReadOnlyHint)
	assert.False(t, admin[CrawlJobTool].Annotations.ReadOnlyHint, "with_logs sends the rig a command, so the job tool is not read-only")
	assert.True(t, admin[CrawlSmokeStatusTool].Annotations.ReadOnlyHint)
	assert.False(t, admin[CrawlSmokeTool].Annotations.ReadOnlyHint, "the smoke tool starts a run and must not claim to be read-only")
	assert.False(t, admin[CrawlLogsTool].Annotations.ReadOnlyHint, "a log request is a command to a rig")
	for _, s := range []string{ScopeCrawlRead, ScopeCrawlOperate} {
		assert.Contains(t, AdminScopes, s)
		assert.NotContains(t, Scopes, s, "the admin scope leaked into the public vocabulary")
	}
}

// --- blocked is judged against the server's clock ----------------------------------

func TestPortalBlockedIsComputedAgainstServerTime(t *testing.T) {
	future := fixedNow.Add(10 * time.Minute)
	past := fixedNow.Add(-10 * time.Minute)
	cases := []struct {
		name    string
		portal  brandbrain.Portal
		now     *time.Time
		status  string
		blocked *bool
	}{
		{"open until later is blocked", brandbrain.Portal{State: "open", OpenUntil: &future}, &fixedNow, "blocked", ptrBool(true)},
		{"open with a past deadline is cooldown over", brandbrain.Portal{State: "open", OpenUntil: &past}, &fixedNow, "cooldown_over_probing_next", ptrBool(false)},
		{"closed is not blocked", brandbrain.Portal{State: "closed"}, &fixedNow, "closed", ptrBool(false)},
		{"open without a deadline is not judged blocked", brandbrain.Portal{State: "open"}, &fixedNow, "open_without_deadline", ptrBool(false)},
		{"no clock leaves blocked unknown", brandbrain.Portal{State: "open", OpenUntil: &future}, nil, "unknown_clock", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			status, blocked := portalStatus(c.portal, c.now)
			assert.Equal(t, c.status, status)
			assert.Equal(t, c.blocked, blocked)
		})
	}
}

func ptrBool(b bool) *bool { return &b }

// The clock that counts is the server's, not the admin's: a breaker that the server says
// is still open is blocked, even if this process's clock disagrees.
func TestStatusJudgesBlockedByTheServersClock(t *testing.T) {
	serverNow := fixedNow
	openUntil := serverNow.Add(time.Minute)
	fleet := &fakeFleet{
		rigs: []brandbrain.Rig{{ID: "rig-1", Version: "1.4.0"}},
		details: map[string]brandbrain.RigDetail{"rig-1": {
			Rig: brandbrain.Rig{ID: "rig-1", Resources: brandbrain.RigResources{HousingCrawl: brandbrain.HousingCrawl{
				State: "running", Portals: []brandbrain.Portal{{Source: "rea", State: "open", OpenUntil: &openUntil, ConsecutiveBlocked: 3}}}}},
			ServerTime: &serverNow,
		}},
	}
	out := crawlStatus(context.Background(), &fakeCrawlOpsOp{fleet: fleet}, "uid", fixedNow.Add(time.Hour))
	require.Len(t, out.Rigs, 1)
	portal := out.Rigs[0].Portals[0]
	assert.Equal(t, "blocked", portal.Status)
	require.NotNil(t, portal.Blocked)
	assert.True(t, *portal.Blocked)
	assert.Equal(t, serverNow.Format(time.RFC3339), out.Rigs[0].ServerTime)
	assert.NotEmpty(t, out.Notes, "a blocked portal should be named in the notes")
}

// --- failure classification ---------------------------------------------------------

func TestFailureClassificationNormalisesMessages(t *testing.T) {
	cases := []struct {
		msg     string
		summary string
		want    string
	}{
		{"not_dispatched: no crawl_dispatch row", "", FailureNotDispatched},
		{"dispatch_expired at 2026-10-30", "", FailureDispatchExpired},
		{"target_mismatch: suburb differs", "", FailureTargetMismatch},
		{"portal circuit open for rea", "", FailureCircuitOpen},
		{"", `{"outcome":"blocked by portal"}`, FailureBlocked},
		{"chrome exited with status 1", "", FailureChrome},
		{"context deadline exceeded", "", FailureTimeout},
		{"ingest unavailable: 503 from upstream", "", FailureIngestUnavailable},
		{"something nobody has seen before", "", FailureOther},
		{"", "", FailureOther},
	}
	for _, c := range cases {
		var summary json.RawMessage
		if c.summary != "" {
			summary = json.RawMessage(c.summary)
		}
		assert.Equal(t, c.want, classifyCrawlFailure(c.msg, summary), "message %q", c.msg)
	}
}

// A count named "blocked" is a count, not a block: only string values are read.
func TestFailureClassificationIgnoresKeysAndNumbers(t *testing.T) {
	summary := json.RawMessage(`{"counts":{"blocked":4,"expired":0,"chrome":0},"status":"partial"}`)
	assert.Equal(t, FailureOther, classifyCrawlFailure("", summary))
}

// --- job debugging ------------------------------------------------------------------

func TestJobDebugAssemblesTheTrailAndRedacts(t *testing.T) {
	deferredAt := fixedNow.Add(-time.Hour)
	fleet := &fakeFleet{jobs: []brandbrain.CrawlJob{{
		ID: "job-42", Kind: "housing", Suburb: "Bondi", Postcode: "2026", Source: "rea", Status: "failed",
		AssignedAgent: "rig-1", Attempts: 2, MaxAttempts: 3,
		ErrorMessage:  "blocked at https://www.realestate.com.au/buy/12-smith-street-bondi and $1,250,000 listed",
		ResultSummary: json.RawMessage(`{"listings":4,"note":"12 Smith Street, Bondi","counts":{"blocked":4}}`),
		CreatedAt:     &deferredAt,
	}}}
	ledger := &fakeLedger{
		dispatch:   []CrawlDispatch{{JobID: "job-42", RunID: "smoke-20261031T093000Z-0a1b2c3d", Suburb: "Bondi", State: "NSW", Postcode: "2026", Source: "rea", CreatedAt: deferredAt, ExpiresAt: fixedNow.Add(time.Hour)}},
		receipts:   map[string][]CrawlReceipt{"job-42": {{Key: "job-42:1:rea", AppliedStatus: "SWEEP_STATUS_BLOCKED", ListingsUpserted: 0, CreatedAt: deferredAt}}},
		quarantine: map[string][]CrawlQuarantine{"job-42": {{Reason: "mass_delist", CreatedAt: deferredAt}}},
	}
	out, err := crawlJob(context.Background(), &fakeCrawlOpsOp{fleet: fleet, ledger: ledger}, "uid", CrawlJobInput{JobID: "job-42"})
	require.NoError(t, err)
	assert.Equal(t, FailureBlocked, out.FailureClass)
	require.NotNil(t, out.Dispatch)
	assert.Equal(t, "smoke-20261031T093000Z-0a1b2c3d", out.Dispatch.RunID)
	require.Len(t, out.Receipts, 1)
	assert.Equal(t, "blocked", out.Receipts[0].AppliedStatus)
	require.Len(t, out.Quarantine, 1)
	assert.Equal(t, "mass_delist", out.Quarantine[0].Reason)

	raw, _ := json.Marshal(out)
	assert.NotContains(t, string(raw), "realestate", "a URL reached the output")
	assert.NotContains(t, string(raw), "Smith Street", "an address reached the output")
	assert.NotContains(t, string(raw), "1,250,000", "a price reached the output")
	assert.NotContains(t, string(raw), fleetFixtureToken)
	assert.Contains(t, out.Job.ErrorMessage, "[url]")
	assert.Equal(t, float64(4), out.Job.ResultSummary["listings"], "numeric summary values are kept")
	assert.NotContains(t, out.Job.ResultSummary, "note", "string summary values are not kept")
}

func TestJobDebugRefusesUnknownJobsAndBadIDs(t *testing.T) {
	fake := &fakeCrawlOpsOp{fleet: &fakeFleet{}, ledger: &fakeLedger{}}
	_, err := crawlJob(context.Background(), fake, "uid", CrawlJobInput{JobID: "../x"})
	assert.ErrorIs(t, err, errCrawlJobID)
	_, err = crawlJob(context.Background(), fake, "uid", CrawlJobInput{JobID: "job-404"})
	assert.ErrorIs(t, err, errCrawlJobNotFound)
}

func TestJobLogsAreExcerptedAroundTheJobWithContext(t *testing.T) {
	shortPolls(t)
	logText := strings.Join([]string{
		"line 1", "line 2", "line 3",
		"starting job job-42 for Bondi",
		"line 5", "line 6", "line 7", "line 8",
		"line 9", "line 10",
		"unrelated job-7 noise",
	}, "\n")
	fleet := &fakeFleet{logText: logText, jobs: []brandbrain.CrawlJob{{ID: "job-42", AssignedAgent: "rig-1", Status: "failed"}}}
	ledger := &fakeLedger{}
	out, err := crawlJob(context.Background(), &fakeCrawlOpsOp{fleet: fleet, ledger: ledger}, "uid", CrawlJobInput{JobID: "job-42", WithLogs: true})
	require.NoError(t, err)
	require.NotNil(t, out.Logs)
	assert.Equal(t, "rig-1", out.Logs.RigID)
	assert.False(t, out.Logs.Pending)
	// Three lines of context either side of the match (index 3): lines 1 to 7 and nothing more.
	joined := strings.Join(out.Logs.Lines, "\n")
	assert.Contains(t, joined, "> starting job job-42 for Bondi")
	assert.Contains(t, joined, "  line 1")
	assert.Contains(t, joined, "  line 7")
	assert.NotContains(t, joined, "line 8", "context must stop at three lines")
	assert.NotContains(t, joined, "unrelated")
	assert.Len(t, out.Logs.Lines, 7)
}

func TestExcerptAroundDoesNotRepeatOverlappingContext(t *testing.T) {
	text := "a\nmatch-1\nb\nmatch-2\nc"
	lines := excerptAround(text, "match")
	assert.Equal(t, []string{"  a", "> match-1", "  b", "> match-2", "  c"}, lines)
}

// --- logs ---------------------------------------------------------------------------

func TestLogsWaitForTheRigAndGrepAndCapTheTail(t *testing.T) {
	shortPolls(t)
	var lines []string
	for i := 0; i < 30; i++ {
		lines = append(lines, fmt.Sprintf("tick %d", i))
	}
	lines = append(lines, "ERROR chrome crashed", "listing at 1 Main Street, Bondi")
	fleet := &fakeFleet{logText: strings.Join(lines, "\n"), pendingReads: 2}
	out, err := crawlLogs(context.Background(), &fakeCrawlOpsOp{fleet: fleet}, "uid", CrawlLogsInput{RigID: "rig-1", Source: "housing", Grep: "tick", MaxLines: 5})
	require.NoError(t, err)
	assert.False(t, out.Pending)
	assert.Equal(t, 30, out.MatchedLines)
	assert.True(t, out.Truncated)
	assert.Equal(t, []string{"tick 25", "tick 26", "tick 27", "tick 28", "tick 29"}, out.Lines)
	require.Len(t, fleet.logRequests, 1, "one command per call")
	assert.True(t, strings.HasPrefix(fleet.logRequests[0], "rig-1/housing/"))
	assert.GreaterOrEqual(t, fleet.reads, 3, "the tool must poll until the rig answers")
}

func TestLogsRedactAndAreCaseInsensitive(t *testing.T) {
	shortPolls(t)
	fleet := &fakeFleet{logText: "CHROME failed for https://example.com/x\nprice $850k at 12 Smith Street\nok"}
	out, err := crawlLogs(context.Background(), &fakeCrawlOpsOp{fleet: fleet}, "uid", CrawlLogsInput{RigID: "rig-1", Source: "runtime", Grep: "chrome"})
	require.NoError(t, err)
	require.Len(t, out.Lines, 1)
	assert.Equal(t, "CHROME failed for [url]", out.Lines[0])
	out, err = crawlLogs(context.Background(), &fakeCrawlOpsOp{fleet: fleet}, "uid", CrawlLogsInput{RigID: "rig-1", Source: "runtime"})
	require.NoError(t, err)
	joined := strings.Join(out.Lines, "\n")
	assert.NotContains(t, joined, "850k")
	assert.NotContains(t, joined, "Smith Street")
}

func TestLogsRefuseAnotherSourceBeforeAnythingIsSent(t *testing.T) {
	fleet := &fakeFleet{}
	_, err := crawlLogs(context.Background(), &fakeCrawlOpsOp{fleet: fleet}, "uid", CrawlLogsInput{RigID: "rig-1", Source: "all"})
	assert.ErrorIs(t, err, errCrawlSourceLogs)
	assert.Empty(t, fleet.logRequests)
}

func TestLogRequestThatBrandBrainCannotTakeIsRefused(t *testing.T) {
	shortPolls(t)
	fleet := &fakeFleet{logErr: errors.New("boom")}
	_, err := crawlLogs(context.Background(), &fakeCrawlOpsOp{fleet: fleet}, "uid", CrawlLogsInput{RigID: "rig-1", Source: "housing"})
	assert.ErrorIs(t, err, errCrawlLogRequest)
}

// --- parse ----------------------------------------------------------------------------

func TestSinceIsHoursOrDaysUpToSevenDays(t *testing.T) {
	d, text, err := parseCrawlSince("")
	require.NoError(t, err)
	assert.Equal(t, 24*time.Hour, d)
	assert.Equal(t, "24h", text)
	d, _, err = parseCrawlSince("7d")
	require.NoError(t, err)
	assert.Equal(t, 7*24*time.Hour, d)
	for _, bad := range []string{"8d", "0h", "1w", "24", "-1h", "999h99d"} {
		_, _, err := parseCrawlSince(bad)
		assert.ErrorIs(t, err, errCrawlSince, "%q was accepted", bad)
	}
}

func TestRedactTextRemovesWhatAListingLeaks(t *testing.T) {
	in := "see https://www.domain.com.au/x, mail a.b@agent.com.au, $1.2m, call 0412 345 678, 4/12 Ocean Parade ok"
	out := redactText(in)
	for _, leak := range []string{"domain.com", "agent.com", "1.2m", "0412", "Ocean Parade"} {
		assert.NotContains(t, out, leak)
	}
	assert.Contains(t, out, "ok")
}

// --- status and not-configured behaviour ----------------------------------------------

func TestStatusReportsUnconfiguredSourcesAndNeverPretendsHealth(t *testing.T) {
	out := crawlStatus(context.Background(), &fakeCrawlOpsOp{}, "uid", fixedNow)
	assert.Empty(t, out.Rigs)
	assert.Equal(t, 0, len(out.Queue.ByStatusSource))
	got := map[string]string{}
	for _, s := range out.Sources {
		got[s.Name] = s.Status
	}
	assert.Equal(t, "unconfigured", got["brandbrain_fleet"])
	assert.Equal(t, "unconfigured", got["shorted_ledger"])
}

func TestStatusShowsLedgerCountsAndSchedulesWithoutRows(t *testing.T) {
	wm := fixedNow.Add(-time.Hour)
	ledger := &fakeLedger{open: 12, soon: 3, groups: []CrawlReceiptGroup{
		{Source: "rea", AppliedStatus: "SWEEP_STATUS_COMPLETE", Suburb: "bondi", Count: 4},
		{Source: "rea", AppliedStatus: "SWEEP_STATUS_COMPLETE", Suburb: "manly", Count: 2},
		{Source: "domain", AppliedStatus: "SWEEP_STATUS_PARTIAL", Suburb: "bondi", Count: 1},
	}, reasons: []CrawlReasonCount{{Reason: "mass_delist", Count: 2}}, watermark: &wm}
	fake := &fakeCrawlOpsOp{ledger: ledger, schedules: []CrawlSchedule{{Name: "house-price-collector-enqueue-delta", State: "ENABLED", LastStatus: "succeeded"}}}
	out := crawlStatus(context.Background(), fake, "uid", fixedNow)
	assert.Equal(t, int64(12), out.Shorted.DispatchOpen)
	assert.Equal(t, int64(3), out.Shorted.DispatchExpiringWithin24h)
	require.Len(t, out.Shorted.ReceiptsLast24h, 2, "receipts are aggregated over suburb")
	// Sorted by portal: domain, then rea.
	assert.Equal(t, "domain", out.Shorted.ReceiptsLast24h[0].Source)
	assert.Equal(t, int64(6), out.Shorted.ReceiptsLast24h[1].Count)
	assert.Equal(t, "mass_delist", out.Shorted.QuarantineLast24h[0].Reason)
	assert.Equal(t, wm.Format(time.RFC3339), out.Shorted.FinalizeWatermark)
	require.Len(t, out.Schedules, 1)
	assert.Equal(t, "enabled", out.Schedules[0].State)
}

func TestStatusNamesABlockedPortalAndAnAlarmInItsNotes(t *testing.T) {
	future := fixedNow.Add(time.Hour)
	fleet := &fakeFleet{
		rigs: []brandbrain.Rig{{ID: "rig-1"}},
		details: map[string]brandbrain.RigDetail{"rig-1": {
			Rig: brandbrain.Rig{ID: "rig-1", Resources: brandbrain.RigResources{HousingCrawl: brandbrain.HousingCrawl{
				Portals: []brandbrain.Portal{{Source: "domain", State: "open", OpenUntil: &future}},
				Alarm:   map[string]any{"active": true, "since": "not a timestamp in the enum", "kind": "stale_suburbs"},
			}}},
			ServerTime: &fixedNow,
		}},
	}
	out := crawlStatus(context.Background(), &fakeCrawlOpsOp{fleet: fleet}, "uid", fixedNow)
	require.Len(t, out.Rigs, 1)
	alarm, _ := out.Rigs[0].Alarm.(map[string]any)
	require.NotNil(t, alarm)
	assert.Equal(t, true, alarm["active"])
	assert.Equal(t, "stale_suburbs", alarm["kind"])
	assert.NotContains(t, alarm, "since", "free text in an alarm must be dropped")
	joined := strings.Join(out.Notes, " | ")
	assert.Contains(t, joined, "domain portal blocked")
	assert.Contains(t, joined, "rig reports an alarm")
}

func TestFailuresGroupJobsByClassWithSamplesAndTopSuburbs(t *testing.T) {
	jobs := []brandbrain.CrawlJob{}
	for i := 0; i < 6; i++ {
		jobs = append(jobs, brandbrain.CrawlJob{ID: fmt.Sprintf("job-%d", i), Suburb: "bondi", Status: "failed", Source: "rea",
			ErrorMessage: "chrome exited"})
	}
	jobs = append(jobs,
		brandbrain.CrawlJob{ID: "job-x", Suburb: "manly", Status: "deferred", Source: "rea", ErrorMessage: "timeout"},
		brandbrain.CrawlJob{ID: "job-y", Suburb: "manly", Status: "deferred", Source: "domain", ErrorMessage: "timeout"})
	fleet := &fakeFleet{jobs: jobs}
	ledger := &fakeLedger{groups: []CrawlReceiptGroup{{Source: "rea", AppliedStatus: "SWEEP_STATUS_BLOCKED", Suburb: "bondi", Count: 2}},
		reasons: []CrawlReasonCount{{Reason: "mass_delist", Count: 1}}}
	out, err := crawlFailures(context.Background(), &fakeCrawlOpsOp{fleet: fleet, ledger: ledger}, "uid", CrawlFailuresInput{Source: "rea"}, fixedNow)
	require.NoError(t, err)
	assert.Equal(t, 6, out.JobFailed)
	assert.Equal(t, 1, out.JobDeferred, "the domain deferral is filtered by source")
	require.Len(t, out.Classes, 2)
	chrome := out.Classes[0]
	assert.Equal(t, FailureChrome, chrome.Class)
	assert.Equal(t, 6, chrome.Count)
	assert.Len(t, chrome.SampleJobIDs, 5, "samples are capped")
	assert.Equal(t, "bondi", chrome.TopSuburbs[0].Suburb)
	require.Len(t, out.Receipts, 1)
	assert.Equal(t, "blocked", out.Receipts[0].AppliedStatus)
	assert.Equal(t, "mass_delist", out.Quarantine[0].Reason)
}

func TestFailuresWithNoFleetAreRefusedAndWithNoLedgerSayso(t *testing.T) {
	_, err := crawlFailures(context.Background(), &fakeCrawlOpsOp{}, "uid", CrawlFailuresInput{}, fixedNow)
	assert.ErrorIs(t, err, errCrawlFleetUnconfigured)

	out, err := crawlFailures(context.Background(), &fakeCrawlOpsOp{fleet: &fakeFleet{}}, "uid", CrawlFailuresInput{}, fixedNow)
	require.NoError(t, err)
	got := map[string]string{}
	for _, s := range out.Sources {
		got[s.Name] = s.Status
	}
	assert.Equal(t, "unconfigured", got["shorted_ledger"])
}

func TestTheSmokeToolIsNotConfiguredWithoutFleetOrLedger(t *testing.T) {
	_, err := crawlSmoke(context.Background(), &fakeCrawlOpsOp{ledger: &fakeLedger{}}, "uid", CrawlSmokeInput{RigID: "rig-1", Confirm: true}, fixedNow)
	assert.ErrorIs(t, err, errCrawlFleetUnconfigured)
	_, err = crawlSmoke(context.Background(), &fakeCrawlOpsOp{fleet: &fakeFleet{}}, "uid", CrawlSmokeInput{RigID: "rig-1", Confirm: true}, fixedNow)
	assert.ErrorIs(t, err, errCrawlLedgerUnavailable)
}

// --- smoke: the verdict from fixtures -----------------------------------------------

func smokeDispatch(job, source string, expires time.Time, closed bool) CrawlDispatch {
	d := CrawlDispatch{JobID: job, RunID: "smoke-20261031T093000Z-0a1b2c3d", Suburb: "Bondi", State: "NSW",
		Postcode: "2026", Source: source, CreatedAt: fixedNow.Add(-time.Minute), ExpiresAt: expires}
	if closed {
		c := fixedNow
		d.ClosedAt = &c
	}
	return d
}

func TestSmokeVerdictPassedWhenEveryJobLandedWithListings(t *testing.T) {
	future := fixedNow.Add(time.Hour)
	facts := smokeJobFacts{Dispatch: smokeDispatch("job-1", "rea", future, true), Now: fixedNow,
		Receipts: []CrawlReceipt{{AppliedStatus: "SWEEP_STATUS_COMPLETE", ListingsUpserted: 14}}}
	verdict, class, detail := judgeSmokeJob(facts)
	assert.Equal(t, SmokePassed, verdict)
	assert.Empty(t, class)
	assert.Equal(t, "applied with listings", detail)

	jobs := []CrawlSmokeJob{{Verdict: SmokePassed}, {Verdict: SmokePassed}}
	v, classes, waiting := smokeVerdict(jobs)
	assert.Equal(t, SmokePassed, v)
	assert.Empty(t, classes)
	assert.Empty(t, waiting)
}

func TestSmokeVerdictPartialWithListingsPasses(t *testing.T) {
	future := fixedNow.Add(time.Hour)
	verdict, _, _ := judgeSmokeJob(smokeJobFacts{Dispatch: smokeDispatch("job-1", "domain", future, true), Now: fixedNow,
		Receipts: []CrawlReceipt{{AppliedStatus: "SWEEP_STATUS_PARTIAL", ListingsUpserted: 3}}})
	assert.Equal(t, SmokePassed, verdict)
}

func TestSmokeVerdictFailedWithTheFailureClass(t *testing.T) {
	future := fixedNow.Add(time.Hour)
	bb := &brandbrain.CrawlJob{ID: "job-1", Status: "failed", ErrorMessage: "chrome exited with status 1"}
	verdict, class, _ := judgeSmokeJob(smokeJobFacts{Dispatch: smokeDispatch("job-1", "rea", future, false), BB: bb, Now: fixedNow})
	assert.Equal(t, SmokeFailed, verdict)
	assert.Equal(t, FailureChrome, class)

	jobs := []CrawlSmokeJob{{Verdict: SmokeFailed, FailureClass: class, JobID: "job-1"}, {Verdict: SmokeWaiting, Detail: "queued", JobID: "job-2"}}
	v, classes, waiting := smokeVerdict(jobs)
	assert.Equal(t, SmokeFailed, v, "one failed job fails the run, whatever the other is doing")
	assert.Equal(t, []string{FailureChrome}, classes)
	assert.Len(t, waiting, 1)
}

func TestSmokeVerdictFailsAnEmptyApplyAndAnExpiredDispatch(t *testing.T) {
	future := fixedNow.Add(time.Hour)
	verdict, class, detail := judgeSmokeJob(smokeJobFacts{Dispatch: smokeDispatch("job-1", "rea", future, true), Now: fixedNow,
		Receipts: []CrawlReceipt{{AppliedStatus: "SWEEP_STATUS_COMPLETE", ListingsUpserted: 0}}})
	assert.Equal(t, SmokeFailed, verdict)
	assert.Equal(t, FailureOther, class)
	assert.Equal(t, "applied with no listings", detail)

	past := fixedNow.Add(-time.Minute)
	verdict, class, _ = judgeSmokeJob(smokeJobFacts{Dispatch: smokeDispatch("job-2", "rea", past, false), Now: fixedNow})
	assert.Equal(t, SmokeFailed, verdict)
	assert.Equal(t, FailureDispatchExpired, class)
}

func TestSmokeVerdictWaitingWithWhatItWaitsOn(t *testing.T) {
	future := fixedNow.Add(time.Hour)
	cases := []struct {
		name   string
		bb     *brandbrain.CrawlJob
		detail string
	}{
		{"queued at brandbrain", &brandbrain.CrawlJob{Status: "queued"}, "queued at BrandBrain; waiting for the rig's drain"},
		{"deferred with attempts left", &brandbrain.CrawlJob{Status: "deferred", Attempts: 1, MaxAttempts: 3}, "deferred at BrandBrain; it will retry"},
		{"brandbrain unknown", nil, "BrandBrain's state for this job could not be read"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			verdict, class, detail := judgeSmokeJob(smokeJobFacts{Dispatch: smokeDispatch("job-1", "rea", future, false), BB: c.bb, Now: fixedNow})
			assert.Equal(t, SmokeWaiting, verdict)
			assert.Empty(t, class)
			assert.Equal(t, c.detail, detail)
		})
	}
}

func TestSmokeVerdictWithNoRowsIsWaitingNotPassed(t *testing.T) {
	v, classes, waiting := smokeVerdict(nil)
	assert.Equal(t, SmokeWaiting, v)
	assert.Empty(t, classes)
	assert.NotEmpty(t, waiting)
}

// --- smoke: the tools end to end -----------------------------------------------------

func TestSmokeStatusIsStatelessAndReadsRowsReceiptsAndBrandBrain(t *testing.T) {
	future := fixedNow.Add(time.Hour)
	smokeID := "smoke-20261031T093000Z-0a1b2c3d"
	ledger := &fakeLedger{
		dispatch: []CrawlDispatch{
			smokeDispatch("job-rea", "rea", future, true),
			smokeDispatch("job-domain", "domain", future, false),
		},
		receipts: map[string][]CrawlReceipt{
			"job-rea": {{AppliedStatus: "SWEEP_STATUS_COMPLETE", ListingsUpserted: 9}},
		},
	}
	fleet := &fakeFleet{jobs: []brandbrain.CrawlJob{{ID: "job-domain", Status: "queued", Source: "domain"}}}
	out, err := crawlSmokeStatus(context.Background(), &fakeCrawlOpsOp{fleet: fleet, ledger: ledger}, "uid", smokeID, fixedNow)
	require.NoError(t, err)
	assert.Equal(t, SmokeWaiting, out.Verdict)
	require.Len(t, out.Jobs, 2)
	assert.Equal(t, SmokePassed, out.Jobs[0].Verdict)
	assert.Equal(t, 9, out.Jobs[0].Listings)
	assert.Equal(t, SmokeWaiting, out.Jobs[1].Verdict)
	assert.Equal(t, "queued", out.Jobs[1].BrandBrainStatus)

	// Stateless: the same inputs give the same answer, and nothing was written.
	again, _ := crawlSmokeStatus(context.Background(), &fakeCrawlOpsOp{fleet: fleet, ledger: ledger}, "uid", smokeID, fixedNow)
	assert.Equal(t, out.Verdict, again.Verdict)
	assert.Empty(t, fleet.drainKeys)
}

func TestSmokeStatusPassesOnlyWhenEveryJobPassed(t *testing.T) {
	future := fixedNow.Add(time.Hour)
	smokeID := "smoke-20261031T093000Z-0a1b2c3d"
	ledger := &fakeLedger{
		dispatch: []CrawlDispatch{smokeDispatch("job-rea", "rea", future, true), smokeDispatch("job-domain", "domain", future, true)},
		receipts: map[string][]CrawlReceipt{
			"job-rea":    {{AppliedStatus: "SWEEP_STATUS_COMPLETE", ListingsUpserted: 9}},
			"job-domain": {{AppliedStatus: "SWEEP_STATUS_PARTIAL", ListingsUpserted: 2}},
		},
	}
	out, err := crawlSmokeStatus(context.Background(), &fakeCrawlOpsOp{ledger: ledger}, "uid", smokeID, fixedNow)
	require.NoError(t, err)
	assert.Equal(t, SmokePassed, out.Verdict)
	assert.Empty(t, out.Waiting)
}

func TestSmokeStatusFailsWithClassesAndWithoutBrandBrainNothingPasses(t *testing.T) {
	future := fixedNow.Add(time.Hour)
	smokeID := "smoke-20261031T093000Z-0a1b2c3d"
	ledger := &fakeLedger{dispatch: []CrawlDispatch{smokeDispatch("job-rea", "rea", future, false)}}
	// No fleet: BrandBrain state is unknown, so the job waits. It never passes.
	out, err := crawlSmokeStatus(context.Background(), &fakeCrawlOpsOp{ledger: ledger}, "uid", smokeID, fixedNow)
	require.NoError(t, err)
	assert.Equal(t, SmokeWaiting, out.Verdict)

	fleet := &fakeFleet{jobs: []brandbrain.CrawlJob{{ID: "job-rea", Status: "failed", Source: "rea", ErrorMessage: "ingest unavailable: connect refused"}}}
	out, err = crawlSmokeStatus(context.Background(), &fakeCrawlOpsOp{fleet: fleet, ledger: ledger}, "uid", smokeID, fixedNow)
	require.NoError(t, err)
	assert.Equal(t, SmokeFailed, out.Verdict)
	assert.Equal(t, []string{FailureIngestUnavailable}, out.FailureClasses)
}

func TestSmokeStatusRefusesAMalformedRunID(t *testing.T) {
	_, err := crawlSmokeStatus(context.Background(), &fakeCrawlOpsOp{ledger: &fakeLedger{}}, "uid", "smoke-../x", fixedNow)
	assert.ErrorIs(t, err, errCrawlSmokeID)
}

func TestSmokeStartsOneEnqueueWaitsDrainsAndReturnsItsID(t *testing.T) {
	shortPolls(t)
	fleet := &fakeFleet{}
	ledger := &fakeLedger{}
	fake := &fakeCrawlOpsOp{fleet: fleet, ledger: ledger, execs: []*jobmonitor.ExecutionStatus{{Status: "succeeded"}}}
	srv, pub := opsStack(t, fake)
	raw := crawlCall(t, srv, "t", CrawlSmokeTool, `{"rig_id":"rig-1","confirm":true,"suburb":"bondi"}`)
	res := parseToolResult(t, raw)
	require.False(t, res.Refused, res.Text)
	require.Equal(t, 1, pub.runCalls, "exactly one enqueue")
	assert.Equal(t, "bondi", pub.runReq.Suburb)
	assert.True(t, strings.HasPrefix(pub.runReq.RunID, "smoke-"), "the run id must carry the smoke- prefix")
	// The run wrote no rows, so the smoke says so and sends no drain.
	assert.Equal(t, "failed", res.Structured["verdict"])
	assert.Empty(t, fleet.drainKeys)
}

func TestSmokeDrainsOnceTheRowsExistAndKeysItByRun(t *testing.T) {
	shortPolls(t)
	future := fixedNow.Add(time.Hour)
	fleet := &fakeFleet{}
	ledger := &fakeLedger{}
	fake := &fakeCrawlOpsOp{fleet: fleet, ledger: ledger, execs: []*jobmonitor.ExecutionStatus{{Status: "succeeded"}}}
	srv, pub := opsStack(t, fake)
	// First call: no rows yet, so no drain.
	raw := crawlCall(t, srv, "t", CrawlSmokeTool, `{"rig_id":"rig-1","confirm":true}`)
	res := parseToolResult(t, raw)
	require.False(t, res.Refused, res.Text)
	runID := pub.runReq.RunID
	assert.Empty(t, fleet.drainKeys, "no drain before the enqueue has written rows")

	// The enqueue's rows exist: a continuation sends the drain, keyed by the run.
	ledger.dispatch = []CrawlDispatch{smokeDispatch("job-rea", "rea", future, false)}
	ledger.dispatch[0].RunID = runID
	raw = crawlCall(t, srv, "t", CrawlSmokeTool, fmt.Sprintf(`{"rig_id":"rig-1","confirm":true,"smoke_id":%q}`, runID))
	res = parseToolResult(t, raw)
	require.False(t, res.Refused, res.Text)
	require.Len(t, fleet.drainKeys, 1)
	assert.Equal(t, "rig-1|"+runID+":drain", fleet.drainKeys[0])
	assert.Equal(t, 1, pub.runCalls, "a continuation starts no second enqueue")
	assert.Equal(t, "sent", res.Structured["drain"])
	assert.Equal(t, "waiting", res.Structured["verdict"])
}

func TestSmokeNeverSendsADrainWhileTheEnqueueIsStillRunning(t *testing.T) {
	shortPolls(t)
	fleet := &fakeFleet{}
	fake := &fakeCrawlOpsOp{fleet: fleet, ledger: &fakeLedger{}}
	out, err := crawlSmoke(context.Background(), fake, "uid", CrawlSmokeInput{RigID: "rig-1", Confirm: true}, fixedNow)
	require.NoError(t, err)
	assert.Equal(t, "running", out.Enqueue)
	assert.Equal(t, SmokeWaiting, out.Verdict)
	assert.Empty(t, fleet.drainKeys)
}

func TestSmokeStopsWhenTheEnqueueFailsAndSendsNothing(t *testing.T) {
	shortPolls(t)
	fleet := &fakeFleet{}
	fake := &fakeCrawlOpsOp{fleet: fleet, ledger: &fakeLedger{}, execs: []*jobmonitor.ExecutionStatus{{Status: "failed", Message: "exit 7 at https://x.example/path"}}}
	out, err := crawlSmoke(context.Background(), fake, "uid", CrawlSmokeInput{RigID: "rig-1", Confirm: true}, fixedNow)
	require.NoError(t, err)
	assert.Equal(t, "failed", out.Enqueue)
	assert.Equal(t, SmokeFailed, out.Verdict)
	assert.Empty(t, fleet.drainKeys)
	assert.NotContains(t, out.Message, "x.example")
}

func TestSmokeNeedsConfirmAndSendsNothingWithoutIt(t *testing.T) {
	fleet := &fakeFleet{}
	fake := &fakeCrawlOpsOp{fleet: fleet, ledger: &fakeLedger{}}
	_, err := crawlSmoke(context.Background(), fake, "uid", CrawlSmokeInput{RigID: "rig-1"}, fixedNow)
	assert.ErrorIs(t, err, errCrawlSmokeConfirm)
	assert.Equal(t, 0, fake.runCalls)
	assert.Empty(t, fleet.drainKeys)

	srv, pub := opsStack(t, fake)
	res := parseToolResult(t, crawlCall(t, srv, "t", CrawlSmokeTool, `{"rig_id":"rig-1"}`))
	assert.True(t, res.Refused, "a call without the confirm field must not be accepted")
	assert.Equal(t, 0, pub.runCalls)
}

func TestSmokeRefusesBadInputsBeforeAnythingIsSent(t *testing.T) {
	fleet := &fakeFleet{}
	fake := &fakeCrawlOpsOp{fleet: fleet, ledger: &fakeLedger{}}
	for _, in := range []CrawlSmokeInput{
		{RigID: "../rig", Confirm: true},
		{RigID: "rig-1", Confirm: true, Suburb: "Bondi Beach"},
		{RigID: "rig-1", Confirm: true, Suburb: "bondi;rm"},
		{RigID: "rig-1", Confirm: true, SmokeID: "smoke-whatever"},
	} {
		_, err := crawlSmoke(context.Background(), fake, "uid", in, fixedNow)
		assert.Error(t, err, "%+v was accepted", in)
	}
	assert.Equal(t, 0, fake.runCalls)
	assert.Empty(t, fleet.drainKeys)
}

func TestSmokeRunIDIsGeneratedInTheSmokeFormat(t *testing.T) {
	shortPolls(t)
	fake := &fakeCrawlOpsOp{fleet: &fakeFleet{}, ledger: &fakeLedger{}, execs: []*jobmonitor.ExecutionStatus{{Status: "succeeded"}}}
	out, err := crawlSmoke(context.Background(), fake, "uid", CrawlSmokeInput{RigID: "rig-1", Confirm: true}, fixedNow)
	require.NoError(t, err)
	assert.Regexp(t, `^smoke-20261031T100000Z-[a-f0-9]{8}$`, out.SmokeID)
}

func TestTheReadToolsCarryNoListingData(t *testing.T) {
	shortPolls(t)
	future := fixedNow.Add(time.Hour)
	fleet := &fakeFleet{
		rigs:    []brandbrain.Rig{{ID: "rig-1"}},
		details: map[string]brandbrain.RigDetail{"rig-1": {Rig: brandbrain.Rig{ID: "rig-1"}, ServerTime: &fixedNow}},
		jobs:    []brandbrain.CrawlJob{{ID: "job-1", Status: "failed", Suburb: "Bondi", ErrorMessage: "chrome: listing at 12 Smith Street $900k https://x.example"}},
		logText: "scrape 12 Smith Street Bondi $900k https://x.example\nfine",
	}
	ledger := &fakeLedger{dispatch: []CrawlDispatch{smokeDispatch("job-1", "rea", future, false)}}
	fake := &fakeCrawlOpsOp{fleet: fleet, ledger: ledger}
	status := crawlStatus(context.Background(), fake, "uid", fixedNow)
	failures, err := crawlFailures(context.Background(), fake, "uid", CrawlFailuresInput{}, fixedNow)
	require.NoError(t, err)
	job, err := crawlJob(context.Background(), fake, "uid", CrawlJobInput{JobID: "job-1", WithLogs: true})
	require.NoError(t, err)
	logs, err := crawlLogs(context.Background(), fake, "uid", CrawlLogsInput{RigID: "rig-1", Source: "housing"})
	require.NoError(t, err)
	smoke, err := crawlSmokeStatus(context.Background(), fake, "uid", "smoke-20261031T093000Z-0a1b2c3d", fixedNow)
	require.NoError(t, err)
	for name, v := range map[string]any{"status": status, "failures": failures, "job": job, "logs": logs, "smoke": smoke} {
		raw, _ := json.Marshal(v)
		s := string(raw)
		assert.NotContains(t, s, "Smith Street", "%s leaked an address", name)
		assert.NotContains(t, s, "900k", "%s leaked a price", name)
		assert.NotContains(t, s, "x.example", "%s leaked a URL", name)
		assert.NotContains(t, s, fleetFixtureToken, "%s leaked the token", name)
	}
}

// The smoke drain goes over the real fleet client to a fake BrandBrain: the route, the
// fleet token, the idempotency key, the body, and the kind filter on the job read.
func TestSmokeDrainReachesTheRigOverTheFleetWire(t *testing.T) {
	shortPolls(t)
	smokeID := "smoke-20261031T093000Z-0a1b2c3d"
	var (
		mu        sync.Mutex
		drainIdem string
		drainBody string
		jobQuery  string
		sawToken  bool
	)
	bb := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Fleet-Ops-Token") != fleetFixtureToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		sawToken = true
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/fleet/rigs/rig-1/commands":
			raw, _ := io.ReadAll(r.Body)
			drainBody, drainIdem = string(raw), r.Header.Get("Idempotency-Key")
			w.WriteHeader(http.StatusAccepted)
			_, _ = io.WriteString(w, `{"id":"cmd-wire-1","kind":"housing_crawl_run","status":"queued"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/fleet/crawl-jobs":
			jobQuery = r.URL.RawQuery
			_, _ = io.WriteString(w, `{"jobs":[],"summary":{"by_status_source":[]}}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(bb.Close)
	fleet, err := brandbrain.NewFleetTestClient(bb.URL, fleetFixtureToken, time.Second)
	require.NoError(t, err)

	ledger := &fakeLedger{dispatch: []CrawlDispatch{smokeDispatch("job-wire", "rea", fixedNow.Add(time.Hour), false)}}
	ledger.dispatch[0].RunID = smokeID
	fake := &fakeCrawlOpsOp{fleet: fleet, ledger: ledger}
	out, err := crawlSmoke(context.Background(), fake, "uid", CrawlSmokeInput{RigID: "rig-1", Confirm: true, SmokeID: smokeID}, fixedNow)
	require.NoError(t, err)
	assert.Equal(t, "sent", out.Drain)
	assert.Equal(t, "cmd-wire-1", out.DrainCommandID)

	mu.Lock()
	defer mu.Unlock()
	assert.True(t, sawToken)
	assert.Equal(t, smokeID+":drain", drainIdem, "the drain is keyed by the run, so a retry is the same command")
	assert.JSONEq(t, `{"kind":"housing_crawl_run","payload":{"job":"drain","dry_run":false}}`, drainBody)
	assert.Contains(t, jobQuery, "kind=housing", "the job read must name the housing kind")
	assert.Contains(t, jobQuery, "id=job-wire")
}
