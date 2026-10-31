package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/brandbrain"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
)

// --- wait budgets -------------------------------------------------------------------

// Every wait stays under the admin connection's lifetime, so a tool answers instead of being cut.
// The admin stream is cut at StreamLifetime (90s) and Cloudflare at 120s.
func TestEveryToolWaitStaysUnderTheConnectionLifetime(t *testing.T) {
	assert.LessOrEqual(t, int64(smokeWait), int64(50*time.Second), "the enqueue wait is about 50 seconds")
	assert.LessOrEqual(t, int64(crawlLogsWait), int64(50*time.Second), "the log wait is about 50 seconds")
	assert.Less(t, int64(toolBudget), int64(StreamLifetime), "a tool's whole budget must end before the connection is cut")
	assert.LessOrEqual(t, int64(smokeWait+crawlTimeout), int64(toolBudget), "the enqueue wait and the BrandBrain reads share one budget")
	assert.LessOrEqual(t, int64(crawlLogsWait+crawlTimeout), int64(toolBudget), "the log wait and the BrandBrain reads share one budget")
}

// A wait that runs out is a normal answer: running, with the smoke id, and no error.
func TestAnEnqueueWaitThatRunsOutIsANormalRunningAnswer(t *testing.T) {
	shortPolls(t)
	fake := &fakeCrawlOpsOp{fleet: &fakeFleet{}, ledger: &fakeLedger{}}
	out, err := crawlSmoke(context.Background(), fake, "uid", CrawlSmokeInput{RigID: "rig-1", Confirm: true}, fixedNow)
	require.NoError(t, err, "a timed-out wait must not be a tool error")
	assert.Equal(t, "running", out.Enqueue)
	assert.NotEmpty(t, out.SmokeID)
	assert.Equal(t, SmokeWaiting, out.Verdict)
}

// --- the enqueue dedupe (collector exit code 11) --------------------------------------

func TestADeduplicatedEnqueueIsReportedAsDeduplicatedNotFailed(t *testing.T) {
	shortPolls(t)
	fleet := &fakeFleet{}
	fake := &fakeCrawlOpsOp{fleet: fleet, ledger: &fakeLedger{}, execs: []*jobmonitor.ExecutionStatus{
		{Status: "failed", Message: "Container exited with code 11"},
	}}
	out, err := crawlSmoke(context.Background(), fake, "uid", CrawlSmokeInput{RigID: "rig-1", Confirm: true}, fixedNow)
	require.NoError(t, err)
	assert.Equal(t, "deduplicated", out.Enqueue)
	assert.Equal(t, SmokeDeduplicated, out.Verdict)
	assert.NotEqual(t, SmokeFailed, out.Verdict, "a second smoke on a queued suburb is not a failure")
	assert.Empty(t, fleet.drainKeys, "no drain for a deduplicated run")
}

func TestAnOrdinaryEnqueueFailureStaysAFailure(t *testing.T) {
	shortPolls(t)
	fake := &fakeCrawlOpsOp{fleet: &fakeFleet{}, ledger: &fakeLedger{}, execs: []*jobmonitor.ExecutionStatus{
		{Status: "failed", Message: "Container exited with code 7"},
	}}
	out, err := crawlSmoke(context.Background(), fake, "uid", CrawlSmokeInput{RigID: "rig-1", Confirm: true}, fixedNow)
	require.NoError(t, err)
	assert.Equal(t, SmokeFailed, out.Verdict)
}

// --- the live drain: skipped, refused, rate limited, settled ----------------------------

func TestTheDrainIsSkippedWhenTheRigIsAlreadyDraining(t *testing.T) {
	shortPolls(t)
	fleet := &fakeFleet{rigs: []brandbrain.Rig{{ID: "rig-1", Resources: brandbrain.RigResources{HousingCrawl: &brandbrain.HousingCrawl{
		InFlight: &brandbrain.InFlight{Job: "drain", Phase: "sweeping"}}}}}}
	ledger := &fakeLedger{dispatch: []CrawlDispatch{smokeDispatch("job-rea", "rea", fixedNow.Add(time.Hour), false)}}
	ledger.dispatch[0].RunID = "smoke-20261031T093000Z-0a1b2c3d"
	fake := &fakeCrawlOpsOp{fleet: fleet, ledger: ledger}
	out, err := crawlSmoke(context.Background(), fake, "uid", CrawlSmokeInput{RigID: "rig-1", Confirm: true, SmokeID: "smoke-20261031T093000Z-0a1b2c3d"}, fixedNow)
	require.NoError(t, err)
	assert.Equal(t, "skipped_drain_running", out.Drain)
	assert.Empty(t, fleet.drainKeys, "a second live drain must not be sent over a running one")
	assert.Contains(t, out.Next, "claims it next")
}

