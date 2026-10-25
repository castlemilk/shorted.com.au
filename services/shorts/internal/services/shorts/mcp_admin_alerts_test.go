package shorts

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

const (
	adminUID     = "uid-admin"
	adminAddress = "ben@shorted.com.au"
	smokeMonID   = "7d2c4f1e-0a9b-4c3d-8e2f-1a2b3c4d5e6f"
)

// fakeAdminAlertsStore records every call the admin alerts path makes, so a test
// can say what was written, for whom, and what was not touched.
type fakeAdminAlertsStore struct {
	window         shortsstore.AlertWindow
	monitors       []*shortsstore.AlertMonitor
	created        []shortsstore.CreateAlertMonitorInput
	refreshed      []string
	deleted        []string
	deleteErr      error
	counts         []shortsstore.AlertMonitorCount
	runs           []shortsstore.AdminAlertRun
	events         []shortsstore.AdminAlertEvent
	onDateOwned    bool
	onDateEvents   []shortsstore.AdminAlertEvent
	checkedThrough string
	delivery       shortsstore.AlertDeliveryHealth
}

func (f *fakeAdminAlertsStore) AdminAlertDeliveryHealth(context.Context) (shortsstore.AlertDeliveryHealth, error) {
	return f.delivery, nil
}

func (f *fakeAdminAlertsStore) ReportWindow(context.Context) (shortsstore.AlertWindow, error) {
	return f.window, nil
}
func (f *fakeAdminAlertsStore) AdminAlertMonitorCounts(context.Context) ([]shortsstore.AlertMonitorCount, error) {
	return f.counts, nil
}
func (f *fakeAdminAlertsStore) AdminAlertEvaluatorRuns(context.Context, int) ([]shortsstore.AdminAlertRun, error) {
	return f.runs, nil
}
func (f *fakeAdminAlertsStore) AdminRecentAlertEvents(context.Context, int) ([]shortsstore.AdminAlertEvent, error) {
	return f.events, nil
}
func (f *fakeAdminAlertsStore) AdminAlertEventsOnDate(context.Context, string, string, string) (bool, []shortsstore.AdminAlertEvent, error) {
	return f.onDateOwned, f.onDateEvents, nil
}
func (f *fakeAdminAlertsStore) CreateAlertMonitor(input shortsstore.CreateAlertMonitorInput) (*shortsstore.AlertMonitor, error) {
	f.created = append(f.created, input)
	th := input.Threshold
	m := &shortsstore.AlertMonitor{ID: smokeMonID, UserID: input.UserID, UserEmail: input.UserEmail, Scope: input.Scope,
		Target: input.Target, Condition: input.Condition, Threshold: th, Cadence: input.Cadence, Status: "active", CreatedAt: time.Now()}
	f.monitors = append(f.monitors, m)
	return m, nil
}
func (f *fakeAdminAlertsStore) ListAlertMonitors(userID string, limit, offset int32) ([]*shortsstore.AlertMonitor, int32, error) {
	var mine []*shortsstore.AlertMonitor
	for _, m := range f.monitors {
		if m.UserID == userID {
			mine = append(mine, m)
		}
	}
	total := int32(len(mine))
	if int(offset) > len(mine) {
		return nil, total, nil
	}
	end := int(offset) + int(limit)
	if end > len(mine) {
		end = len(mine)
	}
	return mine[offset:end], total, nil
}
func (f *fakeAdminAlertsStore) UpdateAlertMonitorStatus(string, string, string, string) (*shortsstore.AlertMonitor, error) {
	return nil, errors.New("not used by the admin path")
}
func (f *fakeAdminAlertsStore) RefreshAlertMonitorEmail(userID, email string) error {
	f.refreshed = append(f.refreshed, userID+"="+email)
	for _, m := range f.monitors {
		if m.UserID == userID {
			m.UserEmail = email
		}
	}
	return nil
}
func (f *fakeAdminAlertsStore) DeleteAlertMonitor(userID, monitorID string) error {
	f.deleted = append(f.deleted, userID+"/"+monitorID)
	return f.deleteErr
}
func (f *fakeAdminAlertsStore) CanonicalIndustry(string) (string, bool, error) { return "", false, nil }
func (f *fakeAdminAlertsStore) StockCodeKnown(string) (bool, error)            { return true, nil }
func (f *fakeAdminAlertsStore) AlertCheckedThrough() (string, error)           { return f.checkedThrough, nil }

