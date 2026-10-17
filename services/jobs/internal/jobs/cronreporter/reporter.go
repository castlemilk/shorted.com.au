// Package cronreporter is `shorted cronjob-reporter`: the in-cluster bridge
// between Kubernetes CronJob runs and Telesis cron monitors.
//
// It replaces the Cloud Monitoring alerts the jobs had on Cloud Run
// (terraform/modules/job-monitoring). Once the jobs run as CronJobs on the
// omega VKE cluster there is no Cloud Run execution metric and no Cloud Run
// log stream for those policies to watch, so every run reports its own
// lifecycle instead:
//
//	Job started            -> POST <check-in URL>/start
//	Job Complete           -> POST <check-in URL>/complete  (duration, exit 0)
//	Job Failed             -> POST <check-in URL>/fail      (exit code, reason,
//	                          OOMKilled/DeadlineExceeded, redacted log tail)
//
// Telesis owns everything that requires a clock rather than an event: a run
// that never starts (CronJob suspended by mistake, controller down, whole
// cluster down, THIS reporter down) is a MISSED occurrence once the expected
// cadence plus grace passes, and a run that starts but never ends is TIMED OUT
// after the monitor's max runtime. That split is deliberate — an in-cluster
// watcher cannot report its own cluster's death, and a missed check-in is the
// only signal that survives it.
//
// Why a watcher and not a wrapper around each command: a wrapper runs inside
// the container it is watching, so it dies with it. It cannot report an
// OOMKill, an activeDeadlineSeconds kill, an image pull failure or a pod that
// never schedules — exactly the failures worth paging on. It would also need a
// shell or a helper binary in every image, and two of the four job images are
// distroless.
//
// State lives on the Job itself (annotations), so a restarted reporter neither
// re-sends nor forgets, and the Telesis Idempotency-Key covers the window
// between a send and its annotation.
package cronreporter

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

// Labels the chart stamps on every CronJob's jobTemplate, and the annotations
// the reporter writes back onto each Job.
const (
	// LabelCronJob names the CronJob (== the monitor key in the check-in
	// secret). A label rather than an ownerReference so a manual
	// `kubectl create job --from=cronjob/<x>` run reports too.
	LabelCronJob = "shorted.com.au/cronjob"
	// LabelMonitored opts a Job into reporting.
	LabelMonitored = "shorted.com.au/cron-monitor"

	annStart = "shorted.com.au/checkin-start"
	annEnd   = "shorted.com.au/checkin-end"

	// jobNamePodLabel is set by the Job controller on every pod it creates.
	jobNamePodLabel = "batch.kubernetes.io/job-name"
	// jobContainer is the container name the chart gives every job pod.
	jobContainer = "job"
	// heartbeatKey is the check-in secret key for the reporter's own liveness
	// monitor. The leading underscore keeps it out of the CronJob namespace
	// (Kubernetes object names cannot start with one).
	heartbeatKey = "_reporter"
)

// Terminal outcomes recorded in annEnd.
const (
	endComplete    = "complete"
	endFail        = "fail"
	endStale       = "stale"
	endUnmonitored = "unmonitored"
)

// Job returns the `shorted cronjob-reporter` subcommand.
func Job() runner.Job {
	return runner.Func{
		JobName: "cronjob-reporter",
		Desc:    "report Kubernetes CronJob run lifecycle (start/complete/fail) to Telesis cron monitors — long-running",
		DryRun:  true,
		Fn:      Run,
	}
}

type config struct {
	namespace         string
	interval          time.Duration
	checkinDir        string
	healthAddr        string
	maxReportAge      time.Duration
	logTailLines      int
	heartbeatInterval time.Duration
	dryRun            bool
	allowHTTP         bool
	cloudRunConfig    string
}

