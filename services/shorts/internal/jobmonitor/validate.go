package jobmonitor

// validate.go adds ONE constrained override-run to the monitor: a per-stock,
// read-only validation of the ASIC short-positions sync.
//
// # Why this is a separate method and not a flag on RunJob
//
// RunJob is deliberately a no-arguments API. The shorts-api service account
// holds roles/run.invoker on the runnable fleet, which grants run.jobs.run but
// NOT run.jobs.runWithOverrides — so even a compromised RunJob caller cannot
// change what a job DOES, only whether it runs. Keeping that property while
// adding "run this one job with these arguments" requires two things:
//
//  1. the elevation (roles/run.developer) is scoped in IAM to exactly ONE job
//     (shorts-data-sync), not the fleet — see terraform/environments/*/main.tf;
//  2. the ARGUMENTS ARE BUILT HERE, server-side, from a validated stock list.
//     A caller supplies stock codes and nothing else. There is no code path,
//     at any layer, by which caller input becomes an argv element verbatim.
//
// Both halves are load-bearing. (1) without (2) would let an admin-authenticated
// caller run shorts-data-sync with, say, no -shadow. (2) without (1) would put a
// fleet-wide override capability behind one endpoint's discipline.
//
// # Why the already-running guard does NOT apply
//
// RunJob refuses to start a second execution because a real sync writes: two
// concurrent writers on the shorts table, both refreshing MVs, is a genuine
// hazard. A validation run is `-shadow`, which opens no write path at all — no
// upsert, no sync_status row, no MV refresh, no revalidation ping. Its only
// database contact is two SELECTs. Blocking it behind an in-flight sync would
// therefore refuse the diagnostic at precisely the moment an operator needs it:
// the sync legitimately runs 26-29h, so "wait for it to finish" can mean "wait
// a day to find out why it looks wrong". Retired and unknown-job still refuse.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"google.golang.org/api/googleapi"
	logging "google.golang.org/api/logging/v2"
	"google.golang.org/api/option"
	run "google.golang.org/api/run/v2"
)

// ValidationJobName is the ONLY job this endpoint can execute. It is a
// constant, not a parameter: the IAM elevation that makes the override possible
// is scoped to this one job, and the endpoint must not be able to aim elsewhere.
const ValidationJobName = "shorts-data-sync"

// validationSubcommand is the job binary's subcommand (the image ENTRYPOINT is
// /shorted and the deployed args are ["short-data-sync"]).
const validationSubcommand = "short-data-sync"

// ValidationLinePrefix marks the single compact JSON line a `-shadow -stocks`
// run writes to stdout.
//
// This literal is DUPLICATED in the job's own module
// (services/jobs/internal/jobs/shortdatasync/stocks.go, validationLinePrefix) —
// the two are separate Go modules and cannot share a constant. Both sides have
// a test pinning the exact string; change one, change the other.
const ValidationLinePrefix = "SHORTED_VALIDATION_JSON "

// maxValidationStocks mirrors the job's own cap. Enforced here too so an
// oversized request is refused before it costs a Cloud Run execution.
const maxValidationStocks = 20

// stockCodePattern is the ASX product-code shape: the ONLY characters that can
// reach the constructed argv.
var stockCodePattern = regexp.MustCompile(`^[A-Z0-9]{1,5}$`)

// executionNamePattern is the Cloud Run execution short-name shape. The lookup
// endpoint takes an execution name from the caller, so it is validated to the
// same standard as everything else before it is interpolated into a resource
// path.
var executionNamePattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// executionPathPattern is the full resource path Cloud Run emits. Whatever it
// names, only the trailing execution id is used — the project/region/job the
// lookup actually targets always come from the resolved fleet entry.
var executionPathPattern = regexp.MustCompile(`^projects/[^/]+/locations/[^/]+/jobs/[^/]+/executions/[^/]+$`)

// Errors specific to validation runs.
var (
	// ErrInvalidStocks: the requested code list is empty, oversized, or contains
	// something that is not a product code.
	ErrInvalidStocks = errors.New("jobmonitor: invalid stock codes")
	// ErrOverridesUnsupported: the configured Runner cannot perform an override
	// run (a test stub, or a future backend that only implements Run).
	ErrOverridesUnsupported = errors.New("jobmonitor: runner does not support argument overrides")
	// ErrInvalidExecution: the supplied execution name is not a plausible
	// Cloud Run execution id.
	ErrInvalidExecution = errors.New("jobmonitor: invalid execution name")
	// ErrSummaryNotFound: the execution finished but no validation JSON line was
	// found in its logs.
	ErrSummaryNotFound = errors.New("jobmonitor: validation summary not found in logs")
)