// A 409 is a refusal: nothing was created, and it is never reported as an unknown outcome.
func TestARefusedDrainIsARefusalWithBrandBrainsReason(t *testing.T) {
	shortPolls(t)
	ledger := &fakeLedger{dispatch: []CrawlDispatch{smokeDispatch("job-rea", "rea", fixedNow.Add(time.Hour), false)}}
	ledger.dispatch[0].RunID = "smoke-20261031T093000Z-0a1b2c3d"
	fleet := &fakeFleet{drainErr: &brandbrain.ConflictError{Code: "rig_not_active"}}
	out, err := crawlSmoke(context.Background(), &fakeCrawlOpsOp{fleet: fleet, ledger: ledger}, "uid",
		CrawlSmokeInput{RigID: "rig-1", Confirm: true, SmokeID: "smoke-20261031T093000Z-0a1b2c3d"}, fixedNow)
	require.NoError(t, err)
	assert.Equal(t, "refused", out.Drain)
	assert.Contains(t, out.Message, "not active")
	assert.NotContains(t, out.Drain, "unknown")
}

// rig_busy means a drain is already running; the run reports it, and does not fail.
func TestRigBusyIsReportedAsADrainAlreadyRunning(t *testing.T) {
	shortPolls(t)
	ledger := &fakeLedger{dispatch: []CrawlDispatch{smokeDispatch("job-rea", "rea", fixedNow.Add(time.Hour), false)}}
	ledger.dispatch[0].RunID = "smoke-20261031T093000Z-0a1b2c3d"
	fleet := &fakeFleet{drainErr: &brandbrain.ConflictError{Code: "rig_busy"}}
	out, err := crawlSmoke(context.Background(), &fakeCrawlOpsOp{fleet: fleet, ledger: ledger}, "uid",
		CrawlSmokeInput{RigID: "rig-1", Confirm: true, SmokeID: "smoke-20261031T093000Z-0a1b2c3d"}, fixedNow)
	require.NoError(t, err)
	assert.Equal(t, "rig_busy", out.Drain)
	assert.Contains(t, out.Message, "already running")
	assert.NotEqual(t, SmokeFailed, out.Verdict)
}

// A drain whose answer was lost is settled by its key: if BrandBrain created it, it is the sent drain.
func TestALostDrainAnswerIsSettledByItsKey(t *testing.T) {
	shortPolls(t)
	smokeID := "smoke-20261031T093000Z-0a1b2c3d"
	ledger := &fakeLedger{dispatch: []CrawlDispatch{smokeDispatch("job-rea", "rea", fixedNow.Add(time.Hour), false)}}
	ledger.dispatch[0].RunID = smokeID
	fleet := &fakeFleet{drainErr: brandbrain.ErrUnavailable, commands: map[string]brandbrain.Command{
		smokeID + ":drain": {ID: "drain-created", Kind: brandbrain.CommandHousingCrawlRun, RequestKey: smokeID + ":drain", Status: brandbrain.CommandPending},
	}}
	out, err := crawlSmoke(context.Background(), &fakeCrawlOpsOp{fleet: fleet, ledger: ledger}, "uid",
		CrawlSmokeInput{RigID: "rig-1", Confirm: true, SmokeID: smokeID}, fixedNow)
	require.NoError(t, err)
	assert.Equal(t, "sent", out.Drain)
	assert.Equal(t, "drain-created", out.DrainCommandID)
}

