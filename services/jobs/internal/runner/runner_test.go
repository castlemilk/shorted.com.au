package runner

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
)

func testJob(name string, calls *[]string, err error) Job {
	return Func{
		JobName: name,
		Desc:    name + " description",
		Fn: func(ctx context.Context, args []string) error {
			*calls = append(*calls, name+":"+strings.Join(args, ","))
			return err
		},
	}
}

func TestDispatchRunsNamedJobWithRemainingArgs(t *testing.T) {
	var calls []string
	r := NewRegistry(testJob("influence", &calls, nil), testJob("economy", &calls, nil))

	var out bytes.Buffer
	if err := r.Dispatch(context.Background(), "shorted", []string{"influence", "-mode", "tax"}, &out); err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if len(calls) != 1 || calls[0] != "influence:-mode,tax" {
		t.Fatalf("job not invoked with remaining args: %v", calls)
	}
	if !strings.Contains(out.String(), "[job] start name=shorted influence") {
		t.Errorf("missing start line: %q", out.String())
	}
	if !strings.Contains(out.String(), "status=ok") {
		t.Errorf("missing ok end line: %q", out.String())
	}
}

func TestDispatchLogsJobError(t *testing.T) {
	var calls []string
	want := errors.New("boom")
	r := NewRegistry(testJob("influence", &calls, want))

	var out bytes.Buffer
	err := r.Dispatch(context.Background(), "shorted", []string{"influence"}, &out)
	if !errors.Is(err, want) {
		t.Fatalf("want %v, got %v", want, err)
	}
	if !strings.Contains(out.String(), "status=error error=boom") {
		t.Errorf("missing error end line: %q", out.String())
	}
}

func TestDispatchNoArgsPrintsAvailableJobs(t *testing.T) {
	var calls []string
	r := NewRegistry(testJob("influence", &calls, nil), testJob("reports", &calls, nil))

	var out bytes.Buffer
	err := r.Dispatch(context.Background(), "shorted", nil, &out)
	if !errors.Is(err, ErrUsage) {
		t.Fatalf("want ErrUsage, got %v", err)
	}
	for _, want := range []string{"usage: shorted <job>", "influence", "reports", "influence description"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("usage missing %q:\n%s", want, out.String())
		}
	}
	if len(calls) != 0 {
		t.Errorf("no job should have run: %v", calls)
	}
}

func TestDispatchHelpTokenPrintsUsage(t *testing.T) {
	var calls []string
	r := NewRegistry(testJob("influence", &calls, nil))
	for _, arg := range []string{"-h", "--help", "help"} {
		var out bytes.Buffer
		if err := r.Dispatch(context.Background(), "shorted", []string{arg}, &out); !errors.Is(err, ErrUsage) {
			t.Fatalf("%s: want ErrUsage, got %v", arg, err)
		}
		if !strings.Contains(out.String(), "Available jobs:") {
			t.Errorf("%s: missing usage: %q", arg, out.String())
		}
	}
}

func TestDispatchUnknownJob(t *testing.T) {
	var calls []string
	r := NewRegistry(testJob("influence", &calls, nil))

	var out bytes.Buffer
	err := r.Dispatch(context.Background(), "shorted", []string{"nope"}, &out)
	if err == nil || !strings.Contains(err.Error(), `unknown job "nope"`) {
		t.Fatalf("want unknown-job error, got %v", err)
	}
	if !strings.Contains(out.String(), "Available jobs:") {
		t.Errorf("expected usage after unknown job: %q", out.String())
	}
}

func TestGroupDispatchesSubJobs(t *testing.T) {
	var calls []string
	g := NewGroup("reports", "report tools",
		testJob("coverage", &calls, nil),
		testJob("link", &calls, nil),
		testJob("sync", &calls, nil),
	)
	r := NewRegistry(g)

	var out bytes.Buffer
	if err := r.Dispatch(context.Background(), "shorted", []string{"reports", "link", "-crawl"}, &out); err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if len(calls) != 1 || calls[0] != "link:-crawl" {
		t.Fatalf("sub-job not invoked correctly: %v", calls)
	}

	if names := g.Sub().Names(); len(names) != 3 || names[0] != "coverage" || names[2] != "sync" {
		t.Errorf("unexpected sub-job order: %v", names)
	}
}

func TestGroupUnknownSubJob(t *testing.T) {
	var calls []string
	g := NewGroup("reports", "report tools", testJob("coverage", &calls, nil))
	err := g.Run(context.Background(), []string{"nope"})
	if err == nil || !strings.Contains(err.Error(), `unknown reports job "nope"`) {
		t.Fatalf("want unknown sub-job error, got %v", err)
	}
}

func TestGroupNoArgsIsUsage(t *testing.T) {
	g := NewGroup("reports", "report tools")
	if err := g.Run(context.Background(), nil); !errors.Is(err, ErrUsage) {
		t.Fatalf("want ErrUsage, got %v", err)
	}
}

func TestGlobalsRoundTrip(t *testing.T) {
	ctx := WithGlobals(context.Background(), Globals{DryRun: true, Verbose: true})
	g := FromContext(ctx)
	if !g.DryRun || !g.Verbose {
		t.Fatalf("globals lost: %+v", g)
	}
	if empty := FromContext(context.Background()); empty.DryRun || empty.Verbose {
		t.Fatalf("want zero-value globals, got %+v", empty)
	}
}

func TestDuplicateRegistrationPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic on duplicate job name")
		}
	}()
	var calls []string
	NewRegistry(testJob("dup", &calls, nil), testJob("dup", &calls, nil))
}

func TestHelpRequested(t *testing.T) {
	if !HelpRequested([]string{"-mode", "tax", "-h"}) {
		t.Error("-h not detected")
	}
	if HelpRequested([]string{"-mode", "tax"}) {
		t.Error("false positive")
	}
}
