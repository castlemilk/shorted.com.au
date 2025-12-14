# Market Data Service - Integration Testing

## Purpose

These integration tests protect against critical production issues like:

1. **Database Connection Issues** (Port 5432 vs 6543)
2. **Hanging Queries** (Timeout problems)
3. **Prepared Statement Conflicts** (Supabase pooler compatibility)
4. **Connection Pool Exhaustion**
5. **Concurrent Request Handling**

## Tests Overview

### 1. `TestDatabaseConnection`

**Protects Against**: Port misconfiguration, SSL issues, slow connections

- **`connection_establishes_quickly`**: Verifies connection completes in < 5 seconds
  - ✅ Would have caught: Port 5432 timeout issue
- **`prepared_statements_not_conflicting`**: Runs same query multiple times
  - ✅ Would have caught: "prepared statement already exists" error
- **`connection_pool_handles_concurrency`**: Tests 10 concurrent queries
  - ✅ Would have caught: Connection pool exhaustion

### 2. `TestGetHistoricalPricesIntegration`

**Protects Against**: Hanging queries, incorrect data, missing records

Tests multiple scenarios:

- One month of data for CBA
- Three months of data for BHP
- One year of data (tests larger datasets)
- Invalid stock codes (edge case)

Each test:

- ✅ Has explicit timeout (10-15 seconds)
- ✅ Verifies query completes before timeout
- ✅ Checks data structure and validity
- ✅ Would have caught: Hanging `GetHistoricalPrices` query

### 3. `TestGetHistoricalPricesConcurrency`

**Protects Against**: Prepared statement conflicts, connection pool issues under load

- Simulates 20 concurrent requests
- Uses limited connection pool (5 connections)
- Alternates between stocks and periods
- ✅ Would have caught: Prepared statement conflicts under concurrent load

### 4. `TestQueryTimeout`

**Protects Against**: Queries that don't respect context timeouts

- Tests with very short timeout (1ms)
- Verifies query fails quickly, not hangs
- ✅ Would have caught: Missing context timeout in query execution

### 5. `TestGetHistoricalPricesNilDatabase`

**Protects Against**: Nil database connection causing panics or incorrect behavior

- Tests service behavior when database connection is nil
- Verifies proper error handling (CodeUnavailable)
- ✅ Would have caught: Missing nil check causing runtime errors

### 6. `TestGetHistoricalPricesTimezone`

**Protects Against**: Timezone mismatches causing incorrect date range queries

- Tests that dates are calculated in UTC (matching database timezone)
- Verifies date ranges are correct (within expected period)
- ✅ Would have caught: Timezone mismatch causing missing historical data

### 7. `TestDatabaseSchema`

**Protects Against**: Missing tables, schema drift

- Verifies `stock_prices` table exists
- Checks all required columns
- Ensures table has data (> 1000 rows)

## Running Tests

### Prerequisites

```bash
# Set correct DATABASE_URL (port 6543, not 5432!)
export DATABASE_URL="postgresql://postgres.xivfykscsdagwsreyqgf:661wMKAq9zdZpDk2@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres?sslmode=require"
```

### Run All Integration Tests

```bash
cd services/market-data

# Run with integration tag
go test -tags=integration -v -timeout 5m ./...
```

### Run Specific Test

```bash
# Test only database connection
go test -tags=integration -v -timeout 2m -run TestDatabaseConnection

# Test only GetHistoricalPrices
go test -tags=integration -v -timeout 3m -run TestGetHistoricalPricesIntegration

# Test only concurrency
go test -tags=integration -v -timeout 3m -run TestGetHistoricalPricesConcurrency
```

### Makefile Targets

```bash
# Run all integration tests
make test-integration

# Run specific test
make test-integration TEST=TestDatabaseConnection
```

## CI/CD Integration

Add to `.github/workflows/ci.yml`:

```yaml
test-market-data-integration:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4

    - name: Set up Go
      uses: actions/setup-go@v5
      with:
        go-version: "1.23"

    - name: Run integration tests
      working-directory: services/market-data
      env:
        DATABASE_URL: ${{ secrets.DATABASE_URL }}
      run: |
        go test -tags=integration -v -timeout 5m ./... \
          -coverprofile=integration-coverage.out

    - name: Upload coverage
      uses: codecov/codecov-action@v4
      with:
        files: ./services/market-data/integration-coverage.out
        flags: integration
```

## Expected Results

### ✅ Passing Tests (with correct configuration)

```bash
=== RUN   TestDatabaseConnection
=== RUN   TestDatabaseConnection/connection_establishes_quickly
    integration_test.go:45: Connection established in 234ms
=== RUN   TestDatabaseConnection/prepared_statements_not_conflicting
=== RUN   TestDatabaseConnection/connection_pool_handles_concurrency
--- PASS: TestDatabaseConnection (2.45s)

=== RUN   TestGetHistoricalPricesIntegration
=== RUN   TestGetHistoricalPricesIntegration/one_month_CBA
    integration_test.go:118: Query completed in 456ms
=== RUN   TestGetHistoricalPricesIntegration/one_year_CBA
    integration_test.go:118: Query completed in 1.2s
--- PASS: TestGetHistoricalPricesIntegration (5.23s)

=== RUN   TestGetHistoricalPricesConcurrency
--- PASS: TestGetHistoricalPricesConcurrency (3.45s)

PASS
coverage: 78.5% of statements
ok      github.com/castlemilk/shorted.com.au/services/market-data    11.234s
```

### ❌ Failing Tests (would catch the bugs)

#### Port 5432 Issue:

```bash
=== RUN   TestDatabaseConnection/connection_establishes_quickly
    integration_test.go:42: Failed to create connection pool:
        context deadline exceeded
    integration_test.go:48: Database connection took too long -
        check port and SSL configuration
--- FAIL: TestDatabaseConnection (10.05s)
```

#### Hanging Query Issue:

```bash
=== RUN   TestGetHistoricalPricesIntegration/one_month_CBA
    integration_test.go:147: Query timed out -
        this indicates a hanging query or connection issue
--- FAIL: TestGetHistoricalPricesIntegration (15.00s)
```

#### Prepared Statement Issue:

```bash
=== RUN   TestDatabaseConnection/prepared_statements_not_conflicting
    integration_test.go:68: Query failed on iteration 2 -
        prepared statement conflict?:
        ERROR: prepared statement "stmtcache_..." already exists
--- FAIL: TestDatabaseConnection (2.34s)
```

## Test Maintenance

### Adding New Tests

When adding new endpoints, add corresponding integration tests:

1. **Connection Test**: Verify the endpoint can connect to DB
2. **Timeout Test**: Verify queries respect context timeouts
3. **Concurrency Test**: Verify endpoint handles concurrent requests
4. **Data Validation Test**: Verify response structure and data quality

### Updating Tests

When changing database schema:

1. Update `TestDatabaseSchema` with new columns
2. Update data validation in `TestGetHistoricalPricesIntegration`

## Performance Benchmarks

These tests also serve as performance benchmarks:

- **Connection**: Should establish in < 5 seconds
- **Query (1 month)**: Should complete in < 2 seconds
- **Query (1 year)**: Should complete in < 5 seconds
- **Concurrent (20 requests)**: Should complete in < 15 seconds

If tests pass but exceed these times, investigate performance issues.
