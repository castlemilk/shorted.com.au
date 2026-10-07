package jobmonitor

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	cloudscheduler "google.golang.org/api/cloudscheduler/v1"
	"google.golang.org/api/option"
	run "google.golang.org/api/run/v2"
)

type observeTransport func(*http.Request) (*http.Response, error)

func (f observeTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func apiJSON(v any) *http.Response {
	raw, _ := json.Marshal(v)
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(string(raw)))}
}

func TestCollectPaginatesJobsExecutionsAndSchedules(t *testing.T) {
	calls := map[string]int{}
	client := &http.Client{Transport: observeTransport(func(r *http.Request) (*http.Response, error) {
		path := r.URL.Path
		token := r.URL.Query().Get("pageToken")
		calls[path+"?"+token]++
		switch {
		case strings.Contains(path, "/executions"):
			if token == "" {
				return apiJSON(map[string]any{"executions": []map[string]any{{"name": path + "/shorted-news-new", "startTime": "2026-10-07T01:00:00Z", "completionTime": "2026-10-07T01:10:00Z", "succeededCount": 1}}, "nextPageToken": "old"}), nil
			}
			return apiJSON(map[string]any{"executions": []map[string]any{{"name": path + "/shorted-news-old", "startTime": "2026-10-06T01:00:00Z", "runningCount": 2, "taskCount": 3}, {"name": path + "/shorted-news-pending", "createTime": "2026-10-06T02:00:00Z"}}}), nil
		case strings.HasPrefix(path, "/v2/"):
			if token == "" {
				return apiJSON(map[string]any{"jobs": []map[string]any{{"name": "projects/proj/locations/us-central1/jobs/shorted-news"}}, "nextPageToken": "more"}), nil
			}
			return apiJSON(map[string]any{"jobs": []map[string]any{{"name": "projects/proj/locations/us-central1/jobs/asx-discovery"}}}), nil
		default:
			if token == "" {
				return apiJSON(map[string]any{"jobs": []map[string]any{{"name": "projects/proj/locations/us-central1/jobs/shorted-news-daily", "schedule": "0 1 * * *", "state": "ENABLED"}}, "nextPageToken": "more"}), nil
			}
			return apiJSON(map[string]any{"jobs": []map[string]any{{"name": "projects/proj/locations/us-central1/jobs/shorted-news-weekly", "schedule": "0 1 * * 1", "state": "PAUSED"}}}), nil
		}
	})}
	jobs, err := collect(context.Background(), Config{ProjectID: "proj", RunRegions: []string{"us-central1"}, SchedulerRegion: "us-central1"}, option.WithHTTPClient(client))
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 2 {
		t.Fatalf("jobs=%+v calls=%v", jobs, calls)
	}
	for _, j := range jobs {
		if len(j.RunningExecutions) != 2 || j.RunningExecution == "" {
			t.Fatalf("older active executions omitted: %+v", j)
		}
		if j.Name == "shorted-news" && len(j.Triggers) != 2 {
			t.Fatalf("scheduler page omitted: %+v", j)
		}
	}
}
func TestCollectExposesPartialFailureAndCacheKeepsWarning(t *testing.T) {
	client := &http.Client{Transport: observeTransport(func(r *http.Request) (*http.Response, error) {
		if strings.HasPrefix(r.URL.Path, "/v2/") && !strings.Contains(r.URL.Path, "/executions") {
			return apiJSON(map[string]any{"jobs": []map[string]any{{"name": "projects/proj/locations/us-central1/jobs/shorted-news"}}}), nil
		}
		return nil, errors.New("unavailable")
	})}
	jobs, err := collect(context.Background(), Config{ProjectID: "proj", RunRegions: []string{"us-central1"}, SchedulerRegion: "us-central1"}, option.WithHTTPClient(client))
	if err == nil || len(jobs) != 1 || jobs[0].Message == "" {
		t.Fatalf("partial result=%+v err=%v", jobs, err)
	}
	c, _ := seeded(t, jobs)
	c.cachedErr = err
	got, cachedErr := c.Collect(context.Background())
	if cachedErr == nil || len(got) != 1 {
		t.Fatal("cached partial result lost warning")
	}
}
func TestGetJobExecutionCannotEscapeFleet(t *testing.T) {
	c, _ := seeded(t, fleet())
	reader := &stubExecReader{exec: &run.GoogleCloudRunV2Execution{Name: "asx-discovery-abc", CompletionTime: "2026-10-07T00:00:00Z", CancelledCount: 1}}
	c.SetExecutionReader(reader)
	for _, args := range [][3]string{{"unknown", "", "unknown-a"}, {"asx-discovery", "europe-west1", "asx-discovery-a"}, {"asx-discovery", "", "projects/other/locations/us-central1/jobs/asx-discovery/executions/asx-discovery-a"}, {"asx-discovery", "", "shorted-news-a"}} {
		if _, err := c.GetJobExecution(context.Background(), args[0], args[1], args[2]); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
	if reader.got != [4]string{} {
		t.Fatal("invalid request reached GCP")
	}
	out, err := c.GetJobExecution(context.Background(), "asx-discovery", "", "asx-discovery-abc")
	if err != nil || out.Status != "cancelled" || reader.got != [4]string{"proj", "us-central1", "asx-discovery", "asx-discovery-abc"} {
		t.Fatalf("%+v %v %v", out, err, reader.got)
	}
}
func TestReadTargetRequiresRegionForDuplicatesAndAllowsRetired(t *testing.T) {
	c, _ := seeded(t, append(fleet(), JobStatus{Name: "asx-discovery", Type: "job", Region: "australia-southeast2"}))
	if _, err := c.readTarget(context.Background(), "asx-discovery", ""); err == nil {
		t.Fatal("ambiguous name accepted")
	}
	if _, err := c.readTarget(context.Background(), "asx-discovery", "us-central1"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.readTarget(context.Background(), "weekly-report-generator", ""); err != nil {
		t.Fatal("retired history unavailable", err)
	}
}
func TestPendingAndMultipleActiveExecutions(t *testing.T) {
	st := &JobStatus{}
	applyExecutions(st, []*run.GoogleCloudRunV2Execution{
		{Name: "job-pending", CreateTime: time.Now().UTC().Format(time.RFC3339)},
		{Name: "job-running", StartTime: time.Now().Add(-time.Hour).UTC().Format(time.RFC3339), RunningCount: 3},
	})
	if len(st.RunningExecutions) != 2 {
		t.Fatalf("%+v", st)
	}
}

func TestSchedulerTargetsRegionNotDisplayName(t *testing.T) {
	jobs := map[string]*JobStatus{
		"shorted-news":                      {Name: "shorted-news", Type: "job", Region: "us-central1"},
		"australia-southeast2/shorted-news": {Name: "shorted-news", Type: "job", Region: "australia-southeast2"},
	}
	order := []string{"shorted-news", "australia-southeast2/shorted-news"}
	mergeSchedulers(jobs, &order, []*cloudscheduler.Job{{Name: "projects/proj/locations/australia-southeast1/jobs/editorial-daily", State: "ENABLED", Schedule: "0 1 * * *", HttpTarget: &cloudscheduler.HttpTarget{Uri: "https://australia-southeast2-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/proj/jobs/shorted-news:run"}}})
	if len(jobs["shorted-news"].Triggers) != 0 || len(jobs["australia-southeast2/shorted-news"].Triggers) != 1 || len(order) != 2 {
		t.Fatalf("scheduler matched wrong region: %+v", jobs)
	}
}
