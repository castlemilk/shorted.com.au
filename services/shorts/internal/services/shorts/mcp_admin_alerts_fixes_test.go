package shorts

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// M1: a monitor that already has an event for the date is refused before the replay.
// Without the check, the replay inserts nothing and the old row reads as this run's.
func TestRunAlertsSmokeRefusesADateTheMonitorAlreadyHas(t *testing.T) {
	written := time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)
	store := &fakeAdminAlertsStore{window: crossingWindow(), onDateOwned: true,
		onDateEvents: []shortsstore.AdminAlertEvent{{ID: 9, EmailStatus: "sent", CreatedAt: written, RunID: 42}}}
	jobs := &fakeAlertJobs{}
	_, err := smokeSource(store, jobs, true, adminAddress).RunAlertsSmoke(context.Background(), adminUID, "", mcp.RunAlertsSmokeInput{Code: "ABC"})
	require.Error(t, err)
	assert.ErrorContains(t, err, "already has an alert event for 2026-10-21")
	assert.ErrorContains(t, err, "status sent")
	assert.ErrorContains(t, err, "run 42")
	assert.ErrorContains(t, err, "Nothing was started")
	assert.Empty(t, jobs.runs, "no replay may start when the date already has a row")
}

// M1, the other half: a result whose row was written before the execution started is
// flagged, so an old row cannot pass for this replay.
func TestAlertsSmokeResultFlagsARowWrittenBeforeTheReplay(t *testing.T) {
	store := &fakeAdminAlertsStore{onDateOwned: true, onDateEvents: []shortsstore.AdminAlertEvent{
		{ID: 1, EmailStatus: "sent", CreatedAt: time.Date(2026, 10, 23, 8, 0, 0, 0, time.UTC), RunID: 7},
		{ID: 2, EmailStatus: "sent", CreatedAt: time.Date(2026, 10, 24, 10, 5, 0, 0, time.UTC), RunID: 8},
	}}
	jobs := &fakeAlertJobs{status: &jobmonitor.ExecutionStatus{ExecutionName: "shorted-alerts-replay-x", Status: "succeeded", StartedAt: "2026-10-24T10:00:00Z"}}
	out, err := smokeSource(store, jobs, true, "").AlertsSmokeResult(context.Background(), adminUID,
		mcp.AlertsSmokeResultInput{MonitorID: smokeMonID, Date: "2026-10-21", Execution: "shorted-alerts-replay-x"})
	require.NoError(t, err)
	require.Len(t, out.Events, 2)
	assert.True(t, out.Events[0].PredatesExecution, "written 2026-10-23, before the 2026-10-24 replay")
	assert.False(t, out.Events[1].PredatesExecution)
	assert.Equal(t, int64(7), out.Events[0].RunID)
	assert.Equal(t, "2026-10-23T08:00:00Z", out.Events[0].CreatedAt)
	assert.Contains(t, out.Next, "written before this replay started")
}

// Without an execution there is nothing to compare with, so nothing is flagged.
func TestAlertsSmokeResultFlagsNothingWithoutAnExecution(t *testing.T) {
	store := &fakeAdminAlertsStore{onDateOwned: true, onDateEvents: []shortsstore.AdminAlertEvent{
		{EmailStatus: "sent", CreatedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)},
	}}
	out, err := smokeSource(store, &fakeAlertJobs{}, true, "").AlertsSmokeResult(context.Background(), adminUID,
		mcp.AlertsSmokeResultInput{MonitorID: smokeMonID, Date: "2026-10-21"})
	require.NoError(t, err)
	assert.False(t, out.Events[0].PredatesExecution)
	assert.NotContains(t, out.Next, "before this replay")
}

// The run output says the replay is not limited to the smoke monitor.
func TestRunAlertsSmokeSaysTheReplayAlsoEmailsOtherMonitors(t *testing.T) {
	store := &fakeAdminAlertsStore{window: crossingWindow()}
	out, err := smokeSource(store, &fakeAlertJobs{}, true, adminAddress).RunAlertsSmoke(context.Background(), adminUID, "", mcp.RunAlertsSmokeInput{Code: "ABC"})
	require.NoError(t, err)
	assert.Contains(t, out.Also, "also emails any other daily monitor")
}

// L4: the owner's id is checked before anything is created under it.
func TestRunAlertsSmokeRefusesAMalformedOwnerBeforeCreating(t *testing.T) {
	store := &fakeAdminAlertsStore{window: crossingWindow()}
	jobs := &fakeAlertJobs{}
	_, err := smokeSource(store, jobs, true, adminAddress).RunAlertsSmoke(context.Background(), "-injected", "", mcp.RunAlertsSmokeInput{Code: "ABC"})
	require.Error(t, err)
	assert.ErrorContains(t, err, "not a Firebase uid")
	assert.Empty(t, store.created)
	assert.Empty(t, jobs.runs)
}

