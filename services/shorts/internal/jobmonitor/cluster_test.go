package jobmonitor

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type fakeCronSource struct {
	monitors  []CronMonitor
	runs      map[string][]CronRun
	listErr   error
	runErr    map[string]error
	runLimits []int
	runReads  int
}

func (f *fakeCronSource) ListCronMonitors(context.Context) ([]CronMonitor, error) {
	return f.monitors, f.listErr
}

func (f *fakeCronSource) ListCronRuns(_ context.Context, id string, limit int) ([]CronRun, error) {
	f.runReads++
	f.runLimits = append(f.runLimits, limit)
	if err := f.runErr[id]; err != nil {
		return nil, err
	}
	return f.runs[id], nil
}

func ago(d time.Duration) string { return time.Now().Add(-d).UTC().Format(time.RFC3339) }

// clusterRow is a job as the collector sees it the day after it moved to the
// cluster: its trigger paused and its last Cloud Run execution long past.
func clusterRow(name string, lastCloudRun time.Duration, triggers ...Trigger) *JobStatus {
	st := &JobStatus{
		Name: name, Type: "job", LastRunStatus: "succeeded",
		LastRunAt: ago(lastCloudRun), LastSuccessAt: ago(lastCloudRun),
		ExecutionName: name + "-cloudrun", LogUri: "https://console.cloud.google.com/logs",
		SucceededCount: 1, Triggers: triggers, Health: HealthUnknown,
	}
	applyPrimaryTrigger(st) // as mergeSchedulers does, before the overlay
	return st
}

func finish(st *JobStatus) {
	finalizeHealth(st)
	escalateClusterTriggers(st, time.Now())
}

// The defect this fixes: shorted-economy read "No successful run for 37d"
// on 2026-10-17 while it ran on schedule on the cluster.
func TestPausedTriggerWithAMonitorTakesItsRunsFromTelesis(t *testing.T) {
	st := clusterRow("shorted-economy", 37*24*time.Hour,
		Trigger{Name: "shorted-economy-schedule", Schedule: "0 17 5 * *", State: "PAUSED"})
	src := &fakeCronSource{
		monitors: []CronMonitor{{ID: "m-econ", Name: "shorted-economy", Status: "healthy", NextExpectedAt: "2026-11-05T17:00:00Z"}},
		runs: map[string][]CronRun{"m-econ": {{
			RunID: "shorted-economy-29312", Status: "succeeded",
			StartedAt: ago(12 * 24 * time.Hour), EndedAt: ago(12*24*time.Hour - time.Minute), DurationMs: 6066,
		}}},
	}

	if err := applyClusterRuns(context.Background(), map[string]*JobStatus{st.Name: st}, src); err != nil {
		t.Fatal(err)
	}
	finish(st)

	tr := st.Triggers[0]
	if tr.State != "CLUSTER" || tr.Runner != "kubernetes" || tr.MonitorStatus != "healthy" || tr.LastStatus != "succeeded" {
		t.Fatalf("trigger = %+v, want a CLUSTER trigger read from its monitor", tr)
	}
	if st.SchedulerState != "CLUSTER" {
		t.Errorf("schedulerState = %q, want CLUSTER (the trigger is live, not paused)", st.SchedulerState)
	}
	if st.Health != HealthOK {
		t.Errorf("health = %s (%s), want ok: the job ran 12 days ago on a monthly cadence", st.Health, st.Message)
	}
	if st.ExecutionName != "shorted-economy-29312" || st.DurationSeconds != 6.066 || st.LogUri != "" || st.SucceededCount != 0 {
		t.Errorf("row = %+v, want the cluster run's fields and none of the old Cloud Run execution's", st)
	}
	if !strings.Contains(st.Note, "omega") {
		t.Errorf("note = %q, want it to say where the job runs", st.Note)
	}
	if want := []int{clusterRunsPerMonitor}; len(src.runLimits) != 1 || src.runLimits[0] != want[0] {
		t.Errorf("run reads = %v, want one read of %d", src.runLimits, clusterRunsPerMonitor)
	}
}

func TestPausedTriggerWithoutAMonitorStillReadsAsPaused(t *testing.T) {
	st := clusterRow("signals-collector", 2*time.Hour,
		Trigger{Name: "signals-collector-weekly", Schedule: "0 13 * * 1", State: "PAUSED"})
	src := &fakeCronSource{monitors: []CronMonitor{{ID: "m1", Name: "shorted-news"}}}

	if err := applyClusterRuns(context.Background(), map[string]*JobStatus{st.Name: st}, src); err != nil {
		t.Fatal(err)
	}
	finish(st)

	if st.Triggers[0].State != "PAUSED" || src.runReads != 0 {
		t.Fatalf("trigger = %+v after %d run reads, want it left paused and no run read", st.Triggers[0], src.runReads)
	}
	if st.Health != HealthWarning {
		t.Errorf("health = %s, want the paused warning", st.Health)
	}
}

