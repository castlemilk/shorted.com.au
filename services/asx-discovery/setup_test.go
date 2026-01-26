//go:build integration
// +build integration

package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"testing"

	"cloud.google.com/go/storage"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
	"google.golang.org/api/option"
)

var (
	gcsContainer testcontainers.Container
	gcsEndpoint  string
)

func TestMain(m *testing.M) {
	ctx := context.Background()

	log.Println("🚀 Setting up asx-discovery integration test environment...")

	// 1. Start fake-gcs-server container
	var err error
	gcsContainer, err = testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        "fsouza/fake-gcs-server",
			ExposedPorts: []string{"4443/tcp"},
			Cmd:          []string{"-scheme", "http", "-public-host", "localhost"},
			WaitingFor:   wait.ForListeningPort("4443/tcp"),
		},
		Started: true,
	})
	if err != nil {
		log.Fatalf("❌ Failed to start GCS container: %v", err)
	}

	host, err := gcsContainer.Host(ctx)
	if err != nil {
		log.Fatalf("❌ Failed to get GCS host: %v", err)
	}
	port, err := gcsContainer.MappedPort(ctx, "4443")
	if err != nil {
		log.Fatalf("❌ Failed to get GCS mapped port: %v", err)
	}
	
	gcsEndpoint = fmt.Sprintf("http://%s:%s", host, port.Port())
	
	// Set emulator host for both the setup and the tests
	os.Setenv("STORAGE_EMULATOR_HOST", gcsEndpoint)

	// Create the test bucket
	err = createTestBucket(ctx, "shorted-data")
	if err != nil {
		log.Fatalf("❌ Failed to create test bucket: %v", err)
	}

	log.Printf("✅ GCS container ready at %s", gcsEndpoint)

	// Run tests
	code := m.Run()

	// Cleanup
	log.Println("🧹 Cleaning up test environment...")
	if gcsContainer != nil {
		gcsContainer.Terminate(ctx)
	}

	os.Exit(code)
}

func createTestBucket(ctx context.Context, name string) error {
	client, err := storage.NewClient(ctx, option.WithoutAuthentication())
	if err != nil {
		return err
	}
	defer client.Close()

	bucket := client.Bucket(name)
	if err := bucket.Create(ctx, "test-project", nil); err != nil {
		return err
	}
	return nil
}