// fakeAlertJobs records replays and answers their status.
type fakeAlertJobs struct {
	runs   []jobmonitor.AlertsReplayRequest
	runErr error
	polled []string
	status *jobmonitor.ExecutionStatus
}

func (f *fakeAlertJobs) RunAlertsReplay(_ context.Context, req jobmonitor.AlertsReplayRequest) (*jobmonitor.AlertsReplayRun, error) {
	f.runs = append(f.runs, req)
	if f.runErr != nil {
		return nil, f.runErr
	}
	return &jobmonitor.AlertsReplayRun{Job: jobmonitor.AlertsReplayJobName, ExecutionName: "shorted-alerts-replay-ab12c", Date: req.Date,
		Args: []string{"alerts", "-date", req.Date, "-user", req.UserID, "-canary", "off"}}, nil
}

func (f *fakeAlertJobs) AlertsReplayResult(_ context.Context, name string) (*jobmonitor.ExecutionStatus, error) {
	f.polled = append(f.polled, name)
	if f.status != nil {
		return f.status, nil
	}
	return &jobmonitor.ExecutionStatus{ExecutionName: name, Status: "running"}, nil
}

// smokeInput is the smoke test's input for ABC, the crossing crossingWindow holds.
func smokeInput() mcp.RunAlertsSmokeInput { return mcp.RunAlertsSmokeInput{Code: "ABC"} }

// crossingWindow is a window where ABC crossed 5 on 2026-10-21 (4.0 -> 5.5).
func crossingWindow() shortsstore.AlertWindow {
	start, _ := time.Parse("2006-01-02", "2026-10-22")
	w := shortsstore.AlertWindow{Readings: map[string]map[string]float64{}, Names: map[string]string{"ABC": "ABC Holdings"}}
	for i := 0; i < shortsstore.AlertWindowDates; i++ {
		day := start.AddDate(0, 0, -i).Format("2006-01-02")
		w.Dates = append(w.Dates, day)
		w.Readings[day] = map[string]float64{"XYZ": 1}
	}
	// ABC: 5.6 on the newest date, 5.5 the day before (a crossing against 4.0, the day
	// before that). 2026-10-22 is index 0 and 2026-10-21 is index 1.
	w.Readings[w.Dates[0]]["ABC"] = 5.6
	w.Readings[w.Dates[1]]["ABC"] = 5.5
	w.Readings[w.Dates[2]]["ABC"] = 4.0
	return w
}

func smokeSource(store *fakeAdminAlertsStore, jobs *fakeAlertJobs, entitled bool, verified string) *adminMCPSource {
	src := &adminMCPSource{
		alerts:    store,
		alertJobs: jobs,
		entitled:  func(string) (bool, error) { return entitled, nil },
	}
	if verified != "" {
		src.verifiedEmail = func(context.Context, string) (string, error) { return verified, nil }
	}
	return src
}

// The smoke test is refused, before anything is written, for an account without
// Premium: the evaluator would skip its mail.
func TestRunAlertsSmokeRefusesWithoutPremiumBeforeAnyWrite(t *testing.T) {
	store := &fakeAdminAlertsStore{window: crossingWindow()}
	jobs := &fakeAlertJobs{}
	_, err := smokeSource(store, jobs, false, adminAddress).RunAlertsSmoke(context.Background(), adminUID, "oauth:"+adminUID, mcp.RunAlertsSmokeInput{})
	require.Error(t, err)
	assert.ErrorContains(t, err, "no active Premium subscription")
	assert.Empty(t, store.created)
	assert.Empty(t, store.refreshed)
	assert.Empty(t, jobs.runs)
}

