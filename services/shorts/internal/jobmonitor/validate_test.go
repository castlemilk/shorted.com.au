package jobmonitor

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"google.golang.org/api/googleapi"
	logging "google.golang.org/api/logging/v2"
	run "google.golang.org/api/run/v2"
)

// stubOverrideRunner implements BOTH Runner and OverrideRunner, and records the
// exact argv it was handed.
type stubOverrideRunner struct {
	stubRunner
	args    []string
	job     string
	region  string
	project string
	err     error
}

func (s *stubOverrideRunner) RunWithArgs(_ context.Context, project, region, job string, args []string) (string, error) {
	s.project, s.region, s.job = project, region, job
	s.args = append([]string(nil), args...)
	if s.err != nil {
		return "", s.err
	}
	return "shorts-data-sync-v4l1d", nil
}

type stubExecReader struct {
	exec *run.GoogleCloudRunV2Execution
	err  error
	// got records the resource coordinates the reader was asked for.
	got [4]string
}

func (s *stubExecReader) Execution(_ context.Context, project, region, job, execution string) (*run.GoogleCloudRunV2Execution, error) {
	s.got = [4]string{project, region, job, execution}
	return s.exec, s.err
}

type stubLogReader struct {
	lines []string
	err   error
	job   string
	exec  string
}

func (s *stubLogReader) Lines(_ context.Context, _, job, execution string, _ int) ([]string, error) {
	s.job, s.exec = job, execution
	return s.lines, s.err
}

func seededValidator(t *testing.T, jobs []JobStatus) (*Collector, *stubOverrideRunner) {
	t.Helper()
	c := NewCollector(Config{ProjectID: "proj", RunRegions: []string{"australia-southeast2"}})
	c.cached = jobs
	c.cachedAt = time.Now()
	r := &stubOverrideRunner{}
	c.SetRunner(r)
	return c, r
}

func TestNormalizeStockCodes(t *testing.T) {
	got, err := NormalizeStockCodes([]string{" bhp , dro", "4dx bhp"})
	if err != nil {
		t.Fatalf("NormalizeStockCodes: %v", err)
	}
	if strings.Join(got, ",") != "BHP,DRO,4DX" {
		t.Fatalf("codes = %v", got)
	}
}

func TestNormalizeStockCodesRejects(t *testing.T) {
	for _, in := range [][]string{
		nil,
		{""},
		{"BH-P"},
		{"TOOLONG"},
		{"BHP", "--shadow=false"},
		{"$(whoami)"},
		{"BHP\nDRO", "-days"},
	} {
		if _, err := NormalizeStockCodes(in); !errors.Is(err, ErrInvalidStocks) {
			t.Fatalf("NormalizeStockCodes(%v) must fail with ErrInvalidStocks, got %v", in, err)
		}
	}
}

func TestNormalizeStockCodesCap(t *testing.T) {
	codes := make([]string, 0, maxValidationStocks+1)
	for i := 0; i <= maxValidationStocks; i++ {
		codes = append(codes, string(rune('A'+i%26))+string(rune('A'+(i/26)%26))+string(rune('0'+i%10)))
	}
	if _, err := NormalizeStockCodes(codes); !errors.Is(err, ErrInvalidStocks) {
		t.Fatalf("more than %d codes must be refused", maxValidationStocks)
	}
}

// TestValidationArgsAreServerConstructed is the security property in one test:
// whatever the caller supplies, the argv is always the same shadow shape.
func TestValidationArgsAreServerConstructed(t *testing.T) {
	c, r := seededValidator(t, fleet())
	res, err := c.RunValidation(context.Background(), ValidationRequest{
		Stocks: []string{"bhp", "DRO"}, Actor: "ben@shorted.com.au",
	})
	if err != nil {
		t.Fatalf("RunValidation: %v", err)
	}
	want := []string{"short-data-sync", "-shadow", "-stocks", "BHP,DRO"}
	if strings.Join(r.args, "|") != strings.Join(want, "|") {
		t.Fatalf("args = %v, want %v", r.args, want)
	}
	if r.job != ValidationJobName {
		t.Fatalf("job = %q, want %q — the endpoint must not be aimable", r.job, ValidationJobName)
	}
	if r.region != "australia-southeast2" || r.project != "proj" {
		t.Fatalf("resolved coordinates = %s/%s", r.project, r.region)
	}
	if res.ExecutionName != "shorts-data-sync-v4l1d" {
		t.Fatalf("execution = %q", res.ExecutionName)
	}
	// -shadow is not merely present, it is at a position no later argument can
	// negate: nothing after it re-enables writes.
	if r.args[1] != "-shadow" {
		t.Fatalf("-shadow must always be passed: %v", r.args)
	}
}