// ValidationRequest is a request to validate the sync for a set of stocks.
// Note what is NOT here: no job name, no region, no arguments.
type ValidationRequest struct {
	Stocks []string
	// Actor is the admin identity, for the audit log only.
	Actor string
}

// ValidationRun describes the execution that was created.
type ValidationRun struct {
	Job           string   `json:"job"`
	Region        string   `json:"region"`
	ExecutionName string   `json:"executionName"`
	Stocks        []string `json:"stocks"`
	// Args is the argv this service constructed. Echoed back so the console can
	// show an operator exactly what ran — it is output, never input.
	Args []string `json:"args"`
}

// OverrideRunner executes a job with a server-constructed argument list. It is
// a SEPARATE interface from Runner so that "can run" and "can run with
// arguments" remain distinguishable capabilities in the type system, the same
// way run.invoker and run.developer are in IAM.
type OverrideRunner interface {
	RunWithArgs(ctx context.Context, projectID, region, job string, args []string) (string, error)
}

// NormalizeStockCodes validates and normalises a caller-supplied code list:
// trims, upper-cases, splits on comma/whitespace, de-duplicates preserving
// order, and rejects anything that is not [A-Z0-9]{1,5}.
//
// This is the ONLY function that turns caller input into argv material, which
// is why it is exported and independently tested.
func NormalizeStockCodes(in []string) ([]string, error) {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, raw := range in {
		for _, field := range strings.FieldsFunc(raw, func(r rune) bool {
			return r == ',' || r == ' ' || r == '\t' || r == '\n' || r == ';'
		}) {
			code := strings.ToUpper(strings.TrimSpace(field))
			if code == "" {
				continue
			}
			if !stockCodePattern.MatchString(code) {
				return nil, fmt.Errorf("%w: %q is not an ASX product code", ErrInvalidStocks, field)
			}
			if _, dup := seen[code]; dup {
				continue
			}
			seen[code] = struct{}{}
			out = append(out, code)
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%w: no stock codes supplied", ErrInvalidStocks)
	}
	if len(out) > maxValidationStocks {
		return nil, fmt.Errorf("%w: %d codes (max %d)", ErrInvalidStocks, len(out), maxValidationStocks)
	}
	return out, nil
}

// validationArgs builds the argv. Pure and total: given codes that passed
// NormalizeStockCodes, the result can only ever be a shadow run.
func validationArgs(codes []string) []string {
	return []string{validationSubcommand, "-shadow", "-stocks", strings.Join(codes, ",")}
}

// RunValidation starts a read-only, per-stock validation of the shorts sync.
//
// Validation order: codes (400) before project config (503) before job
// resolution (404/409). The already-running guard is deliberately NOT applied —
// see the file header.
func (c *Collector) RunValidation(ctx context.Context, req ValidationRequest) (*ValidationRun, error) {
	codes, err := NormalizeStockCodes(req.Stocks)
	if err != nil {
		return nil, err
	}
	target, err := c.resolveValidationTarget(ctx)
	if err != nil {
		return nil, err
	}

	overrider, ok := c.overrideRunner()
	if !ok {
		return nil, ErrOverridesUnsupported
	}
	args := validationArgs(codes)
	execName, err := overrider.RunWithArgs(ctx, c.cfg.ProjectID, target.Region, target.Name, args)
	if err != nil {
		return nil, err
	}

	// A validation run creates an execution the dashboard will otherwise miss
	// for up to a minute; same reasoning as RunJob.
	c.Invalidate()

	return &ValidationRun{
		Job:           target.Name,
		Region:        target.Region,
		ExecutionName: execName,
		Stocks:        codes,
		Args:          args,
	}, nil
}

// resolveValidationTarget finds shorts-data-sync in the collected fleet. Same
// posture as resolveRunTarget: the caller never names a resource, and an
// unknown/retired/non-job row refuses here rather than at GCP.
func (c *Collector) resolveValidationTarget(ctx context.Context) (*JobStatus, error) {
	if c.cfg.ProjectID == "" {
		return nil, ErrNoProject
	}
	jobs, err := c.Collect(ctx)
	if err != nil && len(jobs) == 0 {
		return nil, err
	}
	for i := range jobs {
		if jobs[i].Name != ValidationJobName {
			continue
		}
		if jobs[i].Type != "job" || jobs[i].Region == "" {
			return nil, ErrNotExecutable
		}
		if jobs[i].Retired {
			return nil, ErrRetiredJob
		}
		return &jobs[i], nil
	}
	return nil, ErrUnknownJob
}

// overrideRunner returns the configured runner as an OverrideRunner.
func (c *Collector) overrideRunner() (OverrideRunner, bool) {
	r := c.runner
	if r == nil {
		r = cloudRunRunner{}
	}
	o, ok := r.(OverrideRunner)
	return o, ok
}

// RunWithArgs is the production override path: projects.locations.jobs.run with
// overrides.containerOverrides[0].args.
//
// The deployed job has exactly ONE container and it is unnamed, so an empty
// override Name targets it. `command` is NOT overridden — the image ENTRYPOINT
// (/shorted) stays in force, so the override can only ever change the
// subcommand and flags, never the binary.
func (r cloudRunRunner) RunWithArgs(ctx context.Context, projectID, region, job string, args []string) (string, error) {
	opts := append([]option.ClientOption{regionalRunEndpoint(region)}, r.opts...)
	svc, err := run.NewService(ctx, opts...)
	if err != nil {
		return "", fmt.Errorf("jobmonitor: create run client (%s): %w", region, err)
	}
	name := fmt.Sprintf("projects/%s/locations/%s/jobs/%s", projectID, region, job)
	op, err := svc.Projects.Locations.Jobs.
		Run(name, &run.GoogleCloudRunV2RunJobRequest{
			Overrides: &run.GoogleCloudRunV2Overrides{
				ContainerOverrides: []*run.GoogleCloudRunV2ContainerOverride{{
					Args: args,
					// ClearArgs is not set: Args replaces the deployed args
					// outright, and an empty Args would be ambiguous. Every
					// validation run supplies a non-empty list.
				}},
			},
		}).
		Context(ctx).Do()
	if err != nil {
		return "", fmt.Errorf("jobmonitor: run job %s with overrides: %w", job, err)
	}
	return executionNameFromOperation(op), nil
}

// --- result retrieval -------------------------------------------------------

// ValidationReport is the polled result of a validation run.
type ValidationReport struct {
	ExecutionName string `json:"executionName"`
	// Status is "running" | "succeeded" | "failed" | "unknown".
	Status      string `json:"status"`
	StartedAt   string `json:"startedAt,omitempty"`
	CompletedAt string `json:"completedAt,omitempty"`
	LogUri      string `json:"logUri,omitempty"`
	// Message explains a failure or a missing summary; empty on a clean success.
	Message string `json:"message,omitempty"`
	// Summary is the job's own JSON, passed through VERBATIM. jobmonitor does
	// not re-shape it: the contract belongs to the job (schema_version), and a
	// translation layer here would be a second place for it to drift.
	Summary json.RawMessage `json:"summary,omitempty"`
	// LogTail is the last few log lines, surfaced when the run failed or the
	// summary could not be found — the two cases where an operator needs the
	// raw evidence rather than a parsed report.
	LogTail []string `json:"logTail,omitempty"`
}

// ExecutionReader fetches one execution's state. An interface so the handler is
// testable without GCP.
type ExecutionReader interface {
	Execution(ctx context.Context, projectID, region, job, execution string) (*run.GoogleCloudRunV2Execution, error)
}

// LogReader returns an execution's log lines, NEWEST FIRST.
type LogReader interface {
	Lines(ctx context.Context, projectID, job, execution string, limit int) ([]string, error)
}

// SetExecutionReader / SetLogReader override the retrieval backends (tests).
func (c *Collector) SetExecutionReader(r ExecutionReader) { c.execReader = r }
func (c *Collector) SetLogReader(r LogReader)             { c.logReader = r }

// logTailLimit is how many log entries the reader pulls. Enough to hold the
// summary line plus a failure's stderr context, small enough to stay one page.
const logTailLimit = 200

// ValidationResult polls one validation execution and, once it has finished,
// returns the job's JSON summary.
//
// Behaviour by state:
//   - still running  → Status "running", no summary, no error
//   - finished ok    → Status "succeeded" + Summary (or ErrSummaryNotFound)
//   - finished bad   → Status "failed" + Message + LogTail (a summary is still
//     attached if one was emitted before the failure)
func (c *Collector) ValidationResult(ctx context.Context, executionName string) (*ValidationReport, error) {
	execName := strings.TrimSpace(executionName)
	// A full resource path is accepted for convenience, but ONLY the last
	// segment is ever used, and only when the rest of the path is the exact
	// shape Cloud Run emits. Anything else (a relative path, a traversal, a
	// different resource kind) is refused outright rather than silently reduced
	// to its basename — "../../etc/passwd" must not become "passwd".
	if strings.Contains(execName, "/") {
		if !executionPathPattern.MatchString(execName) {
			return nil, ErrInvalidExecution
		}
		execName = basename(execName)
	}
	if !executionNamePattern.MatchString(execName) {
		return nil, ErrInvalidExecution
	}
	target, err := c.resolveValidationTarget(ctx)
	if err != nil {
		return nil, err
	}

	reader := c.execReader
	if reader == nil {
		reader = cloudRunExecutionReader{}
	}
	exec, err := reader.Execution(ctx, c.cfg.ProjectID, target.Region, target.Name, execName)
	if err != nil {
		return nil, err
	}

	rep := &ValidationReport{ExecutionName: execName}
	if exec != nil {
		rep.StartedAt = exec.StartTime
		rep.CompletedAt = exec.CompletionTime
		rep.LogUri = exec.LogUri
	}
	rep.Status = executionState(exec)
	if rep.Status == "running" {
		return rep, nil
	}

	logs := c.logReader
	if logs == nil {
		logs = cloudLoggingReader{}
	}
	lines, logErr := logs.Lines(ctx, c.cfg.ProjectID, target.Name, execName, logTailLimit)
	if logErr != nil {
		rep.Message = fmt.Sprintf("execution %s, but its logs could not be read: %v", rep.Status, logErr)
		return rep, nil
	}

	if summary, ok := findValidationSummary(lines); ok {
		rep.Summary = summary
	}
	if rep.Status == "failed" {
		rep.Message = executionFailureMessage(exec)
		rep.LogTail = tail(lines, 15)
		return rep, nil
	}
	if rep.Summary == nil {
		// An explicit error, not a silent empty report: "the run succeeded but
		// produced no summary" is a real (and confusing) failure mode — a stale
		// job image without the -stocks flag looks exactly like this.
		rep.Message = "the execution succeeded but no validation summary was found in its logs (is the deployed shorts-data-sync image new enough to support -stocks?)"
		rep.LogTail = tail(lines, 15)
		return rep, ErrSummaryNotFound
	}
	return rep, nil
}

// executionState collapses Cloud Run's counters into the three states the
// console cares about. Counters, not conditions: a task that has finished is
// counted, whereas the condition set varies by failure mode.
func executionState(exec *run.GoogleCloudRunV2Execution) string {
	if exec == nil {
		return "unknown"
	}
	if exec.CompletionTime == "" || exec.RunningCount > 0 {
		return "running"
	}
	if exec.FailedCount > 0 || exec.CancelledCount > 0 || exec.SucceededCount == 0 {
		return "failed"
	}
	return "succeeded"
}

// failureMessage extracts the most specific reason Cloud Run offers.
func executionFailureMessage(exec *run.GoogleCloudRunV2Execution) string {
	if exec == nil {
		return "execution not found"
	}
	for _, cond := range exec.Conditions {
		if cond == nil || cond.Message == "" {
			continue
		}
		if cond.State == "CONDITION_FAILED" || cond.Reason != "" {
			return cond.Message
		}
	}
	if exec.CancelledCount > 0 {
		return "execution was cancelled"
	}
	return fmt.Sprintf("execution failed (%d failed task(s))", exec.FailedCount)
}

// findValidationSummary locates the job's compact JSON line among log entries.
//
// Defensive on purpose — logs are a lossy transport:
//  1. prefer a line carrying ValidationLinePrefix;
//  2. otherwise accept any line that parses as a JSON object whose "mode" is
//     "shadow" (a structured-logging layer may have stripped the prefix);
//  3. a line that does not parse is skipped, never fatal.
//
// Entries arrive newest first, so the FIRST match is the latest summary.
func findValidationSummary(lines []string) (json.RawMessage, bool) {
	var fallback json.RawMessage
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if i := strings.Index(trimmed, ValidationLinePrefix); i >= 0 {
			candidate := strings.TrimSpace(trimmed[i+len(ValidationLinePrefix):])
			if raw, ok := parseSummary(candidate); ok {
				return raw, true
			}
			continue
		}
		if fallback == nil {
			if raw, ok := parseSummary(trimmed); ok {
				fallback = raw
			}
		}
	}
	if fallback != nil {
		return fallback, true
	}
	return nil, false
}