// Run parses flags and runs the reconcile loop until ctx is cancelled.
func Run(ctx context.Context, args []string) error {
	g := runner.FromContext(ctx)
	fs := flag.NewFlagSet("cronjob-reporter", flag.ContinueOnError)
	var cfg config
	fs.StringVar(&cfg.namespace, "namespace", os.Getenv("POD_NAMESPACE"), "Namespace to watch (default: the pod's own)")
	fs.DurationVar(&cfg.interval, "interval", 30*time.Second, "Poll interval")
	fs.StringVar(&cfg.checkinDir, "checkin-dir", "/etc/shorted/cron-monitors", "Directory of check-in URLs, one file per CronJob name (a mounted Secret)")
	fs.StringVar(&cfg.healthAddr, "health-addr", ":8080", "Listen address for /healthz")
	fs.DurationVar(&cfg.maxReportAge, "max-report-age", 3*time.Hour, "Terminal runs older than this are marked stale instead of reported (protects Telesis from a backlog replay after a long reporter outage)")
	fs.IntVar(&cfg.logTailLines, "log-tail-lines", 60, "Log lines attached to a failure check-in")
	fs.DurationVar(&cfg.heartbeatInterval, "heartbeat-interval", 5*time.Minute, "How often to ping the reporter's own monitor (secret key "+heartbeatKey+"), if present")
	fs.BoolVar(&cfg.dryRun, "dry-run", g.DryRun, "Log check-ins instead of sending them; never annotate Jobs")
	fs.StringVar(&cfg.cloudRunConfig, "cloudrun-config", "", "JSON file mapping Telesis monitor keys to Cloud Run jobs whose executions are reported too (empty = Kubernetes only)")
	fs.BoolVar(&cfg.allowHTTP, "allow-http-checkins", false, "Accept http:// check-in URLs (local end-to-end tests against a fake Telesis only; the URL is a credential)")
	if err := fs.Parse(args); err != nil {
		return runner.ErrUsage
	}
	if cfg.interval < 5*time.Second {
		return fmt.Errorf("-interval %s is below the 5s floor", cfg.interval)
	}

	kube, err := newInClusterClient(cfg.namespace)
	if err != nil {
		return err
	}
	r := newReporter(kube, newHTTPSender(), dirURLs(cfg.checkinDir, cfg.allowHTTP), cfg)
	if cfg.cloudRunConfig != "" {
		crc, err := loadCloudRunConfig(cfg.cloudRunConfig)
		if err != nil {
			return err
		}
		api, err := newCloudRunAPI(ctx)
		if err != nil {
			return err
		}
		r.cloudRun = newCloudRunWatcher(crc, api, r.send, r.urls, cfg.maxReportAge, cfg.dryRun)
		log.Printf("cronjob-reporter: watching %d Cloud Run monitors in %s", len(crc.Monitors), crc.Project)
	}
	log.Printf("cronjob-reporter: namespace=%s interval=%s checkin-dir=%s dry-run=%v", kube.namespace, cfg.interval, cfg.checkinDir, cfg.dryRun)

	srv := &http.Server{Addr: cfg.healthAddr, Handler: r.healthHandler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("cronjob-reporter: health server: %v", err)
		}
	}()
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	ticker := time.NewTicker(cfg.interval)
	defer ticker.Stop()
	for {
		r.tick(ctx)
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

// urlSource resolves a monitor key to its private check-in URL.
type urlSource func(key string) (string, bool)

// dirURLs reads a mounted Secret on every lookup, so a rotated or newly added
// URL is picked up (kubelet refreshes Secret volumes) without a restart.
func dirURLs(dir string, allowHTTP bool) urlSource {
	return func(key string) (string, bool) {
		if key == "" || strings.ContainsAny(key, `/\`) {
			return "", false
		}
		raw, err := os.ReadFile(filepath.Join(dir, key))
		if err != nil {
			return "", false
		}
		u := strings.TrimSpace(string(raw))
		return u, strings.HasPrefix(u, "https://") || (allowHTTP && strings.HasPrefix(u, "http://"))
	}
}

type reporter struct {
	kube cluster
	send sender
	urls urlSource
	cfg  config
	now  func() time.Time

	lastOK        atomic.Int64 // unix nanos of the last successful reconcile
	lastHeartbeat time.Time
	cloudRun      *cloudRunWatcher // nil: Kubernetes only

	mu        sync.Mutex
	warnedFor map[string]bool // CronJobs already warned about a missing URL
	stats     map[string]int
}

func newReporter(k cluster, s sender, u urlSource, cfg config) *reporter {
	return &reporter{
		kube: k, send: s, urls: u, cfg: cfg, now: time.Now,
		warnedFor: map[string]bool{},
		stats:     map[string]int{},
	}
}

func (r *reporter) tick(ctx context.Context) {
	if err := r.reconcile(ctx); err != nil {
		log.Printf("ERROR cronjob-reporter: reconcile: %v", err)
		return
	}
	r.lastOK.Store(r.now().UnixNano())
	if r.cloudRun != nil {
		// A Cloud Run listing failure is logged loudly but does not stop the
		// heartbeat: the Kubernetes half still works, and every Cloud Run
		// monitor it leaves unreported will go MISSED in Telesis on its own.
		if err := r.cloudRun.reconcile(ctx); err != nil {
			log.Printf("ERROR cronjob-reporter: cloud run: %v", err)
		}
	}
	r.heartbeat(ctx)
}

// heartbeat pings the reporter's own monitor after a successful reconcile, so a
// reporter that is up but cannot list Jobs (RBAC, apiserver) goes quiet too.
func (r *reporter) heartbeat(ctx context.Context) {
	u, ok := r.urls(heartbeatKey)
	if !ok || r.cfg.dryRun {
		return
	}
	if !r.lastHeartbeat.IsZero() && r.now().Sub(r.lastHeartbeat) < r.cfg.heartbeatInterval {
		return
	}
	if err := r.send.Send(ctx, u, checkin{State: stateComplete}); err != nil {
		log.Printf("ERROR cronjob-reporter: heartbeat: %v", err)
		return
	}
	r.lastHeartbeat = r.now()
}

func (r *reporter) reconcile(ctx context.Context) error {
	jobs, err := r.kube.ListJobs(ctx, LabelMonitored+"=true")
	if err != nil {
		return err
	}
	// Oldest first, so a backlog reports in the order it happened.
	sort.Slice(jobs, func(i, j int) bool {
		return jobs[i].Metadata.CreationTimestamp.Before(jobs[j].Metadata.CreationTimestamp)
	})
	for i := range jobs {
		if err := r.reconcileJob(ctx, &jobs[i]); err != nil {
			// One Job's transient failure must not starve the rest; it is
			// retried on the next tick because its annotation was not written.
			log.Printf("ERROR cronjob-reporter: job %s: %v", jobs[i].Metadata.Name, err)
		}
	}
	return nil
}

func (r *reporter) reconcileJob(ctx context.Context, j *kjob) error {
	name := j.Metadata.Name
	cron := j.Metadata.Labels[LabelCronJob]
	if cron == "" || j.Metadata.Annotations[annEnd] != "" {
		return nil
	}
	outcome, cond := classify(j)

	checkinURL, ok := r.urls(cron)
	if !ok {
		r.warnOnce(cron)
		if outcome != "" {
			// Only terminal runs are marked, so a URL added mid-run still
			// receives that run's outcome.
			return r.annotate(ctx, name, map[string]string{annEnd: endUnmonitored})
		}
		return nil
	}

	switch outcome {
	case "":
		if j.Status.StartTime == nil || j.Metadata.Annotations[annStart] != "" {
			return nil
		}
		if err := r.deliver(ctx, name, checkinURL, checkin{
			State:          stateStart,
			RunID:          name,
			IdempotencyKey: j.Metadata.UID + ":" + stateStart,
		}); err != nil {
			return ignoreRecorded(err)
		}
		return r.annotate(ctx, name, map[string]string{annStart: r.now().UTC().Format(time.RFC3339)})

	case endComplete, endFail:
		ended := cond.LastTransitionTime
		if j.Status.CompletionTime != nil && outcome == endComplete {
			ended = *j.Status.CompletionTime
		}
		if !ended.IsZero() && r.now().Sub(ended) > r.cfg.maxReportAge {
			log.Printf("cronjob-reporter: job %s ended %s ago (> -max-report-age %s); marking stale, not reporting", name, r.now().Sub(ended).Round(time.Second), r.cfg.maxReportAge)
			return r.annotate(ctx, name, map[string]string{annEnd: endStale})
		}
		c := checkin{RunID: name, IdempotencyKey: j.Metadata.UID + ":" + outcome, DurationMs: durationMs(j, ended)}
		if outcome == endComplete {
			zero := 0
			c.State, c.ExitCode = stateComplete, &zero
		} else {
			c.State = stateFail
			r.describeFailure(ctx, j, cond, &c)
		}
		if err := r.deliver(ctx, name, checkinURL, c); err != nil {
			return ignoreRecorded(err)
		}
		return r.annotate(ctx, name, map[string]string{annEnd: outcome})
	}
	return nil
}

// errRecorded is returned by deliver when a permanent rejection has already been
// written to the Job; the caller must not overwrite that annotation.
var errRecorded = errors.New("check-in rejection recorded on the job")

// deliver sends one check-in. A permanent rejection is recorded on the Job (so
// it is not retried forever), logged as an ERROR, and reported as errRecorded;
// anything else is returned for a retry on the next tick.
func (r *reporter) deliver(ctx context.Context, jobName, checkinURL string, c checkin) error {
	if r.cfg.dryRun {
		log.Printf("cronjob-reporter: [dry-run] job %s -> %s exit=%v reason=%q", jobName, c.State, derefInt(c.ExitCode), c.TerminalReason)
		return nil
	}
	err := r.send.Send(ctx, checkinURL, c)
	if err == nil {
		r.count(c.State)
		log.Printf("cronjob-reporter: job %s -> %s", jobName, c.State)
		return nil
	}
	if p, ok := isPermanent(err); ok {
		r.count("rejected")
		log.Printf("ERROR cronjob-reporter: job %s: Telesis rejected %s check-in (HTTP %d) — check the monitor's check-in URL: %s", jobName, c.State, p.Status, p.Body)
		key := annEnd
		if c.State == stateStart {
			key = annStart
		}
		if err := r.annotate(ctx, jobName, map[string]string{key: fmt.Sprintf("rejected-%d", p.Status)}); err != nil {
			return err
		}
		return errRecorded
	}
	return err
}

func ignoreRecorded(err error) error {
	if errors.Is(err, errRecorded) {
		return nil
	}
	return err
}

func (r *reporter) annotate(ctx context.Context, name string, ann map[string]string) error {
	if r.cfg.dryRun {
		return nil
	}
	return r.kube.AnnotateJob(ctx, name, ann)
}

// classify returns "" while a Job is running (or pending), endComplete or
// endFail once it has a terminal condition, plus that condition.
//
// Kubernetes ≥1.31 sets FailureTarget / SuccessCriteriaMet BEFORE the terminal
// Failed / Complete while pods are still terminating; waiting for the terminal
// condition means the reported outcome is the one the Job actually ended in.
func classify(j *kjob) (string, kjobCondition) {
	for _, c := range j.Status.Conditions {
		if c.Status != "True" {
			continue
		}
		switch c.Type {
		case "Complete":
			return endComplete, c
		case "Failed":
			return endFail, c
		}
	}
	return "", kjobCondition{}
}

// describeFailure fills exit code, reason and a redacted log tail from the
// Job's most recent pod. Best effort: the Job condition alone is still a
// complete, alertable failure, so a pod or log lookup error only thins the
// diagnostic.
func (r *reporter) describeFailure(ctx context.Context, j *kjob, cond kjobCondition, c *checkin) {
	reason := strings.TrimSpace(cond.Reason + ": " + cond.Message)
	pods, err := r.kube.ListJobPods(ctx, j.Metadata.Name)
	if err != nil || len(pods) == 0 {
		c.TerminalReason = reason
		if err != nil {
			c.Diagnostic = "pod lookup failed: " + err.Error()
		}
		return
	}
	sort.Slice(pods, func(a, b int) bool {
		return pods[a].Metadata.CreationTimestamp.After(pods[b].Metadata.CreationTimestamp)
	})
	pod := pods[0]
	details := []string{}
	if pod.Status.Reason != "" { // e.g. DeadlineExceeded, Evicted
		details = append(details, "pod "+pod.Status.Reason+": "+pod.Status.Message)
	}
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.Name != jobContainer {
			continue
		}
		t := cs.State.Terminated
		if t == nil {
			t = cs.LastState.Terminated
		}
		if t != nil {
			code := int(t.ExitCode)
			if code >= 0 && code <= 255 {
				c.ExitCode = &code
			}
			details = append(details, fmt.Sprintf("container exited %d (%s)", t.ExitCode, t.Reason)) // Reason: OOMKilled | Error
		}
	}
	if len(details) > 0 {
		reason += " — " + strings.Join(details, "; ")
	}
	c.TerminalReason = strings.TrimSpace(fmt.Sprintf("%s (attempts: %d failed)", reason, j.Status.Failed))

	logs, err := r.kube.PodLogTail(ctx, pod.Metadata.Name, jobContainer, r.cfg.logTailLines, maxDiagnosticBytes*2)
	if err != nil {
		c.Diagnostic = fmt.Sprintf("pod %s: log tail unavailable: %v", pod.Metadata.Name, err)
		return
	}
	c.Diagnostic = fmt.Sprintf("pod %s (last %d lines):\n%s", pod.Metadata.Name, r.cfg.logTailLines, Redact(logs))
}

// Credential shapes scrubbed from a log tail before it leaves the cluster. The
// jobs do not log secrets on purpose, but a failure path that prints a DSN or a
// request URL is exactly the path this excerpt captures.
var redactions = []struct {
	re   *regexp.Regexp
	repl string
}{
	{regexp.MustCompile(`(?i)\b((?:postgres(?:ql)?|mysql|redis|rediss|amqp|mongodb(?:\+srv)?)://[^:@\s/]+:)[^@\s]+@`), "${1}***@"},
	{regexp.MustCompile(`(?i)\b(bearer\s+)[a-z0-9._~+/=-]{8,}`), "${1}***"},
	{regexp.MustCompile(`(?i)\b((?:api[_-]?key|access[_-]?token|token|secret|password|passwd|pwd|key)\s*[=:]\s*"?)[^\s"&,]{4,}`), "${1}***"},
	{regexp.MustCompile(`\b(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+`), "${1}***"},
	{regexp.MustCompile(`\bAIza[0-9A-Za-z_-]{20,}`), "AIza***"},
}

// Redact scrubs credential-shaped substrings from s.
func Redact(s string) string {
	for _, r := range redactions {
		s = r.re.ReplaceAllString(s, r.repl)
	}
	return s
}

func durationMs(j *kjob, ended time.Time) int64 {
	if j.Status.StartTime == nil || ended.IsZero() || ended.Before(*j.Status.StartTime) {
		return 0
	}
	return ended.Sub(*j.Status.StartTime).Milliseconds()
}

func derefInt(p *int) any {
	if p == nil {
		return "n/a"
	}
	return *p
}

func (r *reporter) warnOnce(cron string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.warnedFor[cron] {
		return
	}
	r.warnedFor[cron] = true
	log.Printf("WARN cronjob-reporter: no check-in URL for CronJob %q (key missing from %s) — its runs are NOT monitored", cron, r.cfg.checkinDir)
}

func (r *reporter) count(k string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.stats[k]++
}

// healthHandler serves /healthz: 200 while reconciles are succeeding, 503 once
// the last success is older than four intervals (liveness restarts a reporter
// wedged on the apiserver).
func (r *reporter) healthHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		last := r.lastOK.Load()
		age := time.Duration(0)
		if last > 0 {
			age = r.now().Sub(time.Unix(0, last))
		}
		healthy := last > 0 && age <= 4*r.cfg.interval
		r.mu.Lock()
		stats := make(map[string]int, len(r.stats))
		for k, v := range r.stats {
			stats[k] = v
		}
		r.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if !healthy {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		body := map[string]any{
			"healthy":             healthy,
			"last_reconcile_ago":  age.Round(time.Second).String(),
			"checkins_since_boot": stats,
		}
		if r.cloudRun != nil {
			body["cloud_run"] = r.cloudRun.status()
		}
		_ = json.NewEncoder(w).Encode(body)
	})
	return mux
}
