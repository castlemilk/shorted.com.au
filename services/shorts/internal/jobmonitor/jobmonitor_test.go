package jobmonitor

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"golang.org/x/oauth2"
	cloudscheduler "google.golang.org/api/cloudscheduler/v1"
	"google.golang.org/api/option"
	run "google.golang.org/api/run/v2"
)

func TestExpectedMaxGap(t *testing.T) {
	cases := []struct {
		cron string
		max  time.Duration
	}{
		{"0 10 * * *", 30 * time.Hour},     // daily
		{"0 8 * * 1-5", 80 * time.Hour},    // weekdays (weekend gap allowed)
		{"0 13 * * 1", 8 * 24 * time.Hour}, // weekly (single DOW)
		{"0 1 1 * *", 32 * 24 * time.Hour}, // monthly (DOM set)
		{"30 */2 * * *", 3 * time.Hour},    // every 2h
		{"garbage", 36 * time.Hour},        // unparseable
	}
	for _, c := range cases {
		if got := expectedMaxGap(c.cron); got != c.max {
			t.Errorf("expectedMaxGap(%q) = %v, want %v", c.cron, got, c.max)
		}
	}
}

func TestHumanizeCron(t *testing.T) {
	cases := map[string]string{
		"0 10 * * *":   "Daily at 10:00",
		"0 8 * * 1-5":  "Weekdays at 08:00",
		"0 13 * * 1":   "Weekly (Mon) at 13:00",
		"0 1 1 * *":    "Monthly at 01:00",
		"30 */2 * * *": "Every 2h",
	}
	for cron, want := range cases {
		if got := humanizeCron(cron); got != want {
			t.Errorf("humanizeCron(%q) = %q, want %q", cron, got, want)
		}
	}
}

