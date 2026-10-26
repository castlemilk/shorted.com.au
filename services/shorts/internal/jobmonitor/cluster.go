package jobmonitor

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Jobs moved to the omega Kubernetes cluster keep their Cloud Run job (Run now,
// validation runs and rollback still use it) but have their Cloud Scheduler
// trigger PAUSED (terraform local.jobs_on_vke). Everything this package reads
// from GCP therefore describes such a job as it stood the day it moved: a
// paused trigger and a last run weeks old, i.e. paused and overdue, while the
// job runs fine on the cluster. On 2026-10-17 the news, index-sync and economy
// rows read 15-37 days overdue with current data behind them.
//
// The cluster runs are not invisible: cronjob-reporter reports every CronJob
// run to a Telesis cron monitor named after the CronJob. So a PAUSED trigger
// whose name is a monitor's name (shorted-news-cluster), or a monitor's name
// plus "-schedule" (trigger shorted-news-schedule, CronJob shorted-news), is a
// trigger that MOVED rather than one that stopped, and its runs come from
// Telesis. A paused trigger with no monitor still reads as paused.

const (
	clusterTriggerState = "CLUSTER"
	clusterRunner       = "kubernetes"

	// clusterRunsPerMonitor bounds the history read per monitor: enough to
	// find the last success of a job that has failed for a while, and one
	// request per monitor per collection.
	clusterRunsPerMonitor = 20
	// clusterReadConcurrency bounds parallel run reads, well inside Telesis'
	// 300 requests a minute per token.
	clusterReadConcurrency = 4
)

// CronMonitor is a Telesis cron monitor. Statuses are lower case without the
// enum prefix; times are RFC3339 or "".
type CronMonitor struct {
	ID     string
	Name   string
	Status string // waiting | healthy | running | late | failing | paused
	Paused bool
	// Schedule is the monitor's cron expression (UTC). "" for an interval monitor.
	Schedule string
	// Armed is Telesis' own flag: true only after the monitor's first check-in. A
	// monitor that is not paused but has never reported is not armed, so a missed
	// run cannot alert yet.
	Armed          bool
	LastRunAt      string
	NextExpectedAt string
}

// CronRun is one run of a monitored job, as cronjob-reporter reported it.
type CronRun struct {
	RunID          string // the Kubernetes Job name
	Status         string // running | succeeded | failed | missed | timed_out
	ExpectedAt     string
	StartedAt      string
	EndedAt        string
	DurationMs     int64
	ExitCode       *int
	TerminalReason string
}

// CronSource reads Telesis cron monitors (telesis.go in production).
type CronSource interface {
	ListCronMonitors(ctx context.Context) ([]CronMonitor, error)
	// ListCronRuns returns a monitor's newest runs, newest first.
	ListCronRuns(ctx context.Context, monitorID string, limit int) ([]CronRun, error)
}

// applyClusterRuns turns each paused trigger that has a Telesis monitor into a
// CLUSTER trigger carrying that monitor's runs, then folds those runs into its
// row. A monitor list that cannot be read leaves every row as it was; a run
// history that cannot be read leaves that trigger on its monitor's summary.
func applyClusterRuns(ctx context.Context, byName map[string]*JobStatus, src CronSource) error {
	monitors, err := src.ListCronMonitors(ctx)
	if err != nil {
		return fmt.Errorf("telesis cron monitors unavailable: %w", err)
	}
	byMonitorName := make(map[string]CronMonitor, len(monitors))
	for _, m := range monitors {
		byMonitorName[m.Name] = m
	}

	type match struct {
		st      *JobStatus
		trigger int
		monitor CronMonitor
	}
	var matches []match
	for _, st := range byName {
		// Only Cloud Run jobs move to the cluster; a scheduler-triggered
		// service has no CronJob.
		if st.Type != "job" {
			continue
		}
		for i := range st.Triggers {
			t := &st.Triggers[i]
			// A cluster-only job has no scheduler trigger to be paused, so its own
			// trigger is the one to read, whether or not its monitor is paused.
			if t.State != "PAUSED" && !t.clusterOnly {
				continue
			}
			if m, ok := monitorForTrigger(byMonitorName, t.Name); ok && (t.clusterOnly || !m.Paused) {
				matches = append(matches, match{st: st, trigger: i, monitor: m})
			}
		}
	}
	if len(matches) == 0 {
		return nil
	}

	runs := map[string][]CronRun{}
	var (
		mu   sync.Mutex
		errs []error
		wg   sync.WaitGroup
	)
	sem := make(chan struct{}, clusterReadConcurrency)
	requested := map[string]bool{}
	for _, m := range matches {
		if requested[m.monitor.ID] {
			continue
		}
		requested[m.monitor.ID] = true
		wg.Add(1)
		go func(mon CronMonitor) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			got, err := src.ListCronRuns(ctx, mon.ID, clusterRunsPerMonitor)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				errs = append(errs, fmt.Errorf("telesis runs unavailable for %s: %w", mon.Name, err))
				return
			}
			runs[mon.ID] = got
		}(m.monitor)
	}
	wg.Wait()

	touched := map[*JobStatus]bool{}
	for _, m := range matches {
		applyClusterTrigger(&m.st.Triggers[m.trigger], m.monitor, runs[m.monitor.ID])
		touched[m.st] = true
	}
	for st := range touched {
		applyClusterRow(st)
		// Re-pick the primary trigger: a CLUSTER trigger is live, so the
		// row's cadence and scheduler state are its, not a paused one's.
		applyPrimaryTrigger(st)
	}
	return errors.Join(errs...)
}