// parseSummary accepts a JSON object that looks like a shadow summary.
func parseSummary(s string) (json.RawMessage, bool) {
	if !strings.HasPrefix(s, "{") {
		return nil, false
	}
	var probe struct {
		Mode string `json:"mode"`
	}
	if err := json.Unmarshal([]byte(s), &probe); err != nil {
		return nil, false
	}
	if probe.Mode != "shadow" {
		return nil, false
	}
	return json.RawMessage(s), true
}

// tail returns the last n entries of a NEWEST-FIRST list, oldest first, so the
// console renders them in reading order.
func tail(lines []string, n int) []string {
	if len(lines) > n {
		lines = lines[:n]
	}
	out := make([]string, 0, len(lines))
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.TrimSpace(lines[i]) == "" {
			continue
		}
		out = append(out, lines[i])
	}
	return out
}

// cloudRunExecutionReader is the production ExecutionReader.
type cloudRunExecutionReader struct {
	opts []option.ClientOption
}

func (r cloudRunExecutionReader) Execution(ctx context.Context, projectID, region, job, execution string) (*run.GoogleCloudRunV2Execution, error) {
	opts := append([]option.ClientOption{regionalRunEndpoint(region)}, r.opts...)
	svc, err := run.NewService(ctx, opts...)
	if err != nil {
		return nil, fmt.Errorf("jobmonitor: create run client (%s): %w", region, err)
	}
	name := fmt.Sprintf("projects/%s/locations/%s/jobs/%s/executions/%s", projectID, region, job, execution)
	exec, err := svc.Projects.Locations.Jobs.Executions.Get(name).Context(ctx).Do()
	if err != nil {
		var apiErr *googleapi.Error
		if errors.As(err, &apiErr) && apiErr.Code == 404 {
			return nil, fmt.Errorf("jobmonitor: execution %s not found", execution)
		}
		return nil, fmt.Errorf("jobmonitor: get execution %s: %w", execution, err)
	}
	return exec, nil
}

