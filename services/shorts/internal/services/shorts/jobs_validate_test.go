package shorts

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
)

// fakeValidator stands in for the jobmonitor collector.
type fakeValidator struct {
	req     jobmonitor.ValidationRequest
	run     *jobmonitor.ValidationRun
	runErr  error
	exec    string
	report  *jobmonitor.ValidationReport
	pollErr error
}

func (f *fakeValidator) RunValidation(_ context.Context, req jobmonitor.ValidationRequest) (*jobmonitor.ValidationRun, error) {
	f.req = req
	return f.run, f.runErr
}

func (f *fakeValidator) ValidationResult(_ context.Context, execution string) (*jobmonitor.ValidationReport, error) {
	f.exec = execution
	return f.report, f.pollErr
}

func validateRequest(t *testing.T, v jobValidator, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	h := adminJobsValidateSyncHandler(log.NewLogger(), v)
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.Header.Set("x-admin-actor", "ben@shorted.com.au")
	w := httptest.NewRecorder()
	h(w, r)
	return w
}

func decodeBody(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("response is not JSON (%d): %s", w.Code, w.Body.String())
	}
	return out
}

func TestValidateSyncAccepted(t *testing.T) {
	v := &fakeValidator{run: &jobmonitor.ValidationRun{
		Job:           "shorts-data-sync",
		Region:        "australia-southeast2",
		ExecutionName: "shorts-data-sync-v4l1d",
		Stocks:        []string{"BHP", "DRO"},
		Args:          []string{"short-data-sync", "-shadow", "-stocks", "BHP,DRO"},
	}}
	w := validateRequest(t, v, http.MethodPost, "/api/admin/jobs/validate-sync", `{"stocks":["bhp","dro"]}`)
	if w.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	body := decodeBody(t, w)
	if body["executionName"] != "shorts-data-sync-v4l1d" {
		t.Fatalf("body = %v", body)
	}
	// The handler forwards codes VERBATIM: normalisation is jobmonitor's job, so
	// there is exactly one place that decides what a valid code is.
	if len(v.req.Stocks) != 2 || v.req.Stocks[0] != "bhp" {
		t.Fatalf("forwarded stocks = %v", v.req.Stocks)
	}
	if v.req.Actor != "ben@shorted.com.au" {
		t.Fatalf("actor = %q", v.req.Actor)
	}
}

// TestValidateSyncTakesNoJobOrArgs: the request contract carries stock codes
// and nothing else. A caller-supplied job/args/region is ignored, because there
// is no field to carry it.
func TestValidateSyncTakesNoJobOrArgs(t *testing.T) {
	v := &fakeValidator{run: &jobmonitor.ValidationRun{ExecutionName: "e"}}
	w := validateRequest(t, v, http.MethodPost, "/api/admin/jobs/validate-sync",
		`{"stocks":["BHP"],"job":"enrichment-processor","args":["-live"],"region":"us-central1","force":true}`)
	if w.Code != http.StatusAccepted {
		t.Fatalf("status = %d", w.Code)
	}
	if len(v.req.Stocks) != 1 || v.req.Stocks[0] != "BHP" {
		t.Fatalf("stocks = %v", v.req.Stocks)
	}
}