// TestValidationIgnoresAlreadyRunningGuard documents the deliberate divergence
// from RunJob: a shadow run writes nothing, so an in-flight 27h sync must not
// block the diagnostic. fleet()'s shorts-data-sync is running.
func TestValidationIgnoresAlreadyRunningGuard(t *testing.T) {
	c, _ := seededValidator(t, fleet())
	if _, err := c.RunValidation(context.Background(), ValidationRequest{Stocks: []string{"BHP"}}); err != nil {
		t.Fatalf("a validation run must not be blocked by an in-flight sync: %v", err)
	}
	// RunValidation invalidates the status cache (the new execution must show up
	// on the next poll), so re-seed before asserting the contrast.
	c.cached = fleet()
	c.cachedAt = time.Now()

	// ...while a real run of the same job still is.
	var running *AlreadyRunningError
	if _, err := c.RunJob(context.Background(), RunRequest{Job: "shorts-data-sync"}); !errors.As(err, &running) {
		t.Fatalf("RunJob must still refuse: %v", err)
	}
}

func TestValidationRefusesRetiredAndUnknown(t *testing.T) {
	c, _ := seededValidator(t, []JobStatus{
		{Name: "shorts-data-sync", Type: "job", Region: "australia-southeast2", Retired: true},
	})
	if _, err := c.RunValidation(context.Background(), ValidationRequest{Stocks: []string{"BHP"}}); !errors.Is(err, ErrRetiredJob) {
		t.Fatalf("retired must refuse, got %v", err)
	}

	c2, _ := seededValidator(t, []JobStatus{{Name: "shorted-news", Type: "job", Region: "australia-southeast2"}})
	if _, err := c2.RunValidation(context.Background(), ValidationRequest{Stocks: []string{"BHP"}}); !errors.Is(err, ErrUnknownJob) {
		t.Fatalf("an absent shorts-data-sync must be unknown_job, got %v", err)
	}
}

func TestValidationRefusesBadCodesBeforeTouchingTheFleet(t *testing.T) {
	c, r := seededValidator(t, fleet())
	if _, err := c.RunValidation(context.Background(), ValidationRequest{Stocks: []string{"rm -rf /"}}); !errors.Is(err, ErrInvalidStocks) {
		t.Fatalf("want ErrInvalidStocks, got %v", err)
	}
	if r.args != nil {
		t.Fatal("no execution may be created for an invalid request")
	}
}

func TestValidationRefusesWithoutOverrideCapableRunner(t *testing.T) {
	c := NewCollector(Config{ProjectID: "proj"})
	c.cached = fleet()
	c.cachedAt = time.Now()
	c.SetRunner(&stubRunner{}) // Runner only — no RunWithArgs
	if _, err := c.RunValidation(context.Background(), ValidationRequest{Stocks: []string{"BHP"}}); !errors.Is(err, ErrOverridesUnsupported) {
		t.Fatalf("want ErrOverridesUnsupported, got %v", err)
	}
}

// --- result retrieval -------------------------------------------------------

const sampleSummary = `{"mode":"shadow","schema_version":1,"rows_parsed":2100,"stocks":{"requested":["BHP"],"not_found":[],"observations":[{"code":"BHP","date":"2026-08-20","status":"changed"}],"counts":{"changed":1}}}`