// A lost drain that BrandBrain never created is reported as not sent, with the key read back.
func TestALostDrainNeverCreatedIsNotSent(t *testing.T) {
	shortPolls(t)
	smokeID := "smoke-20261031T093000Z-0a1b2c3d"
	ledger := &fakeLedger{dispatch: []CrawlDispatch{smokeDispatch("job-rea", "rea", fixedNow.Add(time.Hour), false)}}
	ledger.dispatch[0].RunID = smokeID
	fleet := &fakeFleet{drainErr: brandbrain.ErrUnavailable}
	out, err := crawlSmoke(context.Background(), &fakeCrawlOpsOp{fleet: fleet, ledger: ledger}, "uid",
		CrawlSmokeInput{RigID: "rig-1", Confirm: true, SmokeID: smokeID}, fixedNow)
	require.NoError(t, err)
	assert.Equal(t, "not_sent", out.Drain)
	assert.Contains(t, out.Message, "did not create")
}

// --- lost log requests ----------------------------------------------------------------

func TestALostLogRequestThatBrandBrainCreatedIsFollowedByItsKey(t *testing.T) {
	shortPolls(t)
	fleet := &fakeFleet{lostPost: true, notCreated: false, logText: "line one\nline two"}
	res, err := requestRigLogs(context.Background(), fleet, "rig-1", brandbrain.LogSourceHousing)
	require.NoError(t, err)
	assert.Equal(t, "line one\nline two", res.text)
}

func TestALostLogRequestNotCreatedSaysSo(t *testing.T) {
	shortPolls(t)
	fleet := &fakeFleet{lostPost: true, notCreated: true}
	_, err := requestRigLogs(context.Background(), fleet, "rig-1", brandbrain.LogSourceHousing)
	assert.ErrorIs(t, err, errCrawlLogNotCreated)
}

// A log request refused with 409 says why, from the closed code.
func TestALogRequestRefusedByBrandBrainSaysWhy(t *testing.T) {
	shortPolls(t)
	fleet := &fakeFleet{logErr: &brandbrain.ConflictError{Code: "agent_update_required"}}
	_, err := requestRigLogs(context.Background(), fleet, "rig-1", brandbrain.LogSourceHousing)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "too old")
}

// --- queue position follows claim order -------------------------------------------------

func TestQueuePositionFollowsClaimOrder(t *testing.T) {
	early, late := fixedNow.Add(-time.Hour), fixedNow
	own := brandbrain.CrawlJob{ID: "own", Status: "pending", Priority: 5, CreatedAt: &late}
	pending := []brandbrain.CrawlJob{
		own,
		{ID: "higher-newer", Status: "pending", Priority: 6, CreatedAt: &late},                                          // claimed first: higher priority
		{ID: "same-older", Status: "pending", Priority: 5, CreatedAt: &early},                                           // claimed first: same priority, created earlier
		{ID: "same-newer", Status: "pending", Priority: 5, CreatedAt: &late},                                            // not earlier
		{ID: "lower-older", Status: "pending", Priority: 4, CreatedAt: &early},                                          // lower priority
		{ID: "not-yet", Status: "pending", Priority: 9, CreatedAt: &early, NotBefore: ptrTime(fixedNow.Add(time.Hour))}, // not claimable
		{ID: "running", Status: "in_progress", Priority: 9, CreatedAt: &early},                                          // not waiting
		{ID: "done", Status: "succeeded", Priority: 9, CreatedAt: &early},                                               // not waiting
	}
	assert.Equal(t, 2, queueAhead(pending, own, fixedNow), "higher-newer and same-older are claimed before own")
}

func ptrTime(t time.Time) *time.Time { return &t }

// The queue summary's statuses pass through the known-status map: an unknown status is other.
func TestQueueSummaryStatusesAreMappedThroughKnownStatuses(t *testing.T) {
	fleet := &fakeFleet{summary: []brandbrain.StatusSourceCount{{Status: "queued", Source: "rea", Count: 3}, {Status: "pending", Source: "rea", Count: 9}}}
	out := crawlStatus(context.Background(), &fakeCrawlOpsOp{fleet: fleet}, "uid", fixedNow)
	require.Len(t, out.Queue.ByStatusSource, 2)
	assert.Equal(t, "other", out.Queue.ByStatusSource[0].Status, "queued is not a crawl job status")
	assert.Equal(t, "pending", out.Queue.ByStatusSource[1].Status)
}

// --- portals: unknown is never clear ----------------------------------------------------

func TestARigWithNoHousingBlockHasUnknownPortals(t *testing.T) {
	st := rigStatus(brandbrain.Rig{ID: "rig-2", Version: "1.0.3"}, &fixedNow)
	assert.Equal(t, "unknown", st.PortalsState)
	assert.Empty(t, st.Portals)
}

