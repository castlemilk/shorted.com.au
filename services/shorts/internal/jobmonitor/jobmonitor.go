// Package jobmonitor reports the run status of every scheduled async job by
// reading Google Cloud's own execution history — Cloud Run Jobs (executions)
// and Cloud Scheduler (triggers) — rather than relying on each job to write a
// row into a database table.
//
// This gives the /admin dashboard universal coverage of the whole fleet
// (~16 scheduled triggers across ~9 jobs/services) with zero per-job
// instrumentation: any job that exists in the project shows up automatically.
//
// All GCP reads are best-effort: a partial failure (e.g. one job's executions
// cannot be listed) degrades that one entry rather than failing the whole call,
// and a hard failure falls back to the last successfully cached result.
package jobmonitor

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	cloudscheduler "google.golang.org/api/cloudscheduler/v1"
	"google.golang.org/api/option"
	run "google.golang.org/api/run/v2"
)

// Health classifies a job's most recent run for at-a-glance dashboard colouring.
type Health string

const (
	HealthOK       Health = "ok"
	HealthRunning  Health = "running"
	HealthWarning  Health = "warning" // succeeded but stale, or scheduler paused
	HealthCritical Health = "critical"
	HealthUnknown  Health = "unknown" // never run / no data
)

// JobStatus is the unified, source-agnostic status of a single scheduled job.
type JobStatus struct {
	Name            string  `json:"name"`
	DisplayName     string  `json:"displayName"`
	Category        string  `json:"category"`
	Type            string  `json:"type"` // "job" (Cloud Run Job) | "service" (scheduler-triggered HTTP service)
	Schedule        string  `json:"schedule"`
	ScheduleHuman   string  `json:"scheduleHuman"`
	SchedulerState  string  `json:"schedulerState"` // ENABLED | PAUSED | ""
	LastRunAt       string  `json:"lastRunAt"`      // RFC3339, "" if never
	LastRunStatus   string  `json:"lastRunStatus"`  // succeeded | failed | running | unknown | never
	LastSuccessAt   string  `json:"lastSuccessAt"`
	DurationSeconds float64 `json:"durationSeconds"`
	SucceededCount  int64   `json:"succeededCount"`
	FailedCount     int64   `json:"failedCount"`
	RunningCount    int64   `json:"runningCount"`
	ExecutionName   string  `json:"executionName"`
	Message         string  `json:"message"`
	LogUri          string  `json:"logUri"`
	LastAttemptAt   string  `json:"lastAttemptAt"` // scheduler last trigger attempt
	Health          Health  `json:"health"`
}

// Config controls which project/regions are queried.
type Config struct {
	ProjectID       string
	RunRegion       string
	SchedulerRegion string
}

// ConfigFromEnv resolves the project + regions from the environment, falling
// back to the production defaults this service runs in.
func ConfigFromEnv() Config {
	project := firstNonEmpty(
		os.Getenv("JOBS_GCP_PROJECT"),
		os.Getenv("GOOGLE_CLOUD_PROJECT"),
		os.Getenv("GCP_PROJECT_ID"),
		os.Getenv("GOOGLE_CLOUD_PROJECT_ID"),
	)
	return Config{
		ProjectID:       project,
		RunRegion:       firstNonEmpty(os.Getenv("JOBS_RUN_REGION"), "australia-southeast2"),
		SchedulerRegion: firstNonEmpty(os.Getenv("JOBS_SCHEDULER_REGION"), "australia-southeast1"),
	}
}

// Collector lists job status with a short TTL cache so repeated dashboard loads
// don't hammer the Cloud Run / Scheduler admin APIs.
type Collector struct {
	cfg Config
	ttl time.Duration

	mu       sync.Mutex
	cached   []JobStatus
	cachedAt time.Time
}

// NewCollector builds a Collector with a 60s cache TTL.
func NewCollector(cfg Config) *Collector {
	return &Collector{cfg: cfg, ttl: 60 * time.Second}
}