// A job with several cadences is judged per schedule: a failed weekly digest
// must not hide behind the 4-hourly runs that succeeded since.
func TestAFailedScheduleIsNotHiddenByTheJobsOtherSchedules(t *testing.T) {
	st := clusterRow("shorted-news", 17*24*time.Hour,
		Trigger{Name: "shorted-news-schedule", Schedule: "0 */4 * * *", State: "PAUSED"},
		Trigger{Name: "shorted-news-digest", Schedule: "0 1 * * 5", State: "PAUSED"})
	src := &fakeCronSource{
		monitors: []CronMonitor{
			{ID: "m-news", Name: "shorted-news", Status: "healthy"},
			{ID: "m-digest", Name: "shorted-news-digest", Status: "failing"},
		},
		runs: map[string][]CronRun{
			"m-news":   {{RunID: "shorted-news-1", Status: "succeeded", StartedAt: ago(time.Hour), EndedAt: ago(59 * time.Minute)}},
			"m-digest": {{RunID: "shorted-news-digest-1", Status: "failed", StartedAt: ago(48 * time.Hour), TerminalReason: "exit 1: gemini quota"}},
		},
	}

	if err := applyClusterRuns(context.Background(), map[string]*JobStatus{st.Name: st}, src); err != nil {
		t.Fatal(err)
	}
	finish(st)

	if st.LastRunStatus != "succeeded" || st.ExecutionName != "shorted-news-1" {
		t.Errorf("last run = %s %s, want the newest run (the 4-hourly one)", st.LastRunStatus, st.ExecutionName)
	}
	if st.Health != HealthCritical || st.Message != "shorted-news-digest: last run failed: exit 1: gemini quota" {
		t.Errorf("health = %s %q, want critical naming the failed schedule and its reason", st.Health, st.Message)
	}
}

// A missed run is an absence: the row's last run stays the last real one and
// the schedule reads overdue, not failed.
func TestAMissedRunReadsOverdue(t *testing.T) {
	st := clusterRow("shorted-index-sync", 17*24*time.Hour,
		Trigger{Name: "shorted-index-sync-schedule", Schedule: "30 11 * * *", State: "PAUSED"})
	real := ago(25 * time.Hour)
	src := &fakeCronSource{
		monitors: []CronMonitor{{ID: "m-idx", Name: "shorted-index-sync", Status: "late"}},
		runs: map[string][]CronRun{"m-idx": {
			{Status: "missed", ExpectedAt: ago(time.Hour)},
			{RunID: "shorted-index-sync-7", Status: "succeeded", StartedAt: real, EndedAt: real},
		}},
	}

	if err := applyClusterRuns(context.Background(), map[string]*JobStatus{st.Name: st}, src); err != nil {
		t.Fatal(err)
	}
	finish(st)

	if st.LastRunAt != real || st.LastRunStatus != "succeeded" {
		t.Errorf("last run = %s %s, want the last run that happened", st.LastRunAt, st.LastRunStatus)
	}
	if st.Triggers[0].LastStatus != "missed" || st.Health != HealthOverdue {
		t.Errorf("trigger %s, health %s (%s): want missed and overdue", st.Triggers[0].LastStatus, st.Health, st.Message)
	}
}

// Run now still starts the Cloud Run job; a newer Cloud Run execution stays
// the row's last run.
func TestANewerCloudRunExecutionStaysTheLastRun(t *testing.T) {
	st := clusterRow("shorted-economy", 10*time.Minute,
		Trigger{Name: "shorted-economy-schedule", Schedule: "0 17 5 * *", State: "PAUSED"})
	src := &fakeCronSource{
		monitors: []CronMonitor{{ID: "m", Name: "shorted-economy", Status: "healthy"}},
		runs:     map[string][]CronRun{"m": {{RunID: "k8s-run", Status: "succeeded", StartedAt: ago(5 * 24 * time.Hour)}}},
	}

	if err := applyClusterRuns(context.Background(), map[string]*JobStatus{st.Name: st}, src); err != nil {
		t.Fatal(err)
	}
	finish(st)

	if st.ExecutionName != "shorted-economy-cloudrun" || st.LogUri == "" {
		t.Errorf("row = %s %q, want the newer Cloud Run execution kept", st.ExecutionName, st.LogUri)
	}
}

