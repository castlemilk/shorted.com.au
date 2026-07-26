// Package discovery is the `shorted discovery` job, migrated from
// services/asx-discovery (docs/jobs-consolidation-plan.md Phase 2, step 7).
//
// It drives a headless Chromium (playwright-go) over the ASX "trade our cash
// market" directory page, downloads the all-listed-companies CSV and uploads it
// to GCS as both a dated object and asx-stocks/latest.csv — the file every
// downstream stock-list consumer (market-data sync, backfills) reads.
//
// The standalone binary took NO flags; it is configured purely by environment:
//
//	GCS_BUCKET_NAME  target bucket        (default "shorted-data")
//	DOWNLOAD_DIR     scratch download dir (default "/tmp/asx-downloads")
//
// That contract is unchanged. Because it needs a browser, this is the one job
// that does NOT run from the standard services/jobs/Dockerfile — build the
// binary into services/jobs/Dockerfile.browser instead (same binary, browser
// image). See the README.
package discovery

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/discovery/scraper"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/discovery/storage"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
)

// otelServiceName is preserved from the standalone binary so existing
// dashboards and the sync_job metric attribute keep resolving.
const otelServiceName = "asx-discovery"

// uploadTimeout bounds the GCS upload, as the standalone binary did.
const uploadTimeout = 2 * time.Minute

// config is the resolved environment. The standalone binary read the env vars
// inline in main; a struct keeps them out of package state and makes the
// defaults reviewable in one place.
type config struct {
	bucketName  string
	downloadDir string
}

func loadConfig() config {
	return config{
		bucketName:  platform.GetEnv("GCS_BUCKET_NAME", "shorted-data"),
		downloadDir: platform.GetEnv("DOWNLOAD_DIR", "/tmp/asx-downloads"),
	}
}

// Job returns the `shorted discovery` subcommand.
//
// DryRun is deliberately false: this job has no dry-run path (it always
// downloads and always uploads), so the runner refuses a global -dry-run rather
// than letting it silently write to GCS.
func Job() runner.Job {
	return runner.Func{
		JobName: "discovery",
		Desc:    "scrape the ASX listed-companies CSV and upload it to GCS (needs the browser image)",
		Fn:      Run,
	}
}

// Run downloads the ASX company directory CSV and uploads it to GCS.
func Run(ctx context.Context, args []string) error {
	// No flags, but still parse so `-h` documents the env contract instead of
	// silently accepting (and ignoring) stray arguments.
	fs := flag.NewFlagSet("discovery", flag.ContinueOnError)
	fs.Usage = func() {
		_, _ = fmt.Fprint(fs.Output(), "usage: shorted discovery\n\n"+
			"No flags. Configured by environment:\n"+
			"  GCS_BUCKET_NAME  target bucket        (default \"shorted-data\")\n"+
			"  DOWNLOAD_DIR     scratch download dir (default \"/tmp/asx-downloads\")\n")
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return runner.ErrUsage
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q (discovery takes no flags)", fs.Arg(0))
	}

	cfg := loadConfig()
	log.Printf("Bucket: %s, Download Dir: %s", cfg.bucketName, cfg.downloadDir)

	// OpenTelemetry (traces + metrics via OTLP); a no-op when
	// OTEL_EXPORTER_OTLP_ENDPOINT is unset.
	otelShutdown, otelErr := shortedotel.InitProvider(ctx, otelServiceName)
	if otelErr != nil {
		log.Printf("WARNING: Failed to initialize OpenTelemetry: %v", otelErr)
	} else {
		defer func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := otelShutdown(shutdownCtx); err != nil {
				log.Printf("Error shutting down OpenTelemetry: %v", err)
			}
		}()
	}

	start := time.Now()
	err := discover(ctx, cfg)
	recordOutcome(ctx, start, err)
	return err
}

// discover is the actual work: scrape → upload. Split out so the metric
// recording above has exactly one success/failure decision point (the
// standalone binary repeated the failure block at each of its three
// log.Fatalf sites).
func discover(ctx context.Context, cfg config) error {
	asxScraper := scraper.NewASXScraper(cfg.downloadDir)

	downloadPath, err := asxScraper.DownloadCSV(ctx)
	if err != nil {
		return fmt.Errorf("failed to download ASX CSV: %w", err)
	}
	// Cleanup after done. The standalone binary registered this defer only
	// after a successful download, so a partially-populated download dir from a
	// failed scrape was left behind; the scraper creates the directory, so
	// removing it on the failure path too is the honest cleanup.
	defer func() {
		if rmErr := os.RemoveAll(cfg.downloadDir); rmErr != nil {
			log.Printf("WARNING: failed to clean up %s: %v", cfg.downloadDir, rmErr)
		}
	}()

	gcsClient, err := storage.NewGCSClient(ctx, cfg.bucketName)
	if err != nil {
		return fmt.Errorf("failed to initialize GCS client: %w", err)
	}
	defer func() {
		if closeErr := gcsClient.Close(); closeErr != nil {
			log.Printf("WARNING: closing GCS client: %v", closeErr)
		}
	}()

	uploadCtx, cancel := context.WithTimeout(ctx, uploadTimeout)
	defer cancel()

	if err := gcsClient.UploadCSV(uploadCtx, downloadPath); err != nil {
		return fmt.Errorf("failed to upload CSV to GCS: %w", err)
	}

	log.Printf("🎉 ASX Discovery completed successfully")
	return nil
}

// recordOutcome emits the same three sync metrics the standalone binary did,
// with the same sync_job attribute value.
func recordOutcome(ctx context.Context, start time.Time, err error) {
	syncAttrs := otelmetric.WithAttributes(attribute.String("sync_job", otelServiceName))
	shortedotel.SyncDuration.Record(ctx, time.Since(start).Seconds(), syncAttrs)

	status := "success"
	if err != nil {
		status = "failure"
	}
	shortedotel.SyncStatus.Add(ctx, 1, otelmetric.WithAttributes(
		attribute.String("sync_job", otelServiceName),
		attribute.String("status", status),
	))
	if err == nil {
		shortedotel.SyncLastSuccess.Record(ctx, time.Now().Unix(), syncAttrs)
	}
}