// Without a verified address source the smoke test refuses before it creates
// anything. It never falls back to a guessed or unverified address.
func TestRunAlertsSmokeRefusesWithoutAVerifiedAddress(t *testing.T) {
	store := &fakeAdminAlertsStore{window: crossingWindow()}
	jobs := &fakeAlertJobs{}
	_, err := smokeSource(store, jobs, true, "").RunAlertsSmoke(context.Background(), adminUID, "oauth:"+adminUID, mcp.RunAlertsSmokeInput{})
	require.Error(t, err)
	assert.ErrorContains(t, err, "cannot read your verified address")
	assert.Empty(t, store.created)
	assert.Empty(t, jobs.runs)
}

// A verified address that is not an address is refused the same way.
func TestRunAlertsSmokeRefusesAnUnusableAddress(t *testing.T) {
	store := &fakeAdminAlertsStore{window: crossingWindow()}
	src := smokeSource(store, &fakeAlertJobs{}, true, "")
	src.verifiedEmail = func(context.Context, string) (string, error) { return "not-an-address", nil }
	_, err := src.RunAlertsSmoke(context.Background(), adminUID, "oauth:"+adminUID, mcp.RunAlertsSmokeInput{})
	assert.ErrorContains(t, err, "cannot read your verified address")
	assert.Empty(t, store.created)
}

// The happy path: the crossing is found by the evaluator's rule, the monitor is
// created for the caller through the shared rule with the VERIFIED address, and the
// replay names the caller and the crossing's date, with -canary off.
func TestRunAlertsSmokeCreatesAndReplaysForTheCallerOnly(t *testing.T) {
	store := &fakeAdminAlertsStore{window: crossingWindow()}
	jobs := &fakeAlertJobs{}
	out, err := smokeSource(store, jobs, true, adminAddress).RunAlertsSmoke(context.Background(), adminUID, "oauth:"+adminUID, mcp.RunAlertsSmokeInput{Code: "abc"})
	require.NoError(t, err)

	require.Len(t, store.created, 1)
	created := store.created[0]
	assert.Equal(t, adminUID, created.UserID)
	assert.Equal(t, adminAddress, created.UserEmail, "the monitor's address is the verified one")
	assert.Equal(t, "stock", created.Scope)
	assert.Equal(t, "ABC", created.Target)
	assert.Equal(t, "short_interest_above", created.Condition)
	assert.Equal(t, "daily", created.Cadence)
	require.NotNil(t, created.Threshold)
	assert.Equal(t, 5.0, *created.Threshold)

	require.Len(t, jobs.runs, 1)
	assert.Equal(t, jobmonitor.AlertsReplayRequest{Date: "2026-10-21", UserID: adminUID, Actor: "oauth:" + adminUID}, jobs.runs[0])

	assert.Equal(t, "created", out.MonitorState)
	assert.Equal(t, "2026-10-21", out.Date)
	assert.Equal(t, "2026-10-20", out.ComparedToDate)
	assert.Equal(t, "b***@shorted.com.au", out.EmailTo)
	assert.Equal(t, "shorted-alerts-replay-ab12c", out.Execution)
	// The full address never leaves this function.
	raw, err := json.Marshal(out)
	require.NoError(t, err)
	assert.NotContains(t, string(raw), adminAddress)
}

