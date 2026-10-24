package jobmonitor

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	run "google.golang.org/api/run/v2"
)

// alertsFleet is the standard fleet plus an idle shorted-alerts-replay job.
func alertsFleet() []JobStatus {
	return append(fleet(), JobStatus{
		Name: AlertsReplayJobName, DisplayName: "Alerts Replay", Type: "job",
		Region: "australia-southeast2", LastRunStatus: "succeeded",
	})
}

var alertsToday = time.Date(2026, 10, 24, 9, 0, 0, 0, time.UTC)

func TestNormalizeAlertsReplayDateAcceptsARealPastDay(t *testing.T) {
	for _, in := range []string{"2026-10-24", "2026-10-23", "2026-02-28", "2024-02-29"} {
		got, err := NormalizeAlertsReplayDate(in, alertsToday)
		if err != nil {
			t.Fatalf("NormalizeAlertsReplayDate(%q): %v", in, err)
		}
		if got != in {
			t.Fatalf("got %q, want %q", got, in)
		}
	}
}

func TestNormalizeAlertsReplayDateRefusesShapeCalendarAndFuture(t *testing.T) {
	cases := map[string]string{
		"":                 "shape",
		"2026-1-5":         "shape",
		" 2026-10-23":      "shape",
		"2026-10-23 ":      "shape",
		"2026/10/23":       "shape",
		"23-10-2026":       "shape",
		"2026-10-23T00:00": "shape",
		"2026-02-30":       "calendar",
		"2026-13-01":       "calendar",
		"2026-10-25":       "future",
		"2027-01-01":       "future",
	}
	for in, want := range cases {
		_, err := NormalizeAlertsReplayDate(in, alertsToday)
		if !errors.Is(err, ErrInvalidAlertsDate) {
			t.Fatalf("NormalizeAlertsReplayDate(%q) = %v, want ErrInvalidAlertsDate (%s)", in, err, want)
		}
	}
}

func TestNormalizeAlertsUserIDRefusesFlagsAndInjection(t *testing.T) {
	for _, in := range []string{"", "-abc", "--canary", "a b", "uid;rm", "$(whoami)", "uid\nx", strings.Repeat("a", 129)} {
		if _, err := NormalizeAlertsUserID(in); !errors.Is(err, ErrInvalidAlertsUser) {
			t.Fatalf("NormalizeAlertsUserID(%q) = %v, want ErrInvalidAlertsUser", in, err)
		}
	}
	for _, in := range []string{"uid-admin", "Ab3_x-9", "a"} {
		if got, err := NormalizeAlertsUserID(in); err != nil || got != in {
			t.Fatalf("NormalizeAlertsUserID(%q) = %q, %v", in, got, err)
		}
	}
}

// The exact argv. A change to this list is a change to what production runs.
func TestAlertsReplayArgsAreExact(t *testing.T) {
	got := strings.Join(alertsReplayArgs("2026-10-23", "uid-admin"), " ")
	want := "alerts -date 2026-10-23 -user uid-admin -canary off"
	if got != want {
		t.Fatalf("argv = %q, want %q", got, want)
	}
}

func TestRunAlertsReplayRunsTheFixedJobWithTheServerArgv(t *testing.T) {
	c, r := seededValidator(t, alertsFleet())
	// seededValidator uses the real clock for "today"; use a date that is past.
	res, err := c.RunAlertsReplay(context.Background(), AlertsReplayRequest{Date: "2026-01-05", UserID: "uid-admin", Actor: "oauth:uid-admin"})
	if err != nil {
		t.Fatalf("RunAlertsReplay: %v", err)
	}
	want := "alerts -date 2026-01-05 -user uid-admin -canary off"
	if strings.Join(r.args, " ") != want {
		t.Fatalf("argv = %q, want %q", r.args, want)
	}
	if r.job != AlertsReplayJobName || r.region != "australia-southeast2" || r.project != "proj" {
		t.Fatalf("ran %s/%s/%s, want proj/australia-southeast2/%s", r.project, r.region, r.job, AlertsReplayJobName)
	}
	if res.Date != "2026-01-05" || res.ExecutionName == "" {
		t.Fatalf("result = %+v", res)
	}
}

