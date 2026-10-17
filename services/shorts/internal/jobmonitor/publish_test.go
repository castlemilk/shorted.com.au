package jobmonitor

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	run "google.golang.org/api/run/v2"
)

// publishFleet is the standard fleet plus an idle shorted-news-publish job.
func publishFleet() []JobStatus {
	return append(fleet(), JobStatus{
		Name: PublishJobName, DisplayName: "News Publish", Type: "job",
		Region: "australia-southeast2", LastRunStatus: "succeeded",
	})
}

func TestNormalizeSlugAccepts(t *testing.T) {
	for _, in := range []string{
		"us-bond-rout-australia-banks-property-shorts",
		"q3-2026-short-rotation-defence-lithium-consumer-covering",
		"  dro-4dx-shorts-into-results  ",
		"a",
	} {
		got, err := NormalizeSlug(in)
		if err != nil {
			t.Fatalf("NormalizeSlug(%q): %v", in, err)
		}
		if got != strings.TrimSpace(in) {
			t.Fatalf("NormalizeSlug(%q) = %q", in, got)
		}
	}
}

func TestNormalizeSlugRejects(t *testing.T) {
	for _, in := range []string{
		"",
		"   ",
		"US-Bond",                // a slug is an identifier: never silently lower-cased
		"--dir=/etc",             // cannot express a flag
		"a --no-validate",        // cannot smuggle a second token
		"../content/news/secret", // cannot express a path
		"a/b",
		"a--b",
		"-leading",
		"trailing-",
		"semi;colon",
		"$(whoami)",
		"line\nbreak",
		strings.Repeat("a", maxSlugLength+1),
	} {
		if _, err := NormalizeSlug(in); !errors.Is(err, ErrInvalidSlug) {
			t.Fatalf("NormalizeSlug(%q) must fail with ErrInvalidSlug, got %v", in, err)
		}
	}
}

// TestPublishArgsAreServerConstructed is the security property in one test:
// the job, region and argv all come from this package, and the caller's slug
// reaches argv only as the value of --slug=.
func TestPublishArgsAreServerConstructed(t *testing.T) {
	c, r := seededValidator(t, publishFleet())
	res, err := c.RunPublish(context.Background(), PublishRequest{
		Slug: "us-bond-rout-australia-banks-property-shorts", Actor: "ben@shorted.com.au",
	})
	if err != nil {
		t.Fatalf("RunPublish: %v", err)
	}
	want := []string{"publish-content", "--slug=us-bond-rout-australia-banks-property-shorts"}
	if strings.Join(r.args, " ") != strings.Join(want, " ") {
		t.Fatalf("argv = %q, want %q", r.args, want)
	}
	if r.job != PublishJobName || r.region != "australia-southeast2" || r.project != "proj" {
		t.Fatalf("ran %s/%s/%s, want proj/australia-southeast2/%s", r.project, r.region, r.job, PublishJobName)
	}
	if res.URL != "https://shorted.com.au/news/us-bond-rout-australia-banks-property-shorts" {
		t.Fatalf("url = %q", res.URL)
	}
	if strings.Join(res.Args, " ") != strings.Join(want, " ") {
		t.Fatalf("echoed args = %q", res.Args)
	}
}

func TestPublishSkipImagesAddsOnlyTheFlag(t *testing.T) {
	c, r := seededValidator(t, publishFleet())
	if _, err := c.RunPublish(context.Background(), PublishRequest{Slug: "a-slug", SkipImages: true}); err != nil {
		t.Fatalf("RunPublish: %v", err)
	}
	if got := strings.Join(r.args, " "); got != "publish-content --slug=a-slug --no-images" {
		t.Fatalf("argv = %q", got)
	}
}

func TestPublishRefusesBadSlugBeforeTouchingGCP(t *testing.T) {
	c, r := seededValidator(t, publishFleet())
	_, err := c.RunPublish(context.Background(), PublishRequest{Slug: "--dir=/"})
	if !errors.Is(err, ErrInvalidSlug) {
		t.Fatalf("err = %v, want ErrInvalidSlug", err)
	}
	if r.args != nil {
		t.Fatalf("runner was called with %q for an invalid slug", r.args)
	}
}

