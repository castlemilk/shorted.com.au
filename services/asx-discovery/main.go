package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/castlemilk/shorted.com.au/services/asx-discovery/scraper"
	"github.com/castlemilk/shorted.com.au/services/asx-discovery/storage"
	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
)

func main() {
	// Configuration
	bucketName := os.Getenv("GCS_BUCKET_NAME")
	if bucketName == "" {
		bucketName = "shorted-data" // Default bucket
	}
	
	downloadDir := os.Getenv("DOWNLOAD_DIR")
	if downloadDir == "" {
		downloadDir = "/tmp/asx-downloads"
	}

	log.Printf("Starting ASX Discovery Service")
	log.Printf("Bucket: %s, Download Dir: %s", bucketName, downloadDir)

	// Set up context with cancellation
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Initialize OpenTelemetry (traces + metrics via OTLP).
	// No-op when OTEL_EXPORTER_OTLP_ENDPOINT is not set.
	otelShutdown, otelErr := shortedotel.InitProvider(ctx, "asx-discovery")
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

	// Track sync metrics
	syncStart := time.Now()
	syncAttrs := otelmetric.WithAttributes(attribute.String("sync_job", "asx-discovery"))

	// 1. Scrape ASX website
	asxScraper := scraper.NewASXScraper(downloadDir)

	downloadPath, err := asxScraper.DownloadCSV(ctx)
	if err != nil {
		shortedotel.SyncDuration.Record(ctx, time.Since(syncStart).Seconds(), syncAttrs)
		shortedotel.SyncStatus.Add(ctx, 1, otelmetric.WithAttributes(
			attribute.String("sync_job", "asx-discovery"),
			attribute.String("status", "failure"),
		))
		log.Fatalf("❌ Failed to download ASX CSV: %v", err)
	}
	defer os.RemoveAll(downloadDir) // Cleanup after done

	// 2. Upload to GCS
	gcsClient, err := storage.NewGCSClient(ctx, bucketName)
	if err != nil {
		shortedotel.SyncDuration.Record(ctx, time.Since(syncStart).Seconds(), syncAttrs)
		shortedotel.SyncStatus.Add(ctx, 1, otelmetric.WithAttributes(
			attribute.String("sync_job", "asx-discovery"),
			attribute.String("status", "failure"),
		))
		log.Fatalf("❌ Failed to initialize GCS client: %v", err)
	}
	defer gcsClient.Close()

	uploadCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	if err := gcsClient.UploadCSV(uploadCtx, downloadPath); err != nil {
		shortedotel.SyncDuration.Record(ctx, time.Since(syncStart).Seconds(), syncAttrs)
		shortedotel.SyncStatus.Add(ctx, 1, otelmetric.WithAttributes(
			attribute.String("sync_job", "asx-discovery"),
			attribute.String("status", "failure"),
		))
		log.Fatalf("❌ Failed to upload CSV to GCS: %v", err)
	}

	// Record success metrics
	shortedotel.SyncDuration.Record(ctx, time.Since(syncStart).Seconds(), syncAttrs)
	shortedotel.SyncStatus.Add(ctx, 1, otelmetric.WithAttributes(
		attribute.String("sync_job", "asx-discovery"),
		attribute.String("status", "success"),
	))
	shortedotel.SyncLastSuccess.Record(ctx, time.Now().Unix(), syncAttrs)

	log.Printf("🎉 ASX Discovery completed successfully")
}