// Collect returns the unified job status list, served from cache when fresh.
// On a hard error it returns the last cached result (if any) alongside the error
// so callers can choose to serve stale data.
func (c *Collector) Collect(ctx context.Context) ([]JobStatus, error) {
	c.mu.Lock()
	if c.cached != nil && time.Since(c.cachedAt) < c.ttl {
		out := c.cached
		c.mu.Unlock()
		return out, nil
	}
	c.mu.Unlock()

	fresh, err := collect(ctx, c.cfg)
	if err != nil {
		c.mu.Lock()
		stale := c.cached
		c.mu.Unlock()
		if stale != nil {
			return stale, err
		}
		return nil, err
	}

	c.mu.Lock()
	c.cached = fresh
	c.cachedAt = time.Now()
	c.mu.Unlock()
	return fresh, nil
}

// collect does the actual GCP queries and merge. Exported indirectly via Collect.
// authOpts are applied to every client (used by tests to inject credentials).
func collect(ctx context.Context, cfg Config, authOpts ...option.ClientOption) ([]JobStatus, error) {
	if cfg.ProjectID == "" {
		return nil, fmt.Errorf("jobmonitor: project ID not configured (set JOBS_GCP_PROJECT / GOOGLE_CLOUD_PROJECT)")
	}

	// --- Cloud Run Jobs (regional endpoint) ---
	runOpts := append([]option.ClientOption{regionalRunEndpoint(cfg.RunRegion)}, authOpts...)
	runSvc, err := run.NewService(ctx, runOpts...)
	if err != nil {
		return nil, fmt.Errorf("jobmonitor: create run client: %w", err)
	}

	jobsParent := fmt.Sprintf("projects/%s/locations/%s", cfg.ProjectID, cfg.RunRegion)
	jobsResp, err := runSvc.Projects.Locations.Jobs.List(jobsParent).PageSize(200).Context(ctx).Do()
	if err != nil {
		return nil, fmt.Errorf("jobmonitor: list jobs: %w", err)
	}

	byName := map[string]*JobStatus{}
	order := []string{}
	for _, job := range jobsResp.Jobs {
		name := basename(job.Name)
		st := &JobStatus{
			Name:          name,
			DisplayName:   humanize(name),
			Category:      categoryFor(name),
			Type:          "job",
			LastRunStatus: "never",
			Health:        HealthUnknown,
		}

		// Latest executions for this job (best-effort).
		execResp, execErr := runSvc.Projects.Locations.Jobs.Executions.
			List(job.Name).PageSize(20).Context(ctx).Do()
		if execErr == nil && execResp != nil && len(execResp.Executions) > 0 {
			applyExecutions(st, execResp.Executions)
		} else if job.LatestCreatedExecution != nil {
			// Fall back to the reference embedded on the job itself.
			st.ExecutionName = basename(job.LatestCreatedExecution.Name)
			st.LastRunAt = firstNonEmpty(job.LatestCreatedExecution.CompletionTime, job.LatestCreatedExecution.CreateTime)
			st.LastRunStatus = "unknown"
		}

		byName[name] = st
		order = append(order, name)
	}

	// --- Cloud Scheduler triggers (global endpoint, regional parent) ---
	schedSvc, schedErr := cloudscheduler.NewService(ctx, authOpts...)
	if schedErr == nil {
		schedParent := fmt.Sprintf("projects/%s/locations/%s", cfg.ProjectID, cfg.SchedulerRegion)
		schedResp, listErr := schedSvc.Projects.Locations.Jobs.List(schedParent).PageSize(200).Context(ctx).Do()
		if listErr == nil {
			mergeSchedulers(byName, &order, schedResp.Jobs)
		}
	}

	// Finalise health + assemble in stable order.
	out := make([]JobStatus, 0, len(order))
	for _, n := range order {
		st := byName[n]
		finalizeHealth(st)
		out = append(out, *st)
	}

	sort.SliceStable(out, func(i, j int) bool {
		return healthRank(out[i].Health) < healthRank(out[j].Health)
	})
	return out, nil
}

