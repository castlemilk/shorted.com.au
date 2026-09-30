package cronreporter

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"strings"
	"sync"
	"time"

	"golang.org/x/oauth2/google"
)

// Cloud Run Job executions, reported to the same Telesis monitors as the
// Kubernetes CronJobs.
//
// Jobs not yet cut over to omega still run as Cloud Scheduler -> Cloud Run
// Job. Their Telesis monitors exist (register-monitors.py registers one per
// chart job), but nothing called them until this watcher: it lists each
// job's recent executions through the Cloud Run v2 API and sends the same
// start / complete / fail check-ins the Kubernetes path sends. Telesis then
// tracks every scheduled job the same way, wherever it runs, and a missed or
// failed run alerts either way.
//
// One Cloud Run job can back several monitors (a weekly and a monthly
// schedule with an env override; a daily run and a nightly args override).
// An execution belongs to the monitor whose expected args (and, where given,
// env values) its effective template matches EXACTLY. An execution matching
// no monitor — an operator's re-fetch, a validation run, a workflow's
// freshness check — is ignored: it is not the scheduled work the monitor
// watches, and reporting it would turn its failure into a false incident.
//
// Stateless on purpose: Cloud Run executions cannot be annotated, so the
// watcher keeps an in-memory set of what it sent and relies on Telesis'
// durable Idempotency-Key (stored on the run record) to make a resend after
// a restart a no-op.

// CloudRunMonitor maps one Telesis monitor key to a Cloud Run job.
type CloudRunMonitor struct {
	Key    string   `json:"key"`
	Job    string   `json:"job"`
	Region string   `json:"region"`
	Args   []string `json:"args"`
	// Env: variables whose value must equal (an empty string means "must be
	// absent"): how a schedule's env override tells its runs apart.
	Env map[string]string `json:"env,omitempty"`
}

type cloudRunConfig struct {
	Project  string            `json:"project"`
	Monitors []CloudRunMonitor `json:"monitors"`
}

func loadCloudRunConfig(path string) (*cloudRunConfig, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c cloudRunConfig
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if c.Project == "" {
		return nil, fmt.Errorf("%s: project is required", path)
	}
	for i, m := range c.Monitors {
		if m.Key == "" || m.Job == "" || m.Region == "" {
			return nil, fmt.Errorf("%s: monitor %d needs key, job and region", path, i)
		}
	}
	return &c, nil
}

// execution is the subset of run.googleapis.com/v2 Execution read here.
type execution struct {
	Name           string     `json:"name"`
	CreateTime     time.Time  `json:"createTime"`
	StartTime      *time.Time `json:"startTime"`
	CompletionTime *time.Time `json:"completionTime"`
	RunningCount   int        `json:"runningCount"`
	SucceededCount int        `json:"succeededCount"`
	FailedCount    int        `json:"failedCount"`
	CancelledCount int        `json:"cancelledCount"`
	RetriedCount   int        `json:"retriedCount"`
	TaskCount      int        `json:"taskCount"`
	LogURI         string     `json:"logUri"`
	Conditions     []struct {
		Type    string `json:"type"`
		State   string `json:"state"`
		Message string `json:"message"`
		Reason  string `json:"reason"`
	} `json:"conditions"`
	Template struct {
		Containers []struct {
			Args []string `json:"args"`
			Env  []struct {
				Name  string `json:"name"`
				Value string `json:"value"`
			} `json:"env"`
		} `json:"containers"`
	} `json:"template"`
}

func (e execution) shortName() string {
	return e.Name[strings.LastIndex(e.Name, "/")+1:]
}

func (e execution) args() []string {
	if len(e.Template.Containers) == 0 {
		return nil
	}
	return e.Template.Containers[0].Args
}

func (e execution) env(name string) (string, bool) {
	if len(e.Template.Containers) == 0 {
		return "", false
	}
	for _, v := range e.Template.Containers[0].Env {
		if v.Name == name {
			return v.Value, true
		}
	}
	return "", false
}

