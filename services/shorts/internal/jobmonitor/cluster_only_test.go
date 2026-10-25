package jobmonitor

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"sigs.k8s.io/yaml"
)

// finishRows judges every row the way collectWith does after the cluster read.
func finishRows(byName map[string]*JobStatus) map[string]JobStatus {
	now := time.Now()
	out := map[string]JobStatus{}
	for name, st := range byName {
		finalizeHealth(st)
		escalateClusterTriggers(st, now)
		out[name] = *st
	}
	return out
}

func TestClusterOnlyJobReadsItsTelesisMonitor(t *testing.T) {
	byName := map[string]*JobStatus{}
	var order []string
	addClusterOnlyJobs(byName, &order)
	src := &fakeCronSource{
		monitors: []CronMonitor{{
			ID: "m-alerts", Name: "shorted-alerts", Status: "healthy", Armed: true,
			Schedule: "55 * * * 1-5", LastRunAt: ago(10 * time.Minute),
		}},
		runs: map[string][]CronRun{"m-alerts": {{
			RunID: "shorted-alerts-29000001", Status: "succeeded",
			StartedAt: ago(10 * time.Minute), EndedAt: ago(9 * time.Minute),
		}}},
	}

	if err := applyClusterRuns(context.Background(), byName, src); err != nil {
		t.Fatal(err)
	}
	row := finishRows(byName)["shorted-alerts"]

	if row.Type != "job" {
		t.Errorf("Type = %q, want job", row.Type)
	}
	if row.SchedulerState != clusterTriggerState {
		t.Errorf("SchedulerState = %q, want %q (live on the cluster, not paused)", row.SchedulerState, clusterTriggerState)
	}
	if row.Schedule != "55 * * * 1-5" {
		t.Errorf("Schedule = %q, want the monitor's cron", row.Schedule)
	}
	if row.LastRunStatus != "succeeded" || row.Health != HealthOK {
		t.Errorf("LastRunStatus=%q Health=%q, want succeeded/ok", row.LastRunStatus, row.Health)
	}
	if row.ExecutionName != "shorted-alerts-29000001" {
		t.Errorf("ExecutionName = %q, want the Telesis run id", row.ExecutionName)
	}
	if !strings.Contains(row.Note, "omega") {
		t.Errorf("Note = %q, want the cluster note", row.Note)
	}
	if len(row.Triggers) != 1 || row.Triggers[0].Runner != "kubernetes" {
		t.Errorf("Triggers = %+v, want one kubernetes trigger", row.Triggers)
	}
}

func TestClusterOnlyJobFailedTelesisRunIsCritical(t *testing.T) {
	byName := map[string]*JobStatus{}
	var order []string
	addClusterOnlyJobs(byName, &order)
	src := &fakeCronSource{
		monitors: []CronMonitor{{ID: "m-alerts", Name: "shorted-alerts", Status: "failing", Armed: true,
			Schedule: "55 * * * 1-5", LastRunAt: ago(5 * time.Minute)}},
		runs: map[string][]CronRun{"m-alerts": {{
			RunID: "shorted-alerts-29000002", Status: "failed",
			StartedAt: ago(5 * time.Minute), EndedAt: ago(4 * time.Minute), TerminalReason: "exit 1: boom",
		}}},
	}

	if err := applyClusterRuns(context.Background(), byName, src); err != nil {
		t.Fatal(err)
	}
	row := finishRows(byName)["shorted-alerts"]

	if row.Health != HealthCritical {
		t.Fatalf("Health = %q, want critical", row.Health)
	}
	if !strings.Contains(row.Message, "shorted-alerts") || !strings.Contains(row.Message, "exit 1: boom") {
		t.Errorf("Message = %q, want the job and the Telesis reason", row.Message)
	}
}