// clusterNote is the operator context on every cluster-run row.
const clusterNote = "Runs on the omega Kubernetes cluster; run status from Telesis cron monitors."

// clusterOnlyJobs are CronJobs with no Cloud Run twin and no Cloud Scheduler
// trigger, so no Cloud Run or Scheduler read ever makes a row for them. They are
// the chart's vkeNative list (deploy/kubernetes/jobs/chart/values.yaml), and
// TestClusterOnlyJobsMatchChart keeps the two in step.
var clusterOnlyJobs = []string{"shorted-alerts"}

// addClusterOnlyJobs gives each cluster-only job a row, unless a Cloud Run job or
// a scheduler already produced one. The row's single trigger is a CLUSTER trigger
// named after the job, which is the name its Telesis monitor carries, so
// applyClusterRuns can read the runs. With no monitor the row reads as never run:
// it is not paused, and it is not treated as overdue.
func addClusterOnlyJobs(byName map[string]*JobStatus, order *[]string) {
	for _, name := range clusterOnlyJobs {
		if _, ok := byName[name]; ok {
			continue
		}
		st := &JobStatus{
			Name:          name,
			Type:          "job",
			LastRunStatus: "never",
			Health:        HealthUnknown,
			Triggers: []Trigger{{
				Name:        name,
				State:       clusterTriggerState,
				Runner:      clusterRunner,
				LastStatus:  "never",
				clusterOnly: true,
			}},
		}
		decorate(st)
		st.Note = joinNote(st.Note, clusterNote)
		byName[name] = st
		*order = append(*order, name)
	}
}

// monitorForTrigger finds the monitor for a Cloud Scheduler trigger: the
// CronJob is named either exactly as the trigger or as the trigger less
// "-schedule".
func monitorForTrigger(monitors map[string]CronMonitor, trigger string) (CronMonitor, bool) {
	if m, ok := monitors[trigger]; ok {
		return m, true
	}
	if base, cut := strings.CutSuffix(trigger, "-schedule"); cut {
		m, ok := monitors[base]
		return m, ok
	}
	return CronMonitor{}, false
}

func applyClusterTrigger(t *Trigger, m CronMonitor, runs []CronRun) {
	if len(runs) == 0 {
		runs = monitorRun(m)
	}
	t.State = clusterTriggerState
	t.Runner = clusterRunner
	if t.Schedule == "" && m.Schedule != "" {
		t.Schedule = m.Schedule
		t.ScheduleHuman = humanizeCron(m.Schedule)
	}
	t.MonitorStatus = m.Status
	t.NextExpectedAt = m.NextExpectedAt
	t.clusterRuns = runs
	t.LastAttemptAt = m.LastRunAt
	t.LastStatus = monitorLastStatus(m)
	t.LastMessage = ""
	if len(runs) > 0 {
		newest := runs[0]
		t.LastAttemptAt = firstNonEmpty(newest.StartedAt, newest.ExpectedAt)
		t.LastStatus = clusterRunStatus(newest.Status)
		t.LastMessage = newest.TerminalReason
	}
	t.LastSuccessAt = ""
	for _, r := range runs {
		if r.Status == "succeeded" {
			t.LastSuccessAt = firstNonEmpty(r.EndedAt, r.StartedAt)
			break
		}
	}
}

// monitorRun stands in for a run history that came back empty. ListCronRuns
// returns only runs inside the Telesis plan's retention window, which can be
// shorter than a monthly job's cadence: shorted-economy's last run is then
// outside it, and with no run at all the row would fall back to its Cloud Run
// history and read overdue again. The monitor still knows when it last ran
// and how that went.
func monitorRun(m CronMonitor) []CronRun {
	status := monitorLastStatus(m)
	if m.LastRunAt == "" || (status != "succeeded" && status != "failed" && status != "running") {
		return nil
	}
	run := CronRun{Status: status, StartedAt: m.LastRunAt}
	if status != "running" {
		run.EndedAt = m.LastRunAt
	}
	return []CronRun{run}
}