// matches reports whether e is a run of monitor m.
func (m CloudRunMonitor) matches(e execution) bool {
	got, want := e.args(), m.Args
	if len(got) == 0 && len(want) == 0 {
		// no args either side
	} else if !reflect.DeepEqual(got, want) {
		return false
	}
	for k, v := range m.Env {
		have, ok := e.env(k)
		if v == "" {
			if ok && have != "" {
				return false
			}
			continue
		}
		if !ok || have != v {
			return false
		}
	}
	return true
}

// terminal: "" while running, else complete | fail.
func (e execution) terminal() string {
	if e.CompletionTime == nil {
		return ""
	}
	for _, c := range e.Conditions {
		if c.Type == "Completed" {
			if c.State == "CONDITION_SUCCEEDED" {
				return endComplete
			}
			return endFail
		}
	}
	if e.FailedCount > 0 || e.CancelledCount > 0 || (e.TaskCount > 0 && e.SucceededCount < e.TaskCount) {
		return endFail
	}
	return endComplete
}

func (e execution) failureReason() string {
	parts := []string{}
	for _, c := range e.Conditions {
		if c.Type == "Completed" && c.Message != "" {
			parts = append(parts, c.Message)
		}
	}
	parts = append(parts, fmt.Sprintf("tasks succeeded=%d failed=%d cancelled=%d retried=%d",
		e.SucceededCount, e.FailedCount, e.CancelledCount, e.RetriedCount))
	return "Cloud Run execution " + e.shortName() + ": " + strings.Join(parts, "; ")
}

// executionLister lists a job's recent executions (newest first).
type executionLister interface {
	ListExecutions(ctx context.Context, project, region, job string) ([]execution, error)
}

type cloudRunAPI struct {
	client *http.Client
	base   string
}

func newCloudRunAPI(ctx context.Context) (*cloudRunAPI, error) {
	// GOOGLE_APPLICATION_CREDENTIALS: the chart-rendered external-account
	// (Workload Identity Federation) config; no key file exists.
	c, err := google.DefaultClient(ctx, "https://www.googleapis.com/auth/cloud-platform")
	if err != nil {
		return nil, fmt.Errorf("google credentials: %w", err)
	}
	c.Timeout = 30 * time.Second
	return &cloudRunAPI{client: c, base: "https://run.googleapis.com/v2"}, nil
}

