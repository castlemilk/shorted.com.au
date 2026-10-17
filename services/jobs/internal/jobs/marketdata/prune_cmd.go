package marketdata

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"time"

	msync "github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/sync"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

// pruneJob returns the `shorted market-data prune` subcommand: delete stored
// prices dated on days the ASX did not trade (every weekend row, and every row
// on a market holiday), which the sweep never deletes.
//
//	-dry-run     count what would be deleted, per year and per holiday; delete nothing
//	-from DATE   judge holidays from DATE instead of the first stored session
func pruneJob() runner.Job {
	return runner.Func{
		JobName: "prune",
		Desc:    "delete stored prices dated on weekends and ASX holidays, and exit",
		DryRun:  true,
		Fn:      runPrune,
	}
}

func runPrune(ctx context.Context, args []string) error {
	opts, err := parsePruneFlags(runner.FromContext(ctx).DryRun, args)
	if err != nil {
		return err
	}
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	logConfig(cfg)

	d, err := initDependencies(ctx, cfg)
	if err != nil {
		return fmt.Errorf("failed to initialize dependencies: %w", err)
	}
	defer d.close()

	if _, err := msync.NewSyncManager(d.pool, d.gcs, cfg, d.providers).Prune(ctx, opts); err != nil {
		return fmt.Errorf("prune: %w", err)
	}
	return nil
}

// parsePruneFlags reads the prune subcommand's flags. -dry-run defaults to the
// global flag.
func parsePruneFlags(globalDryRun bool, args []string) (msync.PruneOptions, error) {
	var opts msync.PruneOptions
	fs := flag.NewFlagSet("market-data prune", flag.ContinueOnError)
	fs.BoolVar(&opts.DryRun, "dry-run", globalDryRun, "count what would be deleted; delete nothing")
	from := fs.String("from", "", "judge holidays from this date (YYYY-MM-DD) instead of the first stored session")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return opts, runner.ErrUsage
		}
		return opts, err
	}
	if fs.NArg() > 0 {
		return opts, fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	if *from != "" {
		t, err := time.Parse("2006-01-02", *from)
		if err != nil {
			return opts, fmt.Errorf("-from %q: want YYYY-MM-DD", *from)
		}
		opts.From = t
	}
	return opts, nil
}