// monitorLastStatus reads a trigger's outcome off its monitor alone, for when
// the run history could not be read.
func monitorLastStatus(m CronMonitor) string {
	switch m.Status {
	case "healthy":
		return "succeeded"
	case "failing":
		return "failed"
	case "running":
		return "running"
	case "waiting":
		return "never"
	default:
		return "unknown"
	}
}

func clusterRunStatus(s string) string {
	switch s {
	case "running", "succeeded", "failed", "missed":
		return s
	case "timed_out":
		return "failed"
	default:
		return "unknown"
	}
}

// applyClusterRow makes a cluster run the row's last run when it is newer
// than the newest Cloud Run execution (which is still possible: Run now
// starts the Cloud Run job), and takes the newest success from either.
func applyClusterRow(st *JobStatus) {
	var newest *CronRun
	newestTrigger := ""
	for i := range st.Triggers {
		t := &st.Triggers[i]
		if t.Runner != clusterRunner {
			continue
		}
		// A missed run is an absence, not a run: the row's last run stays the
		// last one that happened, and the cadence check reports the gap.
		for j := range t.clusterRuns {
			r := &t.clusterRuns[j]
			if r.Status == "missed" {
				continue
			}
			if newest == nil || parseTime(runStart(r)).After(parseTime(runStart(newest))) {
				newest, newestTrigger = r, t.Name
			}
			break
		}
		if after(t.LastSuccessAt, st.LastSuccessAt) {
			st.LastSuccessAt = t.LastSuccessAt
		}
	}
	if newest != nil && after(runStart(newest), st.LastRunAt) {
		st.LastRunAt = runStart(newest)
		st.LastRunStatus = clusterRunStatus(newest.Status)
		st.ExecutionName = newest.RunID
		st.DurationSeconds = float64(newest.DurationMs) / 1000
		// Cloud Run task counts and its log link describe a different run.
		st.SucceededCount, st.FailedCount, st.RunningCount = 0, 0, 0
		st.LogUri = ""
		st.Message = ""
		if st.LastRunStatus == "failed" {
			st.Message = clusterFailure(newestTrigger, newest.TerminalReason)
		}
	}
	st.Note = joinNote(st.Note, clusterNote)
}

// escalateClusterTriggers judges each CLUSTER trigger on its own runs, after
// finalizeHealth has judged the row on its newest. One job can have several
// cadences — shorted-news runs every 2h and also a Friday digest — so a failed
// digest would otherwise sit unseen behind a dozen good 2-hourly runs. Each
// trigger is a Telesis monitor of its own, and is held to its own schedule.
func escalateClusterTriggers(st *JobStatus, now time.Time) {
	for i := range st.Triggers {
		t := &st.Triggers[i]
		if t.Runner != clusterRunner {
			continue
		}
		health, msg := clusterTriggerHealth(t, now)
		if healthRank(health) < healthRank(st.Health) {
			st.Health = health
			st.Message = msg
		}
	}
}

func clusterTriggerHealth(t *Trigger, now time.Time) (Health, string) {
	switch t.LastStatus {
	case "failed":
		return HealthCritical, clusterFailure(t.Name, t.LastMessage)
	case "missed":
		return HealthOverdue, fmt.Sprintf("%s: missed its scheduled run", t.Name)
	case "running", "never", "unknown":
		return HealthOK, ""
	}
	if t.LastSuccessAt == "" || t.Schedule == "" {
		return HealthOK, ""
	}
	since := now.Sub(parseTime(t.LastSuccessAt))
	if gap := expectedMaxGap(t.Schedule); since > gap {
		return HealthOverdue, fmt.Sprintf("%s: no successful run for %s — %s past its %s cadence",
			t.Name, humanizeDuration(since), humanizeDuration(since-gap),
			strings.ToLower(firstNonEmpty(humanizeCron(t.Schedule), "expected")))
	}
	return HealthOK, ""
}

func clusterFailure(trigger, reason string) string {
	if reason == "" {
		return trigger + ": last run failed"
	}
	return trigger + ": last run failed: " + reason
}

func runStart(r *CronRun) string {
	return firstNonEmpty(r.StartedAt, r.ExpectedAt)
}

// after reports whether RFC3339 a is later than b; "" is earlier than anything.
func after(a, b string) bool {
	if a == "" {
		return false
	}
	if b == "" {
		return true
	}
	return parseTime(a).After(parseTime(b))
}

func joinNote(existing, add string) string {
	if existing == "" {
		return add
	}
	if strings.Contains(existing, add) {
		return existing
	}
	return existing + " " + add
}