func TestAnEmptyPortalListIsUnknownNotClear(t *testing.T) {
	st := rigStatus(brandbrain.Rig{ID: "rig-3", Resources: brandbrain.RigResources{HousingCrawl: &brandbrain.HousingCrawl{State: "running"}}}, &fixedNow)
	assert.Equal(t, "unknown", st.PortalsState)
	out := crawlStatus(context.Background(), &fakeCrawlOpsOp{fleet: &fakeFleet{rigs: []brandbrain.Rig{{ID: "rig-3", Resources: brandbrain.RigResources{HousingCrawl: &brandbrain.HousingCrawl{State: "running"}}}}, serverTime: &fixedNow}}, "uid", fixedNow)
	joined := strings.Join(out.Notes, " | ")
	assert.Contains(t, joined, "portal state is unknown, not clear")
}

func TestAMissingServerTimeLeavesBlockedUnknown(t *testing.T) {
	future := fixedNow.Add(time.Hour)
	out := crawlStatus(context.Background(), &fakeCrawlOpsOp{fleet: &fakeFleet{rigs: []brandbrain.Rig{{ID: "rig-1", Resources: brandbrain.RigResources{HousingCrawl: &brandbrain.HousingCrawl{
		Portals: []brandbrain.Portal{{Source: "rea", State: "open", OpenUntil: &future}}}}}}}}, "uid", fixedNow)
	require.Len(t, out.Rigs, 1)
	assert.Equal(t, "unknown_clock", out.Rigs[0].Portals[0].Status)
	assert.Nil(t, out.Rigs[0].Portals[0].Blocked)
	assert.Contains(t, strings.Join(out.Notes, " | "), "carries no server_time")
}

// --- versions and alarms ------------------------------------------------------------

func TestVersionsAcceptSemverAndRefuseText(t *testing.T) {
	assert.Equal(t, "1.21.0", closedVersion("1.21.0"))
	assert.Equal(t, "1.40.0-rc1", closedVersion("1.40.0-rc1"))
	assert.Equal(t, "128.0.6613.120", closedVersion("128.0.6613.120"))
	assert.Equal(t, "", closedVersion("a free text version"))
	assert.Equal(t, "", closedVersion("1.2.3; rm -rf"))
}

func TestAlarmWordsAreKeptAndFreeTextIsDropped(t *testing.T) {
	st := rigStatus(brandbrain.Rig{ID: "rig-1", Resources: brandbrain.RigResources{HousingCrawl: &brandbrain.HousingCrawl{
		Jobs: map[string]brandbrain.DrainSched{"drain": {Last: &brandbrain.DrainRun{Alarm: "Stale Suburbs at 12 Smith Street"}},
			"repair": {Last: &brandbrain.DrainRun{Alarm: "rewarm_needed"}}},
	}}}, &fixedNow)
	alarm, _ := st.Alarm.(map[string]string)
	require.NotNil(t, alarm)
	assert.NotContains(t, alarm, "drain", "a free-text alarm is dropped, not kept")
	assert.Equal(t, "rewarm_needed", alarm["repair"])
}

// --- smoke verdict: BLOCKED and the two portals -------------------------------------------

func TestBlockedThenFinishedFailsAsBlocked(t *testing.T) {
	future := fixedNow.Add(time.Hour)
	for _, status := range []string{"succeeded", "failed"} {
		verdict, class, detail := judgeSmokeJob(smokeJobFacts{Dispatch: smokeDispatch("job-1", "rea", future, false), Now: fixedNow,
			Receipts: []CrawlReceipt{{AppliedStatus: "SWEEP_STATUS_BLOCKED"}}, BB: &brandbrain.CrawlJob{Status: status}})
		assert.Equal(t, SmokeFailed, verdict, "BrandBrain %s after a BLOCKED sweep", status)
		assert.Equal(t, FailureBlocked, class)
		assert.Contains(t, detail, "BLOCKED")
	}
}

