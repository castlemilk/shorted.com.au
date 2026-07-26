// Package runner is the shared scaffolding every `shorted` subcommand hangs off:
// a Job interface, a Registry that dispatches `shorted <job> [flags]`, nested
// Groups (`shorted reports coverage`), signal-aware contexts and structured
// start/end log lines. Jobs contain ONLY their own logic — no flag plumbing,
// no signal handling, no timing/logging boilerplate.
package runner

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// Job is one runnable unit of work. Name() is the subcommand token typed on the
// command line; Run receives the args AFTER that token (so the job owns its own
// flag.FlagSet) plus a context that is cancelled on SIGINT/SIGTERM.
type Job interface {
	Name() string
	Synopsis() string
	Run(ctx context.Context, args []string) error
}

// DryRunAware is implemented by jobs that honour a dry run (i.e. they have their
// own -dry-run flag defaulting to Globals.DryRun). A global -dry-run against a
// job that does NOT implement this is refused before the job runs, rather than
// silently writing to the database — see Registry.Dispatch.
type DryRunAware interface {
	SupportsDryRun() bool
}

func supportsDryRun(j Job) bool {
	d, ok := j.(DryRunAware)
	return ok && d.SupportsDryRun()
}

// Dispatcher is implemented by jobs that own a nested registry (Group). The
// parent Dispatch hands the log prefix and log writer down so the LEAF job's
// name reaches the single start/end line (`name=shorted reports coverage`)
// instead of stopping at the group.
type Dispatcher interface {
	Dispatch(ctx context.Context, prefix string, args []string, logw io.Writer) error
}

// Globals are the root-level flags shared by every job. Jobs opt in by reading
// them from the context (FromContext) — typically as the DEFAULT for their own
// -dry-run / -verbose flags, so per-job flags keep their existing semantics.
type Globals struct {
	DryRun  bool
	Verbose bool
}

type globalsKey struct{}

// WithGlobals attaches the root flag values to ctx.
func WithGlobals(ctx context.Context, g Globals) context.Context {
	return context.WithValue(ctx, globalsKey{}, g)
}

// FromContext returns the root flag values (zero value when unset).
func FromContext(ctx context.Context) Globals {
	if g, ok := ctx.Value(globalsKey{}).(Globals); ok {
		return g
	}
	return Globals{}
}

// ErrUsage signals that the caller asked for help (or got the invocation wrong)
// and usage has ALREADY been printed by the runner. Main maps it to exit code 2
// and must not print anything itself — usage errors are reported exactly once.
var ErrUsage = errors.New("usage")

// ExitCodeError carries a SPECIFIC process exit code out of a job, for the rare
// case where an external caller branches on the code rather than on "did it
// fail". The runner's default contract is one failure code (1); this is the
// documented escape hatch.
//
// The only current user is `shorted house-prices`, whose residential-rig
// launchers (services/house-price-collector/deploy/*.sh) branch on
//
//	3 = re-warm the crawl Chrome (Kasada/Akamai clearance expired)
//	4 = fetcher init failed — Chrome/CDP unusable (hard-recover)
//	5 = warmcheck says the session is cold
//	6 = crawl-freshness ALARM
//
// A job returns this INSTEAD of calling os.Exit, so deferred cleanup (pool
// close) still runs and the runner still emits its `status=error` line; main
// unwraps it and exits with Code. Errors carrying code 0 are treated as
// ordinary failures (exit 1) — a "successful error" is not expressible.
type ExitCodeError struct {
	Code int
	Err  error
}

// Error implements error.
func (e *ExitCodeError) Error() string {
	if e.Err == nil {
		return fmt.Sprintf("exit status %d", e.Code)
	}
	return fmt.Sprintf("%v (exit %d)", e.Err, e.Code)
}

// Unwrap exposes the underlying cause to errors.Is/As.
func (e *ExitCodeError) Unwrap() error { return e.Err }

// ExitCode returns the process exit code this error asks for.
func (e *ExitCodeError) ExitCode() int { return e.Code }

