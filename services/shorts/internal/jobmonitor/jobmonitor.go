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
	HealthOK      Health = "ok"
	HealthRunning Health = "running"
	// HealthOverdue: the last run SUCCEEDED, but that success is older than the
	// job's cadence allows — i.e. a scheduled run silently did not happen. This is
	// deliberately distinct from HealthWarning: a failing job screams, but a job
	// that simply stopped being triggered is the outage mode that hides for days.
	HealthOverdue  Health = "overdue"
	HealthWarning  Health = "warning" // paused scheduler, stuck run, degraded
	HealthCritical Health = "critical"
	HealthUnknown  Health = "unknown" // never run / no data
)

// Trigger is ONE Cloud Scheduler entry pointing at a job. A job can have many
// (shorted-news has five, house-price-collector two); collapsing them to a single
// "schedule" column hid whole cadences from the console, so all of them travel.
type Trigger struct {
	Name          string `json:"name"`
	Schedule      string `json:"schedule"`
	ScheduleHuman string `json:"scheduleHuman"`
	State         string `json:"state"` // ENABLED | PAUSED
	LastAttemptAt string `json:"lastAttemptAt"`
	LastStatus    string `json:"lastStatus"` // succeeded | failed | never
}

// RecordCount is a per-run volume metric from a job's own bookkeeping (currently
// only the sync_status table). Purely for display.
type RecordCount struct {
	Label string `json:"label"`
	Count int64  `json:"count"`
}

// JobStatus is the unified, source-agnostic status of a single scheduled job.
type JobStatus struct {
	Name           string `json:"name"`
	DisplayName    string `json:"displayName"`
	Category       string `json:"category"`
	Type           string `json:"type"`   // "job" (Cloud Run Job) | "service" (scheduler-triggered HTTP service) | "rig"
	Region         string `json:"region"` // Cloud Run region the job is deployed in
	Schedule       string `json:"schedule"`
	ScheduleHuman  string `json:"scheduleHuman"`
	SchedulerState string `json:"schedulerState"` // ENABLED | PAUSED | ""
	// Triggers lists EVERY Cloud Scheduler entry that fires this job. Schedule/
	// ScheduleHuman above are the "primary" (tightest enabled cadence) trigger.
	Triggers        []Trigger `json:"triggers,omitempty"`
	LastRunAt       string    `json:"lastRunAt"`     // RFC3339, "" if never
	LastRunStatus   string    `json:"lastRunStatus"` // succeeded | failed | running | unknown | never
	LastSuccessAt   string    `json:"lastSuccessAt"`
	DurationSeconds float64   `json:"durationSeconds"`
	SucceededCount  int64     `json:"succeededCount"`
	FailedCount     int64     `json:"failedCount"`
	RunningCount    int64     `json:"runningCount"`
	// RunningExecution is the newest execution still in flight — including when a
	// LATER execution has already completed (the Python sync ran 26-29h, so a
	// quick on-demand run finishing first left the long run invisible to the
	// newest-execution fields; the Run-now guard missed it in prod 2026-08-21).
	RunningExecution string `json:"runningExecution,omitempty"`
	RunningStartedAt string `json:"runningStartedAt,omitempty"`
	ExecutionName   string    `json:"executionName"`
	Message         string    `json:"message"`
	// Note is static operator context from the catalog (why a job is retired,
	// how it is triggered). Distinct from Message, which is run-derived.
	Note    string `json:"note,omitempty"`
	Retired bool   `json:"retired,omitempty"`
	LogUri  string `json:"logUri"`
	// ExpectedMaxGapSeconds is the cadence-derived ceiling on the interval between
	// successful runs; OverdueBySeconds is how far past it we are (0 when fine).
	ExpectedMaxGapSeconds float64       `json:"expectedMaxGapSeconds,omitempty"`
	OverdueBySeconds      float64       `json:"overdueBySeconds,omitempty"`
	Records               []RecordCount `json:"records,omitempty"`
	LastAttemptAt         string        `json:"lastAttemptAt"` // scheduler last trigger attempt
	Health                Health        `json:"health"`
}