func TestValidateSyncBadBody(t *testing.T) {
	w := validateRequest(t, &fakeValidator{}, http.MethodPost, "/api/admin/jobs/validate-sync", `not json`)
	if w.Code != http.StatusBadRequest || decodeBody(t, w)["error"] != "invalid_body" {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
}

func TestValidateSyncRefusalMapping(t *testing.T) {
	cases := []struct {
		err  error
		code int
		slug string
	}{
		{jobmonitor.ErrInvalidStocks, http.StatusBadRequest, "invalid_stocks"},
		{jobmonitor.ErrUnknownJob, http.StatusNotFound, "unknown_job"},
		{jobmonitor.ErrRetiredJob, http.StatusConflict, "retired"},
		{jobmonitor.ErrNotExecutable, http.StatusConflict, "not_executable"},
		{jobmonitor.ErrNoProject, http.StatusServiceUnavailable, "not_configured"},
		{jobmonitor.ErrOverridesUnsupported, http.StatusServiceUnavailable, "not_configured"},
		{errors.New("boom"), http.StatusBadGateway, "validation_failed"},
	}
	for _, tc := range cases {
		w := validateRequest(t, &fakeValidator{runErr: tc.err}, http.MethodPost,
			"/api/admin/jobs/validate-sync", `{"stocks":["BHP"]}`)
		if w.Code != tc.code {
			t.Fatalf("%v → status %d, want %d", tc.err, w.Code, tc.code)
		}
		if got := decodeBody(t, w)["error"]; got != tc.slug {
			t.Fatalf("%v → error %v, want %q", tc.err, got, tc.slug)
		}
	}
}

func TestValidateSyncPollRunning(t *testing.T) {
	v := &fakeValidator{report: &jobmonitor.ValidationReport{ExecutionName: "e1", Status: "running"}}
	w := validateRequest(t, v, http.MethodGet, "/api/admin/jobs/validate-sync?execution=e1", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if decodeBody(t, w)["status"] != "running" {
		t.Fatalf("body = %s", w.Body.String())
	}
	if v.exec != "e1" {
		t.Fatalf("execution = %q", v.exec)
	}
}

func TestValidateSyncPollSucceeded(t *testing.T) {
	v := &fakeValidator{report: &jobmonitor.ValidationReport{
		ExecutionName: "e1",
		Status:        "succeeded",
		Summary:       json.RawMessage(`{"mode":"shadow","schema_version":1}`),
	}}
	w := validateRequest(t, v, http.MethodGet, "/api/admin/jobs/validate-sync?execution=e1", "")
	body := decodeBody(t, w)
	summary, ok := body["summary"].(map[string]any)
	if !ok || summary["mode"] != "shadow" {
		t.Fatalf("summary must pass through as an object: %s", w.Body.String())
	}
}

func TestValidateSyncPollMissingExecutionParam(t *testing.T) {
	w := validateRequest(t, &fakeValidator{}, http.MethodGet, "/api/admin/jobs/validate-sync", "")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", w.Code)
	}
}

// TestValidateSyncPollSummaryNotFound: an explicit, diagnosable failure — not
// an empty 200 that reads like "nothing to report".
func TestValidateSyncPollSummaryNotFound(t *testing.T) {
	v := &fakeValidator{
		report: &jobmonitor.ValidationReport{
			ExecutionName: "e1", Status: "succeeded",
			Message: "no validation summary was found",
			LogTail: []string{"✅ done"},
		},
		pollErr: jobmonitor.ErrSummaryNotFound,
	}
	w := validateRequest(t, v, http.MethodGet, "/api/admin/jobs/validate-sync?execution=e1", "")
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d", w.Code)
	}
	body := decodeBody(t, w)
	if body["error"] != "summary_not_found" {
		t.Fatalf("body = %s", w.Body.String())
	}
	if body["logTail"] == nil {
		t.Fatal("the log tail must travel — it is the only evidence an operator has")
	}
}

func TestValidateSyncPollInvalidExecution(t *testing.T) {
	v := &fakeValidator{pollErr: jobmonitor.ErrInvalidExecution}
	w := validateRequest(t, v, http.MethodGet, "/api/admin/jobs/validate-sync?execution=..%2Fetc", "")
	if w.Code != http.StatusBadRequest || decodeBody(t, w)["error"] != "invalid_execution" {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
}

func TestValidateSyncMethodNotAllowed(t *testing.T) {
	w := validateRequest(t, &fakeValidator{}, http.MethodDelete, "/api/admin/jobs/validate-sync", "")
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d", w.Code)
	}
}
