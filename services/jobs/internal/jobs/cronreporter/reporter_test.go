package cronreporter

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var t0 = time.Date(2026, 9, 29, 10, 0, 0, 0, time.UTC)

type fakeCluster struct {
	mu          sync.Mutex
	jobs        []kjob
	pods        map[string][]kpod
	logs        map[string]string
	annotations map[string]map[string]string
	listErr     error
}

func (f *fakeCluster) ListJobs(context.Context, string) ([]kjob, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.listErr != nil {
		return nil, f.listErr
	}
	out := make([]kjob, len(f.jobs))
	for i, j := range f.jobs {
		// Reflect previously written annotations, like the apiserver would.
		cp := j
		cp.Metadata.Annotations = map[string]string{}
		for k, v := range j.Metadata.Annotations {
			cp.Metadata.Annotations[k] = v
		}
		for k, v := range f.annotations[j.Metadata.Name] {
			cp.Metadata.Annotations[k] = v
		}
		out[i] = cp
	}
	return out, nil
}

func (f *fakeCluster) AnnotateJob(_ context.Context, name string, ann map[string]string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.annotations == nil {
		f.annotations = map[string]map[string]string{}
	}
	if f.annotations[name] == nil {
		f.annotations[name] = map[string]string{}
	}
	for k, v := range ann {
		f.annotations[name][k] = v
	}
	return nil
}

func (f *fakeCluster) ListJobPods(_ context.Context, job string) ([]kpod, error) {
	return f.pods[job], nil
}

func (f *fakeCluster) PodLogTail(_ context.Context, pod, _ string, _, _ int) (string, error) {
	return f.logs[pod], nil
}

type sent struct {
	url string
	c   checkin
}

type fakeSender struct {
	sent []sent
	err  error
}

func (s *fakeSender) Send(_ context.Context, u string, c checkin) error {
	if s.err != nil {
		return s.err
	}
	s.sent = append(s.sent, sent{u, c})
	return nil
}

func staticURLs(m map[string]string) urlSource {
	return func(k string) (string, bool) { u, ok := m[k]; return u, ok }
}

func newJob(name, cron string, start *time.Time, conds ...kjobCondition) kjob {
	var j kjob
	j.Metadata.Name = name
	j.Metadata.UID = "uid-" + name
	j.Metadata.Labels = map[string]string{LabelCronJob: cron, LabelMonitored: "true"}
	j.Metadata.CreationTimestamp = t0
	j.Status.StartTime = start
	j.Status.Conditions = conds
	return j
}

func ptr[T any](v T) *T { return &v }

func testReporter(k *fakeCluster, s *fakeSender, urls map[string]string) *reporter {
	r := newReporter(k, s, staticURLs(urls), config{
		interval: 30 * time.Second, maxReportAge: 3 * time.Hour, logTailLines: 40, heartbeatInterval: 5 * time.Minute,
	})
	r.now = func() time.Time { return t0.Add(10 * time.Minute) }
	return r
}

const url1 = "https://api.telesis.dev/v1/cron/tok1"

func TestStartIsSentOnceThenCompleteWithDuration(t *testing.T) {
	k := &fakeCluster{jobs: []kjob{newJob("news-123", "shorted-news", ptr(t0))}}
	s := &fakeSender{}
	r := testReporter(k, s, map[string]string{"shorted-news": url1})

	r.tick(context.Background())
	r.tick(context.Background())
	if len(s.sent) != 1 || s.sent[0].c.State != stateStart || s.sent[0].url != url1 {
		t.Fatalf("want exactly one start check-in, got %+v", s.sent)
	}
	if s.sent[0].c.RunID != "news-123" || s.sent[0].c.IdempotencyKey != "uid-news-123:start" {
		t.Fatalf("start check-in identity wrong: %+v", s.sent[0].c)
	}

	k.jobs[0].Status.CompletionTime = ptr(t0.Add(90 * time.Second))
	k.jobs[0].Status.Conditions = []kjobCondition{{Type: "Complete", Status: "True", LastTransitionTime: t0.Add(90 * time.Second)}}
	r.tick(context.Background())
	r.tick(context.Background())

	if len(s.sent) != 2 {
		t.Fatalf("want start+complete, got %d check-ins", len(s.sent))
	}
	c := s.sent[1].c
	if c.State != stateComplete || c.DurationMs != 90_000 || c.ExitCode == nil || *c.ExitCode != 0 {
		t.Fatalf("complete check-in wrong: %+v", c)
	}
	if got := k.annotations["news-123"][annEnd]; got != endComplete {
		t.Fatalf("annotation %s = %q, want %q", annEnd, got, endComplete)
	}
}

