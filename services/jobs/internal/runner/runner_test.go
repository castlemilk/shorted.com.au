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
		DryRun:  true,
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
	for _, arg := range []string{"-h", "--help", "help"} {
		t.Run(arg, func(t *testing.T) {
			var calls []string
			r := NewRegistry(testJob("influence", &calls, nil))
			var out bytes.Buffer
			if err := r.Dispatch(context.Background(), "shorted", []string{arg}, &out); !errors.Is(err, ErrUsage) {
				t.Fatalf("want ErrUsage, got %v", err)
			}
			if !strings.Contains(out.String(), "Available jobs:") {
				t.Errorf("missing usage: %q", out.String())
			}
		})
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
	// Wrapped in ErrUsage so main exits 2 WITHOUT reprinting what the runner
	// already wrote.
	if !errors.Is(err, ErrUsage) {
		t.Errorf("unknown job should wrap ErrUsage, got %v", err)
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

// The sub-job name must survive into the log line, and exactly one start/end
// pair may be emitted for the whole invocation.
func TestGroupLogsLeafJobName(t *testing.T) {
	var calls []string
	g := NewGroup("reports", "report tools", testJob("coverage", &calls, nil))
	r := NewRegistry(g)

	var out bytes.Buffer
	if err := r.Dispatch(context.Background(), "shorted", []string{"reports", "coverage"}, &out); err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	got := out.String()
	if !strings.Contains(got, "[job] start name=shorted reports coverage") {
		t.Errorf("leaf name lost from start line: %q", got)
	}
	if !strings.Contains(got, "[job] done name=shorted reports coverage") {
		t.Errorf("leaf name lost from end line: %q", got)
	}
	if n := strings.Count(got, "[job] start"); n != 1 {
		t.Errorf("want exactly 1 start line, got %d:\n%s", n, got)
	}
	if n := strings.Count(got, "[job] done"); n != 1 {
		t.Errorf("want exactly 1 done line, got %d:\n%s", n, got)
	}
}

func TestGroupDispatchWritesUsageToProvidedWriter(t *testing.T) {
	var calls []string
	g := NewGroup("reports", "report tools", testJob("coverage", &calls, nil))
	r := NewRegistry(g)

	var out bytes.Buffer
	err := r.Dispatch(context.Background(), "shorted", []string{"reports"}, &out)
	if !errors.Is(err, ErrUsage) {
		t.Fatalf("want ErrUsage, got %v", err)
	}
	if !strings.Contains(out.String(), "usage: shorted reports <job>") {
		t.Errorf("group usage not written to the dispatch writer: %q", out.String())
	}
}

func TestGroupUnknownSubJob(t *testing.T) {
	var calls []string
	g := NewGroup("reports", "report tools", testJob("coverage", &calls, nil))
	err := g.Run(context.Background(), []string{"nope"})
	if err == nil || !strings.Contains(err.Error(), `unknown job "nope"`) {
		t.Fatalf("want unknown sub-job error, got %v", err)
	}
	if !errors.Is(err, ErrUsage) {
		t.Errorf("unknown sub-job should wrap ErrUsage, got %v", err)
	}
}

func TestGroupNoArgsIsUsage(t *testing.T) {
	g := NewGroup("reports", "report tools")
	if err := g.Run(context.Background(), nil); !errors.Is(err, ErrUsage) {
		t.Fatalf("want ErrUsage, got %v", err)
	}
}

// A global -dry-run must fail fast against a job that cannot honour it, rather
// than letting the job write.
func TestDispatchRefusesGlobalDryRunOnUnsupportedJob(t *testing.T) {
	var calls []string
	writer := Func{
		JobName: "influence",
		Desc:    "always writes",
		Fn: func(ctx context.Context, args []string) error {
			calls = append(calls, "ran")
			return nil
		},
	}
	r := NewRegistry(writer)

	ctx := WithGlobals(context.Background(), Globals{DryRun: true})
	var out bytes.Buffer
	err := r.Dispatch(ctx, "shorted", []string{"influence"}, &out)
	if err == nil || !strings.Contains(err.Error(), "does not support -dry-run") {
		t.Fatalf("want dry-run refusal, got %v", err)
	}
	if len(calls) != 0 {
		t.Fatalf("job ran despite unsupported -dry-run: %v", calls)
	}
	if strings.Contains(out.String(), "[job] start") {
		t.Errorf("refusal should precede the job start line: %q", out.String())
	}
}

func TestDispatchAllowsGlobalDryRunOnSupportingJob(t *testing.T) {
	var calls []string
	r := NewRegistry(testJob("coverage", &calls, nil))

	ctx := WithGlobals(context.Background(), Globals{DryRun: true})
	var out bytes.Buffer
	if err := r.Dispatch(ctx, "shorted", []string{"coverage"}, &out); err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if len(calls) != 1 {
		t.Fatalf("dry-run-aware job should have run: %v", calls)
	}
}

// The enforcement must reach through a Group to the leaf sub-job.
func TestGroupDryRunEnforcementReachesLeaf(t *testing.T) {
	var calls []string
	leaf := Func{
		JobName: "sync",
		Desc:    "always writes",
		Fn: func(ctx context.Context, args []string) error {
			calls = append(calls, "ran")
			return nil
		},
	}
	r := NewRegistry(NewGroup("reports", "report tools", leaf))

	ctx := WithGlobals(context.Background(), Globals{DryRun: true})
	var out bytes.Buffer
	err := r.Dispatch(ctx, "shorted", []string{"reports", "sync"}, &out)
	if err == nil || !strings.Contains(err.Error(), `job "shorted reports sync" does not support -dry-run`) {
		t.Fatalf("want leaf dry-run refusal, got %v", err)
	}
	if len(calls) != 0 {
		t.Fatalf("leaf ran despite unsupported -dry-run: %v", calls)
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

// TestExitCodeOfOrdinaryError — the default contract: any error is exit 1.
func TestExitCodeOfOrdinaryError(t *testing.T) {
	if got := ExitCodeOf(nil); got != 0 {
		t.Fatalf("nil → %d, want 0", got)
	}
	if got := ExitCodeOf(errors.New("boom")); got != 1 {
		t.Fatalf("plain error → %d, want 1", got)
	}
	// A zero code is not a "successful error" — it degrades to 1.
	if got := ExitCodeOf(&ExitCodeError{Code: 0, Err: errors.New("boom")}); got != 1 {
		t.Fatalf("zero-code ExitCodeError → %d, want 1", got)
	}
}

// TestExitCodeErrorSurvivesDispatch is the end-to-end exit-code demonstration:
// a job returns *ExitCodeError, the runner still logs its normal
// `status=error` end line (so nothing is skipped the way os.Exit would), the
// error reaches the caller wrapped, and main's ExitCodeOf recovers the exact
// code the external caller branches on. `shorted house-prices -mode warmcheck`
// → 5 is exactly this path.
func TestExitCodeErrorSurvivesDispatch(t *testing.T) {
	cleanedUp := false
	job := Func{
		JobName: "house-prices",
		Desc:    "exit-code carrier",
		Fn: func(ctx context.Context, args []string) error {
			defer func() { cleanedUp = true }() // stands in for pool.Close()
			return &ExitCodeError{Code: 5, Err: errors.New("-mode warmcheck: REA session is cold")}
		},
	}
	r := NewRegistry(job)

	var out bytes.Buffer
	err := r.Dispatch(context.Background(), "shorted", []string{"house-prices", "-mode", "warmcheck"}, &out)
	if err == nil {
		t.Fatal("want an error carrying exit code 5")
	}
	if !cleanedUp {
		t.Fatal("deferred cleanup did not run — the whole point of not calling os.Exit")
	}
	if got := ExitCodeOf(err); got != 5 {
		t.Fatalf("ExitCodeOf = %d, want 5", got)
	}
	var ec *ExitCodeError
	if !errors.As(err, &ec) || ec.ExitCode() != 5 {
		t.Fatalf("errors.As lost the code: %v", err)
	}
	if logged := out.String(); !strings.Contains(logged, "status=error") || !strings.Contains(logged, "name=shorted house-prices") {
		t.Fatalf("end-of-job line missing/incorrect: %q", logged)
	}
}

// TestExitCodeErrorWrapping asserts the message shape and that Unwrap keeps
// errors.Is working through the wrapper.
func TestExitCodeErrorWrapping(t *testing.T) {
	sentinel := errors.New("cold")
	err := &ExitCodeError{Code: 5, Err: sentinel}
	if !errors.Is(err, sentinel) {
		t.Fatal("Unwrap broken")
	}
	if got := err.Error(); got != "cold (exit 5)" {
		t.Fatalf("Error() = %q", got)
	}
	if got := (&ExitCodeError{Code: 3}).Error(); got != "exit status 3" {
		t.Fatalf("nil-cause Error() = %q", got)
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
