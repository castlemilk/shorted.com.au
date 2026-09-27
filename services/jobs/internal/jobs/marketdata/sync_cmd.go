package marketdata

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
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
func syncJob() runner.Job {
	return runner.Func{
		JobName: "sync",
		Desc:    "sweep every stock's prices up to the last closed session, stalest first, and exit",
		DryRun:  true,
		Fn:      runSync,
	}
}

func runSync(ctx context.Context, args []string) error {
	opts, err := parseSyncFlags(runner.FromContext(ctx).DryRun, args)
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
		return fmt.Errorf("sync failed: %w", syncErr)
	}

	shortedotel.SyncStatus.Add(ctx, 1, otelmetric.WithAttributes(
		attribute.String("sync_job", syncJobAttr),
		attribute.String("status", "success"),
	))
	shortedotel.SyncLastSuccess.Record(ctx, time.Now().Unix(), attrs)

	log.Printf("🎉 Market Data Sync completed successfully")
	return nil
}

// parseSyncFlags reads the sync subcommand's flags into run options. -dry-run
// defaults to the global flag, so `shorted -dry-run market-data sync` previews.
func parseSyncFlags(globalDryRun bool, args []string) (msync.RunOptions, error) {
	var opts msync.RunOptions
	fs := flag.NewFlagSet("market-data sync", flag.ContinueOnError)
	from := fs.String("from", "", "re-fetch every stock from this date (YYYY-MM-DD), overwriting stored sessions, and report differences")
	codes := fs.String("codes", "", "comma-separated codes to sync instead of the whole list (failure blocks ignored)")
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