// The reuse rule matches the target, the threshold, the condition, the cadence, the
// scope and the status. Each near-miss below is NOT reused: a new monitor is created.
func TestEnsureSmokeMonitorReusesOnlyAnExactMatch(t *testing.T) {
	th5, th6 := 5.0, 6.0
	base := func() *shortsstore.AlertMonitor {
		return &shortsstore.AlertMonitor{ID: "near-miss", UserID: adminUID, UserEmail: adminAddress, Scope: "stock", Target: "ABC",
			Condition: "short_interest_above", Threshold: &th5, Cadence: "daily", Status: "active", CreatedAt: time.Now()}
	}
	nearMisses := map[string]func(m *shortsstore.AlertMonitor){
		"weekly cadence":         func(m *shortsstore.AlertMonitor) { m.Cadence = "weekly" },
		"different threshold":    func(m *shortsstore.AlertMonitor) { m.Threshold = &th6 },
		"different stock":        func(m *shortsstore.AlertMonitor) { m.Target = "XYZ" },
		"rises instead of above": func(m *shortsstore.AlertMonitor) { m.Condition = "short_interest_rises" },
		"industry scope":         func(m *shortsstore.AlertMonitor) { m.Scope = "industry" },
		"paused":                 func(m *shortsstore.AlertMonitor) { m.Status = alertevents.MonitorStatusPaused },
		"no threshold":           func(m *shortsstore.AlertMonitor) { m.Threshold = nil },
	}
	for name, mutate := range nearMisses {
		t.Run(name, func(t *testing.T) {
			m := base()
			mutate(m)
			store := &fakeAdminAlertsStore{window: crossingWindow(), monitors: []*shortsstore.AlertMonitor{m}}
			out, err := smokeSource(store, &fakeAlertJobs{}, true, adminAddress).RunAlertsSmoke(context.Background(), adminUID, "", mcp.RunAlertsSmokeInput{Code: "ABC"})
			require.NoError(t, err)
			assert.Equal(t, "created", out.MonitorState, "%s must not be reused", name)
			assert.Len(t, store.created, 1)
		})
	}
}

// The reuse search reads past the first page: an identical monitor on page two is
// found, not duplicated. A pager that stops after one page creates a duplicate here.
func TestEnsureSmokeMonitorReadsASecondPage(t *testing.T) {
	th := 5.0
	var monitors []*shortsstore.AlertMonitor
	for i := 0; i < 150; i++ {
		target := fmt.Sprintf("OT%03d", i)
		if i == 120 {
			target = "ABC"
		}
		monitors = append(monitors, &shortsstore.AlertMonitor{ID: fmt.Sprintf("m-%03d", i), UserID: adminUID, UserEmail: adminAddress,
			Scope: "stock", Target: target, Condition: "short_interest_above", Threshold: &th, Cadence: "daily", Status: "active", CreatedAt: time.Now()})
	}
	store := &fakeAdminAlertsStore{window: crossingWindow(), monitors: monitors}
	out, err := smokeSource(store, &fakeAlertJobs{}, true, adminAddress).RunAlertsSmoke(context.Background(), adminUID, "", mcp.RunAlertsSmokeInput{Code: "ABC"})
	require.NoError(t, err)
	assert.Equal(t, "reused", out.MonitorState)
	assert.Equal(t, "m-120", out.MonitorID)
	assert.Empty(t, store.created)
}

// L2: another owner's event carries no monitor id and no error text, because the error
// text can name that owner's subscription status.
func TestAlertsStatusBlanksAnotherOwnersIdAndErrorText(t *testing.T) {
	store := &fakeAdminAlertsStore{
		events: []shortsstore.AdminAlertEvent{
			{ID: 1, MonitorID: "other-mon-id", UserID: "uid-victim", Target: "XYZ", EmailStatus: "skipped_unentitled",
				LastError: "entitlement: status=canceled"},
			{ID: 2, MonitorID: smokeMonID, UserID: adminUID, Target: "ABC", EmailStatus: "failed", LastError: "resend: 422"},
		},
	}
	out, err := smokeSource(store, &fakeAlertJobs{}, true, "").AlertsStatus(context.Background(), adminUID)
	require.NoError(t, err)
	require.Len(t, out.Events, 2)
	assert.False(t, out.Events[0].Own)
	assert.Empty(t, out.Events[0].MonitorID)
	assert.Empty(t, out.Events[0].LastError)
	assert.True(t, out.Events[1].Own)
	assert.Equal(t, smokeMonID, out.Events[1].MonitorID)
	assert.Equal(t, "resend: 422", out.Events[1].LastError)
	raw, err := json.Marshal(out)
	require.NoError(t, err)
	assert.False(t, strings.Contains(string(raw), "canceled"))
	assert.False(t, strings.Contains(string(raw), "other-mon-id"))
}
