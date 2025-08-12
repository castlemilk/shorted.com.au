package integration

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

const (
	TestDatabase = "shorts_test"
	TestUsername = "test_user"
	TestPassword = "test_password"
)

// TestContainer wraps the PostgreSQL container for integration tests
type TestContainer struct {
	Container testcontainers.Container
	Host      string
	Port      string
	DB        *pgxpool.Pool
}

// SetupTestDatabase starts a PostgreSQL container and returns connection details
func SetupTestDatabase(ctx context.Context, t *testing.T) *TestContainer {
	t.Helper()

	// Create PostgreSQL container
	postgresContainer, err := postgres.Run(ctx,
		"postgres:15-alpine",
		postgres.WithDatabase(TestDatabase),
		postgres.WithUsername(TestUsername),
		postgres.WithPassword(TestPassword),
		postgres.WithInitScripts(
			"../../migrations/000001_initial_schema.up.sql",
			"../fixtures/test_data.sql",
		),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(30*time.Second)),
	)
	require.NoError(t, err)

	// Get connection details
	host, err := postgresContainer.Host(ctx)
	require.NoError(t, err)

	mappedPort, err := postgresContainer.MappedPort(ctx, "5432")
	require.NoError(t, err)

	// Create connection pool
	connString := fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=disable",
		TestUsername, TestPassword, host, mappedPort.Port(), TestDatabase)

	pool, err := pgxpool.New(ctx, connString)
	require.NoError(t, err)

	// Test connection
	err = pool.Ping(ctx)
	require.NoError(t, err)

	return &TestContainer{
		Container: postgresContainer,
		Host:      host,
		Port:      mappedPort.Port(),
		DB:        pool,
	}
}

// ConnectionString returns the PostgreSQL connection string
func (tc *TestContainer) ConnectionString() string {
	return fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=disable",
		TestUsername, TestPassword, tc.Host, tc.Port, TestDatabase)
}

// Cleanup closes the database connection and terminates the container
func (tc *TestContainer) Cleanup(ctx context.Context, t *testing.T) {
	t.Helper()

	if tc.DB != nil {
		tc.DB.Close()
	}

	if tc.Container != nil {
		err := tc.Container.Terminate(ctx)
		require.NoError(t, err)
	}
}

// TruncateAllTables removes all data from test tables for test isolation
func (tc *TestContainer) TruncateAllTables(ctx context.Context, t *testing.T) {
	t.Helper()

	tables := []string{
		"shorts",
		"\"company-metadata\"",
		"subscriptions",
	}

	for _, table := range tables {
		_, err := tc.DB.Exec(ctx, fmt.Sprintf("TRUNCATE TABLE %s RESTART IDENTITY CASCADE", table))
		require.NoError(t, err)
	}
}

// LoadTestData executes a SQL file to load test data
func (tc *TestContainer) LoadTestData(ctx context.Context, t *testing.T, sqlFile string) {
	t.Helper()

	// Read the SQL file
	content, err := os.ReadFile(sqlFile)
	require.NoError(t, err)

	// Execute the SQL content
	_, err = tc.DB.Exec(ctx, string(content))
	require.NoError(t, err)
}

// ExecuteSQL executes arbitrary SQL for test setup
func (tc *TestContainer) ExecuteSQL(ctx context.Context, t *testing.T, sql string, args ...interface{}) {
	t.Helper()

	_, err := tc.DB.Exec(ctx, sql, args...)
	require.NoError(t, err)
}

// GetProjectRoot returns the path to the project root directory
func GetProjectRoot() string {
	wd, _ := os.Getwd()
	for {
		if _, err := os.Stat(filepath.Join(wd, "go.mod")); err == nil {
			return wd
		}
		parent := filepath.Dir(wd)
		if parent == wd {
			break
		}
		wd = parent
	}
	return ""
}

// WithTestDatabase is a helper that sets up and tears down a test database
func WithTestDatabase(t *testing.T, testFn func(*TestContainer)) {
	ctx := context.Background()
	
	container := SetupTestDatabase(ctx, t)
	defer container.Cleanup(ctx, t)

	testFn(container)
}

// SeedSampleData inserts a minimal set of test data for basic tests
func (tc *TestContainer) SeedSampleData(ctx context.Context, t *testing.T) {
	t.Helper()

	// Insert sample shorts data
	sampleShorts := `
		INSERT INTO shorts (date, product_code, product_name, total_short_position, daily_short_volume, percent_of_total_shares)
		VALUES 
			('2024-01-15', 'CBA', 'COMMONWEALTH BANK OF AUSTRALIA', 1000000, 50000, 0.12),
			('2024-01-15', 'CSL', 'CSL LIMITED', 2000000, 75000, 0.45),
			('2024-01-15', 'BHP', 'BHP GROUP LIMITED', 3000000, 100000, 0.89),
			('2024-01-16', 'CBA', 'COMMONWEALTH BANK OF AUSTRALIA', 1100000, 55000, 0.13),
			('2024-01-16', 'CSL', 'CSL LIMITED', 2100000, 80000, 0.47),
			('2024-01-16', 'BHP', 'BHP GROUP LIMITED', 3200000, 120000, 0.95);
	`
	tc.ExecuteSQL(ctx, t, sampleShorts)

	// Insert sample company metadata
	sampleMetadata := `
		INSERT INTO "company-metadata" (stock_code, company_name, sector, industry, market_cap, logo_url, website, description, exchange)
		VALUES 
			('CBA', 'Commonwealth Bank of Australia', 'Financial Services', 'Banks', 180000000000, 'https://example.com/cba-logo.png', 'https://commbank.com.au', 'Major Australian bank', 'ASX'),
			('CSL', 'CSL Limited', 'Healthcare', 'Biotechnology', 150000000000, 'https://example.com/csl-logo.png', 'https://csl.com', 'Global biotechnology company', 'ASX'),
			('BHP', 'BHP Group Limited', 'Materials', 'Mining', 200000000000, 'https://example.com/bhp-logo.png', 'https://bhp.com', 'Global mining company', 'ASX');
	`
	tc.ExecuteSQL(ctx, t, sampleMetadata)
}