func (a *cloudRunAPI) ListExecutions(ctx context.Context, project, region, job string) ([]execution, error) {
	u := fmt.Sprintf("%s/projects/%s/locations/%s/jobs/%s/executions?pageSize=10",
		a.base, url.PathEscape(project), url.PathEscape(region), url.PathEscape(job))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := a.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("list executions %s/%s: %s: %s", region, job, resp.Status, truncate(string(body), 300))
	}
	var out struct {
		Executions []execution `json:"executions"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("decode executions %s/%s: %w", region, job, err)
	}
	return out.Executions, nil
}

type cloudRunWatcher struct {
	cfg     *cloudRunConfig
	api     executionLister
	send    sender
	urls    urlSource
	now     func() time.Time
	maxAge  time.Duration
	dryRun  bool
	mu      sync.Mutex
	sent    map[string]bool // idempotency keys delivered by this process
	lastErr string
	stats   map[string]int
}

func newCloudRunWatcher(cfg *cloudRunConfig, api executionLister, s sender, u urlSource, maxAge time.Duration, dryRun bool) *cloudRunWatcher {
	return &cloudRunWatcher{cfg: cfg, api: api, send: s, urls: u, now: time.Now, maxAge: maxAge, dryRun: dryRun,
		sent: map[string]bool{}, stats: map[string]int{}}
}

// reconcile lists every configured job once (a job backing several monitors
// is listed once) and reports each recent execution to the monitor it
// matches. Returns the first listing error; other jobs are still processed.
func (w *cloudRunWatcher) reconcile(ctx context.Context) error {
	type jobKey struct{ region, job string }
	byJob := map[jobKey][]CloudRunMonitor{}
	var order []jobKey
	for _, m := range w.cfg.Monitors {
		k := jobKey{m.Region, m.Job}
		if _, seen := byJob[k]; !seen {
			order = append(order, k)
		}
		byJob[k] = append(byJob[k], m)
	}
	var firstErr error
	for _, k := range order {
		execs, err := w.api.ListExecutions(ctx, w.cfg.Project, k.region, k.job)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		for _, e := range execs {
			if w.now().Sub(e.CreateTime) > w.maxAge {
				continue
			}
			for _, m := range byJob[k] {
				if m.matches(e) {
					w.report(ctx, m, e)
					break
				}
			}
		}
	}
	w.mu.Lock()
	w.lastErr = ""
	if firstErr != nil {
		w.lastErr = firstErr.Error()
	}
	w.mu.Unlock()
	return firstErr
}

func (w *cloudRunWatcher) report(ctx context.Context, m CloudRunMonitor, e execution) {
	u, ok := w.urls(m.Key)
	if !ok {
		return
	}
	run := e.shortName()
	outcome := e.terminal()
	if outcome == "" {
		if e.StartTime == nil && e.RunningCount == 0 {
			return // queued, not started
		}
		w.deliver(ctx, m.Key, u, checkin{State: stateStart, RunID: run, IdempotencyKey: "cloudrun:" + run + ":" + stateStart})
		return
	}
	c := checkin{RunID: run, IdempotencyKey: "cloudrun:" + run + ":" + outcome}
	if e.StartTime != nil && e.CompletionTime != nil && e.CompletionTime.After(*e.StartTime) {
		c.DurationMs = e.CompletionTime.Sub(*e.StartTime).Milliseconds()
	}
	if outcome == endComplete {
		zero := 0
		c.State, c.ExitCode = stateComplete, &zero
	} else {
		c.State = stateFail
		c.TerminalReason = e.failureReason()
		if e.LogURI != "" {
			c.Diagnostic = "Logs: " + e.LogURI
		}
	}
	w.deliver(ctx, m.Key, u, c)
}

func (w *cloudRunWatcher) deliver(ctx context.Context, key, u string, c checkin) {
	w.mu.Lock()
	done := w.sent[c.IdempotencyKey]
	w.mu.Unlock()
	if done {
		return
	}
	if w.dryRun {
		log.Printf("cronjob-reporter: [dry-run] cloud run %s (%s) -> %s", c.RunID, key, c.State)
	} else if err := w.send.Send(ctx, u, c); err != nil {
		if p, ok := isPermanent(err); ok {
			log.Printf("ERROR cronjob-reporter: Telesis rejected cloud run %s (%s) %s check-in (HTTP %d): %s", c.RunID, key, c.State, p.Status, p.Body)
		} else {
			log.Printf("ERROR cronjob-reporter: cloud run %s (%s): %v", c.RunID, key, err)
			return // transient: retried next tick
		}
	} else {
		log.Printf("cronjob-reporter: cloud run %s (%s) -> %s", c.RunID, key, c.State)
	}
	w.mu.Lock()
	w.sent[c.IdempotencyKey] = true
	w.stats[c.State]++
	w.mu.Unlock()
	// Bounded memory: keys older than the report window can never recur.
	w.gc()
}

func (w *cloudRunWatcher) gc() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.sent) > 5000 {
		w.sent = map[string]bool{}
	}
}

func (w *cloudRunWatcher) status() map[string]any {
	w.mu.Lock()
	defer w.mu.Unlock()
	st := make(map[string]int, len(w.stats))
	for k, v := range w.stats {
		st[k] = v
	}
	return map[string]any{"monitors": len(w.cfg.Monitors), "last_error": w.lastErr, "checkins_since_boot": st}
}