// Config controls which project/regions are queried.
type Config struct {
	ProjectID string
	// RunRegions is every Cloud Run region to enumerate jobs in. It MUST be a
	// list: batch jobs are deliberately split across regions for Tier-1 pricing
	// (asx-discovery + stock-price ingestion live in us-central1 while everything
	// else is australia-southeast2), so a single-region collector silently omits
	// them from the fleet.
	RunRegions      []string
	SchedulerRegion string
	// ValidationBucket is the GCS bucket a per-stock sync validation publishes
	// its report to (see validate.go). Empty means the retrieval endpoint is
	// not configured — it refuses with ErrNoBucket rather than guessing, since
	// the bucket name differs per environment.
	ValidationBucket string
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
	// JOBS_RUN_REGIONS (csv) is an explicit override — whatever it says, that's the
	// list. Otherwise we scan the regions prod actually deploys jobs to (verified
	// 2026-08-21), UNIONed with the legacy singular JOBS_RUN_REGION.
	//
	// The union matters: terraform sets JOBS_RUN_REGION to the API's own region,
	// so treating the singular var as a replacement would keep the collector blind
	// to the us-central1 jobs (asx-discovery) until a terraform apply lands. The
	// list of regions to LOOK IN is not the same question as where the API runs.
	var regions []string
	if explicit := os.Getenv("JOBS_RUN_REGIONS"); explicit != "" {
		regions = splitCSV(explicit)
	} else {
		regions = dedupe(append(
			splitCSV(defaultRunRegions),
			splitCSV(os.Getenv("JOBS_RUN_REGION"))...,
		))
	}
	return Config{
		ProjectID:       project,
		RunRegions:      regions,
		SchedulerRegion: firstNonEmpty(os.Getenv("JOBS_SCHEDULER_REGION"), "australia-southeast1"),
		// SHORTS_DATA_BUCKET is the SAME variable name the shorts-data-sync job
		// reads (services/jobs/.../artifact.go): they must agree on one bucket,
		// and a second name would be a second thing to get wrong. No default —
		// prod and dev use different bucket names, so a guess would read the
		// wrong bucket rather than fail honestly.
		ValidationBucket: os.Getenv("SHORTS_DATA_BUCKET"),
	}
}

// defaultRunRegions is every Cloud Run region prod deploys jobs to. Batch jobs
// are split out to us-central1 for Tier-1 pricing (asx-discovery, stock-price
// ingestion, enrichment-processor) — see terraform/environments/prod/main.tf.
const defaultRunRegions = "australia-southeast2,us-central1"