func TestFailureCarriesExitCodeReasonAndRedactedLogs(t *testing.T) {
	j := newJob("fre-1", "financial-report-extractor", ptr(t0),
		kjobCondition{Type: "FailureTarget", Status: "True"},
		kjobCondition{Type: "Failed", Status: "True", Reason: "BackoffLimitExceeded", Message: "Job has reached the specified backoff limit", LastTransitionTime: t0.Add(5 * time.Minute)},
	)
	j.Status.Failed = 1
	var older, newer kpod
	older.Metadata.Name, older.Metadata.CreationTimestamp = "fre-1-old", t0
	newer.Metadata.Name, newer.Metadata.CreationTimestamp = "fre-1-new", t0.Add(time.Minute)
	newer.Status.ContainerStatuses = []kcontainerStatus{{Name: "job"}}
	newer.Status.ContainerStatuses[0].State.Terminated = &struct {
		ExitCode int32  `json:"exitCode"`
		Reason   string `json:"reason"`
		Message  string `json:"message"`
	}{ExitCode: 137, Reason: "OOMKilled"}

	k := &fakeCluster{
		jobs: []kjob{j},
		pods: map[string][]kpod{"fre-1": {older, newer}},
		logs: map[string]string{"fre-1-new": "connecting postgresql://admin:hunter2@db:5432/shorts\nGEMINI_API_KEY=AIzaSyA1234567890abcdefghijk\nboom\n"},
	}
	s := &fakeSender{}
	testReporter(k, s, map[string]string{"financial-report-extractor": url1}).tick(context.Background())

	if len(s.sent) != 1 {
		t.Fatalf("a job first seen already failed sends only the fail check-in, got %+v", s.sent)
	}
	c := s.sent[0].c
	if c.State != stateFail || c.ExitCode == nil || *c.ExitCode != 137 {
		t.Fatalf("fail check-in wrong: %+v", c)
	}
	for _, want := range []string{"BackoffLimitExceeded", "OOMKilled", "exited 137"} {
		if !strings.Contains(c.TerminalReason, want) {
			t.Errorf("terminal reason %q missing %q", c.TerminalReason, want)
		}
	}
	if !strings.Contains(c.Diagnostic, "fre-1-new") || !strings.Contains(c.Diagnostic, "boom") {
		t.Errorf("diagnostic should come from the newest pod: %q", c.Diagnostic)
	}
	for _, leak := range []string{"hunter2", "AIzaSyA1234567890abcdefghijk"} {
		if strings.Contains(c.Diagnostic, leak) {
			t.Errorf("diagnostic leaked %q: %q", leak, c.Diagnostic)
		}
	}
	if c.DurationMs != (5 * time.Minute).Milliseconds() {
		t.Errorf("duration = %d, want 5m", c.DurationMs)
	}
}

func TestFailureTargetAloneIsNotTerminal(t *testing.T) {
	j := newJob("x-1", "x", ptr(t0), kjobCondition{Type: "FailureTarget", Status: "True"})
	k := &fakeCluster{jobs: []kjob{j}}
	s := &fakeSender{}
	testReporter(k, s, map[string]string{"x": url1}).tick(context.Background())
	if len(s.sent) != 1 || s.sent[0].c.State != stateStart {
		t.Fatalf("FailureTarget without Failed is still running; want only start, got %+v", s.sent)
	}
}

func TestStaleTerminalRunsAreMarkedNotReported(t *testing.T) {
	j := newJob("old-1", "x", ptr(t0.Add(-10*time.Hour)),
		kjobCondition{Type: "Complete", Status: "True", LastTransitionTime: t0.Add(-9 * time.Hour)})
	k := &fakeCluster{jobs: []kjob{j}}
	s := &fakeSender{}
	testReporter(k, s, map[string]string{"x": url1}).tick(context.Background())
	if len(s.sent) != 0 {
		t.Fatalf("stale run must not be replayed to Telesis, got %+v", s.sent)
	}
	if got := k.annotations["old-1"][annEnd]; got != endStale {
		t.Fatalf("annotation = %q, want %q", got, endStale)
	}
}

func TestMissingURLMarksOnlyTerminalRuns(t *testing.T) {
	running := newJob("a-1", "unregistered", ptr(t0))
	done := newJob("a-0", "unregistered", ptr(t0),
		kjobCondition{Type: "Complete", Status: "True", LastTransitionTime: t0.Add(time.Minute)})
	k := &fakeCluster{jobs: []kjob{running, done}}
	s := &fakeSender{}
	testReporter(k, s, map[string]string{}).tick(context.Background())
	if len(s.sent) != 0 {
		t.Fatalf("nothing can be sent without a URL, got %+v", s.sent)
	}
	if k.annotations["a-1"] != nil {
		t.Fatalf("a running job must stay unmarked so a later URL still gets its outcome")
	}
	if got := k.annotations["a-0"][annEnd]; got != endUnmonitored {
		t.Fatalf("annotation = %q, want %q", got, endUnmonitored)
	}
}