func finished(failed int64) *run.GoogleCloudRunV2Execution {
	e := &run.GoogleCloudRunV2Execution{
		StartTime:      "2026-08-21T01:00:00Z",
		CompletionTime: "2026-08-21T01:02:00Z",
		LogUri:         "https://console.cloud.google.com/logs",
	}
	if failed > 0 {
		e.FailedCount = failed
		e.Conditions = []*run.GoogleCloudRunV2Condition{{State: "CONDITION_FAILED", Reason: "Failed", Message: "task exited with code 1"}}
	} else {
		e.SucceededCount = 1
	}
	return e
}

func withReaders(t *testing.T, exec *run.GoogleCloudRunV2Execution, lines []string) (*Collector, *stubExecReader, *stubLogReader) {
	t.Helper()
	c, _ := seededValidator(t, fleet())
	er := &stubExecReader{exec: exec}
	lr := &stubLogReader{lines: lines}
	c.SetExecutionReader(er)
	c.SetLogReader(lr)
	return c, er, lr
}

func TestValidationResultStillRunning(t *testing.T) {
	c, _, lr := withReaders(t, &run.GoogleCloudRunV2Execution{StartTime: "2026-08-21T01:00:00Z", RunningCount: 1}, nil)
	rep, err := c.ValidationResult(context.Background(), "shorts-data-sync-v4l1d")
	if err != nil {
		t.Fatalf("ValidationResult: %v", err)
	}
	if rep.Status != "running" || rep.Summary != nil {
		t.Fatalf("report = %+v", rep)
	}
	if lr.exec != "" {
		t.Fatal("a still-running execution must not cost a log query")
	}
}

func TestValidationResultSucceededParsesSummary(t *testing.T) {
	c, er, lr := withReaders(t, finished(0), []string{
		"noise after the summary",
		ValidationLinePrefix + sampleSummary,
		"🚀 SHORT DATA SYNC — starting",
	})
	rep, err := c.ValidationResult(context.Background(), "shorts-data-sync-v4l1d")
	if err != nil {
		t.Fatalf("ValidationResult: %v", err)
	}
	if rep.Status != "succeeded" {
		t.Fatalf("status = %q", rep.Status)
	}
	var back struct {
		Mode   string `json:"mode"`
		Stocks struct {
			Requested []string `json:"requested"`
		} `json:"stocks"`
	}
	if err := json.Unmarshal(rep.Summary, &back); err != nil {
		t.Fatalf("summary must be passed through verbatim and parse: %v", err)
	}
	if back.Mode != "shadow" || len(back.Stocks.Requested) != 1 {
		t.Fatalf("summary lost content: %s", rep.Summary)
	}
	if er.got[2] != ValidationJobName || er.got[3] != "shorts-data-sync-v4l1d" {
		t.Fatalf("execution lookup coordinates = %v", er.got)
	}
	if lr.job != ValidationJobName {
		t.Fatalf("log query job = %q", lr.job)
	}
}

// TestValidationResultAcceptsPrefixlessJSON covers a structured-logging sink
// that strips the marker: the reader still recognises a shadow summary.
func TestValidationResultAcceptsPrefixlessJSON(t *testing.T) {
	c, _, _ := withReaders(t, finished(0), []string{"unrelated {not json", sampleSummary})
	rep, err := c.ValidationResult(context.Background(), "shorts-data-sync-v4l1d")
	if err != nil {
		t.Fatalf("ValidationResult: %v", err)
	}
	if rep.Summary == nil {
		t.Fatal("a prefixless but well-formed shadow summary must still be found")
	}
}

func TestValidationResultFailedSurfacesLogTail(t *testing.T) {
	c, _, _ := withReaders(t, finished(1), []string{
		"panic: connection refused",
		"dialing postgres",
	})
	rep, err := c.ValidationResult(context.Background(), "shorts-data-sync-v4l1d")
	if err != nil {
		t.Fatalf("a failed execution is a report, not a transport error: %v", err)
	}
	if rep.Status != "failed" {
		t.Fatalf("status = %q", rep.Status)
	}
	if !strings.Contains(rep.Message, "exited with code 1") {
		t.Fatalf("message = %q", rep.Message)
	}
	// Oldest first, so the console reads top-to-bottom.
	if len(rep.LogTail) != 2 || rep.LogTail[0] != "dialing postgres" {
		t.Fatalf("logTail = %v", rep.LogTail)
	}
}