// ExitCodeOf returns the exit code a job asked for, or 1 for any ordinary
// error (and 0 for nil). Main uses it as the single mapping from error to
// process status.
func ExitCodeOf(err error) int {
	if err == nil {
		return 0
	}
	var ec *ExitCodeError
	if errors.As(err, &ec) && ec.Code != 0 {
		return ec.Code
	}
	return 1
}

// Registry holds the jobs reachable from one command level.
type Registry struct {
	jobs map[string]Job
	// order preserves registration order for stable help output.
	order []string
}

// NewRegistry builds a registry from the given jobs.
func NewRegistry(jobs ...Job) *Registry {
	r := &Registry{jobs: map[string]Job{}}
	for _, j := range jobs {
		r.Register(j)
	}
	return r
}

// Register adds a job. Duplicate names panic — that's a programming error.
func (r *Registry) Register(j Job) {
	if _, dup := r.jobs[j.Name()]; dup {
		panic("runner: duplicate job name " + j.Name())
	}
	r.jobs[j.Name()] = j
	r.order = append(r.order, j.Name())
}

// Lookup returns the job registered under name.
func (r *Registry) Lookup(name string) (Job, bool) {
	j, ok := r.jobs[name]
	return j, ok
}

// Names returns the registered job names in registration order.
func (r *Registry) Names() []string {
	out := append([]string(nil), r.order...)
	return out
}

// PrintUsage writes the "available jobs" listing.
func (r *Registry) PrintUsage(w io.Writer, prefix string) {
	fmt.Fprintf(w, "usage: %s <job> [flags]\n\nAvailable jobs:\n", prefix)
	width := 0
	for _, n := range r.order {
		if len(n) > width {
			width = len(n)
		}
	}
	for _, n := range r.order {
		fmt.Fprintf(w, "  %-*s  %s\n", width, n, r.jobs[n].Synopsis())
	}
	fmt.Fprintf(w, "\nRun \"%s <job> -h\" for job flags.\n", prefix)
}

// Dispatch resolves args[0] to a job and runs it with the remaining args,
// wrapped in the standard start/end logging. args must NOT include the program
// name. An empty args slice (or -h/--help/help) prints usage and returns
// ErrUsage.
//
// A job that owns a nested registry (Group) is handed the extended prefix and
// the log writer instead of being Observe-wrapped here, so the start/end pair is
// emitted ONCE, at the leaf, carrying the full name (`shorted reports coverage`).
//
// An unknown job name is reported HERE (message + usage listing) and returned
// wrapped in ErrUsage so main exits 2 without printing it a second time.
func (r *Registry) Dispatch(ctx context.Context, prefix string, args []string, logw io.Writer) error {
	if len(args) == 0 {
		r.PrintUsage(logw, prefix)
		return ErrUsage
	}
	name := args[0]
	switch name {
	case "-h", "--help", "help":
		r.PrintUsage(logw, prefix)
		return ErrUsage
	}
	job, ok := r.Lookup(name)
	if !ok {
		fmt.Fprintf(logw, "unknown job %q\n\n", name)
		r.PrintUsage(logw, prefix)
		return fmt.Errorf("unknown job %q: %w", name, ErrUsage)
	}
	full := prefix + " " + name
	if d, nested := job.(Dispatcher); nested {
		return d.Dispatch(ctx, full, args[1:], logw)
	}
	// A global -dry-run against a job with no dry-run support would silently
	// write; fail before the job opens a pool.
	if FromContext(ctx).DryRun && !supportsDryRun(job) {
		return fmt.Errorf("job %q does not support -dry-run: refusing to run so a global -dry-run never writes", full)
	}
	return Observe(ctx, full, logw, func(ctx context.Context) error {
		return job.Run(ctx, args[1:])
	})
}