// cloudLoggingReader is the production LogReader.
type cloudLoggingReader struct {
	opts []option.ClientOption
}

// logFilter scopes the query to ONE execution of ONE job. Every interpolated
// value is either a constant or has already passed a pattern check, so the
// filter cannot be steered by caller input.
func logFilter(job, execution string) string {
	return fmt.Sprintf(
		`resource.type="cloud_run_job" resource.labels.job_name=%q labels."run.googleapis.com/execution_name"=%q`,
		job, execution,
	)
}

func (r cloudLoggingReader) Lines(ctx context.Context, projectID, job, execution string, limit int) ([]string, error) {
	svc, err := logging.NewService(ctx, r.opts...)
	if err != nil {
		return nil, fmt.Errorf("jobmonitor: create logging client: %w", err)
	}
	resp, err := svc.Entries.List(&logging.ListLogEntriesRequest{
		ResourceNames: []string{"projects/" + projectID},
		Filter:        logFilter(job, execution),
		OrderBy:       "timestamp desc",
		PageSize:      int64(limit),
	}).Context(ctx).Do()
	if err != nil {
		return nil, fmt.Errorf("jobmonitor: list log entries: %w", err)
	}
	return entryLines(resp.Entries), nil
}

// entryLines flattens log entries to strings, newest first. Both payload shapes
// are handled: a plain stdout line arrives as textPayload, but a structured
// logging sink may wrap it in jsonPayload.message.
func entryLines(entries []*logging.LogEntry) []string {
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		if e == nil {
			continue
		}
		if e.TextPayload != "" {
			out = append(out, e.TextPayload)
			continue
		}
		if len(e.JsonPayload) > 0 {
			var payload struct {
				Message string `json:"message"`
			}
			if err := json.Unmarshal(e.JsonPayload, &payload); err == nil && payload.Message != "" {
				out = append(out, payload.Message)
				continue
			}
			out = append(out, string(e.JsonPayload))
		}
	}
	return out
}