// applyExecutions picks the newest execution for last-run status and scans for
// the most recent successful one for the "last success" timestamp.
func applyExecutions(st *JobStatus, execs []*run.GoogleCloudRunV2Execution) {
	sort.SliceStable(execs, func(i, j int) bool {
		return execStart(execs[i]) > execStart(execs[j]) // newest first
	})

	latest := execs[0]
	st.ExecutionName = basename(latest.Name)
	st.LastRunAt = firstNonEmpty(latest.StartTime, latest.CreateTime)
	st.SucceededCount = latest.SucceededCount
	st.FailedCount = latest.FailedCount
	st.RunningCount = latest.RunningCount
	st.LogUri = latest.LogUri
	st.LastRunStatus = execStatus(latest)
	if latest.CompletionTime != "" && latest.StartTime != "" {
		if d := parseTime(latest.CompletionTime).Sub(parseTime(latest.StartTime)); d > 0 {
			st.DurationSeconds = d.Seconds()
		}
	}
	if msg := failureMessage(latest); msg != "" {
		st.Message = msg
	}

	for _, e := range execs {
		if execStatus(e) == "succeeded" {
			st.LastSuccessAt = firstNonEmpty(e.CompletionTime, e.StartTime, e.CreateTime)
			break
		}
	}
}

// mergeSchedulers attaches schedule/state to matching Cloud Run jobs and adds a
// row for any scheduler trigger that targets a service rather than a job.
func mergeSchedulers(byName map[string]*JobStatus, order *[]string, schedulers []*cloudscheduler.Job) {
	// Stable order so "primary" selection is deterministic.
	sort.SliceStable(schedulers, func(i, j int) bool {
		return basename(schedulers[i].Name) < basename(schedulers[j].Name)
	})

	// Match scheduler -> run job by name prefix (e.g. "shorts-data-sync-daily" -> "shorts-data-sync").
	runNames := make([]string, 0, len(byName))
	for n := range byName {
		runNames = append(runNames, n)
	}
	// Longest job name first so the most specific match wins.
	sort.Slice(runNames, func(i, j int) bool { return len(runNames[i]) > len(runNames[j]) })

	for _, sj := range schedulers {
		sName := basename(sj.Name)
		matched := ""
		for _, rn := range runNames {
			if sName == rn || strings.HasPrefix(sName, rn+"-") {
				matched = rn
				break
			}
		}

		if matched != "" {
			st := byName[matched]
			// Prefer the trigger with the most recent attempt as the primary schedule.
			if st.Schedule == "" || sj.LastAttemptTime > st.LastAttemptAt {
				st.Schedule = sj.Schedule
				st.ScheduleHuman = humanizeCron(sj.Schedule)
				st.SchedulerState = sj.State
			}
			if sj.LastAttemptTime > st.LastAttemptAt {
				st.LastAttemptAt = sj.LastAttemptTime
			}
			continue
		}

		// No matching Cloud Run Job: this scheduler triggers an HTTP service.
		st := &JobStatus{
			Name:           sName,
			DisplayName:    humanize(sName),
			Category:       categoryFor(sName),
			Type:           "service",
			Schedule:       sj.Schedule,
			ScheduleHuman:  humanizeCron(sj.Schedule),
			SchedulerState: sj.State,
			LastAttemptAt:  sj.LastAttemptTime,
			LastRunAt:      sj.LastAttemptTime,
			LastRunStatus:  schedulerStatus(sj),
			Health:         HealthUnknown,
		}
		if sj.Status != nil && sj.Status.Code != 0 {
			st.Message = sj.Status.Message
		}
		if sj.LastAttemptTime != "" && st.LastRunStatus == "succeeded" {
			st.LastSuccessAt = sj.LastAttemptTime
		}
		byName[sName] = st
		*order = append(*order, sName)
	}
}

