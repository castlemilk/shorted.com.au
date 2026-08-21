package jobmonitor

// run.go adds on-demand execution ("Run now") to the read-only monitor.
//
// The safety property that shapes the whole file: a caller NEVER names a Cloud
// Run resource. The requested job/region is resolved against the fleet this
// collector has actually observed (Collect()), and only the resolved job's own
// name + region are ever handed to the Cloud Run API. An unknown name is a 404
// here, not a 404 from GCP — arbitrary caller input never reaches google.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"google.golang.org/api/option"
	run "google.golang.org/api/run/v2"
)

// Errors returned by RunJob. Callers map these to HTTP status codes.
var (
	// ErrUnknownJob: the name (or name+region pair) is not in the collected fleet.
	ErrUnknownJob = errors.New("jobmonitor: unknown job")
	// ErrRetiredJob: the job is deployed-but-unscheduled ON PURPOSE. Running it is
	// almost always a mistake (its replacement is the live one), so it is refused
	// outright rather than force-able.
	ErrRetiredJob = errors.New("jobmonitor: job is retired")
	// ErrNotExecutable: the row exists but is not a Cloud Run Job — scheduler-only
	// "service" rows and the residential "rig" rows have nothing to execute.
	ErrNotExecutable = errors.New("jobmonitor: job is not a Cloud Run Job")
	// ErrNoProject: the collector has no project configured.
	ErrNoProject = errors.New("jobmonitor: project ID not configured")
)

// AlreadyRunningError reports that the job has an in-flight execution. It is
// overridable (RunRequest.Force) rather than fatal: the ASIC short-positions
// sync legitimately runs 26-29h, and an operator may still want a parallel run.
type AlreadyRunningError struct {
	Job           string
	ExecutionName string
	StartedAt     string
	Age           time.Duration
}

func (e *AlreadyRunningError) Error() string {
	age := "unknown age"
	if e.Age > 0 {
		age = humanizeDuration(e.Age) + " old"
	}
	name := e.ExecutionName
	if name == "" {
		name = "an execution"
	}
	return fmt.Sprintf("%s already has a running execution (%s, %s)", e.Job, name, age)
}

// RunRequest is a validated-on-arrival request to execute one job.
type RunRequest struct {
	// Job is the Cloud Run Job resource name (not the display name).
	Job string
	// Region is optional. When set it must MATCH the region the job was collected
	// in — a mismatch is an unknown job, never a blind cross-region attempt.
	Region string
	// Force overrides the already-running guard.
	Force bool
	// Actor is the admin identity, for the audit log only.
	Actor string
}

// RunResult describes the execution that was created.
type RunResult struct {
	Job           string `json:"job"`
	DisplayName   string `json:"displayName"`
	Region        string `json:"region"`
	ExecutionName string `json:"executionName"`
	Forced        bool   `json:"forced"`
	// PreviousExecution is the in-flight execution that was overridden (force only).
	PreviousExecution string `json:"previousExecution,omitempty"`
}

// Runner executes a single Cloud Run Job and returns the created execution's
// short name. It exists so tests can drive RunJob without touching GCP.
type Runner interface {
	Run(ctx context.Context, projectID, region, job string) (string, error)
}

// RunJob validates the request against the currently collected fleet and, if it
// passes, asks Cloud Run to execute the job.
//
// Validation order is deliberate: unknown (404) before retired (409) before
// already-running (409), so the most specific refusal is the one reported.
func (c *Collector) RunJob(ctx context.Context, req RunRequest) (*RunResult, error) {
	if c.cfg.ProjectID == "" {
		return nil, ErrNoProject
	}

	// Serve-stale is fine here: the fleet membership list changes on deploys, not
	// minute to minute, and a stale-but-present job is still a real job.
	jobs, err := c.Collect(ctx)
	if err != nil && len(jobs) == 0 {
		return nil, err
	}

	target, err := resolveRunTarget(jobs, req, time.Now().UTC())
	if err != nil {
		return nil, err
	}

	runner := c.runner
	if runner == nil {
		runner = cloudRunRunner{}
	}
	execName, err := runner.Run(ctx, c.cfg.ProjectID, target.Region, target.Name)
	if err != nil {
		return nil, err
	}

	// The job is now running; the cached status says otherwise. Drop the cache so
	// the very next dashboard poll shows the new execution rather than up to a
	// minute of "ok, last ran 9h ago".
	c.Invalidate()

	res := &RunResult{
		Job:           target.Name,
		DisplayName:   target.DisplayName,
		Region:        target.Region,
		ExecutionName: execName,
		Forced:        req.Force,
	}
	if req.Force && isRunning(target) {
		res.PreviousExecution = target.ExecutionName
	}
	return res, nil
}