func TestBlockedWhileBrandBrainIsUnreadableWaits(t *testing.T) {
	future := fixedNow.Add(time.Hour)
	verdict, _, _ := judgeSmokeJob(smokeJobFacts{Dispatch: smokeDispatch("job-1", "rea", future, false), Now: fixedNow,
		Receipts: []CrawlReceipt{{AppliedStatus: "SWEEP_STATUS_BLOCKED"}}, BB: nil})
	assert.Equal(t, SmokeWaiting, verdict)
	verdict, _, _ = judgeSmokeJob(smokeJobFacts{Dispatch: smokeDispatch("job-1", "rea", future, false), Now: fixedNow,
		Receipts: []CrawlReceipt{{AppliedStatus: "SWEEP_STATUS_BLOCKED"}}, BB: &brandbrain.CrawlJob{Status: "pending"}})
	assert.Equal(t, SmokeWaiting, verdict, "a BLOCKED sweep that BrandBrain may still retry waits")
}

func TestAPassRequiresEachPortal(t *testing.T) {
	passed := func(src string) CrawlSmokeJob { return CrawlSmokeJob{Source: src, Verdict: SmokePassed} }
	v, _, waiting := smokeVerdict([]CrawlSmokeJob{passed("rea")}, smokeTargetSources)
	assert.Equal(t, SmokeWaiting, v, "one landed portal is not a passed smoke")
	assert.Contains(t, strings.Join(waiting, " "), "no ledger row for domain")
	v, _, _ = smokeVerdict([]CrawlSmokeJob{passed("rea"), passed("domain")}, smokeTargetSources)
	assert.Equal(t, SmokePassed, v)
	v, classes, _ := smokeVerdict([]CrawlSmokeJob{passed("rea"), {Source: "domain", Verdict: SmokeFailed, FailureClass: FailureChrome}}, smokeTargetSources)
	assert.Equal(t, SmokeFailed, v)
	assert.Equal(t, []string{FailureChrome}, classes)
}

// A passing job crawled by another rig than the target is flagged, and still passes.
func TestAPassingJobCrawledByAnotherRigIsFlagged(t *testing.T) {
	future := fixedNow.Add(time.Hour)
	smokeID := "smoke-20261031T093000Z-0a1b2c3d"
	ledger := &fakeLedger{
		dispatch: []CrawlDispatch{smokeDispatch("job-rea", "rea", future, true), smokeDispatch("job-domain", "domain", future, true)},
		receipts: map[string][]CrawlReceipt{
			"job-rea":    {{RigSubject: "rig:rig-2", AppliedStatus: "SWEEP_STATUS_COMPLETE", ListingsUpserted: 4}},
			"job-domain": {{RigSubject: "rig:rig-1", AppliedStatus: "SWEEP_STATUS_PARTIAL", ListingsUpserted: 2}},
		},
	}
	out, err := crawlSmokeStatus(context.Background(), &fakeCrawlOpsOp{ledger: ledger}, "uid", smokeID, "rig-1", fixedNow)
	require.NoError(t, err)
	assert.Equal(t, SmokePassed, out.Verdict)
	require.Len(t, out.Jobs, 2)
	var rea CrawlSmokeJob
	for _, j := range out.Jobs {
		if j.Source == "rea" {
			rea = j
		}
	}
	assert.Equal(t, "rig-2", rea.CrawledBy)
	assert.True(t, rea.RigMismatch)
	assert.Contains(t, rea.Detail, "not the target rig rig-1")
}

// Without a fleet, a job with a landed receipt can still pass; the status must not say otherwise.
func TestUnconfiguredFleetDoesNotClaimNoJobCanPass(t *testing.T) {
	future := fixedNow.Add(time.Hour)
	smokeID := "smoke-20261031T093000Z-0a1b2c3d"
	ledger := &fakeLedger{
		dispatch: []CrawlDispatch{smokeDispatch("job-rea", "rea", future, true), smokeDispatch("job-domain", "domain", future, true)},
		receipts: map[string][]CrawlReceipt{
			"job-rea":    {{RigSubject: "rig:rig-1", AppliedStatus: "SWEEP_STATUS_COMPLETE", ListingsUpserted: 4}},
			"job-domain": {{RigSubject: "rig:rig-1", AppliedStatus: "SWEEP_STATUS_COMPLETE", ListingsUpserted: 1}},
		},
	}
	out, err := crawlSmokeStatus(context.Background(), &fakeCrawlOpsOp{ledger: ledger}, "uid", smokeID, "", fixedNow)
	require.NoError(t, err)
	assert.Equal(t, SmokePassed, out.Verdict, "receipts are the evidence; a missing fleet does not block a pass")
	raw, _ := json.Marshal(out.Sources)
	assert.NotContains(t, string(raw), "no job can pass")
}