// An identical active monitor is reused, not duplicated, and its address is brought
// up to the verified one.
func TestRunAlertsSmokeReusesAnIdenticalMonitor(t *testing.T) {
	th := 5.0
	store := &fakeAdminAlertsStore{window: crossingWindow(), monitors: []*shortsstore.AlertMonitor{{
		ID: smokeMonID, UserID: adminUID, UserEmail: "old@example.com", Scope: "stock", Target: "ABC",
		Condition: "short_interest_above", Threshold: &th, Cadence: "daily", Status: "active", CreatedAt: time.Now(),
	}}}
	jobs := &fakeAlertJobs{}
	out, err := smokeSource(store, jobs, true, adminAddress).RunAlertsSmoke(context.Background(), adminUID, "oauth:"+adminUID, mcp.RunAlertsSmokeInput{Code: "ABC"})
	require.NoError(t, err)
	assert.Empty(t, store.created, "an identical monitor must be reused")
	assert.Equal(t, []string{adminUID + "=" + adminAddress}, store.refreshed)
	assert.Equal(t, "reused", out.MonitorState)
	assert.Equal(t, smokeMonID, out.MonitorID)
}

// A paused identical monitor is not reused: the smoke test needs an active one.
func TestRunAlertsSmokeCreatesWhenTheIdenticalMonitorIsPaused(t *testing.T) {
	th := 5.0
	store := &fakeAdminAlertsStore{window: crossingWindow(), monitors: []*shortsstore.AlertMonitor{{
		ID: "paused-one", UserID: adminUID, UserEmail: adminAddress, Scope: "stock", Target: "ABC",
		Condition: "short_interest_above", Threshold: &th, Cadence: "daily", Status: "paused", CreatedAt: time.Now(),
	}}}
	out, err := smokeSource(store, &fakeAlertJobs{}, true, adminAddress).RunAlertsSmoke(context.Background(), adminUID, "", mcp.RunAlertsSmokeInput{Code: "ABC"})
	require.NoError(t, err)
	assert.Len(t, store.created, 1)
	assert.Equal(t, "created", out.MonitorState)
}

// With a date, the date must be one the stock crossed on. Otherwise nothing is
// created or replayed.
func TestRunAlertsSmokeReplaysOnlyADateTheStockCrossed(t *testing.T) {
	store := &fakeAdminAlertsStore{window: crossingWindow()}
	jobs := &fakeAlertJobs{}
	_, err := smokeSource(store, jobs, true, adminAddress).RunAlertsSmoke(context.Background(), adminUID, "", mcp.RunAlertsSmokeInput{Code: "ABC", Date: "2026-10-22"})
	require.Error(t, err)
	assert.EqualError(t, err, "ABC did not cross 5 on 2026-10-22")
	assert.Empty(t, store.created)
	assert.Empty(t, jobs.runs)
}

// No crossing in the window: nothing is created and nothing is replayed.
func TestRunAlertsSmokeWithNoCrossingChangesNothing(t *testing.T) {
	store := &fakeAdminAlertsStore{window: crossingWindow()}
	jobs := &fakeAlertJobs{}
	_, err := smokeSource(store, jobs, true, adminAddress).RunAlertsSmoke(context.Background(), adminUID, "", mcp.RunAlertsSmokeInput{Code: "XYZ"})
	require.Error(t, err)
	assert.ErrorContains(t, err, "nothing to replay")
	assert.Empty(t, store.created)
	assert.Empty(t, jobs.runs)
}

// A refused replay says the monitor was left in place, so the admin can clean up.
func TestRunAlertsSmokeNamesTheMonitorWhenTheReplayIsRefused(t *testing.T) {
	store := &fakeAdminAlertsStore{window: crossingWindow()}
	jobs := &fakeAlertJobs{runErr: &jobmonitor.AlreadyRunningError{Job: jobmonitor.AlertsReplayJobName, ExecutionName: "shorted-alerts-replay-old"}}
	_, err := smokeSource(store, jobs, true, adminAddress).RunAlertsSmoke(context.Background(), adminUID, "", mcp.RunAlertsSmokeInput{Code: "ABC"})
	require.Error(t, err)
	assert.ErrorContains(t, err, "already running")
	assert.ErrorContains(t, err, smokeMonID)
	assert.ErrorContains(t, err, "left in place")
}

