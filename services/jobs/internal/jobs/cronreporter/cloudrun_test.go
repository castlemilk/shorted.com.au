package cronreporter

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeLister struct {
	execs map[string][]execution // "region/job" -> executions
	err   map[string]error
	calls map[string]int
}

func (f *fakeLister) ListExecutions(_ context.Context, _ string, region, job string) ([]execution, error) {
	k := region + "/" + job
	if f.calls == nil {
		f.calls = map[string]int{}
	}
	f.calls[k]++
	if err := f.err[k]; err != nil {
		return nil, err
	}
	return f.execs[k], nil
}

// ex builds an execution from compact JSON, the shape the API returns.
func ex(t *testing.T, js string) execution {
	t.Helper()
	var e execution
	if err := json.Unmarshal([]byte(js), &e); err != nil {
		t.Fatal(err)
	}
	return e
}

const base = "2026-09-30T10:00:00Z"

func watcherFor(monitors []CloudRunMonitor, lister executionLister, s *fakeSender) *cloudRunWatcher {
	urls := map[string]string{}
	for _, m := range monitors {
		urls[m.Key] = "https://api.telesis.dev/v1/cron/" + m.Key
	}
	w := newCloudRunWatcher(&cloudRunConfig{Project: "p", Monitors: monitors}, lister, s, staticURLs(urls), 3*time.Hour, false)
	w.now = func() time.Time { return time.Date(2026, 9, 30, 11, 0, 0, 0, time.UTC) }
	return w
}

var weekly = []CloudRunMonitor{
	{Key: "shorted-weekly-report", Job: "shorted-weekly-report", Region: "r", Args: []string{"weekly-report"}, Env: map[string]string{"REPORT_TYPE": ""}},
	{Key: "shorted-weekly-report-monthly", Job: "shorted-weekly-report", Region: "r", Args: []string{"weekly-report"}, Env: map[string]string{"REPORT_TYPE": "monthly"}},
}

func TestAnEnvOverrideRoutesARunToItsOwnMonitor(t *testing.T) {
	plain := ex(t, `{"name":"projects/p/locations/r/jobs/shorted-weekly-report/executions/w-1","createTime":"`+base+`","startTime":"`+base+`","completionTime":"2026-09-30T10:05:00Z","succeededCount":1,"taskCount":1,
		"conditions":[{"type":"Completed","state":"CONDITION_SUCCEEDED"}],"template":{"containers":[{"args":["weekly-report"],"env":[{"name":"ENVIRONMENT","value":"production"}]}]}}`)
	monthly := ex(t, `{"name":"projects/p/locations/r/jobs/shorted-weekly-report/executions/w-2","createTime":"`+base+`","startTime":"`+base+`","completionTime":"2026-09-30T10:07:00Z","succeededCount":1,"taskCount":1,
		"conditions":[{"type":"Completed","state":"CONDITION_SUCCEEDED"}],"template":{"containers":[{"args":["weekly-report"],"env":[{"name":"REPORT_TYPE","value":"monthly"}]}]}}`)
	l := &fakeLister{execs: map[string][]execution{"r/shorted-weekly-report": {plain, monthly}}}
	s := &fakeSender{}
	if err := watcherFor(weekly, l, s).reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, c := range s.sent {
		got[c.c.RunID] = c.url[strings.LastIndex(c.url, "/")+1:] + ":" + c.c.State
	}
	if got["w-1"] != "shorted-weekly-report:complete" || got["w-2"] != "shorted-weekly-report-monthly:complete" {
		t.Fatalf("routing wrong: %v", got)
	}
	if l.calls["r/shorted-weekly-report"] != 1 {
		t.Fatalf("a job backing two monitors must be listed once per tick, got %d", l.calls["r/shorted-weekly-report"])
	}
}

func TestAnAdHocOverrideIsNotAScheduledRun(t *testing.T) {
	m := []CloudRunMonitor{{Key: "shorted-price-sync", Job: "shorted-price-sync", Region: "r", Args: []string{"market-data", "sync"}}}
	refetch := ex(t, `{"name":"x/executions/p-9","createTime":"`+base+`","completionTime":"2026-09-30T10:30:00Z","failedCount":1,"taskCount":1,
		"conditions":[{"type":"Completed","state":"CONDITION_FAILED","message":"boom"}],"template":{"containers":[{"args":["market-data","sync","-from","2026-01-01"]}]}}`)
	s := &fakeSender{}
	_ = watcherFor(m, &fakeLister{execs: map[string][]execution{"r/shorted-price-sync": {refetch}}}, s).reconcile(context.Background())
	if len(s.sent) != 0 {
		t.Fatalf("an operator re-fetch must not page the scheduled monitor: %+v", s.sent)
	}
}