func TestClusterOnlyJobWithoutMonitorReadsUnknownNotPaused(t *testing.T) {
	byName := map[string]*JobStatus{}
	var order []string
	addClusterOnlyJobs(byName, &order)

	// No monitor at all, and a Telesis read that succeeds: the row must still be
	// there, and read as never run, not as a paused or overdue trigger.
	if err := applyClusterRuns(context.Background(), byName, &fakeCronSource{}); err != nil {
		t.Fatal(err)
	}
	row, ok := finishRows(byName)["shorted-alerts"]
	if !ok {
		t.Fatal("no shorted-alerts row without a monitor")
	}
	if row.Triggers[0].State == "PAUSED" || row.SchedulerState == "PAUSED" {
		t.Errorf("reads as paused: trigger=%q scheduler=%q", row.Triggers[0].State, row.SchedulerState)
	}
	if row.LastRunStatus != "never" || row.Health != HealthUnknown {
		t.Errorf("LastRunStatus=%q Health=%q, want never/unknown", row.LastRunStatus, row.Health)
	}
	if !strings.Contains(row.Note, "omega") {
		t.Errorf("Note = %q, want the cluster note", row.Note)
	}
}

func TestClusterOnlyJobSurvivesAFailedTelesisRead(t *testing.T) {
	byName := map[string]*JobStatus{}
	var order []string
	addClusterOnlyJobs(byName, &order)
	src := &fakeCronSource{
		listErr: fmt.Errorf("telesis down"),
	}

	if err := applyClusterRuns(context.Background(), byName, src); err == nil {
		t.Fatal("want the Telesis error reported")
	}
	rows := finishRows(byName)
	if _, ok := rows["shorted-alerts"]; !ok {
		t.Fatal("the row must still be listed when Telesis is down")
	}
}

func TestAddClusterOnlyJobsKeepsARowThatAlreadyExists(t *testing.T) {
	existing := &JobStatus{Name: "shorted-alerts", Type: "job", Region: "australia-southeast2"}
	byName := map[string]*JobStatus{"shorted-alerts": existing}
	order := []string{"shorted-alerts"}

	addClusterOnlyJobs(byName, &order)

	if byName["shorted-alerts"] != existing {
		t.Error("an existing row was replaced")
	}
	if len(order) != 1 {
		t.Errorf("order = %v, want no duplicate", order)
	}
}

// TestClusterOnlyJobsMatchChart pins clusterOnlyJobs to the chart: a CronJob the
// chart marks vkeNative has no Cloud Run twin, so it needs a row from here.
func TestClusterOnlyJobsMatchChart(t *testing.T) {
	raw, err := os.ReadFile("../../../../deploy/kubernetes/jobs/chart/values.yaml")
	if err != nil {
		t.Fatalf("read chart values: %v", err)
	}
	var values struct {
		VKENative []string `json:"vkeNative"`
	}
	if err := yaml.Unmarshal(raw, &values); err != nil {
		t.Fatalf("parse chart values: %v", err)
	}
	want := append([]string(nil), values.VKENative...)
	got := append([]string(nil), clusterOnlyJobs...)
	sort.Strings(want)
	sort.Strings(got)
	if len(want) == 0 {
		t.Fatal("chart vkeNative is empty; the pin would be vacuous")
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("clusterOnlyJobs = %v, chart vkeNative = %v", got, want)
	}
}

func TestTelesisListReadsTheCronExpressionOfAMonitor(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"monitors":[
			{"id":"m-cron","name":"shorted-alerts","status":"CRON_MONITOR_STATUS_HEALTHY",
			 "schedule":{"cronExpression":"55 * * * 1-5","timezone":"UTC"}},
			{"id":"m-interval","name":"cronjob-reporter heartbeat","status":"CRON_MONITOR_STATUS_HEALTHY",
			 "schedule":{"intervalSeconds":"600","timezone":"UTC"}}
		],"pageInfo":{"hasNextPage":false}}`))
	}))
	defer srv.Close()

	client := newTelesisClient(TelesisConfig{BaseURL: srv.URL, Token: "test-token", OrgID: "org"})
	monitors, err := client.ListCronMonitors(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, m := range monitors {
		got[m.Name] = m.Schedule
	}
	if got["shorted-alerts"] != "55 * * * 1-5" {
		t.Errorf("cron monitor Schedule = %q, want the cron expression", got["shorted-alerts"])
	}
	if got["cronjob-reporter heartbeat"] != "" {
		t.Errorf("interval monitor Schedule = %q, want empty", got["cronjob-reporter heartbeat"])
	}
}
