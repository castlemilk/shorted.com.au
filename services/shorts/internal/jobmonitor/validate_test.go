package jobmonitor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

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

// stubArtifactReader stands in for GCS and records the exact key it was asked
// for — the cross-module contract with the job.
type stubArtifactReader struct {
	body   []byte
	err    error
	calls  int
	bucket string
	object string
}

func (s *stubArtifactReader) Object(_ context.Context, bucket, object string) ([]byte, error) {
	s.calls++
	s.bucket, s.object = bucket, object
	return s.body, s.err
}

// testBucket is the configured report bucket in these tests.
const testBucket = "shorted-short-selling-data-test"

func seededValidator(t *testing.T, jobs []JobStatus) (*Collector, *stubOverrideRunner) {
	t.Helper()
	c := NewCollector(Config{ProjectID: "proj", RunRegions: []string{"australia-southeast2"}, ValidationBucket: testBucket})
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

// TestValidationWindowIsOptionalAndBounded covers the one caller-supplied
// NUMBER that reaches the argv. It is rendered by strconv, never echoed, and an
// out-of-range value costs no execution at all.
func TestValidationWindowIsOptionalAndBounded(t *testing.T) {
	// Omitted → the flag is not passed, so the job's own default stands and the
	// existing argv contract is byte-identical.
	c, r := seededValidator(t, fleet())
	if _, err := c.RunValidation(context.Background(), ValidationRequest{Stocks: []string{"BHP"}}); err != nil {
		t.Fatalf("RunValidation: %v", err)
	}
	if strings.Join(r.args, "|") != "short-data-sync|-shadow|-stocks|BHP" {
		t.Fatalf("an omitted window must not add an argument: %v", r.args)
	}

	c2, r2 := seededValidator(t, fleet())
	if _, err := c2.RunValidation(context.Background(), ValidationRequest{Stocks: []string{"BHP"}, Days: 14}); err != nil {
		t.Fatalf("RunValidation: %v", err)
	}
	if strings.Join(r2.args, "|") != "short-data-sync|-shadow|-stocks|BHP|-validate-days|14" {
		t.Fatalf("args = %v", r2.args)
	}
	if r2.args[1] != "-shadow" {
		t.Fatalf("-shadow must still lead, whatever the window: %v", r2.args)
	}

	for _, days := range []int{-1, 31, 1 << 30} {
		c3, r3 := seededValidator(t, fleet())
		if _, err := c3.RunValidation(context.Background(), ValidationRequest{Stocks: []string{"BHP"}, Days: days}); !errors.Is(err, ErrInvalidDays) {
			t.Fatalf("days=%d must fail with ErrInvalidDays, got %v", days, err)
		}
		if r3.args != nil {
			t.Fatalf("days=%d must not create an execution", days)
		}
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

func withReaders(t *testing.T, exec *run.GoogleCloudRunV2Execution, body []byte) (*Collector, *stubExecReader, *stubArtifactReader) {
	t.Helper()
	c, _ := seededValidator(t, fleet())
	er := &stubExecReader{exec: exec}
	ar := &stubArtifactReader{body: body}
	if body == nil {
		ar.err = fmt.Errorf("%w: gs://%s/x", errObjectNotFound, testBucket)
	}
	c.SetExecutionReader(er)
	c.SetArtifactReader(ar)
	return c, er, ar
}

func TestValidationResultStillRunning(t *testing.T) {
	c, _, ar := withReaders(t, &run.GoogleCloudRunV2Execution{StartTime: "2026-08-21T01:00:00Z", RunningCount: 1}, nil)
	rep, err := c.ValidationResult(context.Background(), "shorts-data-sync-v4l1d")
	if err != nil {
		t.Fatalf("ValidationResult: %v", err)
	}
	if rep.Status != "running" || rep.Summary != nil {
		t.Fatalf("report = %+v", rep)
	}
	if ar.calls != 0 {
		t.Fatal("a still-running execution must not cost a bucket read")
	}
}

func TestValidationResultSucceededParsesSummary(t *testing.T) {
	c, er, ar := withReaders(t, finished(0), []byte(sampleSummary))
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
	// The report is read from the configured bucket at the agreed key, never
	// from anywhere the caller could steer.
	if ar.bucket != testBucket || ar.object != "validations/shorts-data-sync-v4l1d.json" {
		t.Fatalf("artifact coordinates = %s/%s", ar.bucket, ar.object)
	}
}

// TestValidationObjectPathMatchesTheJob pins the cross-module contract. The job
// side (services/jobs/.../artifact.go) has the mirror of this assertion.
func TestValidationObjectPathMatchesTheJob(t *testing.T) {
	if ValidationObjectPrefix != "validations/" {
		t.Fatalf("prefix changed to %q — update services/jobs/internal/jobs/shortdatasync/artifact.go too", ValidationObjectPrefix)
	}
	if got := validationObjectPath("shorts-data-sync-v4l1d"); got != "validations/shorts-data-sync-v4l1d.json" {
		t.Fatalf("object path = %q — update the job side too", got)
	}
}

// TestValidationResultRejectsANonReportObject: an object at the right key that
// is not a shadow summary must read as "no report", never as an empty diff.
func TestValidationResultRejectsANonReportObject(t *testing.T) {
	for _, body := range []string{`{"mode":"live","rows":3}`, `not json at all`, ``} {
		c, _, _ := withReaders(t, finished(0), []byte(body))
		if _, err := c.ValidationResult(context.Background(), "shorts-data-sync-v4l1d"); !errors.Is(err, ErrSummaryNotFound) {
			t.Fatalf("body %q must not be accepted as a report, got %v", body, err)
		}
	}
}

func TestValidationResultFailedReportsTheFailure(t *testing.T) {
	c, _, _ := withReaders(t, finished(1), nil)
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
	// A run that died before publishing has no artifact, and that absence must
	// not mask the real failure with a summary_not_found.
	if rep.Summary != nil {
		t.Fatalf("summary = %s", rep.Summary)
	}
}

// TestValidationResultFailedStillAttachesAnArtifact: if the job published a
// report and then failed, the report still travels.
func TestValidationResultFailedStillAttachesAnArtifact(t *testing.T) {
	c, _, _ := withReaders(t, finished(1), []byte(sampleSummary))
	rep, err := c.ValidationResult(context.Background(), "shorts-data-sync-v4l1d")
	if err != nil {
		t.Fatalf("ValidationResult: %v", err)
	}
	if rep.Status != "failed" || rep.Summary == nil {
		t.Fatalf("report = %+v", rep)
	}
}

func TestValidationResultSummaryNotFoundIsExplicit(t *testing.T) {
	c, _, _ := withReaders(t, finished(0), nil)
	rep, err := c.ValidationResult(context.Background(), "shorts-data-sync-v4l1d")
	if !errors.Is(err, ErrSummaryNotFound) {
		t.Fatalf("want ErrSummaryNotFound, got %v", err)
	}
	if rep == nil || rep.Message == "" {
		t.Fatal("the partial report must still travel so an operator can diagnose it")
	}
	// The message must NAME the object that is missing — the whole point of a
	// durable artifact is that an operator can go and look.
	if !strings.Contains(rep.Message, "gs://"+testBucket+"/validations/shorts-data-sync-v4l1d.json") {
		t.Fatalf("message must name the missing artifact: %q", rep.Message)
	}
}

// TestValidationResultWithoutABucketIsNotConfigured: an unset bucket is a
// deployment problem, reported as one, not as a missing report.
func TestValidationResultWithoutABucketIsNotConfigured(t *testing.T) {
	c, _, ar := withReaders(t, finished(0), []byte(sampleSummary))
	c.cfg.ValidationBucket = ""
	if _, err := c.ValidationResult(context.Background(), "shorts-data-sync-v4l1d"); !errors.Is(err, ErrNoBucket) {
		t.Fatalf("want ErrNoBucket, got %v", err)
	}
	if ar.calls != 0 {
		t.Fatal("no bucket read may be attempted without a configured bucket")
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
	c, er, _ := withReaders(t, finished(0), []byte(sampleSummary))
	if _, err := c.ValidationResult(context.Background(),
		"projects/evil/locations/elsewhere/jobs/other/executions/shorts-data-sync-v4l1d"); err != nil {
		t.Fatalf("ValidationResult: %v", err)
	}
	if er.got[0] != "proj" || er.got[1] != "australia-southeast2" || er.got[2] != ValidationJobName {
		t.Fatalf("caller-supplied path leaked into the lookup: %v", er.got)
	}
}

// TestValidationResultArtifactReadFailureDegrades: a permission/transport
// failure is reported alongside the execution state rather than raised — the
// same posture the log reader had.
func TestValidationResultArtifactReadFailureDegrades(t *testing.T) {
	c, _, ar := withReaders(t, finished(0), nil)
	ar.err = errors.New("storage: permission denied on storage.objects.get")
	rep, err := c.ValidationResult(context.Background(), "shorts-data-sync-v4l1d")
	if err != nil {
		t.Fatalf("an artifact-read failure must degrade, not error: %v", err)
	}
	if !strings.Contains(rep.Message, "could not be read") || !strings.Contains(rep.Message, "permission denied") {
		t.Fatalf("message = %q", rep.Message)
	}
}

// TestNoLoggingClientRemains is a guard against re-introducing the retrieval
// path that broke every terraform apply: reading a validation report must
// never require a project-level roles/logging.viewer again.
func TestNoLoggingClientRemains(t *testing.T) {
	src, err := os.ReadFile("validate.go")
	if err != nil {
		t.Fatalf("read validate.go: %v", err)
	}
	for _, banned := range []string{`api/logging/v2`, "logging.NewService", "logEntries.list"} {
		if strings.Contains(string(src), banned) {
			t.Fatalf("validate.go references %q — the report is retrieved from GCS, and a project-level logging grant cannot be applied by the CI deploy service account", banned)
		}
	}
}
