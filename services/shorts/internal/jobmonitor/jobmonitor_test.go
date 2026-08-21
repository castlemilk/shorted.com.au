package jobmonitor

import (
	"context"
	"encoding/json"
	"os"
	"strings"
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
		"shorted-news":     {Name: "shorted-news", Type: "job"},
	}
	order := []string{"shorts-data-sync", "shorted-news"}

	schedulers := []*cloudscheduler.Job{
		{Name: "p/l/jobs/shorts-data-sync-daily", Schedule: "0 10 * * *", State: "ENABLED", LastAttemptTime: "2026-06-21T10:00:00Z"},
		// Four triggers on ONE job, matching the real shorted-news topology.
		{Name: "p/l/jobs/shorted-news-schedule", Schedule: "0 */4 * * *", State: "ENABLED", LastAttemptTime: "2026-06-22T04:00:00Z"},
		{Name: "p/l/jobs/shorted-news-cluster", Schedule: "30 */2 * * *", State: "ENABLED", LastAttemptTime: "2026-06-22T04:30:00Z"},
		{Name: "p/l/jobs/shorted-news-digest", Schedule: "0 1 * * 5", State: "ENABLED", LastAttemptTime: "2026-06-20T01:00:00Z"},
		{Name: "p/l/jobs/shorted-news-resolve-googlenews", Schedule: "0 4 * * 1", State: "ENABLED", LastAttemptTime: "2026-06-17T04:00:00Z"},
		// Service-triggered (no matching run job):
		{Name: "p/l/jobs/market-data-sync-daily", Schedule: "0 10 * * 1-5", State: "ENABLED", LastAttemptTime: "2026-06-19T10:00:00Z"},
	}

	mergeSchedulers(byName, &order, schedulers)

	// Matched job gets a schedule.
	if byName["shorts-data-sync"].Schedule != "0 10 * * *" {
		t.Errorf("shorts-data-sync schedule = %q", byName["shorts-data-sync"].Schedule)
	}
	news := byName["shorted-news"]
	// EVERY trigger travels — collapsing to one hid whole cadences.
	if len(news.Triggers) != 4 {
		t.Errorf("shorted-news triggers = %d, want 4", len(news.Triggers))
	}
	// Primary is the TIGHTEST enabled cadence (every 2h), not the most recent attempt.
	if news.Schedule != "30 */2 * * *" {
		t.Errorf("shorted-news primary schedule = %q, want the 2-hourly cluster trigger", news.Schedule)
	}
	if !strings.Contains(news.ScheduleHuman, "+3 more") {
		t.Errorf("shorted-news scheduleHuman = %q, want a '+3 more' trigger count", news.ScheduleHuman)
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
	// The catalog decorates the service row with its real display name.
	if mds.DisplayName != "Market Data Sync" {
		t.Errorf("market-data-sync-daily displayName = %q, want catalog name", mds.DisplayName)
	}
}

// A job whose only triggers are PAUSED must still show its cadence rather than a
// blank schedule column.
func TestApplyPrimaryTriggerAllPaused(t *testing.T) {
	st := &JobStatus{Name: "weekly-report-generator", Triggers: []Trigger{
		{Name: "weekly-report-generator-monthly", Schedule: "0 1 1 * *", State: "PAUSED"},
		{Name: "weekly-report-generator-weekly", Schedule: "0 11 * * 5", State: "PAUSED"},
	}}
	applyPrimaryTrigger(st)
	if st.Schedule == "" {
		t.Fatal("all-paused job lost its schedule")
	}
	if st.SchedulerState != "PAUSED" {
		t.Errorf("schedulerState = %q, want PAUSED", st.SchedulerState)
	}
}

func TestCatalogCoversTheRealFleet(t *testing.T) {
	// Fleet enumerated read-only from prod (rosy-clover-477102-t5) on 2026-08-21.
	// A rename/addition should fail here loudly rather than silently degrade to a
	// title-cased resource name in the console.
	fleet := []string{
		"director-trade-extractor", "financial-report-extractor", "house-price-collector",
		"influence-collector", "shorted-announcements", "shorted-economy", "shorted-news",
		"shorted-signals", "shorted-weekly-report", "shorts-data-sync", "signals-collector",
		"weekly-report-generator", "asx-discovery",
	}
	for _, name := range fleet {
		if _, ok := catalog[name]; !ok {
			t.Errorf("catalog is missing prod job %q", name)
		}
	}
	// The two superseded jobs must be marked retired or they alarm forever.
	for _, name := range []string{"signals-collector", "weekly-report-generator"} {
		if !catalog[name].Retired {
			t.Errorf("%q should be marked Retired (terraform pauses its schedulers)", name)
		}
	}
	// And their replacements must NOT be.
	for _, name := range []string{"shorted-signals", "shorted-weekly-report"} {
		if catalog[name].Retired {
			t.Errorf("%q is the live replacement and must not be Retired", name)
		}
	}
}

func TestDecorateFallsBackForUnknownJobs(t *testing.T) {
	st := &JobStatus{Name: "some-new-housing-job"}
	decorate(st)
	if st.DisplayName != "Some New Housing Job" {
		t.Errorf("DisplayName = %q, want a derived title", st.DisplayName)
	}
	if st.Category != "Housing" {
		t.Errorf("Category = %q, want Housing", st.Category)
	}
}

