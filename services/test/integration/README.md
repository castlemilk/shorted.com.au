# Integration Tests with Test Data Seeding

This directory contains integration tests for the Shorts service with comprehensive test data seeding capabilities.

## Overview

The integration tests use **testcontainers-go** to spin up a PostgreSQL database on-demand, seed it with test data, and run tests against it. This ensures tests are:

- ✅ Self-contained and isolated
- ✅ Fast and repeatable
- ✅ Don't require external services or databases
- ✅ Can be run in parallel

## Test Data Seeding Library

### Location

- `testdata/seed.go` - Core seeding functionality
- `testdata/fixtures.go` - Test data fixtures and builders

### Key Features

**Flexible Data Generation:**

```go
// Generate test data for specific stocks
shorts, metadata, prices := testdata.GetCBATestData(startDate, 30)

// Generate data for multiple stocks
stockCodes := []string{"CBA", "BHP", "CSL"}
shorts, metadata, prices := testdata.GetMultipleStocksTestData(stockCodes, startDate, 30)

// Generate data for top shorts
shorts, metadata := testdata.GetTopShortsTestData(10, date)
```

**Time Series Generation:**

```go
// Generate 30 days of short position data
shorts := testdata.GenerateShortTimeSeries("CBA", "COMMONWEALTH BANK", startDate, 30, 0.12)

// Generate 30 days of stock prices
prices := testdata.GenerateStockPriceTimeSeries("CBA", startDate, 30, 100.0)
```

## Running Tests

### Run All Integration Tests

```bash
cd services
go test ./test/integration/... -v
```

### Run Specific Tests

```bash
# Database setup and operations
go test ./test/integration/... -v -run "TestDatabaseSetup|TestDatabaseOperations"

# Data consistency tests
go test ./test/integration/... -v -run "TestDataConsistency"

# Performance tests
go test ./test/integration/... -v -run "TestPerformance"
```

### Using Makefile

```bash
# From project root
make test-integration-local
```

## Test Structure

### TestDatabaseSetup

Tests that the PostgreSQL container spins up correctly with the schema and can seed test data.

### TestDatabaseOperations

Tests basic database operations with seeded test data:

- Querying shorts by date
- Joining with company metadata
- Validating data integrity

### TestDataConsistency

Tests data integrity constraints:

- Short percentages are valid (0-100%)
- All stocks have corresponding metadata
- Multiple dates exist in test data

### TestPerformance

Tests query performance with seeded data to ensure indexes are working.

### TestCleanup

Tests that test utilities (truncate, cleanup) work correctly.

### TestShortsServiceIntegration

Tests against a running service (skipped if service not available at `localhost:9091`).
Set `SHORTS_API_URL` environment variable to test against a different endpoint.

## Writing New Tests

### Example: Testing a New Endpoint

```go
func TestMyNewFeature(t *testing.T) {
	WithTestDatabase(t, func(container *TestContainer) {
		ctx := context.Background()
		seeder := container.GetSeeder()

		// Seed test data
		testDate := time.Now().Truncate(24 * time.Hour)
		shorts, metadata := testdata.GetTopShortsTestData(5, testDate)

		require.NoError(t, seeder.SeedCompanyMetadata(ctx, metadata))
		require.NoError(t, seeder.SeedShorts(ctx, shorts))

		// Run your test
		// ...
	})
}
```

### Adding Custom Test Data

```go
// In testdata/fixtures.go
func GetMyCustomTestData(date time.Time) ([]ShortData, []CompanyMetadata) {
	// Create custom test fixtures
	shorts := []ShortData{
		{
			Date:            date,
			ProductCode:     "TEST",
			ProductName:     "Test Company",
			TotalShortPos:   1000000,
			DailyShortVol:   50000,
			PercentOfShares: 0.5,
		},
	}

	metadata := []CompanyMetadata{
		NewCompanyMetadata("TEST", "Test Company"),
	}

	return shorts, metadata
}
```

## Environment Variables

- `SHORTS_API_URL` - URL of running shorts service (default: `http://localhost:9091`)
- `SKIP_SERVICE_TESTS` - Set to skip tests that require a running service
- `DATABASE_URL` - Override database connection string (for testing against external DB)

## Test Isolation

Each test runs in its own database container, ensuring complete isolation:

1. Container starts with fresh database
2. Migrations run automatically
3. Test seeds its own data
4. Test runs
5. Container is destroyed

This means:

- ✅ Tests can run in parallel
- ✅ Tests don't affect each other
- ✅ No cleanup needed between tests
- ✅ Consistent test results

## Performance

Typical test run time:

- Single test: ~1-3 seconds (includes container startup)
- Full test suite: ~15-20 seconds
- Containers are reused within a test session

## Troubleshooting

### "Failed to start container"

Ensure Docker is running:

```bash
docker ps
```

### "Port already in use"

Kill any processes using the test ports:

```bash
lsof -ti :5432 | xargs kill -9
```

### "Migration failed"

Check migration files exist:

```bash
ls services/migrations/*.sql
```

## Future Improvements

Potential enhancements for the test suite:

- [ ] Add support for stock_prices table when migration is added
- [ ] Add performance benchmarks
- [ ] Add load testing with larger datasets
- [ ] Add test data snapshots for regression testing
- [ ] Add API integration tests with service auto-start
