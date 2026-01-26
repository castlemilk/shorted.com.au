package integration

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

var (
	postgresContainer *postgres.PostgresContainer
	testDatabaseURL   string
	shortsServiceCmd  *exec.Cmd
	shortsServicePort = "9091"
)

// TestMain sets up and tears down the test environment
func TestMain(m *testing.M) {
	ctx := context.Background()

	fmt.Println("🚀 Setting up integration test environment...")
	fmt.Println("  📦 Starting PostgreSQL container...")

	// Start PostgreSQL container
	var err error
	postgresContainer, err = postgres.Run(ctx,
		"postgres:15-alpine",
		postgres.WithDatabase("shorts_test"),
		postgres.WithUsername("test_user"),
		postgres.WithPassword("test_password"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(60*time.Second),
		),
	)
	if err != nil {
		fmt.Printf("❌ Failed to start PostgreSQL container: %v\n", err)
		os.Exit(1)
	}

	// Get database connection details
	host, err := postgresContainer.Host(ctx)
	if err != nil {
		fmt.Printf("❌ Failed to get host: %v\n", err)
		os.Exit(1)
	}
	
	port, err := postgresContainer.MappedPort(ctx, "5432")
	if err != nil {
		fmt.Printf("❌ Failed to get port: %v\n", err)
		os.Exit(1)
	}

	testDatabaseURL, err = postgresContainer.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		fmt.Printf("❌ Failed to get connection string: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("✅ PostgreSQL container ready at %s:%s\n", host, port.Port())

	// Initialize database schema
	fmt.Println("  📝 Initializing database schema...")
	if err := initializeSchema(ctx, postgresContainer); err != nil {
		fmt.Printf("❌ Failed to initialize schema: %v\n", err)
		cleanup(ctx)
		os.Exit(1)
	}
	fmt.Println("✅ Database schema initialized")

	// Set environment variables for tests and service
	os.Setenv("DATABASE_URL", testDatabaseURL)
	os.Setenv("APP_STORE_POSTGRES_ADDRESS", fmt.Sprintf("%s:%s", host, port.Port()))
	os.Setenv("APP_STORE_POSTGRES_DATABASE", "shorts_test")
	os.Setenv("APP_STORE_POSTGRES_USERNAME", "test_user")
	os.Setenv("APP_STORE_POSTGRES_PASSWORD", "test_password")
	os.Setenv("APP_PORT", shortsServicePort)
	os.Setenv("BACKEND_URL", fmt.Sprintf("http://localhost:%s", shortsServicePort))

	// Start the shorts service
	fmt.Println("  🚀 Starting shorts service...")
	if err := startShortsService(); err != nil {
		fmt.Printf("❌ Failed to start shorts service: %v\n", err)
		cleanup(ctx)
		os.Exit(1)
	}

	fmt.Println("✅ Test environment ready!")
	fmt.Println("")

	// Run tests
	code := m.Run()

	// Cleanup
	fmt.Println("")
	fmt.Println("🧹 Cleaning up test environment...")
	cleanup(ctx)

	os.Exit(code)
}

func startShortsService() error {
	// Path to the shorts service main.go
	serviceDir := "../../services"
	
	// Create log file for service output to avoid I/O blocking
	logFile, err := os.Create(filepath.Join(serviceDir, "shorts-test.log"))
	if err != nil {
		return fmt.Errorf("failed to create log file: %w", err)
	}
	
	shortsServiceCmd = exec.Command("go", "run", "shorts/cmd/server/main.go")
	shortsServiceCmd.Dir = serviceDir
	shortsServiceCmd.Stdout = logFile
	shortsServiceCmd.Stderr = logFile
	shortsServiceCmd.Env = os.Environ()

	if err := shortsServiceCmd.Start(); err != nil {
		logFile.Close()
		return fmt.Errorf("failed to start service: %w", err)
	}

	// Wait for service to be ready by checking health endpoint
	fmt.Printf("  Waiting for service to be ready on port %s...\n", shortsServicePort)
	client := &http.Client{Timeout: 2 * time.Second}
	for i := 0; i < 30; i++ {
		resp, err := client.Get(fmt.Sprintf("http://localhost:%s/health", shortsServicePort))
		if err == nil && resp != nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				fmt.Printf("✅ Shorts service ready on port %s\n", shortsServicePort)
				return nil
			}
		}
		time.Sleep(1 * time.Second)
	}
	
	return fmt.Errorf("service did not become healthy after 30 seconds")
}

func cleanup(ctx context.Context) {
	// Stop shorts service gracefully
	if shortsServiceCmd != nil && shortsServiceCmd.Process != nil {
		fmt.Println("  Stopping shorts service...")
		// Send SIGTERM for graceful shutdown
		_ = shortsServiceCmd.Process.Signal(os.Interrupt)
		// Wait a moment for graceful shutdown
		done := make(chan error)
		go func() {
			done <- shortsServiceCmd.Wait()
		}()
		select {
		case <-done:
			// Graceful shutdown completed
		case <-time.After(5 * time.Second):
			// Force kill if not shutdown in 5 seconds
			_ = shortsServiceCmd.Process.Kill()
			<-done
		}
	}

	// Stop PostgreSQL container
	if postgresContainer != nil {
		fmt.Println("  Stopping PostgreSQL container...")
		terminateCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		if err := postgresContainer.Terminate(terminateCtx); err != nil {
			fmt.Printf("  Warning: Failed to terminate PostgreSQL container: %v\n", err)
		}
	}

	// Small delay to ensure all I/O is flushed
	time.Sleep(500 * time.Millisecond)
	fmt.Println("✅ Cleanup complete")
}

func initializeSchema(ctx context.Context, container *postgres.PostgresContainer) error {
	// Use the init-db.sql for test schema (has sample data and correct uppercase columns)
	schemaPath := filepath.Join("../../analysis/sql/init-db.sql")
	schemaSQL, err := os.ReadFile(schemaPath)
	if err != nil {
		return fmt.Errorf("failed to read schema file: %w", err)
	}

	// Execute schema SQL directly via psql in container
	_, _, err = container.Exec(ctx, []string{
		"psql",
		"-U", "test_user",
		"-d", "shorts_test",
		"-c", string(schemaSQL),
	})
	if err != nil {
		return fmt.Errorf("failed to execute schema: %w", err)
	}

	fmt.Println("  📊 Sample data loaded (3 stocks with historical data)")
	return nil
}

// Alternative: Use golang-migrate for production migrations
func initializeSchemaWithMigrate(ctx context.Context, container *postgres.PostgresContainer) error {
	// Get database connection string
	connStr, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		return fmt.Errorf("failed to get connection string: %w", err)
	}

	// Path to migrations directory
	migrationsPath := "file://../../services/migrations"
	
	// Create migrate instance
	m, err := migrate.New(migrationsPath, connStr)
	if err != nil {
		return fmt.Errorf("failed to create migrate instance: %w", err)
	}
	defer m.Close()

	// Run migrations
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return fmt.Errorf("failed to run migrations: %w", err)
	}

	fmt.Println("  📊 Database migrations applied successfully")
	return nil
}

// GetTestDatabaseURL returns the connection string for the test database
func GetTestDatabaseURL() string {
	return testDatabaseURL
}
