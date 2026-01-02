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

	// 1. Scrape ASX website
	asxScraper := scraper.NewASXScraper(downloadDir)
	
	downloadPath, err := asxScraper.DownloadCSV(ctx)
	if err != nil {
		log.Fatalf("❌ Failed to download ASX CSV: %v", err)
	}
	defer os.RemoveAll(downloadDir) // Cleanup after done

	// 2. Upload to GCS
	gcsClient, err := storage.NewGCSClient(ctx, bucketName)
	if err != nil {
		log.Fatalf("❌ Failed to initialize GCS client: %v", err)
	}
	defer gcsClient.Close()

	uploadCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	if err := gcsClient.UploadCSV(uploadCtx, downloadPath); err != nil {
		log.Fatalf("❌ Failed to upload CSV to GCS: %v", err)
	}

	log.Printf("🎉 ASX Discovery completed successfully")
}
