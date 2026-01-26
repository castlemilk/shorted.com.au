//go:build integration
// +build integration

package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

var (
	postgresContainer *postgres.PostgresContainer
	gcsContainer      testcontainers.Container
	testDBURL         string
	testGCSURL        string
)

func TestMain(m *testing.M) {
	ctx := context.Background()

	log.Println("🚀 Setting up market-data-sync integration test environment...")

	// 1. Start PostgreSQL container
	var err error
	postgresContainer, err = postgres.Run(ctx,
		"postgres:15-alpine",
		postgres.WithDatabase("market_test"),
		postgres.WithUsername("test_user"),
		postgres.WithPassword("test_password"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(60*time.Second),
		),
	)
	if err != nil {
		log.Fatalf("❌ Failed to start PostgreSQL container: %v", err)
	}

	testDBURL, err = postgresContainer.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		log.Fatalf("❌ Failed to get connection string: %v", err)
	}

	// Initialize schema
	if err := initializeSchema(ctx, testDBURL); err != nil {
		log.Fatalf("❌ Failed to initialize schema: %v", err)
	}

	// 2. Start fake-gcs-server container
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
	
	testGCSURL = fmt.Sprintf("http://%s:%s", host, port.Port())

	log.Printf("✅ Test environment ready! GCS: %s", testGCSURL)

	// Run tests
	code := m.Run()

	// Cleanup
	log.Println("🧹 Cleaning up test environment...")
	if postgresContainer != nil {
		postgresContainer.Terminate(ctx)
	}
	if gcsContainer != nil {
		gcsContainer.Terminate(ctx)
	}

	os.Exit(code)
}

func initializeSchema(ctx context.Context, dbURL string) error {
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	// Minimal schema for tests
	queries := []string{
		`CREATE TABLE IF NOT EXISTS stock_prices (
			stock_code VARCHAR(10) NOT NULL,
			date DATE NOT NULL,
			open DECIMAL(10, 2),
			high DECIMAL(10, 2),
			low DECIMAL(10, 2),
			close DECIMAL(10, 2),
			adjusted_close DECIMAL(10, 2),
			volume BIGINT,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY (stock_code, date)
		)`,
		`CREATE TABLE IF NOT EXISTS sync_status (
			run_id VARCHAR(50) PRIMARY KEY,
			started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
			completed_at TIMESTAMP WITH TIME ZONE,
			status VARCHAR(20) DEFAULT 'running',
			error_message TEXT,
			checkpoint_stocks_total INTEGER,
			checkpoint_stocks_processed INTEGER,
			checkpoint_stocks_successful INTEGER,
			checkpoint_stocks_failed INTEGER
		)`,
	}

	for _, q := range queries {
		if _, err := pool.Exec(ctx, q); err != nil {
			return err
		}
	}
	return nil
}