func TestExecStatus(t *testing.T) {
	cases := []struct {
		name string
		exec *run.GoogleCloudRunV2Execution
		want string
	}{
		{"succeeded", &run.GoogleCloudRunV2Execution{SucceededCount: 1}, "succeeded"},
		{"failed", &run.GoogleCloudRunV2Execution{FailedCount: 1}, "failed"},
		{"running", &run.GoogleCloudRunV2Execution{RunningCount: 1}, "running"},
		{"failed-takes-priority-over-succeeded", &run.GoogleCloudRunV2Execution{SucceededCount: 1, FailedCount: 1}, "failed"},
		{"running-takes-priority", &run.GoogleCloudRunV2Execution{RunningCount: 1, FailedCount: 1}, "running"},
		{"condition-fallback-succeeded", &run.GoogleCloudRunV2Execution{
			Conditions: []*run.GoogleCloudRunV2Condition{{Type: "Completed", State: "CONDITION_SUCCEEDED"}},
		}, "succeeded"},
		{"condition-fallback-failed", &run.GoogleCloudRunV2Execution{
			Conditions: []*run.GoogleCloudRunV2Condition{{Type: "Completed", State: "CONDITION_FAILED"}},
		}, "failed"},
		{"empty", &run.GoogleCloudRunV2Execution{}, "unknown"},
	}
	for _, c := range cases {
		if got := execStatus(c.exec); got != c.want {
			t.Errorf("%s: execStatus = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestApplyExecutionsPicksNewestAndLastSuccess(t *testing.T) {
	st := &JobStatus{Name: "x"}
	execs := []*run.GoogleCloudRunV2Execution{
		{Name: "p/old-success", StartTime: "2026-06-19T10:00:00Z", CompletionTime: "2026-06-19T10:05:00Z", SucceededCount: 1},
		{Name: "p/newest-failed", StartTime: "2026-06-21T10:00:00Z", CompletionTime: "2026-06-21T10:01:00Z", FailedCount: 1},
		{Name: "p/mid-success", StartTime: "2026-06-20T10:00:00Z", CompletionTime: "2026-06-20T10:06:00Z", SucceededCount: 1},
	}
	applyExecutions(st, execs)

	if st.ExecutionName != "newest-failed" {
		t.Errorf("latest exec = %q, want newest-failed", st.ExecutionName)
	}
	if st.LastRunStatus != "failed" {
		t.Errorf("LastRunStatus = %q, want failed", st.LastRunStatus)
	}
	// last success should be the most recent succeeded one (mid-success, 06-20).
	if st.LastSuccessAt != "2026-06-20T10:06:00Z" {
		t.Errorf("LastSuccessAt = %q, want 2026-06-20T10:06:00Z", st.LastSuccessAt)
	}
	if st.DurationSeconds != 60 {
		t.Errorf("DurationSeconds = %v, want 60", st.DurationSeconds)
	}
}

func TestMergeSchedulers(t *testing.T) {
	byName := map[string]*JobStatus{
		"shorts-data-sync": {Name: "shorts-data-sync", Type: "job"},
		"news-aggregator":  {Name: "news-aggregator", Type: "job"},
	}
	order := []string{"shorts-data-sync", "news-aggregator"}

	schedulers := []*cloudscheduler.Job{
		{Name: "p/l/jobs/shorts-data-sync-daily", Schedule: "0 10 * * *", State: "ENABLED", LastAttemptTime: "2026-06-21T10:00:00Z"},
		{Name: "p/l/jobs/news-aggregator-periodic", Schedule: "0 */4 * * *", State: "ENABLED", LastAttemptTime: "2026-06-22T04:00:00Z"},
		{Name: "p/l/jobs/news-aggregator-cluster", Schedule: "30 */2 * * *", State: "ENABLED", LastAttemptTime: "2026-06-22T04:30:00Z"},
		// Service-triggered (no matching run job):
		{Name: "p/l/jobs/market-data-sync-daily", Schedule: "0 10 * * 1-5", State: "ENABLED", LastAttemptTime: "2026-06-19T10:00:00Z"},
	}

	mergeSchedulers(byName, &order, schedulers)

	// Matched job gets a schedule.
	if byName["shorts-data-sync"].Schedule != "0 10 * * *" {
		t.Errorf("shorts-data-sync schedule = %q", byName["shorts-data-sync"].Schedule)
	}
	// News had two triggers; primary is the most recent attempt (cluster @ 04:30).
	if byName["news-aggregator"].Schedule != "30 */2 * * *" {
		t.Errorf("news-aggregator primary schedule = %q, want cluster", byName["news-aggregator"].Schedule)
	}
	// Service-triggered scheduler becomes its own entry.
	mds, ok := byName["market-data-sync-daily"]
	if !ok {
		t.Fatalf("market-data-sync-daily not added as service entry")
	}
	if mds.Type != "service" {
		t.Errorf("market-data-sync-daily type = %q, want service", mds.Type)
	}
	if mds.LastRunStatus != "succeeded" {
		t.Errorf("market-data-sync-daily status = %q, want succeeded", mds.LastRunStatus)
	}
}

func TestFinalizeHealthAndSort(t *testing.T) {
	now := time.Now().UTC().Format(time.RFC3339)
	staleOK := &JobStatus{LastRunStatus: "succeeded", Schedule: "0 10 * * *", LastSuccessAt: "2026-01-01T00:00:00Z"}
	freshOK := &JobStatus{LastRunStatus: "succeeded", Schedule: "0 10 * * *", LastSuccessAt: now}
	failed := &JobStatus{LastRunStatus: "failed"}
	running := &JobStatus{LastRunStatus: "running"}
	never := &JobStatus{LastRunStatus: "never"}

	finalizeHealth(staleOK)
	finalizeHealth(freshOK)
	finalizeHealth(failed)
	finalizeHealth(running)
	finalizeHealth(never)

	if staleOK.Health != HealthWarning {
		t.Errorf("stale ok health = %v, want warning", staleOK.Health)
	}
	if freshOK.Health != HealthOK {
		t.Errorf("fresh ok health = %v, want ok", freshOK.Health)
	}
	if failed.Health != HealthCritical {
		t.Errorf("failed health = %v, want critical", failed.Health)
	}
	if running.Health != HealthRunning {
		t.Errorf("running health = %v, want running", running.Health)
	}
	if never.Health != HealthUnknown {
		t.Errorf("never health = %v, want unknown", never.Health)
	}

	// healthRank ordering: critical < warning < running < unknown < ok
	order := []Health{HealthCritical, HealthWarning, HealthRunning, HealthUnknown, HealthOK}
	for i := 1; i < len(order); i++ {
		if healthRank(order[i-1]) >= healthRank(order[i]) {
			t.Errorf("healthRank(%s) should sort before healthRank(%s)", order[i-1], order[i])
		}
	}
}

// TestCollectE2E hits the real Cloud Run + Scheduler APIs. Guarded so it only
// runs when explicitly opted in:
//
//	JOBMONITOR_E2E=1 \
//	JOBMONITOR_E2E_TOKEN=$(gcloud auth print-access-token --account=ben@shorted.com.au) \
//	JOBS_GCP_PROJECT=rosy-clover-477102-t5 \
//	go test -run TestCollectE2E -v ./shorts/internal/jobmonitor/
func TestCollectE2E(t *testing.T) {
	if os.Getenv("JOBMONITOR_E2E") != "1" {
		t.Skip("set JOBMONITOR_E2E=1 to run the live Cloud Run/Scheduler E2E test")
	}
	cfg := ConfigFromEnv()
	if cfg.ProjectID == "" {
		t.Fatal("JOBS_GCP_PROJECT must be set for E2E")
	}

	var opts []option.ClientOption
	if tok := os.Getenv("JOBMONITOR_E2E_TOKEN"); tok != "" {
		opts = append(opts, option.WithTokenSource(oauth2.StaticTokenSource(&oauth2.Token{AccessToken: tok})))
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	jobs, err := collect(ctx, cfg, opts...)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if len(jobs) == 0 {
		t.Fatal("expected at least one job, got 0")
	}
	pretty, _ := json.MarshalIndent(jobs, "", "  ")
	t.Logf("collected %d jobs:\n%s", len(jobs), pretty)
	if out := os.Getenv("JOBMONITOR_E2E_OUT"); out != "" {
		if err := os.WriteFile(out, pretty, 0o644); err != nil {
			t.Fatalf("write out: %v", err)
		}
	}
}
