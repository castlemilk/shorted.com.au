package jobmonitor

import (
	"context"
	"errors"
	"testing"
	"time"

	run "google.golang.org/api/run/v2"
)

// stubRunner records what would have been sent to Cloud Run.
type stubRunner struct {
	calls   [][3]string // project, region, job
	exec    string
	failErr error
}

func (s *stubRunner) Run(_ context.Context, project, region, job string) (string, error) {
	s.calls = append(s.calls, [3]string{project, region, job})
	if s.failErr != nil {
		return "", s.failErr
	}
	if s.exec == "" {
		return "exec-abc12", nil
	}
	return s.exec, nil
}

// seeded builds a collector whose fleet is fixed (no GCP calls).
func seeded(t *testing.T, jobs []JobStatus) (*Collector, *stubRunner) {
	t.Helper()
	c := NewCollector(Config{ProjectID: "proj", RunRegions: []string{"australia-southeast2"}})
	c.cached = jobs
	c.cachedAt = time.Now()
	r := &stubRunner{}
	c.SetRunner(r)
	return c, r
}

func fleet() []JobStatus {
	return []JobStatus{
		{Name: "shorted-news", DisplayName: "News Aggregator", Type: "job", Region: "australia-southeast2", LastRunStatus: "succeeded"},
		{Name: "asx-discovery", DisplayName: "ASX Discovery", Type: "job", Region: "us-central1", LastRunStatus: "succeeded"},
		{Name: "shorts-data-sync", DisplayName: "Short Positions Sync", Type: "job", Region: "australia-southeast2",
			LastRunStatus: "running", RunningCount: 1, ExecutionName: "shorts-data-sync-abcde",
			LastRunAt: time.Now().UTC().Add(-27 * time.Hour).Format(time.RFC3339)},
		{Name: "weekly-report-generator", DisplayName: "Weekly Reports (legacy)", Type: "job", Region: "australia-southeast2", Retired: true},
		{Name: "market-data-sync-daily", DisplayName: "Market Data Sync", Type: "service"},
		{Name: "housing-crawl-rig", DisplayName: "Housing crawl rig", Type: "rig"},
	}
}

func TestRunJobExecutesTheCollectedJob(t *testing.T) {
	c, r := seeded(t, fleet())
	res, err := c.RunJob(context.Background(), RunRequest{Job: "shorted-news", Actor: "ben@shorted.com.au"})
	if err != nil {
		t.Fatalf("RunJob: %v", err)
	}
	if res.ExecutionName != "exec-abc12" || res.Region != "australia-southeast2" {
		t.Errorf("result = %+v", res)
	}
	if len(r.calls) != 1 || r.calls[0] != [3]string{"proj", "australia-southeast2", "shorted-news"} {
		t.Errorf("runner calls = %v", r.calls)
	}
	// A successful run must drop the cache — otherwise the console shows the
	// pre-run status for up to a minute and the operator clicks again.
	c.mu.Lock()
	cached := c.cached
	c.mu.Unlock()
	if cached != nil {
		t.Error("cache should be invalidated after a run")
	}
}

// The job's OWN region is used, not the caller's guess — a us-central1 job must
// be executed against us-central1.
func TestRunJobUsesTheJobsOwnRegion(t *testing.T) {
	c, r := seeded(t, fleet())
	if _, err := c.RunJob(context.Background(), RunRequest{Job: "asx-discovery"}); err != nil {
		t.Fatalf("RunJob: %v", err)
	}
	if r.calls[0][1] != "us-central1" {
		t.Errorf("region = %q, want us-central1", r.calls[0][1])
	}
}

func TestResolveRunTargetRejectsUnknownInput(t *testing.T) {
	now := time.Now().UTC()
	cases := []struct {
		name string
		req  RunRequest
	}{
		{"unknown name", RunRequest{Job: "not-a-job"}},
		{"empty name", RunRequest{Job: ""}},
		{"path traversal", RunRequest{Job: "../../projects/other/locations/x/jobs/y"}},
		// Region must AGREE with where the job was collected; a mismatch is not an
		// invitation to try another location.
		{"region mismatch", RunRequest{Job: "shorted-news", Region: "us-central1"}},
		{"unknown region", RunRequest{Job: "shorted-news", Region: "europe-west1"}},
	}
	for _, tc := range cases {
		if _, err := resolveRunTarget(fleet(), tc.req, now); !errors.Is(err, ErrUnknownJob) {
			t.Errorf("%s: err = %v, want ErrUnknownJob", tc.name, err)
		}
	}

	// The matching region IS accepted.
	if _, err := resolveRunTarget(fleet(), RunRequest{Job: "shorted-news", Region: "australia-southeast2"}, now); err != nil {
		t.Errorf("matching region rejected: %v", err)
	}
}

func TestResolveRunTargetRefusesRetiredJobs(t *testing.T) {
	now := time.Now().UTC()
	// Retired jobs are superseded; running one writes with the OLD code path.
	if _, err := resolveRunTarget(fleet(), RunRequest{Job: "weekly-report-generator"}, now); !errors.Is(err, ErrRetiredJob) {
		t.Errorf("err = %v, want ErrRetiredJob", err)
	}
	// Force does NOT unlock a retired job — it only overrides the running guard.
	if _, err := resolveRunTarget(fleet(), RunRequest{Job: "weekly-report-generator", Force: true}, now); !errors.Is(err, ErrRetiredJob) {
		t.Errorf("forced retired err = %v, want ErrRetiredJob", err)
	}
}