// --- status helpers ---

func execStatus(e *run.GoogleCloudRunV2Execution) string {
	if e.RunningCount > 0 {
		return "running"
	}
	if e.FailedCount > 0 {
		return "failed"
	}
	if e.SucceededCount > 0 {
		return "succeeded"
	}
	// Fall back to the Completed condition when counts are absent.
	for _, c := range e.Conditions {
		if c.Type == "Completed" {
			switch c.State {
			case "CONDITION_SUCCEEDED":
				return "succeeded"
			case "CONDITION_FAILED":
				return "failed"
			case "CONDITION_RECONCILING", "CONDITION_PENDING":
				return "running"
			}
		}
	}
	return "unknown"
}

func failureMessage(e *run.GoogleCloudRunV2Execution) string {
	for _, c := range e.Conditions {
		if c.Type == "Completed" && c.State == "CONDITION_FAILED" {
			if c.Message != "" {
				return c.Message
			}
			return c.Reason
		}
	}
	return ""
}

// schedulerStatus maps a scheduler's last attempt status code to a run status.
// Code 0 == OK (google.rpc.Code), non-zero == the last trigger failed.
func schedulerStatus(sj *cloudscheduler.Job) string {
	if sj.LastAttemptTime == "" {
		return "never"
	}
	if sj.Status != nil && sj.Status.Code != 0 {
		return "failed"
	}
	return "succeeded"
}

func finalizeHealth(st *JobStatus) {
	if st.Health != "" && st.Health != HealthUnknown && st.LastRunStatus == "" {
		return
	}
	switch st.LastRunStatus {
	case "running":
		st.Health = HealthRunning
		// A run still "running" well past its expected duration is likely a
		// stuck/zombie execution — surface it as a warning.
		if t := parseTime(st.LastRunAt); !t.IsZero() && time.Since(t) > 90*time.Minute {
			st.Health = HealthWarning
			if st.Message == "" {
				st.Message = "Running unusually long — may be stuck"
			}
		}
	case "failed":
		st.Health = HealthCritical
	case "succeeded":
		st.Health = HealthOK
		if isStale(st) {
			st.Health = HealthWarning
		}
	case "never", "unknown", "":
		st.Health = HealthUnknown
	default:
		st.Health = HealthUnknown
	}

	// A paused trigger on an otherwise-ok job is worth surfacing.
	if st.SchedulerState == "PAUSED" && st.Health == HealthOK {
		st.Health = HealthWarning
	}
}

// isStale flags a successful job whose last run is older than the expected
// cadence (derived loosely from its cron) plus a grace margin.
func isStale(st *JobStatus) bool {
	ref := firstNonEmpty(st.LastSuccessAt, st.LastRunAt)
	if ref == "" || st.Schedule == "" {
		return false
	}
	last := parseTime(ref)
	if last.IsZero() {
		return false
	}
	gap := time.Since(last)
	return gap > expectedMaxGap(st.Schedule)
}

// expectedMaxGap returns a generous upper bound on the interval between runs for
// a cron expression. It is intentionally coarse: daily ~ 30h, weekly ~ 8d,
// monthly ~ 32d, sub-daily ~ 3h.
func expectedMaxGap(cron string) time.Duration {
	fields := strings.Fields(cron)
	if len(fields) < 5 {
		return 36 * time.Hour
	}
	minute, hour, dom, _, dow := fields[0], fields[1], fields[2], fields[3], fields[4]

	if dom != "*" && dom != "?" {
		return 32 * 24 * time.Hour // monthly-ish
	}
	if dow != "*" && dow != "?" {
		// A range/list of weekdays (e.g. "1-5") runs multiple days a week but can
		// still gap across a weekend (Fri -> Mon ~= 72h), so allow ~80h before
		// calling it stale. A single weekday is a genuine weekly cadence.
		if strings.ContainsAny(dow, ",-/") {
			return 80 * time.Hour
		}
		return 8 * 24 * time.Hour // weekly
	}
	// Sub-hourly/hourly cadence: minute or hour contains a step.
	if strings.Contains(hour, "/") || strings.Contains(minute, "/") || strings.Contains(hour, ",") {
		return 3 * time.Hour
	}
	return 30 * time.Hour // daily
}