func TestValidationResultSummaryNotFoundIsExplicit(t *testing.T) {
	c, _, _ := withReaders(t, finished(0), []string{"✅ Shorts update complete"})
	rep, err := c.ValidationResult(context.Background(), "shorts-data-sync-v4l1d")
	if !errors.Is(err, ErrSummaryNotFound) {
		t.Fatalf("want ErrSummaryNotFound, got %v", err)
	}
	if rep == nil || rep.Message == "" {
		t.Fatal("the partial report must still travel so an operator can diagnose it")
	}
}

func TestValidationResultRejectsBadExecutionName(t *testing.T) {
	c, _, _ := withReaders(t, finished(0), nil)
	for _, name := range []string{"", "  ", "Bad_Name", strings.Repeat("a", 70), "../../etc/passwd"} {
		if _, err := c.ValidationResult(context.Background(), name); !errors.Is(err, ErrInvalidExecution) {
			t.Fatalf("ValidationResult(%q) must refuse, got %v", name, err)
		}
	}
}

// TestValidationResultUsesOnlyTheLastPathSegment: a caller passing a full
// resource path cannot steer the lookup at another project or region.
func TestValidationResultUsesOnlyTheLastPathSegment(t *testing.T) {
	c, er, _ := withReaders(t, finished(0), []string{ValidationLinePrefix + sampleSummary})
	if _, err := c.ValidationResult(context.Background(),
		"projects/evil/locations/elsewhere/jobs/other/executions/shorts-data-sync-v4l1d"); err != nil {
		t.Fatalf("ValidationResult: %v", err)
	}
	if er.got[0] != "proj" || er.got[1] != "australia-southeast2" || er.got[2] != ValidationJobName {
		t.Fatalf("caller-supplied path leaked into the lookup: %v", er.got)
	}
}

func TestValidationResultLogReadFailureDegrades(t *testing.T) {
	c, _, lr := withReaders(t, finished(0), nil)
	lr.err = errors.New("permission denied on logging.logEntries.list")
	rep, err := c.ValidationResult(context.Background(), "shorts-data-sync-v4l1d")
	if err != nil {
		t.Fatalf("a log-read failure must degrade, not error: %v", err)
	}
	if !strings.Contains(rep.Message, "logs could not be read") {
		t.Fatalf("message = %q", rep.Message)
	}
}

func TestLogFilterIsScopedToOneExecution(t *testing.T) {
	f := logFilter("shorts-data-sync", "shorts-data-sync-v4l1d")
	for _, want := range []string{
		`resource.type="cloud_run_job"`,
		`resource.labels.job_name="shorts-data-sync"`,
		`labels."run.googleapis.com/execution_name"="shorts-data-sync-v4l1d"`,
	} {
		if !strings.Contains(f, want) {
			t.Fatalf("filter %q missing %q", f, want)
		}
	}
}

// TestValidationLinePrefixMatchesTheJob pins the cross-module literal. The job
// side (services/jobs/.../stocks.go) has the mirror of this assertion.
func TestValidationLinePrefixMatchesTheJob(t *testing.T) {
	if ValidationLinePrefix != "SHORTED_VALIDATION_JSON " {
		t.Fatalf("prefix changed to %q — update services/jobs/internal/jobs/shortdatasync/stocks.go too", ValidationLinePrefix)
	}
}

// TestEntryLinesHandlesBothPayloadShapes: a container's stdout arrives as
// textPayload, but a structured sink wraps it in jsonPayload.message.
func TestEntryLinesHandlesBothPayloadShapes(t *testing.T) {
	got := entryLines([]*logging.LogEntry{
		{TextPayload: "plain stdout"},
		{JsonPayload: googleapi.RawMessage(`{"message":"structured message"}`)},
		{JsonPayload: googleapi.RawMessage(`{"other":"raw"}`)},
		nil,
		{},
	})
	if len(got) != 3 {
		t.Fatalf("lines = %v", got)
	}
	if got[0] != "plain stdout" || got[1] != "structured message" || !strings.Contains(got[2], "raw") {
		t.Fatalf("lines = %v", got)
	}
}
