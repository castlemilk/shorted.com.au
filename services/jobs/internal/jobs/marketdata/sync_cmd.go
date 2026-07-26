package marketdata

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"time"

	msync "github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/sync"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

// syncJob returns the `shorted market-data sync` subcommand — the standalone
// binary's `-cli` mode: initialise, run one full prioritised sweep, exit.
//
// DryRun is false: the sweep always writes stock_prices (and, when SYNC_ALGOLIA
// is set, Algolia), and the standalone binary had no dry-run path.
func syncJob() runner.Job {
	return runner.Func{
		JobName: "sync",
		Desc:    "run one full prioritised price sync and exit (was market-data-sync -cli)",
		Fn:      runSync,
	}
}

func runSync(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("market-data sync", flag.ContinueOnError)
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return runner.ErrUsage
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
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
	syncErr := syncManager.Run(syncCtx)
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
