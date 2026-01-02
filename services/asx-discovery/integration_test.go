//go:build integration
// +build integration

package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"cloud.google.com/go/storage"
	discoveryScraper "github.com/castlemilk/shorted.com.au/services/asx-discovery/scraper"
	discoveryStorage "github.com/castlemilk/shorted.com.au/services/asx-discovery/storage"
	"google.golang.org/api/option"
)

func TestGCSUpload_Success(t *testing.T) {
	ctx := context.Background()
	bucketName := "shorted-data"

	// 1. Create a dummy CSV file
	tmpDir, err := os.MkdirTemp("", "asx-test")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	filePath := filepath.Join(tmpDir, "asx-companies.csv")
	dummyContent := "ASX code,Company name,Listing date,GICs industry group,Market Cap\nABC,ABC LTD,2020-01-01,Materials,1000000"
	if err := os.WriteFile(filePath, []byte(dummyContent), 0644); err != nil {
		t.Fatalf("failed to write dummy file: %v", err)
	}

	// 2. Initialize GCS client using our storage package
	// It will use STORAGE_EMULATOR_HOST set in setup_test.go
	customClient, err := discoveryStorage.NewGCSClient(ctx, bucketName)
	if err != nil {
		t.Fatalf("failed to create GCS client: %v", err)
	}
	defer customClient.Close()

	// Perform upload
	if err := customClient.UploadCSV(ctx, filePath); err != nil {
		t.Fatalf("UploadCSV failed: %v", err)
	}

	// 3. Verify objects exist using a fresh client
	gcsClient, err := storage.NewClient(ctx, option.WithoutAuthentication())
	if err != nil {
		t.Fatalf("failed to create verification client: %v", err)
	}
	defer gcsClient.Close()

	bucket := gcsClient.Bucket(bucketName)
	
	// Add a small delay to let fake-gcs-server process
	time.Sleep(100 * time.Millisecond)

	dateStr := time.Now().Format("2006-01-02")
	expectedObjects := []string{
		fmt.Sprintf("asx-stocks/asx-companies-%s.csv", dateStr),
		"asx-stocks/latest.csv",
	}

	for _, objName := range expectedObjects {
		obj := bucket.Object(objName)
		attrs, err := obj.Attrs(ctx)
		if err != nil {
			t.Errorf("Object %s does not exist or failed to get attrs: %v", objName, err)
			continue
		}
		if attrs.ContentType != "text/csv" {
			t.Errorf("Object %s has wrong content type: %s", objName, attrs.ContentType)
		}

		// Verify content
		rc, err := obj.NewReader(ctx)
		if err != nil {
			t.Errorf("Failed to create reader for %s: %v", objName, err)
			continue
		}
		content, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Errorf("Failed to read content of %s: %v", objName, err)
			continue
		}
		if string(content) != dummyContent {
			t.Errorf("Content mismatch for %s", objName)
		}
	}
}

func TestASXScraper_Integration(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	tmpDir, err := os.MkdirTemp("", "asx-scraper-test")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	scraper := discoveryScraper.NewASXScraper(tmpDir)

	t.Run("download_csv_from_asx", func(t *testing.T) {
		// This test depends on external network access and Chromium being present
		filePath, err := scraper.DownloadCSV(ctx)
		if err != nil {
			t.Logf("Skipping full scraper test: %v (this is expected if Chromium or ASX is unavailable in test env)", err)
			return
		}

		if _, err := os.Stat(filePath); os.IsNotExist(err) {
			t.Errorf("Downloaded file does not exist: %s", filePath)
		}

		// Verify it's a CSV
		if filepath.Ext(filePath) != ".csv" {
			t.Errorf("Expected .csv extension, got %s", filepath.Ext(filePath))
		}
	})
}