func TestOverdueIsDistinctFromWarning(t *testing.T) {
	now := time.Now().UTC()
	// Daily job whose last SUCCESS is three days old: it did not fail, it stopped
	// being run — the outage mode a pass/fail-only dashboard cannot show.
	overdue := &JobStatus{
		LastRunStatus: "succeeded",
		Schedule:      "0 10 * * *",
		LastSuccessAt: now.Add(-72 * time.Hour).Format(time.RFC3339),
	}
	finalizeHealth(overdue)
	if overdue.Health != HealthOverdue {
		t.Errorf("health = %v, want overdue", overdue.Health)
	}
	if overdue.OverdueBySeconds <= 0 {
		t.Errorf("OverdueBySeconds = %v, want > 0", overdue.OverdueBySeconds)
	}
	if overdue.ExpectedMaxGapSeconds != (30 * time.Hour).Seconds() {
		t.Errorf("ExpectedMaxGapSeconds = %v, want the daily 30h ceiling", overdue.ExpectedMaxGapSeconds)
	}
	if overdue.Message == "" {
		t.Error("overdue job should explain itself in Message")
	}

	// A paused scheduler is a WARNING, not overdue — a different operator action.
	paused := &JobStatus{
		LastRunStatus:  "succeeded",
		Schedule:       "0 10 * * *",
		SchedulerState: "PAUSED",
		LastSuccessAt:  now.Format(time.RFC3339),
	}
	finalizeHealth(paused)
	if paused.Health != HealthWarning {
		t.Errorf("paused health = %v, want warning", paused.Health)
	}

	// Never-run job: we never infer overdue-ness from MISSING data.
	never := &JobStatus{LastRunStatus: "never", Schedule: "0 10 * * *"}
	finalizeHealth(never)
	if never.Health != HealthUnknown {
		t.Errorf("never-run health = %v, want unknown", never.Health)
	}
	if never.OverdueBySeconds != 0 {
		t.Errorf("never-run OverdueBySeconds = %v, want 0", never.OverdueBySeconds)
	}
}

func TestRetiredJobsDoNotAlarm(t *testing.T) {
	old := time.Now().UTC().Add(-90 * 24 * time.Hour).Format(time.RFC3339)

	// Retired + paused + long overdue = the DESIGNED steady state.
	retired := &JobStatus{
		Name: "weekly-report-generator", Retired: true,
		LastRunStatus: "succeeded", Schedule: "0 11 * * 5",
		SchedulerState: "PAUSED", LastSuccessAt: old,
	}
	finalizeHealth(retired)
	if retired.Health != HealthOK {
		t.Errorf("retired job health = %v, want ok", retired.Health)
	}

	// A failed last run on a retired job is demoted, never paged.
	retiredFailed := &JobStatus{Name: "signals-collector", Retired: true, LastRunStatus: "failed"}
	finalizeHealth(retiredFailed)
	if retiredFailed.Health != HealthWarning {
		t.Errorf("retired failed health = %v, want warning", retiredFailed.Health)
	}

	// The same failure on a LIVE job still pages.
	live := &JobStatus{Name: "shorted-signals", LastRunStatus: "failed"}
	finalizeHealth(live)
	if live.Health != HealthCritical {
		t.Errorf("live failed health = %v, want critical", live.Health)
	}
}

func TestConfigFromEnvRegions(t *testing.T) {
	t.Setenv("JOBS_RUN_REGIONS", "")
	t.Setenv("JOBS_RUN_REGION", "")
	// asx-discovery lives in us-central1: a single-region default would omit it.
	if got := ConfigFromEnv().RunRegions; len(got) != 2 || got[0] != "australia-southeast2" || got[1] != "us-central1" {
		t.Errorf("default RunRegions = %v, want both prod job regions", got)
	}
	t.Setenv("JOBS_RUN_REGIONS", "a, b ,,c")
	if got := ConfigFromEnv().RunRegions; len(got) != 3 || got[2] != "c" {
		t.Errorf("csv RunRegions = %v, want [a b c]", got)
	}
	// The legacy singular var ADDS to the defaults rather than replacing them:
	// terraform sets it to the API's own region, and "where the API runs" is not
	// the same question as "where jobs are deployed".
	t.Setenv("JOBS_RUN_REGIONS", "")
	t.Setenv("JOBS_RUN_REGION", "europe-west1")
	got := ConfigFromEnv().RunRegions
	if len(got) != 3 || got[2] != "europe-west1" {
		t.Errorf("legacy JOBS_RUN_REGION = %v, want defaults + europe-west1", got)
	}
	// The prod value (already one of the defaults) must not duplicate.
	t.Setenv("JOBS_RUN_REGION", "australia-southeast2")
	if got := ConfigFromEnv().RunRegions; len(got) != 2 {
		t.Errorf("RunRegions = %v, want no duplicate of the default region", got)
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

	if staleOK.Health != HealthOverdue {
		t.Errorf("stale ok health = %v, want overdue", staleOK.Health)
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

	// healthRank ordering: critical < overdue < warning < running < unknown < ok
	order := []Health{HealthCritical, HealthOverdue, HealthWarning, HealthRunning, HealthUnknown, HealthOK}
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
