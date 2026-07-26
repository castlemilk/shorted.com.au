// Command shorted is the single batch-job binary: `shorted <job> [flags]`.
//
// Every scheduled collector/crawler/report tool becomes a subcommand of this
// one binary and one container image, per docs/jobs-consolidation-plan.md.
// Dispatch is stdlib flag.FlagSet-per-subcommand — deliberately no CLI
// framework dependency.
//
//	shorted                      list the available jobs
//	shorted influence -mode tax  run a job with its own flags
//	shorted reports coverage -h  nested job groups
//	shorted -verbose reports sync -limit 10
//
// Global flags (-dry-run, -verbose) go BEFORE the job name and become the
// default for the matching per-job flag, so existing per-job invocations are
// unchanged.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/announcements"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/discovery"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/economy"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/influence"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/news"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/reports"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/signals"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/weeklyreport"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

// jobs is the registry of everything this binary can run.
func jobs() *runner.Registry {
	return runner.NewRegistry(
		announcements.Job(),
		discovery.Job(),
		economy.Job(),
		influence.Job(),
		marketdata.Group(),
		news.Job(),
		reports.Group(),
		signals.Job(),
		weeklyreport.Job(),
	)
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)

	registry := jobs()

	root := flag.NewFlagSet("shorted", flag.ContinueOnError)
	root.SetOutput(os.Stderr)
	dryRun := root.Bool("dry-run", false, "Global default for per-job -dry-run (jobs that support it)")
	verbose := root.Bool("verbose", false, "Global default for per-job -verbose (jobs that support it)")
	root.Usage = func() {
		registry.PrintUsage(os.Stderr, "shorted")
		fmt.Fprintf(os.Stderr, "\nGlobal flags (before the job name):\n")
		root.PrintDefaults()
	}

	if err := root.Parse(os.Args[1:]); err != nil {
		// flag prints the error/usage itself.
		os.Exit(2)
	}

	if root.NArg() == 0 {
		root.Usage()
		os.Exit(2)
	}

	ctx, stop := runner.SignalContext(context.Background())
	defer stop()
	ctx = runner.WithGlobals(ctx, runner.Globals{DryRun: *dryRun, Verbose: *verbose})

	err := registry.Dispatch(ctx, "shorted", root.Args(), os.Stderr)
	switch {
	case err == nil:
		return
	case errors.Is(err, runner.ErrUsage):
		os.Exit(2)
	default:
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}