// --- formatting helpers ---

func regionalRunEndpoint(region string) option.ClientOption {
	return option.WithEndpoint(fmt.Sprintf("https://%s-run.googleapis.com/", region))
}

// humanizeCron turns common cron expressions into a short human label. Falls
// back to the raw expression for anything it doesn't recognise.
func humanizeCron(cron string) string {
	fields := strings.Fields(cron)
	if len(fields) < 5 {
		return cron
	}
	minute, hour, dom, _, dow := fields[0], fields[1], fields[2], fields[3], fields[4]
	atTime := func() string {
		if strings.ContainsAny(hour, "*/,") || strings.ContainsAny(minute, "*/,") {
			return ""
		}
		return fmt.Sprintf(" at %02s:%02s", hour, minute)
	}

	switch {
	case dom != "*" && dom != "?":
		return "Monthly" + atTime()
	case dow == "1-5":
		return "Weekdays" + atTime()
	case dow != "*" && dow != "?" && !strings.ContainsAny(dow, ",-/"):
		return "Weekly (" + weekdayName(dow) + ")" + atTime()
	case strings.Contains(hour, "/"):
		return "Every " + strings.TrimPrefix(hour[strings.Index(hour, "/"):], "/") + "h"
	case strings.Contains(minute, "/"):
		return "Every " + strings.TrimPrefix(minute[strings.Index(minute, "/"):], "/") + "m"
	default:
		return "Daily" + atTime()
	}
}

func weekdayName(dow string) string {
	names := map[string]string{
		"0": "Sun", "1": "Mon", "2": "Tue", "3": "Wed",
		"4": "Thu", "5": "Fri", "6": "Sat", "7": "Sun",
	}
	if n, ok := names[dow]; ok {
		return n
	}
	return dow
}

func basename(resource string) string {
	if i := strings.LastIndex(resource, "/"); i >= 0 {
		return resource[i+1:]
	}
	return resource
}

func humanize(name string) string {
	parts := strings.FieldsFunc(name, func(r rune) bool { return r == '-' || r == '_' })
	for i, p := range parts {
		if p == "" {
			continue
		}
		parts[i] = strings.ToUpper(p[:1]) + p[1:]
	}
	return strings.Join(parts, " ")
}

func categoryFor(name string) string {
	switch {
	case strings.Contains(name, "short") || strings.Contains(name, "market-data") || strings.Contains(name, "stock-price") || strings.Contains(name, "key-metrics") || strings.Contains(name, "discovery"):
		return "Market data"
	case strings.Contains(name, "news"):
		return "News"
	case strings.Contains(name, "report") || strings.Contains(name, "director") || strings.Contains(name, "announcement") || strings.Contains(name, "financial"):
		return "Filings & reports"
	case strings.Contains(name, "signal"):
		return "Signals"
	default:
		return "Other"
	}
}

func execStart(e *run.GoogleCloudRunV2Execution) string {
	return firstNonEmpty(e.StartTime, e.CreateTime)
}

func parseTime(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t, err = time.Parse(time.RFC3339Nano, s)
		if err != nil {
			return time.Time{}
		}
	}
	return t
}

func healthRank(h Health) int {
	switch h {
	case HealthCritical:
		return 0
	case HealthWarning:
		return 1
	case HealthRunning:
		return 2
	case HealthUnknown:
		return 3
	case HealthOK:
		return 4
	default:
		return 5
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