// A publish writes and costs money, so unlike a validation run it refuses to
// start a second execution unless forced.
func TestPublishRefusesWhileRunningUnlessForced(t *testing.T) {
	jobs := publishFleet()
	jobs[len(jobs)-1].LastRunStatus = "running"
	jobs[len(jobs)-1].RunningCount = 1
	jobs[len(jobs)-1].ExecutionName = "shorted-news-publish-x1y2z"
	jobs[len(jobs)-1].LastRunAt = time.Now().UTC().Add(-2 * time.Minute).Format(time.RFC3339)

	c, r := seededValidator(t, jobs)
	_, err := c.RunPublish(context.Background(), PublishRequest{Slug: "a-slug"})
	var running *AlreadyRunningError
	if !errors.As(err, &running) {
		t.Fatalf("err = %v, want AlreadyRunningError", err)
	}
	if running.ExecutionName != "shorted-news-publish-x1y2z" {
		t.Fatalf("running execution = %q", running.ExecutionName)
	}
	if r.args != nil {
		t.Fatal("runner must not be called while a publish is in flight")
	}

	c, r = seededValidator(t, jobs)
	if _, err := c.RunPublish(context.Background(), PublishRequest{Slug: "a-slug", Force: true}); err != nil {
		t.Fatalf("forced RunPublish: %v", err)
	}
	if r.args == nil {
		t.Fatal("force must start the run")
	}
}

func TestPublishRequiresTheJobInTheFleet(t *testing.T) {
	c, _ := seededValidator(t, fleet()) // no shorted-news-publish
	if _, err := c.RunPublish(context.Background(), PublishRequest{Slug: "a-slug"}); !errors.Is(err, ErrUnknownJob) {
		t.Fatalf("err = %v, want ErrUnknownJob", err)
	}
}

func TestPublishResultReportsExecutionState(t *testing.T) {
	c, _ := seededValidator(t, publishFleet())
	reader := &stubExecReader{exec: &run.GoogleCloudRunV2Execution{
		StartTime: "2026-09-25T07:00:00Z", CompletionTime: "2026-09-25T07:04:00Z",
		SucceededCount: 1, LogUri: "https://console.cloud.google.com/logs/x",
	}}
	c.SetExecutionReader(reader)

	st, err := c.PublishResult(context.Background(), "shorted-news-publish-ab12c")
	if err != nil {
		t.Fatalf("PublishResult: %v", err)
	}
	if st.Status != "succeeded" || st.LogUri == "" {
		t.Fatalf("status = %+v", st)
	}
	// The lookup must target the publish job, never a caller-chosen one.
	if reader.got != [4]string{"proj", "australia-southeast2", PublishJobName, "shorted-news-publish-ab12c"} {
		t.Fatalf("reader asked for %v", reader.got)
	}
}

func TestPublishResultCarriesTheFailureReason(t *testing.T) {
	c, _ := seededValidator(t, publishFleet())
	c.SetExecutionReader(&stubExecReader{exec: &run.GoogleCloudRunV2Execution{
		CompletionTime: "2026-09-25T07:04:00Z", FailedCount: 1,
		Conditions: []*run.GoogleCloudRunV2Condition{{State: "CONDITION_FAILED", Message: "Task failed: image generation"}},
	}})
	st, err := c.PublishResult(context.Background(), "shorted-news-publish-ab12c")
	if err != nil {
		t.Fatalf("PublishResult: %v", err)
	}
	if st.Status != "failed" || !strings.Contains(st.Message, "image generation") {
		t.Fatalf("status = %+v", st)
	}
}

func TestPublishResultRejectsTraversal(t *testing.T) {
	c, _ := seededValidator(t, publishFleet())
	if _, err := c.PublishResult(context.Background(), "../../etc/passwd"); !errors.Is(err, ErrInvalidExecution) {
		t.Fatalf("err = %v, want ErrInvalidExecution", err)
	}
}