// The owner in a stored run note is the caller's own or "one"; another owner's id
// never reaches the output.
func TestScrubRunNoteKeepsOnlyTheCallersOwnId(t *testing.T) {
	assert.Equal(t, "replay 2026-10-21 user=uid-admin", scrubRunNote("replay 2026-10-21 user=uid-admin", adminUID))
	assert.Equal(t, "replay 2026-10-21 user=one", scrubRunNote("replay 2026-10-21 user=uid-victim", adminUID))
	assert.Equal(t, "replay 2026-10-21 user=all", scrubRunNote("replay 2026-10-21 user=all", adminUID))
	assert.Equal(t, "bootstrap", scrubRunNote("bootstrap", adminUID))
}

// The status tool never returns another owner's address or id, while the counts and
// the events still answer the operator's question.
func TestAlertsStatusNeverReturnsAnotherOwnersAddressOrId(t *testing.T) {
	store := &fakeAdminAlertsStore{
		counts: []shortsstore.AlertMonitorCount{{Status: "active", Cadence: "daily", Count: 3}},
		runs: []shortsstore.AdminAlertRun{{ID: 9, StartedAt: time.Now(), Outcome: "succeeded",
			Note: "replay 2026-10-21 user=uid-victim", Error: strings.Repeat("e", 300)}},
		events: []shortsstore.AdminAlertEvent{
			{ID: 1, MonitorID: "other-mon", UserID: "uid-victim", Target: "XYZ", ReportDate: "2026-10-21", EmailStatus: "sent", LastError: ""},
			{ID: 2, MonitorID: smokeMonID, UserID: adminUID, Target: "ABC", ReportDate: "2026-10-21", EmailStatus: "sent"},
		},
		monitors: []*shortsstore.AlertMonitor{{ID: smokeMonID, UserID: adminUID, UserEmail: adminAddress, Scope: "stock", Target: "ABC",
			Condition: "short_interest_above", Cadence: "daily", Status: "active", CreatedAt: time.Now()}},
	}
	out, err := smokeSource(store, &fakeAlertJobs{}, true, "").AlertsStatus(context.Background(), adminUID)
	require.NoError(t, err)

	raw, err := json.Marshal(out)
	require.NoError(t, err)
	body := string(raw)
	assert.NotContains(t, body, "uid-victim", "another owner's id must not appear")
	assert.NotContains(t, body, adminAddress, "the caller's address must not appear either: only hasEmail")
	assert.Contains(t, body, `"hasEmail":true`)

	require.Len(t, out.Events, 2)
	assert.False(t, out.Events[0].Own)
	assert.True(t, out.Events[1].Own)
	assert.Equal(t, "replay 2026-10-21 user=one", out.Runs[0].Note)
	assert.Len(t, out.Runs[0].Error, 200, "a stored error is capped")
	assert.Equal(t, 1, out.MineTotal)
}

// Another owner's monitor reads as not found, whatever the id names.
func TestAlertsSmokeResultIsOwnerScoped(t *testing.T) {
	store := &fakeAdminAlertsStore{onDateOwned: false, onDateEvents: []shortsstore.AdminAlertEvent{{EmailStatus: "sent"}}}
	_, err := smokeSource(store, &fakeAlertJobs{}, true, "").AlertsSmokeResult(context.Background(), adminUID,
		mcp.AlertsSmokeResultInput{MonitorID: smokeMonID, Date: "2026-10-21"})
	require.Error(t, err)
	assert.ErrorContains(t, err, "alert monitor not found")
}

