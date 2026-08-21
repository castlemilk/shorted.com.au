package shorts

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
)

// fakeRunner stands in for the jobmonitor collector.
type fakeRunner struct {
	req jobmonitor.RunRequest
	res *jobmonitor.RunResult
	err error
}

func (f *fakeRunner) RunJob(_ context.Context, req jobmonitor.RunRequest) (*jobmonitor.RunResult, error) {
	f.req = req
	return f.res, f.err
}

func postRun(t *testing.T, runner jobRunner, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	h := adminJobsRunHandler(log.NewLogger(), runner)
	r := httptest.NewRequest(http.MethodPost, "/api/admin/jobs/run", strings.NewReader(body))
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h(w, r)
	return w
}

func decode(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("response is not JSON (%d): %s", w.Code, w.Body.String())
	}
	return out
}

func TestJobsRunAccepted(t *testing.T) {
	runner := &fakeRunner{res: &jobmonitor.RunResult{
		Job: "shorted-news", DisplayName: "News Aggregator",
		Region: "australia-southeast2", ExecutionName: "shorted-news-x7k2p",
	}}
	w := postRun(t, runner, `{"job":"shorted-news"}`, map[string]string{"x-admin-actor": "ben@shorted.com.au"})

	if w.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202: %s", w.Code, w.Body.String())
	}
	if got := decode(t, w)["executionName"]; got != "shorted-news-x7k2p" {
		t.Errorf("executionName = %v", got)
	}
	// The admin identity must reach the audit path, not be invented downstream.
	if runner.req.Actor != "ben@shorted.com.au" {
		t.Errorf("actor = %q, want the forwarded admin email", runner.req.Actor)
	}
	if runner.req.Force {
		t.Error("force must default to false")
	}
}

// An anonymous caller (internal secret only, no forwarded identity) is still
// audited — as explicitly unknown rather than silently blank.
func TestJobsRunActorDefaults(t *testing.T) {
	runner := &fakeRunner{res: &jobmonitor.RunResult{Job: "j"}}
	postRun(t, runner, `{"job":"j"}`, nil)
	if !strings.Contains(runner.req.Actor, "unknown") {
		t.Errorf("actor = %q, want an explicit unknown marker", runner.req.Actor)
	}
}

func TestJobsRunPassesRegionAndForceThrough(t *testing.T) {
	runner := &fakeRunner{res: &jobmonitor.RunResult{Job: "asx-discovery"}}
	postRun(t, runner, `{"job":"asx-discovery","region":"us-central1","force":true}`, nil)
	if runner.req.Region != "us-central1" || !runner.req.Force {
		t.Errorf("req = %+v", runner.req)
	}
}

func TestJobsRunRefusals(t *testing.T) {
	cases := []struct {
		name     string
		err      error
		status   int
		code     string
		contains string
	}{
		{"unknown", jobmonitor.ErrUnknownJob, http.StatusNotFound, "unknown_job", ""},
		{"retired", jobmonitor.ErrRetiredJob, http.StatusConflict, "retired", "replacement"},
		{"not executable", jobmonitor.ErrNotExecutable, http.StatusConflict, "not_executable", ""},
		{"unconfigured", jobmonitor.ErrNoProject, http.StatusServiceUnavailable, "not_configured", ""},
		{"gcp rejected", errors.New("googleapi: 403 permission denied"), http.StatusBadGateway, "run_failed", "run.invoker"},
	}
	for _, tc := range cases {
		w := postRun(t, &fakeRunner{err: tc.err}, `{"job":"x"}`, nil)
		if w.Code != tc.status {
			t.Errorf("%s: status = %d, want %d", tc.name, w.Code, tc.status)
		}
		out := decode(t, w)
		if out["error"] != tc.code {
			t.Errorf("%s: error = %v, want %q", tc.name, out["error"], tc.code)
		}
		if tc.contains != "" {
			if msg, _ := out["message"].(string); !strings.Contains(msg, tc.contains) {
				t.Errorf("%s: message %q should mention %q", tc.name, msg, tc.contains)
			}
		}
		// A refusal must never leak the raw GCP error text to the console.
		if msg, _ := out["message"].(string); strings.Contains(msg, "googleapi") {
			t.Errorf("%s: raw upstream error leaked: %q", tc.name, msg)
		}
	}
}

// The already-running 409 has to carry enough for the operator to decide, and
// must advertise that force is the way past it.
func TestJobsRunAlreadyRunningIsForceable(t *testing.T) {
	started := time.Now().UTC().Add(-27 * time.Hour)
	runner := &fakeRunner{err: &jobmonitor.AlreadyRunningError{
		Job: "shorts-data-sync", ExecutionName: "shorts-data-sync-abcde",
		StartedAt: started.Format(time.RFC3339), Age: 27 * time.Hour,
	}}
	w := postRun(t, runner, `{"job":"shorts-data-sync"}`, nil)

	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", w.Code)
	}
	out := decode(t, w)
	if out["error"] != "already_running" {
		t.Errorf("error = %v", out["error"])
	}
	if out["executionName"] != "shorts-data-sync-abcde" {
		t.Errorf("executionName = %v", out["executionName"])
	}
	if out["forceable"] != true {
		t.Error("already_running must advertise forceable so the UI offers the override")
	}
	if secs, _ := out["runningForSeconds"].(float64); secs < 26*3600 {
		t.Errorf("runningForSeconds = %v, want ~27h", secs)
	}
}

func TestJobsRunRejectsBadRequests(t *testing.T) {
	// Non-POST.
	h := adminJobsRunHandler(log.NewLogger(), &fakeRunner{})
	w := httptest.NewRecorder()
	h(w, httptest.NewRequest(http.MethodGet, "/api/admin/jobs/run", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET status = %d, want 405", w.Code)
	}

	// Preflight passes through without touching the runner.
	w = httptest.NewRecorder()
	h(w, httptest.NewRequest(http.MethodOptions, "/api/admin/jobs/run", nil))
	if w.Code != http.StatusOK {
		t.Errorf("OPTIONS status = %d, want 200", w.Code)
	}

	// Garbage body.
	if got := postRun(t, &fakeRunner{}, `not json`, nil).Code; got != http.StatusBadRequest {
		t.Errorf("bad body status = %d, want 400", got)
	}

	// An empty job name is the collector's call (404), not a silent success —
	// prove we forward it rather than defaulting to something.
	runner := &fakeRunner{err: jobmonitor.ErrUnknownJob}
	if got := postRun(t, runner, `{}`, nil).Code; got != http.StatusNotFound {
		t.Errorf("empty job status = %d, want 404", got)
	}
	if runner.req.Job != "" {
		t.Errorf("job = %q, want the empty string forwarded verbatim", runner.req.Job)
	}
}
