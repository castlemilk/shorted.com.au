# Integration Test Infrastructure

This directory contains comprehensive integration tests for the shorted.com.au backend services using testcontainers-go and Docker.

## Overview

The test infrastructure provides:

- **PostgreSQL test containers** with automatic schema migration
- **Sample ASIC short position data** for realistic testing
- **Full API integration tests** covering all endpoints
- **Data consistency validation** across different endpoints
- **Performance and caching tests**
- **Error handling verification**

## Directory Structure

```
test/
├── README.md                 # This documentation
├── integration/
│   ├── setup.go             # PostgreSQL container setup utilities
│   └── shorts_test.go       # Complete API integration tests
└── fixtures/
    └── test_data.sql        # Sample ASIC short position data
```

## Test Data

The test fixtures include:

- **15+ ASX stocks** with realistic short position data
- **5 days of historical data** (2024-01-15 to 2024-01-19)
- **Multiple industries**: Banking, Mining, Healthcare, Technology, Retail, Telecom
- **High short interest stocks** for edge case testing (ZIP, SPT with 20-25% short positions)
- **Company metadata** with sector, industry, and market cap information

## Running Tests

### Prerequisites

1. **Docker** installed and running
2. **Go 1.23+** installed
3. **Make** utility installed

### Local Development Tests (Recommended)

These tests use testcontainers-go to automatically manage PostgreSQL containers:

```bash
# Run integration tests with automatic container management
make test.integration.local

# Run with coverage report
make test.coverage.integration
```

### Docker Environment Tests

Run tests in a fully containerized environment:

```bash
# Start test infrastructure
make test-stack-up

# Run tests in Docker
make test.integration.docker

# Clean up
make test-stack-down
```

### End-to-End Tests

Complete automated testing pipeline:

```bash
# Full E2E test (start → test → cleanup)
make test-e2e

# Run all integration test variations
make test-all-integration
```

## Test Categories

### 1. API Integration Tests

- **GetTopShorts**: Validates top short positions with different periods and limits
- **GetStock**: Tests individual stock data retrieval
- **GetStockData**: Verifies time series data with different periods
- **GetStockDetails**: Validates company metadata retrieval
- **GetIndustryTreeMap**: Tests industry categorization and tree map data

### 2. Data Consistency Tests

- Cross-validates data between different endpoints
- Ensures GetTopShorts results match individual GetStock calls
- Verifies StockDetails consistency with Stock summary data

### 3. Error Handling Tests

- Non-existent stock codes return proper 404 errors
- Invalid parameters return validation errors
- Empty or malformed requests are handled correctly

### 4. Performance Tests

- Response time validation (< 1 second for test data)
- Concurrent request handling
- Cache effectiveness verification

### 5. Caching Tests

- Repeated requests return identical results
- Cache keys work correctly across different parameters

## Test Infrastructure Features

### PostgreSQL Container Management

```go
// Automatic container setup with migrations
container := SetupTestDatabase(ctx, t)
defer container.Cleanup(ctx, t)

// Test data isolation
container.TruncateAllTables(ctx, t)
container.SeedSampleData(ctx, t)
```

### Service Configuration

Tests create a real shorts service instance connected to the test database:

```go
shortsService := createTestShortsService(t, container)
server := httptest.NewServer(/* service handler */)
client := shortsv1alpha1connect.NewShortedStocksServiceClient(/*...*/)
```

### Data Validation

Comprehensive validation of API responses:

- Proper data types and ranges
- Non-empty required fields  
- Correct time series ordering
- Industry categorization accuracy
- Short position percentage calculations

## Environment Variables

Test configuration can be customized via environment variables:

```bash
# Database connection (automatically set by testcontainers)
DATABASE_URL=postgresql://test_user:test_password@localhost:5433/shorts_test

# API endpoint for Docker tests
SHORTS_API_URL=http://localhost:9092

# Go test flags
GO_TEST_FLAGS="-v -timeout=10m"
```

## Makefile Commands

| Command | Description |
|---------|-------------|
| `make test.integration.local` | Run testcontainer integration tests |
| `make test.integration.docker` | Run tests in Docker environment |
| `make test-stack-up` | Start PostgreSQL and Redis test containers |
| `make test-stack-down` | Stop and clean up test containers |
| `make test-stack-status` | Show test container status |
| `make test-stack-logs` | View test container logs |
| `make test-migrate-up` | Run database migrations on test DB |
| `make test-migrate-reset` | Reset test database |
| `make test-e2e` | Full end-to-end test pipeline |
| `make test-all-integration` | Run all integration test variations |
| `make test.coverage.integration` | Generate integration test coverage |
| `make test-clean` | Clean up test artifacts and containers |

## Continuous Integration

The integration tests are designed to work in CI/CD pipelines:

```yaml
# Example GitHub Actions step
- name: Run Integration Tests
  run: |
    make test.integration.local
    make test.coverage.integration
```

## Troubleshooting

### Common Issues

1. **Docker not running**
   ```
   Error: Cannot connect to the Docker daemon
   Solution: Start Docker Desktop or Docker service
   ```

2. **Port conflicts**
   ```
   Error: Port 5433 already in use
   Solution: Stop other PostgreSQL instances or change port mapping
   ```

3. **Test timeout**
   ```
   Error: Test timed out after 2m
   Solution: Increase timeout with -timeout=10m flag
   ```

### Debug Commands

```bash
# View test container logs
make test-stack-logs

# Check container status
docker ps | grep shorted

# Connect to test database
psql postgresql://test_user:test_password@localhost:5433/shorts_test
```

### Verbose Test Output

```bash
# Run with verbose output and extended timeout
go test ./test/integration/... -v -timeout=15m

# Show only failing tests
go test ./test/integration/... -v | grep -E "(FAIL|ERROR)"
```

## Contributing

When adding new tests:

1. **Follow naming conventions**: `Test{Feature}{Scenario}`
2. **Use test helpers**: `WithTestDatabase()`, `SeedSampleData()`
3. **Clean up resources**: Use `defer container.Cleanup()`
4. **Add test data**: Update `test_data.sql` for new scenarios
5. **Document test cases**: Add clear descriptions and validation steps

## Performance Benchmarks

Current test performance benchmarks (test data):

- **GetTopShorts**: < 50ms
- **GetStock**: < 20ms  
- **GetStockData**: < 100ms
- **GetStockDetails**: < 30ms
- **GetIndustryTreeMap**: < 150ms

These benchmarks help detect performance regressions in database queries and caching logic.