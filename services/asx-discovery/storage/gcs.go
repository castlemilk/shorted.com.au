package storage

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"time"

	"cloud.google.com/go/storage"
	"google.golang.org/api/option"
)

// GCSClient handles file uploads to Google Cloud Storage
type GCSClient struct {
	bucketName string
	client     *storage.Client
}

// NewGCSClient creates a new GCSClient instance
func NewGCSClient(ctx context.Context, bucketName string) (*GCSClient, error) {
	var opts []option.ClientOption
	
	// Check for credentials file in environment (if not using emulator)
	if os.Getenv("STORAGE_EMULATOR_HOST") == "" {
		if credsPath := os.Getenv("GOOGLE_APPLICATION_CREDENTIALS"); credsPath != "" {
			// Resolve to absolute path to avoid issues with working directory
			absPath, err := filepath.Abs(credsPath)
			if err != nil {
				return nil, fmt.Errorf("failed to resolve credentials path: %w", err)
			}
			
			// Verify file exists
			if _, err := os.Stat(absPath); os.IsNotExist(err) {
				return nil, fmt.Errorf("credentials file not found: %s", absPath)
			}
			
			// Use WithCredentialsFile with absolute path
			// This should work without conflicts if the path is absolute
			opts = append(opts, option.WithCredentialsFile(absPath))
		}
		// If no explicit credentials, let it use default (gcloud ADC)
	} else {
		opts = append(opts, option.WithoutAuthentication())
	}

	client, err := storage.NewClient(ctx, opts...)
	if err != nil {
		return nil, fmt.Errorf("failed to create storage client: %w", err)
	}

	return &GCSClient{
		bucketName: bucketName,
		client:     client,
	}, nil
}

// UploadCSV uploads the CSV file to GCS
func (g *GCSClient) UploadCSV(ctx context.Context, filePath string) error {
	file, err := os.Open(filePath)
	if err != nil {
		return fmt.Errorf("failed to open file: %w", err)
	}
	defer file.Close()

	// Generate object names
	dateStr := time.Now().Format("2006-01-02")
	datedName := fmt.Sprintf("asx-stocks/asx-companies-%s.csv", dateStr)
	latestName := "asx-stocks/latest.csv"

	// Upload dated version
	if err := g.uploadObject(ctx, file, datedName); err != nil {
		return fmt.Errorf("failed to upload dated object: %w", err)
	}

	// Seek back to start for second upload
	if _, err := file.Seek(0, 0); err != nil {
		return fmt.Errorf("failed to seek file: %w", err)
	}

	// Upload latest version
	if err := g.uploadObject(ctx, file, latestName); err != nil {
		return fmt.Errorf("failed to upload latest object: %w", err)
	}

	log.Printf("Successfully uploaded %s to gs://%s/", filePath, g.bucketName)
	return nil
}

func (g *GCSClient) uploadObject(ctx context.Context, data io.Reader, objectName string) error {
	bucket := g.client.Bucket(g.bucketName)
	obj := bucket.Object(objectName)
	
	w := obj.NewWriter(ctx)
	w.ContentType = "text/csv"
	
	if _, err := io.Copy(w, data); err != nil {
		return fmt.Errorf("failed to copy data: %w", err)
	}
	
	if err := w.Close(); err != nil {
		return fmt.Errorf("failed to close writer for %s: %w", objectName, err)
	}

	log.Printf("Successfully uploaded object %s", objectName)
	return nil
}

// Close closes the storage client
func (g *GCSClient) Close() error {
	return g.client.Close()
}