// dedupe preserves order and drops repeats.
func dedupe(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, v := range in {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

// splitCSV parses a comma-separated region list, dropping blanks.
func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// Collector lists job status with a short TTL cache so repeated dashboard loads
// don't hammer the Cloud Run / Scheduler admin APIs.
type Collector struct {
	cfg Config
	ttl time.Duration
	// runner executes a job on demand (see run.go). nil means the default
	// Cloud Run backend; tests inject a stub.
	runner Runner
	// execReader / artifactReader retrieve a validation run's outcome (see
	// validate.go). nil means the default GCP backends; tests inject stubs.
	execReader     ExecutionReader
	artifactReader ArtifactReader

	mu       sync.Mutex
	cached   []JobStatus
	cachedAt time.Time
}

// NewCollector builds a Collector with a 60s cache TTL.
func NewCollector(cfg Config) *Collector {
	return &Collector{cfg: cfg, ttl: 60 * time.Second, runner: cloudRunRunner{}}
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

	// --- Cloud Run Jobs (one regional endpoint per configured region) ---
	byName := map[string]*JobStatus{}
	order := []string{}

	var lastRegionErr error
	regionsSeen := 0
	for _, region := range cfg.RunRegions {
		runOpts := append([]option.ClientOption{regionalRunEndpoint(region)}, authOpts...)
		runSvc, err := run.NewService(ctx, runOpts...)
		if err != nil {
			lastRegionErr = fmt.Errorf("jobmonitor: create run client (%s): %w", region, err)
			continue
		}

		jobsParent := fmt.Sprintf("projects/%s/locations/%s", cfg.ProjectID, region)
		jobsResp, err := runSvc.Projects.Locations.Jobs.List(jobsParent).PageSize(200).Context(ctx).Do()
		if err != nil {
			// One unreachable region degrades that region, not the whole fleet.
			lastRegionErr = fmt.Errorf("jobmonitor: list jobs (%s): %w", region, err)
			continue
		}
		regionsSeen++

		for _, job := range jobsResp.Jobs {
			name := basename(job.Name)
			if _, dup := byName[name]; dup {
				continue // same name in two regions: first region wins
			}
			st := &JobStatus{
				Name:          name,
				Type:          "job",
				Region:        region,
				LastRunStatus: "never",
				Health:        HealthUnknown,
			}
			decorate(st)

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
	}
	// Every configured region failed — that's a hard error (serve stale instead).
	if regionsSeen == 0 {
		if lastRegionErr != nil {
			return nil, lastRegionErr
		}
		return nil, fmt.Errorf("jobmonitor: no Cloud Run regions configured")
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

	// Problems first; retired jobs always last so they never sit above a live one.
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Retired != out[j].Retired {
			return !out[i].Retired
		}
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

	// Any in-flight execution counts — not just the newest one.
	for _, e := range execs {
		if execStatus(e) == "running" {
			st.RunningExecution = basename(e.Name)
			st.RunningStartedAt = firstNonEmpty(e.StartTime, e.CreateTime)
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

		trig := Trigger{
			Name:          sName,
			Schedule:      sj.Schedule,
			ScheduleHuman: humanizeCron(sj.Schedule),
			State:         sj.State,
			LastAttemptAt: sj.LastAttemptTime,
			LastStatus:    schedulerStatus(sj),
		}

		if matched != "" {
			st := byName[matched]
			st.Triggers = append(st.Triggers, trig)
			if sj.LastAttemptTime > st.LastAttemptAt {
				st.LastAttemptAt = sj.LastAttemptTime
			}
			continue
		}

		// No matching Cloud Run Job: this scheduler triggers an HTTP service.
		st := &JobStatus{
			Name:           sName,
			Type:           "service",
			Schedule:       sj.Schedule,
			ScheduleHuman:  humanizeCron(sj.Schedule),
			SchedulerState: sj.State,
			Triggers:       []Trigger{trig},
			LastAttemptAt:  sj.LastAttemptTime,
			LastRunAt:      sj.LastAttemptTime,
			LastRunStatus:  schedulerStatus(sj),
			Health:         HealthUnknown,
		}
		decorate(st)
		if sj.Status != nil && sj.Status.Code != 0 {
			st.Message = sj.Status.Message
		}
		if sj.LastAttemptTime != "" && st.LastRunStatus == "succeeded" {
			st.LastSuccessAt = sj.LastAttemptTime
		}
		byName[sName] = st
		*order = append(*order, sName)
	}

	// Promote a primary trigger per job now that every trigger is attached.
	for _, st := range byName {
		applyPrimaryTrigger(st)
	}
}

// applyPrimaryTrigger picks the schedule the console shows and that "overdue" is
// measured against.
//
// The rule is the TIGHTEST ENABLED cadence, not (as before) the most recently
// attempted one. For a multi-trigger job — shorted-news fires every 4h, every 2h,
// weekly and daily off one Cloud Run Job — the most-recent-attempt rule picked an
// arbitrary trigger, so the staleness ceiling swung between 3h and 8 days run to
// run. The tightest enabled cadence is the only one that answers "should this job
// have run by now?" consistently.
func applyPrimaryTrigger(st *JobStatus) {
	if len(st.Triggers) == 0 {
		// No live trigger: fall back to the catalog cadence (if the job is
		// operator-invoked there is none, and overdue simply never fires).
		if st.Schedule == "" {
			if cron := fallbackCron(st.Name); cron != "" {
				st.Schedule = cron
				st.ScheduleHuman = humanizeCron(cron)
			}
		}
		return
	}

	sort.SliceStable(st.Triggers, func(i, j int) bool {
		return st.Triggers[i].Name < st.Triggers[j].Name
	})

	var primary *Trigger
	for i := range st.Triggers {
		t := &st.Triggers[i]
		if t.State == "PAUSED" {
			continue
		}
		if primary == nil || expectedMaxGap(t.Schedule) < expectedMaxGap(primary.Schedule) {
			primary = t
		}
	}
	if primary == nil {
		// Every trigger is paused — show the first so the cadence is still legible.
		primary = &st.Triggers[0]
	}
	st.Schedule = primary.Schedule
	st.ScheduleHuman = humanizeCron(primary.Schedule)
	st.SchedulerState = primary.State
	// A job with several triggers gets a count so the single row isn't read as
	// "this job runs once a day" when it actually has five cadences.
	if len(st.Triggers) > 1 {
		st.ScheduleHuman = fmt.Sprintf("%s (+%d more)", st.ScheduleHuman, len(st.Triggers)-1)
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
	if st.Schedule != "" {
		st.ExpectedMaxGapSeconds = expectedMaxGap(st.Schedule).Seconds()
	}
	overdueBy := overdueBy(st)
	st.OverdueBySeconds = overdueBy.Seconds()

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
		if overdueBy > 0 {
			// The job's last run WORKED; it simply hasn't run since it should
			// have. Its own status will never report that — only the clock does.
			st.Health = HealthOverdue
			if st.Message == "" {
				st.Message = fmt.Sprintf(
					"No successful run for %s — %s past its %s cadence",
					humanizeDuration(time.Since(parseTime(lastGood(st)))),
					humanizeDuration(overdueBy),
					strings.ToLower(firstNonEmpty(humanizeCron(st.Schedule), "expected")),
				)
			}
		}
	case "never", "unknown", "":
		st.Health = HealthUnknown
	default:
		st.Health = HealthUnknown
	}

	// A paused trigger on an otherwise-ok job is worth surfacing.
	if st.SchedulerState == "PAUSED" && st.Health == HealthOK {
		st.Health = HealthWarning
		if st.Message == "" {
			st.Message = "Scheduler is paused — this job is not running"
		}
	}

	// RETIRED jobs are deployed-but-unscheduled ON PURPOSE (superseded by the
	// consolidated `shorted <job>` binary; terraform pauses their schedulers for
	// rollback). Paused + overdue IS their designed steady state, so they must not
	// hold the fleet amber forever. A genuinely failed last run is demoted to a
	// warning rather than paging: nothing depends on it any more.
	if st.Retired {
		switch st.Health {
		case HealthOverdue, HealthWarning:
			st.Health = HealthOK
			st.Message = ""
		case HealthCritical:
			st.Health = HealthWarning
		}
	}
}

// lastGood is the timestamp overdue-ness is measured from.
func lastGood(st *JobStatus) string {
	return firstNonEmpty(st.LastSuccessAt, st.LastRunAt)
}

// overdueBy reports how far past its cadence ceiling a job's last success is.
// Zero means "not overdue" (including: no cadence known, or never run — we never
// infer overdue-ness from MISSING data, only from data that is provably old).
func overdueBy(st *JobStatus) time.Duration {
	ref := lastGood(st)
	if ref == "" || st.Schedule == "" {
		return 0
	}
	last := parseTime(ref)
	if last.IsZero() {
		return 0
	}
	if gap := time.Since(last) - expectedMaxGap(st.Schedule); gap > 0 {
		return gap
	}
	return 0
}

// humanizeDuration renders a coarse "3d" / "5h" / "12m" label for messages.
func humanizeDuration(d time.Duration) string {
	switch {
	case d >= 48*time.Hour:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	case d >= time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	case d >= time.Minute:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	default:
		return "moments"
	}
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
	// Sub-hourly/hourly cadence: minute or hour contains a step, or the hour
	// field is a bare "*" (runs every hour at a fixed minute).
	if strings.Contains(hour, "/") || strings.Contains(minute, "/") ||
		strings.Contains(hour, ",") || hour == "*" {
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
	case HealthOverdue:
		return 1
	case HealthWarning:
		return 2
	case HealthRunning:
		return 3
	case HealthUnknown:
		return 4
	case HealthOK:
		return 5
	default:
		return 6
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