func TestTelesisUnavailableLeavesTheRowsAsTheyWere(t *testing.T) {
	st := clusterRow("shorted-economy", 37*24*time.Hour,
		Trigger{Name: "shorted-economy-schedule", Schedule: "0 17 5 * *", State: "PAUSED"})
	src := &fakeCronSource{listErr: errors.New("telesis CronMonitorService/ListCronMonitors: permission_denied: organization access required")}

	err := applyClusterRuns(context.Background(), map[string]*JobStatus{st.Name: st}, src)
	if err == nil || !strings.Contains(err.Error(), "permission_denied") {
		t.Fatalf("err = %v, want the Telesis error surfaced", err)
	}
	if st.Triggers[0].State != "PAUSED" {
		t.Errorf("trigger state = %s, want it untouched", st.Triggers[0].State)
	}
}

// A run history that cannot be read leaves the trigger on its monitor's own
// summary, rather than dropping back to "paused".
func TestUnreadableRunHistoryFallsBackToTheMonitorStatus(t *testing.T) {
	st := clusterRow("shorted-economy", 37*24*time.Hour,
		Trigger{Name: "shorted-economy-schedule", Schedule: "0 17 5 * *", State: "PAUSED"})
	src := &fakeCronSource{
		monitors: []CronMonitor{{ID: "m", Name: "shorted-economy", Status: "failing", LastRunAt: ago(time.Hour)}},
		runErr:   map[string]error{"m": errors.New("HTTP 502")},
	}

	err := applyClusterRuns(context.Background(), map[string]*JobStatus{st.Name: st}, src)
	if err == nil {
		t.Fatal("want the run read failure reported")
	}
	finish(st)

	if st.Triggers[0].State != "CLUSTER" || st.Triggers[0].LastStatus != "failed" || st.Health != HealthCritical {
		t.Errorf("trigger %+v, health %s: want CLUSTER, failed from the monitor, critical", st.Triggers[0], st.Health)
	}
}

func TestMonitorForTrigger(t *testing.T) {
	monitors := map[string]CronMonitor{"shorted-news": {Name: "shorted-news"}, "shorted-news-cluster": {Name: "shorted-news-cluster"}}
	for trigger, want := range map[string]string{
		"shorted-news-schedule": "shorted-news",
		"shorted-news-cluster":  "shorted-news-cluster",
		"shorted-news-digest":   "",
		"shorted-economy":       "",
	} {
		m, ok := monitorForTrigger(monitors, trigger)
		if (want == "") == ok || m.Name != want {
			t.Errorf("monitorForTrigger(%q) = %q, %v; want %q", trigger, m.Name, ok, want)
		}
	}
}

// Telesis returns runs inside its plan's retention window only. A monthly job
// whose last run is older than that is read off its monitor, not off its
// old Cloud Run history.
func TestARunOutsideTelesisRetentionIsReadOffTheMonitor(t *testing.T) {
	st := clusterRow("shorted-economy", 37*24*time.Hour,
		Trigger{Name: "shorted-economy-schedule", Schedule: "0 17 5 * *", State: "PAUSED"})
	lastRun := ago(12 * 24 * time.Hour)
	src := &fakeCronSource{
		monitors: []CronMonitor{{ID: "m", Name: "shorted-economy", Status: "healthy", LastRunAt: lastRun}},
		runs:     map[string][]CronRun{"m": nil},
	}

	if err := applyClusterRuns(context.Background(), map[string]*JobStatus{st.Name: st}, src); err != nil {
		t.Fatal(err)
	}
	finish(st)

	if st.LastRunAt != lastRun || st.LastSuccessAt != lastRun || st.Health != HealthOK {
		t.Errorf("row last run %s, success %s, health %s (%s); want the monitor's last run and ok",
			st.LastRunAt, st.LastSuccessAt, st.Health, st.Message)
	}
}

func TestScheduledServicesAreNeverReadAsClusterJobs(t *testing.T) {
	st := &JobStatus{Name: "stock-price-daily-sync", Type: "service",
		Triggers: []Trigger{{Name: "stock-price-daily-sync", Schedule: "0 8 * * 1-5", State: "PAUSED"}}}
	src := &fakeCronSource{monitors: []CronMonitor{{ID: "m", Name: "stock-price-daily-sync", Status: "healthy"}}}

	if err := applyClusterRuns(context.Background(), map[string]*JobStatus{st.Name: st}, src); err != nil {
		t.Fatal(err)
	}
	if st.Triggers[0].State != "PAUSED" {
		t.Errorf("service trigger state = %s, want it left paused", st.Triggers[0].State)
	}
}
