package shorts

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/jobmonitor"
)

type fakePublisher struct {
	req     jobmonitor.PublishRequest
	run     *jobmonitor.PublishRun
	runErr  error
	exec    string
	status  *jobmonitor.PublishStatus
	pollErr error
}

func (f *fakePublisher) RunPublish(_ context.Context, req jobmonitor.PublishRequest) (*jobmonitor.PublishRun, error) {
	f.req = req
	return f.run, f.runErr
}

func (f *fakePublisher) PublishResult(_ context.Context, execution string) (*jobmonitor.PublishStatus, error) {
	f.exec = execution
	return f.status, f.pollErr
}

func publishRequest(t *testing.T, p newsPublisher, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	h := adminNewsPublishHandler(log.NewLogger(), p)
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.Header.Set("x-admin-actor", "ben@shorted.com.au")
	w := httptest.NewRecorder()
	h(w, r)
	return w
}

func TestNewsPublishAccepted(t *testing.T) {
	p := &fakePublisher{run: &jobmonitor.PublishRun{
		Job: "shorted-news-publish", Region: "australia-southeast2",
		ExecutionName: "shorted-news-publish-ab12c", Slug: "a-slug",
		Args: []string{"publish-content", "--slug=a-slug"}, URL: "https://shorted.com.au/news/a-slug",
	}}
	w := publishRequest(t, p, http.MethodPost, "/api/admin/news/publish", `{"slug":"a-slug"}`)
	if w.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	if body := decodeBody(t, w); body["executionName"] != "shorted-news-publish-ab12c" {
		t.Fatalf("body = %v", body)
	}
	// Slug forwarded verbatim (jobmonitor is the one place that validates it),
	// images default ON when the field is omitted.
	if p.req.Slug != "a-slug" || p.req.SkipImages || p.req.Force || p.req.Actor != "ben@shorted.com.au" {
		t.Fatalf("forwarded request = %+v", p.req)
	}
}

func TestNewsPublishImagesFalseSkipsImages(t *testing.T) {
	p := &fakePublisher{run: &jobmonitor.PublishRun{}}
	publishRequest(t, p, http.MethodPost, "/api/admin/news/publish", `{"slug":"a-slug","images":false,"force":true}`)
	if !p.req.SkipImages || !p.req.Force {
		t.Fatalf("forwarded request = %+v", p.req)
	}
}

func TestNewsPublishRefusals(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"invalid slug", fmt.Errorf("%w: bad", jobmonitor.ErrInvalidSlug), http.StatusBadRequest, "invalid_slug"},
		{"not deployed", jobmonitor.ErrUnknownJob, http.StatusNotFound, "unknown_job"},
		{"no project", jobmonitor.ErrNoProject, http.StatusServiceUnavailable, "not_configured"},
		{"running", &jobmonitor.AlreadyRunningError{Job: "shorted-news-publish", ExecutionName: "x", Age: time.Minute}, http.StatusConflict, "already_running"},
		{"gcp", fmt.Errorf("403 from run.googleapis.com"), http.StatusBadGateway, "publish_failed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := publishRequest(t, &fakePublisher{runErr: tc.err}, http.MethodPost, "/api/admin/news/publish", `{"slug":"a"}`)
			if w.Code != tc.status {
				t.Fatalf("status = %d, want %d (%s)", w.Code, tc.status, w.Body.String())
			}
			if body := decodeBody(t, w); body["error"] != tc.code {
				t.Fatalf("error = %v, want %s", body["error"], tc.code)
			}
		})
	}
}

func TestNewsPublishRejectsNonJSON(t *testing.T) {
	w := publishRequest(t, &fakePublisher{}, http.MethodPost, "/api/admin/news/publish", `slug=a`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", w.Code)
	}
}

func TestNewsPublishPoll(t *testing.T) {
	p := &fakePublisher{status: &jobmonitor.PublishStatus{ExecutionName: "shorted-news-publish-ab12c", Status: "succeeded"}}
	w := publishRequest(t, p, http.MethodGet, "/api/admin/news/publish?execution=shorted-news-publish-ab12c", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if body := decodeBody(t, w); body["status"] != "succeeded" || p.exec != "shorted-news-publish-ab12c" {
		t.Fatalf("body = %v, exec = %q", body, p.exec)
	}
}

func TestNewsPublishPollRequiresExecution(t *testing.T) {
	w := publishRequest(t, &fakePublisher{}, http.MethodGet, "/api/admin/news/publish", "")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", w.Code)
	}
}
