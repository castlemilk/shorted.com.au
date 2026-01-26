//go:build integration
// +build integration

package main

import (
	"context"
	"fmt"
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
	testDatabaseURL   string
)

// TestMain sets up and tears down the test environment
func TestMain(m *testing.M) {
	ctx := context.Background()

	fmt.Println("🚀 Setting up market-data integration test environment...")
	fmt.Println("  📦 Starting PostgreSQL container...")

	// Start PostgreSQL container
	var err error
	postgresContainer, err = postgres.Run(ctx,
		"postgres:15-alpine",
		postgres.WithDatabase("market_data_test"),
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

	// Get database connection string
	testDatabaseURL, err = postgresContainer.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		fmt.Printf("❌ Failed to get connection string: %v\n", err)
		cleanup(ctx)
		os.Exit(1)
	}

	fmt.Printf("✅ PostgreSQL container ready\n")

	// Initialize database schema
	fmt.Println("  📝 Initializing database schema...")
	if err := initializeSchema(ctx); err != nil {
		fmt.Printf("❌ Failed to initialize schema: %v\n", err)
		cleanup(ctx)
		os.Exit(1)
	}
	fmt.Println("✅ Database schema initialized")

	// Seed test data
	fmt.Println("  📊 Seeding test data...")
	if err := seedTestData(ctx); err != nil {
		fmt.Printf("❌ Failed to seed test data: %v\n", err)
		cleanup(ctx)
		os.Exit(1)
	}
	fmt.Println("✅ Test data seeded")

	// Set environment variable for tests
	os.Setenv("DATABASE_URL", testDatabaseURL)

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

func initializeSchema(ctx context.Context) error {
	// Create connection pool
	pool, err := pgxpool.New(ctx, testDatabaseURL)
	if err != nil {
		return fmt.Errorf("failed to create connection pool: %w", err)
	}
	defer pool.Close()

	// Create stock_prices table
	createTableSQL := `
		CREATE TABLE IF NOT EXISTS stock_prices (
			id SERIAL PRIMARY KEY,
			stock_code VARCHAR(10) NOT NULL,
			date DATE NOT NULL,
			open DECIMAL(10, 2),
			high DECIMAL(10, 2),
			low DECIMAL(10, 2),
			close DECIMAL(10, 2),
			adjusted_close DECIMAL(10, 2),
			volume BIGINT,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(stock_code, date)
		)
	`

	if _, err := pool.Exec(ctx, createTableSQL); err != nil {
		return fmt.Errorf("failed to create stock_prices table: %w", err)
	}

	// Create indexes
	indexes := []string{
		"CREATE INDEX IF NOT EXISTS idx_stock_prices_stock_code ON stock_prices(stock_code)",
		"CREATE INDEX IF NOT EXISTS idx_stock_prices_date ON stock_prices(date DESC)",
		"CREATE INDEX IF NOT EXISTS idx_stock_prices_stock_date ON stock_prices(stock_code, date DESC)",
	}

	for _, indexSQL := range indexes {
		if _, err := pool.Exec(ctx, indexSQL); err != nil {
			return fmt.Errorf("failed to create index: %w", err)
		}
	}

	return nil
}

func seedTestData(ctx context.Context) error {
	pool, err := pgxpool.New(ctx, testDatabaseURL)
	if err != nil {
		return fmt.Errorf("failed to create connection pool: %w", err)
	}
	defer pool.Close()

	// Insert test data for multiple stocks with historical data
	// Generate data for the last 10 years to support max period queries
	now := time.Now().UTC()
	startDate := now.AddDate(-10, 0, 0)

	testStocks := []struct {
		code      string
		basePrice float64
	}{
		{"WES", 80.0},
		{"CBA", 100.0},
		{"BHP", 45.0},
		{"CSL", 280.0},
		{"ANZ", 25.0},
		{"WBC", 22.0},
		{"NAB", 28.0},
		{"MQG", 150.0},
		{"TLS", 4.0},
		{"RIO", 120.0},
	}

	for _, stock := range testStocks {
		currentDate := startDate
		price := stock.basePrice

		for currentDate.Before(now) || currentDate.Equal(now) {
			// Skip weekends
			if currentDate.Weekday() == time.Saturday || currentDate.Weekday() == time.Sunday {
				currentDate = currentDate.AddDate(0, 0, 1)
				continue
			}

			// Simulate price movement
			change := (float64(time.Now().UnixNano()%100) - 50) / 1000.0 // Small random change
			price += change
			if price < stock.basePrice*0.9 {
				price = stock.basePrice * 0.9
			}
			if price > stock.basePrice*1.1 {
				price = stock.basePrice * 1.1
			}

			open := price
			close := price + change*0.5
			high := price + abs(change)*0.8
			low := price - abs(change)*0.8
			volume := int64(1000000 + (time.Now().UnixNano() % 5000000))

			insertSQL := `
				INSERT INTO stock_prices (stock_code, date, open, high, low, close, adjusted_close, volume)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
				ON CONFLICT (stock_code, date) DO UPDATE SET
					open = EXCLUDED.open,
					high = EXCLUDED.high,
					low = EXCLUDED.low,
					close = EXCLUDED.close,
					adjusted_close = EXCLUDED.adjusted_close,
					volume = EXCLUDED.volume
			`

			_, err := pool.Exec(ctx, insertSQL,
				stock.code,
				currentDate.Format("2006-01-02"),
				open,
				high,
				low,
				close,
				close, // adjusted_close same as close for simplicity
				volume,
			)
			if err != nil {
				return fmt.Errorf("failed to insert test data for %s: %w", stock.code, err)
			}

			currentDate = currentDate.AddDate(0, 0, 1)
		}
	}

	return nil
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}

func cleanup(ctx context.Context) {
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

// GetTestDatabaseURL returns the connection string for the test database
func GetTestDatabaseURL() string {
	return testDatabaseURL
}
