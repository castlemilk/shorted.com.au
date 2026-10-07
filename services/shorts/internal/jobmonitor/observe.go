package jobmonitor

import (
	"context"
	"fmt"
	"strings"
	"time"

	"google.golang.org/api/option"
	run "google.golang.org/api/run/v2"
)

// ExecutionSummary contains operational state only, never container environment
// variables, arguments, credentials, or arbitrary log contents.
type ExecutionSummary struct {
	ExecutionName   string  `json:"executionName"`
	Status          string  `json:"status"`
	StartedAt       string  `json:"startedAt,omitempty"`
	CompletedAt     string  `json:"completedAt,omitempty"`
	DurationSeconds float64 `json:"durationSeconds"`
	TaskCount       int64   `json:"taskCount"`
	RunningCount    int64   `json:"runningCount"`
	SucceededCount  int64   `json:"succeededCount"`
	FailedCount     int64   `json:"failedCount"`
	CancelledCount  int64   `json:"cancelledCount"`
	RetriedCount    int64   `json:"retriedCount"`
	LogUri          string  `json:"logUri,omitempty"`
	Message         string  `json:"message,omitempty"`
}

type ExecutionPage struct {
	Executions    []ExecutionSummary `json:"executions"`
	NextPageToken string             `json:"nextPageToken,omitempty"`
}

type ExecutionLister interface {
	ListExecutions(context.Context, string, string, string, int, string) (*ExecutionPage, error)
}

type cloudRunExecutionLister struct{ opts []option.ClientOption }

func (l cloudRunExecutionLister) ListExecutions(ctx context.Context, project, region, job string, limit int, token string) (*ExecutionPage, error) {
	opts := append([]option.ClientOption{regionalRunEndpoint(region)}, l.opts...)
	svc, err := run.NewService(ctx, opts...)
	if err != nil {
		return nil, err
	}
	parent := fmt.Sprintf("projects/%s/locations/%s/jobs/%s", project, region, job)
	page, err := svc.Projects.Locations.Jobs.Executions.List(parent).PageSize(int64(limit)).PageToken(token).Context(ctx).Do()
	if err != nil {
		return nil, err
	}
	out := &ExecutionPage{Executions: []ExecutionSummary{}, NextPageToken: page.NextPageToken}
	for _, e := range page.Executions {
		if e != nil {
			out.Executions = append(out.Executions, summarizeExecution(e, time.Now()))
		}
	}
	return out, nil
}

func summarizeExecution(e *run.GoogleCloudRunV2Execution, now time.Time) ExecutionSummary {
	status := execStatus(e)
	if e.CancelledCount > 0 && e.CompletionTime != "" {
		status = "cancelled"
	}
	// Pending executions may have no running tasks yet.
	if status == "unknown" && e.CompletionTime == "" && (e.CreateTime != "" || e.StartTime != "") {
		status = "running"
	}
	out := ExecutionSummary{ExecutionName: basename(e.Name), Status: status,
		StartedAt: firstNonEmpty(e.StartTime, e.CreateTime), CompletedAt: e.CompletionTime,
		TaskCount: e.TaskCount, RunningCount: e.RunningCount, SucceededCount: e.SucceededCount,
		FailedCount: e.FailedCount, CancelledCount: e.CancelledCount, RetriedCount: e.RetriedCount, LogUri: e.LogUri, Message: failureMessage(e)}
	end := now
	if e.CompletionTime != "" {
		end = parseTime(e.CompletionTime)
	}
	if start := parseTime(out.StartedAt); !start.IsZero() && end.After(start) {
		out.DurationSeconds = end.Sub(start).Seconds()
	}
	return out
}

// Read targets must come from the discovered fleet. Retired jobs remain
// inspectable; they cannot be started by this API.
func (c *Collector) readTarget(ctx context.Context, name, region string) (*JobStatus, error) {
	if !executionNamePattern.MatchString(name) {
		return nil, ErrUnknownJob
	}
	jobs, err := c.Collect(ctx)
	if jobs == nil && err != nil {
		return nil, err
	}
	var found *JobStatus
	for i := range jobs {
		j := &jobs[i]
		if j.Name == name && j.Type == "job" && (region == "" || region == j.Region) {
			if found != nil {
				return nil, fmt.Errorf("job exists in multiple regions; specify region")
			}
			found = j
		}
	}
	if found == nil {
		return nil, ErrUnknownJob
	}
	return found, nil
}

func (c *Collector) ListJobExecutions(ctx context.Context, name, region string, limit int, token string) (*ExecutionPage, error) {
	if limit == 0 {
		limit = 20
	}
	if limit < 1 || limit > 100 || len(token) > 4096 {
		return nil, fmt.Errorf("limit must be 1-100 and page token at most 4096 bytes")
	}
	target, err := c.readTarget(ctx, name, region)
	if err != nil {
		return nil, err
	}
	l := c.execLister
	if l == nil {
		l = cloudRunExecutionLister{}
	}
	return l.ListExecutions(ctx, c.cfg.ProjectID, target.Region, target.Name, limit, token)
}

func (c *Collector) GetJobExecution(ctx context.Context, name, region, execution string) (*ExecutionSummary, error) {
	// Accept short IDs only; never silently redirect a caller-supplied full path.
	if !executionNamePattern.MatchString(execution) || !strings.HasPrefix(execution, name+"-") {
		return nil, ErrInvalidExecution
	}
	target, err := c.readTarget(ctx, name, region)
	if err != nil {
		return nil, err
	}
	reader := c.execReader
	if reader == nil {
		reader = cloudRunExecutionReader{}
	}
	e, err := reader.Execution(ctx, c.cfg.ProjectID, target.Region, target.Name, execution)
	if err != nil {
		return nil, err
	}
	if e == nil {
		return nil, fmt.Errorf("execution not found")
	}
	out := summarizeExecution(e, time.Now())
	return &out, nil
}

// ObservedAt is the GCP snapshot's timestamp, including when serving stale data.
func (c *Collector) ObservedAt() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cachedAt.IsZero() {
		return ""
	}
	return c.cachedAt.UTC().Format(time.RFC3339)
}
