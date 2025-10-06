package integration

import (
	"context"
	"fmt"
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
	
	shortsServiceCmd = exec.Command("go", "run", "shorts/cmd/server/main.go")
	shortsServiceCmd.Dir = serviceDir
	shortsServiceCmd.Stdout = os.Stdout
	shortsServiceCmd.Stderr = os.Stderr
	shortsServiceCmd.Env = os.Environ()

	if err := shortsServiceCmd.Start(); err != nil {
		return fmt.Errorf("failed to start service: %w", err)
	}

	// Wait for service to be ready by checking health endpoint
	fmt.Printf("  Waiting for service to be ready on port %s...\n", shortsServicePort)
	// Give it a moment to start
	time.Sleep(2 * time.Second)
	
	fmt.Printf("✅ Shorts service process started (health checks will validate readiness)\n")
	return nil
}

func cleanup(ctx context.Context) {
	// Stop shorts service
	if shortsServiceCmd != nil && shortsServiceCmd.Process != nil {
		fmt.Println("  Stopping shorts service...")
		_ = shortsServiceCmd.Process.Kill()
		_ = shortsServiceCmd.Wait()
	}

	// Stop PostgreSQL container
	if postgresContainer != nil {
		fmt.Println("  Stopping PostgreSQL container...")
		if err := postgresContainer.Terminate(ctx); err != nil {
			fmt.Printf("  Warning: Failed to terminate PostgreSQL container: %v\n", err)
		}
	}

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