// --- redaction of listing data --------------------------------------------------------

// Lines a collector writes about listings are dropped whole, and the real-shaped lines are the fixtures.
func TestListingLinesAreDroppedWholeAndNeverReturned(t *testing.T) {
	text := strings.Join([]string{
		"[listings] start: 2 suburbs · direct · maxPages=3 · dryRun=true",
		"[listings] DRY bondi rea: status=ok pages=2 listings=14",
		"[listings] DRY   12 Smith Street, Bondi NSW 2026 | $1,250,000 (asking) | https://www.realestate.com.au/property-x",
		"[property] 12-smith-street-bondi-nsw-2026: profile address MISMATCH (final=https://www.domain.com.au/x built=y)",
		"[property] 4-ocean-parade-manly-nsw-2095: DRY would mark NOTFOUND (final=https://www.domain.com.au/y)",
		"[property] start: 40 address(es) · direct · dryRun=true",
		"[enqueue] run smoke-20261031T093000Z-0a1b2c3d: 2 job(s) created",
	}, "\n")
	kept := logLines(text)
	joined := strings.Join(kept, "\n")
	assert.NotContains(t, joined, "[listings] DRY", "the DRY listing rows are dropped whole")
	assert.NotContains(t, joined, "smith-street", "an address key line is dropped whole")
	assert.NotContains(t, joined, "ocean-parade", "an address key line is dropped whole")
	assert.NotContains(t, joined, "1,250,000")
	assert.NotContains(t, joined, "realestate.com.au")
	assert.Contains(t, joined, "[listings] start", "a run summary line is not listing data and is kept")
	assert.Contains(t, joined, "[property] start", "a run summary line is kept")
	assert.Contains(t, joined, "[enqueue] run smoke-20261031T093000Z-0a1b2c3d", "the smoke run line is kept")
}

func TestSlugAddressesAndExtendedStreetTypesAreRedacted(t *testing.T) {
	cases := map[string]string{
		"lookup 12-smith-street-bondi-nsw-2026 done":     "lookup [address] done",
		"12 Grove Road sold":                             "[address] sold",
		"8 Lakeview Circuit listed":                      "[address] listed",
		"3 Coastal Esplanade queued":                     "[address] queued",
		"21 Ridge Rise status":                           "[address] status",
		"5 Harbour Square price":                         "[address] price",
		"nothing here but words":                         "nothing here but words",
		"north-nsw is not an address without a postcode": "north-nsw is not an address without a postcode",
	}
	for in, want := range cases {
		assert.Equal(t, want, redactText(in), "input %q", in)
	}
}

// The cap never splits a multi-byte character: the cut moves back to a rune start.
func TestTextCapsOnARuneBoundary(t *testing.T) {
	s := strings.Repeat("é", 400) // 2 bytes each
	for _, n := range []int{1, 2, 3, 299, 300, 301} {
		out := truncateRunes(s, n)
		assert.True(t, utf8.ValidString(out), "cap %d produced invalid UTF-8", n)
	}
	assert.Equal(t, "abc", truncateRunes("abc", 10))
}

// The job's error text is redacted and capped, and its summary keeps closed values only.
func TestJobRecordCapsItsErrorTextOnARune(t *testing.T) {
	rec := jobRecord(brandbrain.CrawlJob{ID: "job-x", Status: "failed", ErrorMessage: strings.Repeat("é", 300)})
	assert.True(t, utf8.ValidString(rec.ErrorMessage))
	assert.LessOrEqual(t, len(rec.ErrorMessage), maxErrorText+len("…"))
}

// --- the admin tool surface still answers in JSON (registration sanity) ----------------

func TestSmokeToolDescriptionsSayItIsLive(t *testing.T) {
	admin := toolNames(t, NewAdminServer(&fakePublisher{}))
	desc := admin[CrawlSmokeTool].Description
	assert.Contains(t, desc, "LIVE CRAWL")
	assert.Contains(t, desc, "FULL drain")
	assert.Contains(t, desc, "priority 100")
}
