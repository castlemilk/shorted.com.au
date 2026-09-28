package marketdata

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"regexp"
	"strings"
	"time"

	msync "github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/sync"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

// syncJob returns the `shorted market-data sync` subcommand: one sweep of every
// listed stock, stalest first, each up to the last closed session. It is the
// daily price job (Cloud Run Job shorted-price-sync).
//
//	-from DATE   re-fetch every stock from DATE, overwriting stored sessions with
//	             the provider's, and report where they differed
//	-codes A,B   only these codes (failure blocks ignored)
//	-dry-run     fetch and compare, write nothing to the database
//	-budget D    stop taking stocks after D (default $SYNC_RUN_BUDGET; 0 = none)
func syncJob() runner.Job {
	return runner.Func{
		JobName: "sync",
		Desc:    "sweep every stock's prices up to the last closed session, stalest first, and exit",
		DryRun:  true,
		Fn:      runSync,
	}
}

// runBudgetEnv is the run budget the deployment sets (terraform: the
// shorted-price-sync module), below the job's task timeout. The -budget flag
// overrides it for one run, which is how the Price Sync workflow follows a
// task_timeout override.
const runBudgetEnv = "SYNC_RUN_BUDGET"

// exitCodeBudgetSpent is the exit code of a sweep that stopped on its run
// budget with stocks left: some of the work was done and reported, and the
// rest is for the next attempt. The same 10 = DEGRADED that economy and picks
// use for a partial run; Cloud Run retries any non-zero exit, so the retry
// resumes from the stalest stock, and an execution fails only when the retry
// runs out too.
const exitCodeBudgetSpent = 10

func runSync(ctx context.Context, args []string) error {
	opts, err := parseSyncFlags(runner.FromContext(ctx).DryRun, os.Getenv(runBudgetEnv), args)
	if err != nil {
		return err
	}

	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	logConfig(cfg)

	shutdownOTel := startOTel(ctx)
	defer shutdownOTel()

	d, err := initDependencies(ctx, cfg)
	if err != nil {
		return fmt.Errorf("failed to initialize dependencies: %w", err)
	}
	defer d.close()

	syncManager := msync.NewSyncManager(d.pool, d.gcs, cfg, d.providers)
	log.Printf("🚀 Starting Market Data Sync (one-shot)")

	// Wrap the sync run in an OTel span and record metrics
	tracer := otel.Tracer("shorted.sync")
	syncCtx, span := tracer.Start(ctx, "sync.run",
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(
			attribute.String("sync.type", syncJobAttr),
		),
	)

	start := time.Now()
	_, syncErr := syncManager.RunWith(syncCtx, opts)
	duration := time.Since(start).Seconds()
	span.End()

	attrs := otelmetric.WithAttributes(attribute.String("sync_job", syncJobAttr))
	shortedotel.SyncDuration.Record(ctx, duration, attrs)

	if syncErr != nil {
		shortedotel.SyncStatus.Add(ctx, 1, otelmetric.WithAttributes(
			attribute.String("sync_job", syncJobAttr),
			attribute.String("status", "failure"),
		))
		// The standalone binary distinguished interruption (exit 130) from
		// failure (log.Fatalf → exit 1). The shared binary has one exit code for
		// a failed job, so an interrupted sweep is reported as a cancellation
		// error instead — the runner logs it and main exits 1. See the README.
		if ctx.Err() != nil {
			return fmt.Errorf("sync interrupted: %w", syncErr)
		}
		return syncOutcome(syncErr)
	}

	shortedotel.SyncStatus.Add(ctx, 1, otelmetric.WithAttributes(
		attribute.String("sync_job", syncJobAttr),
		attribute.String("status", "success"),
	))
	shortedotel.SyncLastSuccess.Record(ctx, time.Now().Unix(), attrs)

	log.Printf("🎉 Market Data Sync completed successfully")
	return nil
}

// syncOutcome is the error a stopped sweep returns: a sweep that spent its
// run budget asks for exitCodeBudgetSpent, anything else is a plain failure.
func syncOutcome(syncErr error) error {
	if errors.Is(syncErr, msync.ErrBudgetSpent) {
		return &runner.ExitCodeError{Code: exitCodeBudgetSpent, Err: fmt.Errorf("sync %w", syncErr)}
	}
	return fmt.Errorf("sync failed: %w", syncErr)
}

// parseSyncFlags reads the sync subcommand's flags into run options. -dry-run
// defaults to the global flag, so `shorted -dry-run market-data sync` previews;
// -budget defaults to defaultBudget (the SYNC_RUN_BUDGET environment variable),
// and either must be a Go duration, so a misspelt budget fails the run at the
// start rather than leaving it unbounded.
func parseSyncFlags(globalDryRun bool, defaultBudget string, args []string) (msync.RunOptions, error) {
	var opts msync.RunOptions
	fs := flag.NewFlagSet("market-data sync", flag.ContinueOnError)
	from := fs.String("from", "", "re-fetch every stock from this date (YYYY-MM-DD), overwriting stored sessions, and report differences")
	codes := fs.String("codes", "", "comma-separated codes to sync instead of the whole list (failure blocks ignored)")
	budget := fs.String("budget", defaultBudget, "stop taking stocks after this long (e.g. 5h30m) and leave the rest to the next attempt; 0 = no budget")
	fs.BoolVar(&opts.DryRun, "dry-run", globalDryRun, "fetch and compare with what is stored; write nothing to the database")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return opts, runner.ErrUsage
		}
		return opts, err
	}
	if fs.NArg() > 0 {
		return opts, fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	if *budget != "" {
		d, err := time.ParseDuration(*budget)
		if err != nil {
			return opts, fmt.Errorf("-budget %q (or $%s): want a duration such as 5h30m", *budget, runBudgetEnv)
		}
		if d < 0 {
			return opts, fmt.Errorf("-budget %q: must not be negative", *budget)
		}
		opts.Budget = d
	}
	if *from != "" {
		t, err := time.Parse("2006-01-02", *from)
		if err != nil {
			return opts, fmt.Errorf("-from %q: want YYYY-MM-DD", *from)
		}
		opts.From = t
	}
	for _, c := range strings.Split(*codes, ",") {
		if c = strings.ToUpper(strings.TrimSpace(c)); c != "" {
			if !stockCodePattern.MatchString(c) {
				return opts, fmt.Errorf("-codes: %q is not an ASX code", c)
			}
			opts.Codes = append(opts.Codes, c)
		}
	}
	return opts, nil
}

// stockCodePattern is an ASX code: three to six letters and digits.
var stockCodePattern = regexp.MustCompile(`^[A-Z0-9]{3,6}$`)
