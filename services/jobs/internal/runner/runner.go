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
	"sort"
	"strings"
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
// and usage has already been printed. Main maps it to exit code 2.
var ErrUsage = errors.New("usage")

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

// SortedNames returns the registered job names alphabetically.
func (r *Registry) SortedNames() []string {
	out := r.Names()
	sort.Strings(out)
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
		return fmt.Errorf("unknown job %q", name)
	}
	return Observe(ctx, prefix+" "+name, logw, func(ctx context.Context) error {
		return job.Run(ctx, args[1:])
	})
}

// Observe runs fn with structured start/end lines (name, duration, error).
// Only the OUTERMOST dispatch wraps in Observe — a Group hands straight to its
// sub-job, so one invocation produces exactly one start/end pair.
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

// Run implements Job by dispatching to the nested registry. The nested job's
// own start/end lines are emitted by the inner Dispatch.
func (g *Group) Run(ctx context.Context, args []string) error {
	if len(args) == 0 {
		g.sub.PrintUsage(os.Stderr, "shorted "+g.name)
		return ErrUsage
	}
	name := args[0]
	switch name {
	case "-h", "--help", "help":
		g.sub.PrintUsage(os.Stderr, "shorted "+g.name)
		return ErrUsage
	}
	job, ok := g.sub.Lookup(name)
	if !ok {
		fmt.Fprintf(os.Stderr, "unknown %s job %q\n\n", g.name, name)
		g.sub.PrintUsage(os.Stderr, "shorted "+g.name)
		return fmt.Errorf("unknown %s job %q", g.name, name)
	}
	return job.Run(ctx, args[1:])
}

// SignalContext returns a context cancelled on SIGINT/SIGTERM. Batch jobs get a
// chance to unwind (close pools, finish a collection run) instead of being hard
// killed mid-write. The returned stop func must be deferred by the caller.
func SignalContext(parent context.Context) (context.Context, context.CancelFunc) {
	return signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
}

// Func adapts a plain function into a Job.
type Func struct {
	JobName string
	Desc    string
	Fn      func(ctx context.Context, args []string) error
}

// Name implements Job.
func (f Func) Name() string { return f.JobName }

// Synopsis implements Job.
func (f Func) Synopsis() string { return f.Desc }

// Run implements Job.
func (f Func) Run(ctx context.Context, args []string) error { return f.Fn(ctx, args) }

// HelpRequested reports whether args ask for help, so a job can short-circuit
// before touching the database.
func HelpRequested(args []string) bool {
	for _, a := range args {
		switch strings.TrimSpace(a) {
		case "-h", "--help":
			return true
		}
	}
	return false
}