// Invalidate drops the status cache so the next Collect re-reads GCP.
func (c *Collector) Invalidate() {
	c.mu.Lock()
	c.cached = nil
	c.cachedAt = time.Time{}
	c.mu.Unlock()
}

// SetRunner overrides the execution backend (tests).
func (c *Collector) SetRunner(r Runner) { c.runner = r }

// resolveRunTarget is the whole guard, kept pure so it is exhaustively testable.
func resolveRunTarget(jobs []JobStatus, req RunRequest, now time.Time) (*JobStatus, error) {
	name := strings.TrimSpace(req.Job)
	region := strings.TrimSpace(req.Region)
	if name == "" {
		return nil, ErrUnknownJob
	}

	var match *JobStatus
	for i := range jobs {
		if jobs[i].Name != name {
			continue
		}
		// A supplied region must agree with where we actually saw the job. This is
		// what stops a caller steering the API at an arbitrary location.
		if region != "" && jobs[i].Region != region {
			continue
		}
		match = &jobs[i]
		break
	}
	if match == nil {
		return nil, ErrUnknownJob
	}
	if match.Type != "job" || match.Region == "" {
		return nil, ErrNotExecutable
	}
	if match.Retired {
		return nil, ErrRetiredJob
	}
	if isRunning(match) && !req.Force {
		return nil, &AlreadyRunningError{
			Job:           match.Name,
			ExecutionName: match.ExecutionName,
			StartedAt:     match.LastRunAt,
			Age:           executionAge(match, now),
		}
	}
	return match, nil
}

// isRunning treats both the derived status and the raw running-task count as
// evidence of an in-flight execution.
func isRunning(st *JobStatus) bool {
	return st.LastRunStatus == "running" || st.RunningCount > 0
}

func executionAge(st *JobStatus, now time.Time) time.Duration {
	started := parseTime(st.LastRunAt)
	if started.IsZero() {
		return 0
	}
	if d := now.Sub(started); d > 0 {
		return d
	}
	return 0
}

// cloudRunRunner is the production Runner: projects.locations.jobs.run against
// the job's own regional endpoint.
type cloudRunRunner struct {
	opts []option.ClientOption
}

func (r cloudRunRunner) Run(ctx context.Context, projectID, region, job string) (string, error) {
	opts := append([]option.ClientOption{regionalRunEndpoint(region)}, r.opts...)
	svc, err := run.NewService(ctx, opts...)
	if err != nil {
		return "", fmt.Errorf("jobmonitor: create run client (%s): %w", region, err)
	}
	name := fmt.Sprintf("projects/%s/locations/%s/jobs/%s", projectID, region, job)
	op, err := svc.Projects.Locations.Jobs.
		Run(name, &run.GoogleCloudRunV2RunJobRequest{}).
		Context(ctx).Do()
	if err != nil {
		return "", fmt.Errorf("jobmonitor: run job %s: %w", job, err)
	}
	return executionNameFromOperation(op), nil
}

// executionNameFromOperation digs the created execution's name out of the LRO.
// Cloud Run puts the Execution resource in the operation metadata immediately;
// the operation name is the fallback so a caller always gets *something* to
// correlate the run with.
func executionNameFromOperation(op *run.GoogleLongrunningOperation) string {
	if op == nil {
		return ""
	}
	for _, raw := range [][]byte{op.Metadata, op.Response} {
		if len(raw) == 0 {
			continue
		}
		var envelope struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(raw, &envelope); err == nil && envelope.Name != "" {
			return basename(envelope.Name)
		}
	}
	return basename(op.Name)
}
