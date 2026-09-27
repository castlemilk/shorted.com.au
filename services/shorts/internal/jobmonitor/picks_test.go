package jobmonitor

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	run "google.golang.org/api/run/v2"
)

// picksFleet is the standard fleet plus an idle shorted-picks job.
func picksFleet() []JobStatus {
	return append(fleet(), JobStatus{
		Name: PicksJobName, DisplayName: "Stock Picker Data", Type: "job",
		Region: "australia-southeast2", LastRunStatus: "succeeded",
	})
}

func TestNormalizePicksModeAcceptsEveryModeTheJobParses(t *testing.T) {
	for _, in := range []string{"fundamentals", "filings", "refresh", "all", " Refresh ", "ALL"} {
		got, err := NormalizePicksMode(in)
		if err != nil {
			t.Fatalf("NormalizePicksMode(%q): %v", in, err)
		}
		if string(got) != strings.ToLower(strings.TrimSpace(in)) {
			t.Fatalf("NormalizePicksMode(%q) = %q", in, got)
		}
	}
}

func TestNormalizePicksModeRejects(t *testing.T) {
	for _, in := range []string{
		"",
		"   ",
		"fundamental",        // not a prefix match
		"refresh -codes BHP", // cannot smuggle a second token
		"-mode=refresh",      // cannot express a flag
		"all;rm -rf /",
		"dry-run", // the job's -dry-run flag is not a mode and is not reachable here
	} {
		if _, err := NormalizePicksMode(in); !errors.Is(err, ErrInvalidPicksMode) {
			t.Fatalf("NormalizePicksMode(%q) must fail with ErrInvalidPicksMode, got %v", in, err)
		}
	}
}

// TestPicksArgsAreServerConstructed is the security property in one test: the
// job, region and argv all come from this package, and the caller's mode
// reaches argv only as the value of -mode, and only after matching the enum.
func TestPicksArgsAreServerConstructed(t *testing.T) {
	c, r := seededValidator(t, picksFleet())
	res, err := c.RunPicks(context.Background(), PicksRequest{Mode: "fundamentals", Actor: "oauth:uid-admin"})
	if err != nil {
		t.Fatalf("RunPicks: %v", err)
	}
	want := []string{"picks", "-mode", "fundamentals"}
	if strings.Join(r.args, " ") != strings.Join(want, " ") {
		t.Fatalf("argv = %q, want %q", r.args, want)
	}
	if r.job != PicksJobName || r.region != "australia-southeast2" || r.project != "proj" {
		t.Fatalf("ran %s/%s/%s, want proj/australia-southeast2/%s", r.project, r.region, r.job, PicksJobName)
	}
	if res.Mode != PicksModeFundamentals || strings.Join(res.Args, " ") != strings.Join(want, " ") {
		t.Fatalf("result = %+v", res)
	}
}

func TestPicksRefusesBadModeBeforeTouchingGCP(t *testing.T) {
	c, r := seededValidator(t, picksFleet())
	_, err := c.RunPicks(context.Background(), PicksRequest{Mode: "refresh -codes BHP"})
	if !errors.Is(err, ErrInvalidPicksMode) {
		t.Fatalf("err = %v, want ErrInvalidPicksMode", err)
	}
	if r.args != nil {
		t.Fatalf("runner was called with %q for an invalid mode", r.args)
	}
}

// Every mode writes, so a second execution is refused unless forced.
func TestPicksRefusesWhileRunningUnlessForced(t *testing.T) {
	jobs := picksFleet()
	jobs[len(jobs)-1].LastRunStatus = "running"
	jobs[len(jobs)-1].RunningCount = 1
	jobs[len(jobs)-1].ExecutionName = "shorted-picks-x1y2z"
	jobs[len(jobs)-1].LastRunAt = time.Now().UTC().Add(-20 * time.Minute).Format(time.RFC3339)

	c, r := seededValidator(t, jobs)
	_, err := c.RunPicks(context.Background(), PicksRequest{Mode: "refresh"})
	var running *AlreadyRunningError
	if !errors.As(err, &running) {
		t.Fatalf("err = %v, want AlreadyRunningError", err)
	}
	if running.ExecutionName != "shorted-picks-x1y2z" {
		t.Fatalf("running execution = %q", running.ExecutionName)
	}
	if r.args != nil {
		t.Fatal("runner must not be called while a picks run is in flight")
	}

	c, r = seededValidator(t, jobs)
	if _, err := c.RunPicks(context.Background(), PicksRequest{Mode: "refresh", Force: true}); err != nil {
		t.Fatalf("forced RunPicks: %v", err)
	}
	if r.args == nil {
		t.Fatal("force must start the run")
	}
}

func TestPicksRequiresTheJobInTheFleet(t *testing.T) {
	c, _ := seededValidator(t, fleet()) // no shorted-picks
	if _, err := c.RunPicks(context.Background(), PicksRequest{Mode: "all"}); !errors.Is(err, ErrUnknownJob) {
		t.Fatalf("err = %v, want ErrUnknownJob", err)
	}
}

// A Runner that cannot override is refused, not silently downgraded to a bare
// run — a bare run would execute the deployed refresh under a caller who asked
// for fundamentals.
func TestPicksRefusesARunnerWithoutOverrides(t *testing.T) {
	c, _ := seeded(t, picksFleet()) // stubRunner: Run only
	if _, err := c.RunPicks(context.Background(), PicksRequest{Mode: "fundamentals"}); !errors.Is(err, ErrOverridesUnsupported) {
		t.Fatalf("err = %v, want ErrOverridesUnsupported", err)
	}
}

func TestPicksResultTargetsThePicksJob(t *testing.T) {
	c, _ := seededValidator(t, picksFleet())
	reader := &stubExecReader{exec: &run.GoogleCloudRunV2Execution{
		StartTime: "2026-09-27T10:00:00Z", CompletionTime: "2026-09-27T10:31:00Z",
		SucceededCount: 1, LogUri: "https://console.cloud.google.com/logs/x",
	}}
	c.SetExecutionReader(reader)

	st, err := c.PicksResult(context.Background(), "shorted-picks-ab12c")
	if err != nil {
		t.Fatalf("PicksResult: %v", err)
	}
	if st.Status != "succeeded" || st.LogUri == "" {
		t.Fatalf("status = %+v", st)
	}
	// The lookup must target the picks job, never a caller-chosen one.
	if reader.got != [4]string{"proj", "australia-southeast2", PicksJobName, "shorted-picks-ab12c"} {
		t.Fatalf("reader asked for %v", reader.got)
	}
}

func TestPicksResultCarriesTheFailureReasonAndRejectsTraversal(t *testing.T) {
	c, _ := seededValidator(t, picksFleet())
	c.SetExecutionReader(&stubExecReader{exec: &run.GoogleCloudRunV2Execution{
		CompletionTime: "2026-09-27T10:31:00Z", FailedCount: 1,
		Conditions: []*run.GoogleCloudRunV2Condition{{State: "CONDITION_FAILED", Message: "Task failed: exit 10"}},
	}})
	st, err := c.PicksResult(context.Background(), "shorted-picks-ab12c")
	if err != nil {
		t.Fatalf("PicksResult: %v", err)
	}
	if st.Status != "failed" || !strings.Contains(st.Message, "exit 10") {
		t.Fatalf("status = %+v", st)
	}
	if _, err := c.PicksResult(context.Background(), "../../etc/passwd"); !errors.Is(err, ErrInvalidExecution) {
		t.Fatalf("err = %v, want ErrInvalidExecution", err)
	}
}