func TestAFailedExecutionCarriesItsReasonAndLogLink(t *testing.T) {
	m := []CloudRunMonitor{{Key: "shorts-data-sync", Job: "shorts-data-sync", Region: "r", Args: []string{"short-data-sync"}}}
	failed := ex(t, `{"name":"x/executions/s-1","createTime":"`+base+`","startTime":"`+base+`","completionTime":"2026-09-30T10:20:00Z","failedCount":1,"retriedCount":1,"taskCount":1,
		"logUri":"https://console.cloud.google.com/logs/viewer?x","conditions":[{"type":"Completed","state":"CONDITION_FAILED","message":"Task s-1-task0 failed with message: The container exited with an error."}],
		"template":{"containers":[{"args":["short-data-sync"]}]}}`)
	s := &fakeSender{}
	_ = watcherFor(m, &fakeLister{execs: map[string][]execution{"r/shorts-data-sync": {failed}}}, s).reconcile(context.Background())
	if len(s.sent) != 1 || s.sent[0].c.State != stateFail {
		t.Fatalf("want one fail, got %+v", s.sent)
	}
	c := s.sent[0].c
	if !strings.Contains(c.TerminalReason, "container exited with an error") || !strings.Contains(c.Diagnostic, "console.cloud.google.com") {
		t.Fatalf("fail check-in lacks reason/log link: %+v", c)
	}
	if c.DurationMs != (20 * time.Minute).Milliseconds() || c.IdempotencyKey != "cloudrun:s-1:fail" {
		t.Fatalf("duration/idempotency wrong: %+v", c)
	}
}

func TestRunningStartsOnceQueuedNotAtAllOldIgnored(t *testing.T) {
	m := []CloudRunMonitor{{Key: "k", Job: "j", Region: "r"}}
	running := ex(t, `{"name":"x/executions/j-run","createTime":"`+base+`","startTime":"`+base+`","runningCount":1,"taskCount":1,"template":{"containers":[{}]}}`)
	queued := ex(t, `{"name":"x/executions/j-q","createTime":"`+base+`","taskCount":1,"template":{"containers":[{}]}}`)
	old := ex(t, `{"name":"x/executions/j-old","createTime":"2026-09-29T01:00:00Z","startTime":"2026-09-29T01:00:00Z","completionTime":"2026-09-29T01:05:00Z","succeededCount":1,"taskCount":1,"template":{"containers":[{}]}}`)
	s := &fakeSender{}
	w := watcherFor(m, &fakeLister{execs: map[string][]execution{"r/j": {running, queued, old}}}, s)
	for i := 0; i < 3; i++ {
		_ = w.reconcile(context.Background())
	}
	if len(s.sent) != 1 || s.sent[0].c.State != stateStart || s.sent[0].c.RunID != "j-run" {
		t.Fatalf("want exactly one start for the running execution, got %+v", s.sent)
	}
}

func TestATransientSendFailureIsRetriedAndAListingErrorSparesOtherJobs(t *testing.T) {
	ms := []CloudRunMonitor{{Key: "a", Job: "a", Region: "r"}, {Key: "b", Job: "b", Region: "r"}}
	done := ex(t, `{"name":"x/executions/b-1","createTime":"`+base+`","startTime":"`+base+`","completionTime":"2026-09-30T10:01:00Z","succeededCount":1,"taskCount":1,"conditions":[{"type":"Completed","state":"CONDITION_SUCCEEDED"}],"template":{"containers":[{}]}}`)
	l := &fakeLister{execs: map[string][]execution{"r/b": {done}}, err: map[string]error{"r/a": errors.New("403 permission denied")}}
	s := &fakeSender{err: errors.New("dial tcp: timeout")}
	w := watcherFor(ms, l, s)
	if err := w.reconcile(context.Background()); err == nil {
		t.Fatal("a listing error must be returned")
	}
	s.err = nil
	_ = w.reconcile(context.Background())
	if len(s.sent) != 1 || s.sent[0].c.RunID != "b-1" {
		t.Fatalf("job b must be reported despite job a failing, after the transient retry: %+v", s.sent)
	}
	if st := w.status(); !strings.Contains(st["last_error"].(string), "403") {
		t.Fatalf("status should surface the listing error: %v", st)
	}
}

func TestCloudRunAPIPathAndDecode(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path + "?" + r.URL.RawQuery
		_, _ = w.Write([]byte(`{"executions":[{"name":"projects/p/locations/us-central1/jobs/asx-discovery/executions/a-1","createTime":"` + base + `"}]}`))
	}))
	defer srv.Close()
	api := &cloudRunAPI{client: srv.Client(), base: srv.URL + "/v2"}
	got, err := api.ListExecutions(context.Background(), "p", "us-central1", "asx-discovery")
	if err != nil || len(got) != 1 || got[0].shortName() != "a-1" {
		t.Fatalf("decode: %v %+v", err, got)
	}
	if gotPath != "/v2/projects/p/locations/us-central1/jobs/asx-discovery/executions?pageSize=10" {
		t.Fatalf("path %q", gotPath)
	}
}

func TestLoadCloudRunConfigValidates(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "c.json")
	_ = os.WriteFile(p, []byte(`{"project":"p","monitors":[{"key":"k","job":"","region":"r"}]}`), 0o600)
	if _, err := loadCloudRunConfig(p); err == nil {
		t.Fatal("a monitor without a job must be rejected")
	}
	_ = os.WriteFile(p, []byte(`{"project":"p","monitors":[{"key":"k","job":"j","region":"r","args":["x"]}]}`), 0o600)
	if c, err := loadCloudRunConfig(p); err != nil || len(c.Monitors) != 1 {
		t.Fatalf("valid config rejected: %v", err)
	}
}