func TestResolveRunTargetRefusesNonJobRows(t *testing.T) {
	now := time.Now().UTC()
	for _, name := range []string{"market-data-sync-daily", "housing-crawl-rig"} {
		if _, err := resolveRunTarget(fleet(), RunRequest{Job: name}, now); !errors.Is(err, ErrNotExecutable) {
			t.Errorf("%s: err = %v, want ErrNotExecutable", name, err)
		}
	}
}

func TestRunningGuardAndForce(t *testing.T) {
	now := time.Now().UTC()

	// Guard on by default, and it reports WHICH execution and how old it is.
	_, err := resolveRunTarget(fleet(), RunRequest{Job: "shorts-data-sync"}, now)
	var running *AlreadyRunningError
	if !errors.As(err, &running) {
		t.Fatalf("err = %v, want AlreadyRunningError", err)
	}
	if running.ExecutionName != "shorts-data-sync-abcde" {
		t.Errorf("execution = %q", running.ExecutionName)
	}
	if running.Age < 26*time.Hour {
		t.Errorf("age = %v, want ~27h (the sync legitimately runs 26-29h)", running.Age)
	}
	if running.Error() == "" {
		t.Error("AlreadyRunningError should explain itself")
	}

	// Force overrides it and reports the execution it ran alongside.
	c, _ := seeded(t, fleet())
	res, err := c.RunJob(context.Background(), RunRequest{Job: "shorts-data-sync", Force: true})
	if err != nil {
		t.Fatalf("forced RunJob: %v", err)
	}
	if !res.Forced || res.PreviousExecution != "shorts-data-sync-abcde" {
		t.Errorf("forced result = %+v", res)
	}
}

// RunningCount alone (status not yet derived) is still an in-flight execution.
func TestRunningGuardUsesRunningCount(t *testing.T) {
	jobs := []JobStatus{{Name: "j", Type: "job", Region: "r", LastRunStatus: "unknown", RunningCount: 2}}
	var running *AlreadyRunningError
	if _, err := resolveRunTarget(jobs, RunRequest{Job: "j"}, time.Now()); !errors.As(err, &running) {
		t.Errorf("err = %v, want AlreadyRunningError", err)
	}
}

// Regression (prod, 2026-08-21): a quick on-demand run COMPLETED while the
// 26-29h Python run was still going. The newest execution read "succeeded", so
// the guard let a duplicate through. Any in-flight execution must trip the
// guard, and the error must name the RUNNING execution, not the completed one.
func TestRunningGuardSeesOlderInFlightExecution(t *testing.T) {
	now := time.Date(2026, 8, 21, 8, 30, 0, 0, time.UTC)
	jobs := []JobStatus{{
		Name: "shorts-data-sync", Type: "job", Region: "r",
		// Newest execution: completed minutes ago.
		ExecutionName: "shorts-data-sync-msk7x", LastRunStatus: "succeeded",
		LastRunAt: "2026-08-21T08:13:00Z", RunningCount: 0,
		// Older execution: still in flight after 26h.
		RunningExecution: "shorts-data-sync-vv2sf",
		RunningStartedAt: "2026-08-21T05:50:00Z",
	}}
	var running *AlreadyRunningError
	_, err := resolveRunTarget(jobs, RunRequest{Job: "shorts-data-sync"}, now)
	if !errors.As(err, &running) {
		t.Fatalf("err = %v, want AlreadyRunningError", err)
	}
	if running.ExecutionName != "shorts-data-sync-vv2sf" {
		t.Errorf("execution = %q, want the in-flight one (vv2sf), not the completed latest", running.ExecutionName)
	}
	if running.Age < 2*time.Hour {
		t.Errorf("age = %v, want ~2h40m from the RUNNING execution's start", running.Age)
	}
}

func TestRunJobRequiresProject(t *testing.T) {
	c := NewCollector(Config{})
	c.cached = fleet()
	c.cachedAt = time.Now()
	if _, err := c.RunJob(context.Background(), RunRequest{Job: "shorted-news"}); !errors.Is(err, ErrNoProject) {
		t.Errorf("err = %v, want ErrNoProject", err)
	}
}

func TestRunJobPropagatesRunnerFailure(t *testing.T) {
	c, r := seeded(t, fleet())
	r.failErr = errors.New("permission denied on run.jobs.run")
	if _, err := c.RunJob(context.Background(), RunRequest{Job: "shorted-news"}); err == nil {
		t.Fatal("expected the runner error to propagate")
	}
}

func TestExecutionNameFromOperation(t *testing.T) {
	// Cloud Run returns the created Execution in the LRO metadata.
	op := &run.GoogleLongrunningOperation{
		Name:     "projects/p/locations/l/operations/op-1",
		Metadata: []byte(`{"name":"projects/p/locations/l/jobs/j/executions/j-x7k2p"}`),
	}
	if got := executionNameFromOperation(op); got != "j-x7k2p" {
		t.Errorf("got %q, want the execution short name", got)
	}
	// No metadata: fall back to the operation name so there is still a handle.
	if got := executionNameFromOperation(&run.GoogleLongrunningOperation{Name: "projects/p/locations/l/operations/op-1"}); got != "op-1" {
		t.Errorf("fallback got %q", got)
	}
	if got := executionNameFromOperation(nil); got != "" {
		t.Errorf("nil op got %q", got)
	}
}