func TestTransientErrorRetriesPermanentErrorIsRecorded(t *testing.T) {
	j := newJob("n-1", "x", ptr(t0), kjobCondition{Type: "Complete", Status: "True", LastTransitionTime: t0.Add(time.Minute)})

	k := &fakeCluster{jobs: []kjob{j}}
	s := &fakeSender{err: errors.New("dial tcp: i/o timeout")}
	r := testReporter(k, s, map[string]string{"x": url1})
	r.tick(context.Background())
	if k.annotations["n-1"] != nil {
		t.Fatalf("a transient failure must leave the Job unmarked for retry")
	}

	s.err = &permanentError{Status: 404, Body: "unknown monitor"}
	r.tick(context.Background())
	if got := k.annotations["n-1"][annEnd]; got != "rejected-404" {
		t.Fatalf("annotation = %q, want rejected-404", got)
	}
}

func TestListFailureMakesHealthzUnhealthy(t *testing.T) {
	k := &fakeCluster{listErr: errors.New("forbidden")}
	r := testReporter(k, &fakeSender{}, nil)
	r.tick(context.Background())
	rec := httptest.NewRecorder()
	r.healthHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("healthz = %d before any successful reconcile, want 503", rec.Code)
	}

	k.listErr = nil
	r.tick(context.Background())
	rec = httptest.NewRecorder()
	r.healthHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("healthz = %d after a successful reconcile, want 200", rec.Code)
	}
}

func TestHeartbeatIsRateLimited(t *testing.T) {
	k := &fakeCluster{}
	s := &fakeSender{}
	r := testReporter(k, s, map[string]string{heartbeatKey: "https://api.telesis.dev/v1/cron/hb"})
	now := t0
	r.now = func() time.Time { return now }
	r.tick(context.Background())
	now = now.Add(time.Minute)
	r.tick(context.Background())
	now = now.Add(5 * time.Minute)
	r.tick(context.Background())
	if len(s.sent) != 2 {
		t.Fatalf("want 2 heartbeats across 6 minutes at a 5m interval, got %d", len(s.sent))
	}
}

func TestHTTPSenderClassifiesStatusesAndNeverLogsTheURL(t *testing.T) {
	var gotPath, gotKey, gotBody string
	status := http.StatusNoContent
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotPath, gotKey = req.URL.Path, req.Header.Get("Idempotency-Key")
		b := make([]byte, 4096)
		n, _ := req.Body.Read(b)
		gotBody = string(b[:n])
		w.WriteHeader(status)
	}))
	defer srv.Close()

	s := newHTTPSender()
	code := 3
	err := s.Send(context.Background(), srv.URL+"/v1/cron/secrettoken", checkin{State: stateFail, RunID: "r1", ExitCode: &code, IdempotencyKey: "k1"})
	if err != nil {
		t.Fatalf("204 should succeed: %v", err)
	}
	if gotPath != "/v1/cron/secrettoken/fail" || gotKey != "k1" || !strings.Contains(gotBody, `"exit_code":3`) {
		t.Fatalf("request wrong: path=%s key=%s body=%s", gotPath, gotKey, gotBody)
	}

	status = http.StatusNotFound
	if _, ok := isPermanent(s.Send(context.Background(), srv.URL+"/v1/cron/secrettoken", checkin{State: stateComplete})); !ok {
		t.Fatalf("404 must be permanent")
	}
	status = http.StatusTooManyRequests
	if err := s.Send(context.Background(), srv.URL+"/v1/cron/secrettoken", checkin{State: stateComplete}); err == nil {
		t.Fatal("429 must be an error")
	} else if _, ok := isPermanent(err); ok {
		t.Fatal("429 must be transient")
	}

	srv.Close()
	err = s.Send(context.Background(), srv.URL+"/v1/cron/secrettoken", checkin{State: stateComplete})
	if err == nil || strings.Contains(err.Error(), "secrettoken") {
		t.Fatalf("transport errors must not echo the check-in URL: %v", err)
	}
}

func TestClipAndTailRespectRuneBoundaries(t *testing.T) {
	s := strings.Repeat("é", 10) // 2 bytes each
	if got := clip(s, 5); got != "éé" {
		t.Errorf("clip = %q", got)
	}
	if got := tail(s, 5); got != "éé" {
		t.Errorf("tail = %q", got)
	}
}

func TestDirURLsRejectsTraversalAndNonHTTPS(t *testing.T) {
	dir := t.TempDir()
	write := func(name, v string) {
		t.Helper()
		if err := writeFile(dir, name, v); err != nil {
			t.Fatal(err)
		}
	}
	write("good", "https://api.telesis.dev/v1/cron/abc\n")
	write("plain", "http://insecure/v1/cron/abc")
	urls := dirURLs(dir, false)
	if u, ok := urls("good"); !ok || u != "https://api.telesis.dev/v1/cron/abc" {
		t.Errorf("good = %q %v", u, ok)
	}
	if _, ok := urls("plain"); ok {
		t.Error("non-https URL must be refused")
	}
	if _, ok := urls("../good"); ok {
		t.Error("path traversal must be refused")
	}
	if _, ok := dirURLs(dir, true)("plain"); !ok {
		t.Error("-allow-http-checkins should accept http://")
	}
}

func writeFile(dir, name, v string) error {
	return os.WriteFile(filepath.Join(dir, name), []byte(v), 0o600)
}