// Observe runs fn with structured start/end lines (name, duration, error).
// Exactly ONE Observe wraps any invocation: nested Groups forward through
// Dispatch (which does not Observe the group itself), so the single pair names
// the leaf job.
func Observe(ctx context.Context, name string, logw io.Writer, fn func(context.Context) error) error {
	start := time.Now()
	fmt.Fprintf(logw, "[job] start name=%s at=%s\n", name, start.UTC().Format(time.RFC3339))
	err := fn(ctx)
	dur := time.Since(start).Round(time.Millisecond)
	switch {
	case err == nil:
		fmt.Fprintf(logw, "[job] done name=%s duration=%s status=ok\n", name, dur)
	case errors.Is(err, ErrUsage):
		// Help output, not a run: don't pretend a job executed.
		fmt.Fprintf(logw, "[job] usage name=%s duration=%s\n", name, dur)
	default:
		fmt.Fprintf(logw, "[job] done name=%s duration=%s status=error error=%v\n", name, dur, err)
	}
	return err
}

// Group is a Job that dispatches to sub-jobs, giving `shorted reports coverage`
// shape without a second CLI framework.
type Group struct {
	name     string
	synopsis string
	sub      *Registry
}

// NewGroup builds a sub-command group.
func NewGroup(name, synopsis string, jobs ...Job) *Group {
	return &Group{name: name, synopsis: synopsis, sub: NewRegistry(jobs...)}
}

// Name implements Job.
func (g *Group) Name() string { return g.name }

// Synopsis implements Job.
func (g *Group) Synopsis() string { return g.synopsis }

// Sub exposes the nested registry (used by help output and tests).
func (g *Group) Sub() *Registry { return g.sub }

// SupportsDryRun implements DryRunAware. A group itself never writes; the
// nested Dispatch enforces the check against the leaf sub-job.
func (g *Group) SupportsDryRun() bool { return true }

// Dispatch implements Dispatcher: the parent hands down its prefix and log
// writer so the leaf sub-job owns the start/end pair and the full log name.
func (g *Group) Dispatch(ctx context.Context, prefix string, args []string, logw io.Writer) error {
	return g.sub.Dispatch(ctx, prefix, args, logw)
}

// Run implements Job. It is the fallback path for a Group invoked outside
// Registry.Dispatch (which is the log-name-preserving path); it logs to stderr.
func (g *Group) Run(ctx context.Context, args []string) error {
	return g.Dispatch(ctx, "shorted "+g.name, args, os.Stderr)
}

// SignalContext returns a context cancelled on SIGINT/SIGTERM. Batch jobs get a
// chance to unwind (close pools, finish a collection run) instead of being hard
// killed mid-write. The returned stop func must be deferred by the caller.
//
// A SECOND signal hard-exits (130): signal.NotifyContext keeps its handler
// installed until stop() runs, which would otherwise swallow repeat Ctrl-C /
// SIGTERM and leave a wedged non-ctx-aware call (e.g. a stuck CDP fetch)
// unkillable short of SIGKILL.
func SignalContext(parent context.Context) (context.Context, context.CancelFunc) {
	ctx, stop := signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-ctx.Done()
		if parent.Err() != nil {
			return // parent cancellation, not a signal
		}
		second := make(chan os.Signal, 1)
		signal.Notify(second, os.Interrupt, syscall.SIGTERM)
		select {
		case <-second:
			fmt.Fprintln(os.Stderr, "second signal: exiting immediately")
			os.Exit(130)
		case <-time.After(10 * time.Minute):
			// Unwind is taking absurdly long even for a crawl finalizer;
			// stop waiting for a second signal and let the process finish
			// however it will (launchd/Cloud Run will SIGKILL eventually).
		}
	}()
	return ctx, stop
}

// Func adapts a plain function into a Job.
type Func struct {
	JobName string
	Desc    string
	// DryRun declares that Fn honours a dry run (it has its own -dry-run flag
	// defaulting to Globals.DryRun). Leave false for jobs that always write —
	// the runner then refuses a global -dry-run instead of writing silently.
	DryRun bool
	Fn     func(ctx context.Context, args []string) error
}

// Name implements Job.
func (f Func) Name() string { return f.JobName }

// Synopsis implements Job.
func (f Func) Synopsis() string { return f.Desc }

// SupportsDryRun implements DryRunAware.
func (f Func) SupportsDryRun() bool { return f.DryRun }

// Run implements Job.
func (f Func) Run(ctx context.Context, args []string) error { return f.Fn(ctx, args) }