func TestRunAlertsReplayRefusesBeforeGCP(t *testing.T) {
	for _, req := range []AlertsReplayRequest{
		{Date: "2026-1-5", UserID: "uid-admin"},
		{Date: "2099-01-01", UserID: "uid-admin"},
		{Date: "2026-01-05", UserID: "-x"},
		{Date: "2026-01-05", UserID: ""},
	} {
		c, r := seededValidator(t, alertsFleet())
		if _, err := c.RunAlertsReplay(context.Background(), req); err == nil {
			t.Fatalf("RunAlertsReplay(%+v) must refuse", req)
		}
		if r.args != nil {
			t.Fatalf("runner was called with %q for %+v", r.args, req)
		}
	}
}

func TestRunAlertsReplayRefusesWhileRunningUnlessForcedElsewhere(t *testing.T) {
	jobs := alertsFleet()
	jobs[len(jobs)-1].LastRunStatus = "running"
	jobs[len(jobs)-1].RunningCount = 1
	jobs[len(jobs)-1].ExecutionName = "shorted-alerts-replay-x1y2z"
	jobs[len(jobs)-1].LastRunAt = time.Now().UTC().Add(-5 * time.Minute).Format(time.RFC3339)

	c, r := seededValidator(t, jobs)
	_, err := c.RunAlertsReplay(context.Background(), AlertsReplayRequest{Date: "2026-01-05", UserID: "uid-admin"})
	var running *AlreadyRunningError
	if !errors.As(err, &running) || running.ExecutionName != "shorted-alerts-replay-x1y2z" {
		t.Fatalf("err = %v, want AlreadyRunningError naming the in-flight execution", err)
	}
	if r.args != nil {
		t.Fatal("runner must not be called while a replay is in flight")
	}
}

func TestRunAlertsReplayRequiresTheJobInTheFleetAndOverrides(t *testing.T) {
	c, _ := seededValidator(t, fleet()) // no shorted-alerts-replay
	if _, err := c.RunAlertsReplay(context.Background(), AlertsReplayRequest{Date: "2026-01-05", UserID: "uid-admin"}); !errors.Is(err, ErrUnknownJob) {
		t.Fatalf("err = %v, want ErrUnknownJob", err)
	}
	c, _ = seeded(t, alertsFleet()) // stubRunner: Run only
	if _, err := c.RunAlertsReplay(context.Background(), AlertsReplayRequest{Date: "2026-01-05", UserID: "uid-admin"}); !errors.Is(err, ErrOverridesUnsupported) {
		t.Fatalf("err = %v, want ErrOverridesUnsupported", err)
	}
}

func TestAlertsReplayResultTargetsTheReplayJob(t *testing.T) {
	c, _ := seededValidator(t, alertsFleet())
	reader := &stubExecReader{exec: &run.GoogleCloudRunV2Execution{
		StartTime: "2026-01-05T10:00:00Z", CompletionTime: "2026-01-05T10:02:00Z", SucceededCount: 1,
	}}
	c.SetExecutionReader(reader)
	st, err := c.AlertsReplayResult(context.Background(), "shorted-alerts-replay-ab12c")
	if err != nil {
		t.Fatalf("AlertsReplayResult: %v", err)
	}
	if st.Status != "succeeded" {
		t.Fatalf("status = %+v", st)
	}
	if reader.got != [4]string{"proj", "australia-southeast2", AlertsReplayJobName, "shorted-alerts-replay-ab12c"} {
		t.Fatalf("reader asked for %v", reader.got)
	}
	if _, err := c.AlertsReplayResult(context.Background(), "../x"); !errors.Is(err, ErrInvalidExecution) {
		t.Fatalf("err = %v, want ErrInvalidExecution", err)
	}
}
