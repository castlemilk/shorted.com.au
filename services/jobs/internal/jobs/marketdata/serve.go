package marketdata

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/api"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/checkpoint"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/config"
	msync "github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/sync"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
)

// Dependency-init retry policy, preserved from the standalone service: the HTTP
// server is up first so Cloud Run startup probes pass, then DB/GCS/providers are
// initialised with a linear backoff capped at maxInitBackoff.
const (
	maxInitAttempts = 10
	maxInitBackoff  = 30 * time.Second
)

// serveJob returns the `shorted market-data serve` subcommand: the Cloud Run
// SERVICE surface the weekday scheduler POSTs.
//
// DryRun is false — every endpoint writes (or triggers a writer), and the
// standalone service had no dry-run concept at all.
func serveJob() runner.Job {
	return runner.Func{
		JobName: "serve",
		Desc:    "run the HTTP surface (/api/sync/*, /api/gaps/*, /healthz, /readyz) until SIGTERM",
		Fn:      runServe,
	}
}

func runServe(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("market-data serve", flag.ContinueOnError)
	port := fs.Int("port", 0, "HTTP port (default $PORT, else 8080)")
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
	if *port != 0 {
		cfg.Port = *port
	}
	logConfig(cfg)

	shutdownOTel := startOTel(ctx)
	defer shutdownOTel()

	// Start the HTTP server FIRST so health probes pass while the heavy
	// dependencies come up. API endpoints answer 503 until SetDependencies.
	server := api.NewServer(cfg.Port)
	if err := server.Start(); err != nil {
		return fmt.Errorf("failed to start HTTP server: %w", err)
	}

	d, err := initWithRetry(ctx, cfg, server)
	if err != nil {
		return err
	}
	defer d.close()

	syncManager := msync.NewSyncManager(d.pool, d.gcs, cfg, d.providers)
	server.SetDependencies(syncManager, checkpoint.NewStore(d.pool), d.pool, d.providers)

	if err := server.AwaitShutdown(ctx); err != nil {
		return fmt.Errorf("server shutdown error: %w", err)
	}
	return nil
}

// initWithRetry retries dependency initialisation, keeping the health endpoint
// alive throughout. The standalone service slept between attempts and
// log.Fatalf'd on exhaustion or cancellation; here the wait is ctx-aware (so
// SIGTERM lands during a 30s backoff) and both terminal cases return an error,
// which lets the caller's deferred shutdowns actually run.
func initWithRetry(ctx context.Context, cfg *config.Config, server *api.Server) (*deps, error) {
	var lastErr error
	for attempt := 1; attempt <= maxInitAttempts; attempt++ {
		d, err := initDependencies(ctx, cfg)
		if err == nil {
			return d, nil
		}
		lastErr = err

		// A failed listener is terminal — retrying dependencies against a
		// server that will never accept traffic just burns the deadline.
		if serveErr := server.Err(); serveErr != nil {
			return nil, serveErr
		}

		backoff := min(time.Duration(attempt)*2*time.Second, maxInitBackoff)
		log.Printf("⚠️ Dependency init failed (attempt %d/%d): %v — retrying in %s", attempt, maxInitAttempts, err, backoff)
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("context cancelled during dependency init (last error: %v): %w", lastErr, ctx.Err())
		case <-time.After(backoff):
		}
	}
	return nil, fmt.Errorf("failed to initialize dependencies after %d attempts: %w", maxInitAttempts, lastErr)
}