func TestAlertsSmokeResultReportsTheEventAndTheExecution(t *testing.T) {
	store := &fakeAdminAlertsStore{onDateOwned: true, onDateEvents: []shortsstore.AdminAlertEvent{{
		EmailStatus: "sent", EmailAttempts: 1, HasResendID: true, LastError: "",
	}}}
	jobs := &fakeAlertJobs{status: &jobmonitor.ExecutionStatus{ExecutionName: "shorted-alerts-replay-ab12c", Status: "succeeded"}}
	out, err := smokeSource(store, jobs, true, "").AlertsSmokeResult(context.Background(), adminUID,
		mcp.AlertsSmokeResultInput{MonitorID: smokeMonID, Date: "2026-10-21", Execution: "shorted-alerts-replay-ab12c"})
	require.NoError(t, err)
	require.Len(t, out.Events, 1)
	assert.Equal(t, "sent", out.Events[0].EmailStatus)
	require.NotNil(t, out.Replay)
	assert.Equal(t, "succeeded", out.Replay.Status)
	assert.Equal(t, []string{"shorted-alerts-replay-ab12c"}, jobs.polled)
	assert.Contains(t, out.Next, "Sent to the verified address")
}

func TestSmokeResultNextSaysWhatTheEventMeans(t *testing.T) {
	assert.Contains(t, smokeResultNext(nil), "No event for this monitor")
	assert.Contains(t, smokeResultNext([]mcp.AlertsSmokeEvent{{EmailStatus: alertevents.StatusPending}}), "Still queued")
	assert.Contains(t, smokeResultNext([]mcp.AlertsSmokeEvent{{EmailStatus: alertevents.StatusFailed}}), "Not delivered (failed)")
}

// The delete path is the shared owner-checked one: the store is asked for the
// caller's uid and the id, and a monitor the store does not find is not found.
func TestDeleteOwnAlertMonitorIsOwnerChecked(t *testing.T) {
	store := &fakeAdminAlertsStore{deleteErr: shortsstore.ErrAlertMonitorNotFound}
	err := smokeSource(store, &fakeAlertJobs{}, true, "").DeleteOwnAlertMonitor(context.Background(), adminUID, smokeMonID)
	require.Error(t, err)
	assert.ErrorContains(t, err, "alert monitor not found")
	assert.Equal(t, []string{adminUID + "/" + smokeMonID}, store.deleted)
}

// The shared rule's refusals map to the Connect codes the web handlers have always
// used, so the wire contract cannot change under the refactor.
func TestAlertsRefusalKindsMapToTheirConnectCodes(t *testing.T) {
	cases := map[alertsErrorKind]connect.Code{
		alertsKindPermission: connect.CodePermissionDenied,
		alertsKindInvalid:    connect.CodeInvalidArgument,
		alertsKindNotFound:   connect.CodeNotFound,
		alertsKindExists:     connect.CodeAlreadyExists,
		alertsKindLimit:      connect.CodeResourceExhausted,
		alertsKindInternal:   connect.CodeInternal,
	}
	for kind, want := range cases {
		err := alertsConnectError(alertsFail(kind, errors.New("message")))
		assert.Equal(t, want, connect.CodeOf(err))
		assert.ErrorContains(t, err, "message")
	}
}

// The delivery feedback is counts only: the status reports how many alerts bounced or
// complained and how many addresses are suppressed, and never names an address.
func TestAlertsStatusReportsDeliveryFeedbackAsCountsOnly(t *testing.T) {
	store := &fakeAdminAlertsStore{
		delivery: shortsstore.AlertDeliveryHealth{Bounced: 2, Complained: 1, Suppressed: 3},
		monitors: []*shortsstore.AlertMonitor{{ID: smokeMonID, UserID: adminUID, UserEmail: adminAddress, Scope: "stock", Target: "ABC",
			Condition: "short_interest_above", Cadence: "daily", Status: "active", CreatedAt: time.Now()}},
	}
	out, err := smokeSource(store, &fakeAlertJobs{}, true, "").AlertsStatus(context.Background(), adminUID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), out.Delivery.Bounced)
	assert.Equal(t, int64(1), out.Delivery.Complained)
	assert.Equal(t, int64(3), out.Delivery.Suppressed)

	raw, err := json.Marshal(out)
	require.NoError(t, err)
	assert.NotContains(t, string(raw), "@", "no address may appear in the delivery feedback")
}
