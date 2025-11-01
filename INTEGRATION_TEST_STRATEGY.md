# Integration Test Strategy - Preventing Production Issues

## What Happened

The `GetHistoricalPrices` API was hanging in production due to:

1. **Wrong Database Port**: Using port 5432 instead of 6543
   - Result: 10-second timeout, then context deadline exceeded
   
2. **Prepared Statement Conflicts**: Not using `QueryExecModeSimpleProtocol`
   - Result: "prepared statement already exists" errors with Supabase pooler

## What Tests Would Have Caught This

### ✅ Critical Tests Created

#### 1. **Connection Speed Test**
```go
// TestDatabaseConnection/connection_establishes_quickly
// Verifies connection completes in < 5 seconds
```

**What it catches:**
- ❌ Port 5432 (times out after 10 seconds)
- ✅ Port 6543 (connects in < 1 second)
- SSL misconfiguration
- Network issues

**Failure Example:**
```
FAIL: Database connection took too long (10.5s > 5s)
      Check port and SSL configuration
```

#### 2. **Prepared Statement Test**
```go
// TestDatabaseConnection/prepared_statements_not_conflicting
// Runs same query 3 times, should never fail
```

**What it catches:**
- ❌ Default query mode (fails on 2nd query)
- ✅ Simple protocol mode (all queries succeed)

**Failure Example:**
```
FAIL: Query failed on iteration 2
      ERROR: prepared statement "stmtcache_..." already exists
```

#### 3. **Query Timeout Test**
```go
// TestGetHistoricalPricesIntegration
// Each query has explicit timeout (10-15 seconds)
```

**What it catches:**
- Hanging queries (no response)
- Slow queries (> timeout)
- Missing context timeout handling

**Failure Example:**
```
FAIL: Query timed out after 10s
      This indicates a hanging query or connection issue
```

#### 4. **Concurrency Test**
```go
// TestGetHistoricalPricesConcurrency
// 20 concurrent requests with limited pool (5 connections)
```

**What it catches:**
- Prepared statement conflicts under load
- Connection pool exhaustion
- Deadlocks
- Race conditions

**Failure Example:**
```
FAIL: Too many concurrent requests failed (15/20)
      Check connection pool and prepared statement config
```

## Test Coverage Matrix

| Issue Type | Test That Catches It | How It Catches It |
|------------|---------------------|-------------------|
| Wrong database port | `connection_establishes_quickly` | Timeout > 5s |
| SSL misconfiguration | `connection_establishes_quickly` | Connection error |
| Prepared statement conflict | `prepared_statements_not_conflicting` | Error on 2nd query |
| Hanging query | `TestGetHistoricalPricesIntegration` | Context timeout |
| No query timeout | `TestQueryTimeout` | Query doesn't respect context |
| Connection pool exhaustion | `connection_pool_handles_concurrency` | Concurrent queries fail |
| Concurrent prepared stmt conflicts | `TestGetHistoricalPricesConcurrency` | Multiple failures under load |
| Missing table/schema | `TestDatabaseSchema` | Table/column doesn't exist |
| No data in database | `TestDatabaseSchema` | Row count < threshold |

## Running Tests

### Local Development

```bash
cd services/market-data

# Export correct DATABASE_URL (port 6543!)
export DATABASE_URL="postgresql://postgres.xivfykscsdagwsreyqgf:661wMKAq9zdZpDk2@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres?sslmode=require"

# Run all integration tests
make test-integration

# Run just connection tests (quick check)
make test-integration-quick

# Run concurrency tests
make test-integration-concurrent
```

### CI/CD Pipeline

Add to `.github/workflows/ci.yml`:

```yaml
test-market-data-integration:
  runs-on: ubuntu-latest
  needs: check-secrets
  if: needs.check-secrets.outputs.has-gcp == 'true'
  
  steps:
    - name: Checkout code
      uses: actions/checkout@v4
    
    - name: Set up Go
      uses: actions/setup-go@v5
      with:
        go-version: '1.23'
    
    - name: Run integration tests
      working-directory: services/market-data
      env:
        DATABASE_URL: ${{ secrets.DATABASE_URL }}
      run: |
        go test -tags=integration -v -timeout 5m -coverprofile=integration-coverage.out ./...
    
    - name: Check coverage
      run: |
        go tool cover -func=services/market-data/integration-coverage.out
    
    - name: Fail if coverage < 80%
      run: |
        coverage=$(go tool cover -func=services/market-data/integration-coverage.out | grep total | awk '{print $3}' | sed 's/%//')
        if (( $(echo "$coverage < 80" | bc -l) )); then
          echo "Coverage $coverage% is below 80%"
          exit 1
        fi
```

## Test Timing Guidelines

Based on the actual issue, these are realistic timing expectations:

| Test | Expected Time | Max Acceptable | Issue Indicator |
|------|--------------|----------------|-----------------|
| Database connection | < 1s | 5s | > 5s = wrong port/SSL |
| Single query (1 month) | < 500ms | 2s | > 2s = missing index |
| Single query (1 year) | < 2s | 5s | > 5s = missing index |
| Concurrent 20 requests | < 10s | 15s | > 15s = pool exhaustion |

## Best Practices

### 1. **Always Use Timeouts**
```go
// ❌ BAD: No timeout
rows, err := db.Query(ctx, query, ...)

// ✅ GOOD: Explicit timeout
queryCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
defer cancel()
rows, err := db.Query(queryCtx, query, ...)
```

### 2. **Test Connection Speed**
```go
startTime := time.Now()
pool, err := pgxpool.NewWithConfig(ctx, config)
duration := time.Since(startTime)

// Should be fast
assert.Less(t, duration, 5*time.Second)
```

### 3. **Test Prepared Statements**
```go
// Run same query multiple times
for i := 0; i < 3; i++ {
    var count int
    err := pool.QueryRow(ctx, query, "CBA").Scan(&count)
    assert.NoError(t, err, "Iteration %d failed", i)
}
```

### 4. **Test Concurrency**
```go
// Simulate real-world concurrent load
for i := 0; i < 20; i++ {
    go func() {
        _, err := service.GetHistoricalPrices(ctx, req)
        results <- err
    }()
}
```

### 5. **Check Context Cancellation**
```go
select {
case <-ctx.Done():
    if ctx.Err() == context.DeadlineExceeded {
        t.Fatal("Query timed out - hanging query detected")
    }
default:
    // Good, context not cancelled
}
```

## Deployment Checklist

Before deploying any database-connected service:

- [ ] Connection test passes (< 5 seconds)
- [ ] Prepared statement test passes
- [ ] Query timeout test passes
- [ ] Concurrency test passes (> 80% success rate)
- [ ] DATABASE_URL uses correct port (6543 for Supabase pooler)
- [ ] `QueryExecModeSimpleProtocol` enabled for Supabase
- [ ] All queries have explicit timeouts
- [ ] Connection pool properly configured

## ROI of These Tests

**Time to create tests**: ~2 hours  
**Time to debug production issue**: ~4 hours  
**Future issues prevented**: Countless

**Cost of NOT having tests**:
- 4 hours debugging
- Production downtime
- Poor user experience
- Emergency fixes
- Stress and context switching

**Value of having tests**:
- Issues caught before deployment
- Confidence in changes
- Documentation of expected behavior
- Performance benchmarks
- Regression prevention

## Next Steps

1. ✅ Add tests to `services/market-data/integration_test.go`
2. ✅ Add Makefile targets for easy test execution
3. ⏳ Add to CI/CD pipeline
4. ⏳ Run tests before every deployment
5. ⏳ Expand to other services (`shorts`, `stock-price-ingestion`)
6. ⏳ Monitor test execution time (alert if tests get slower)
7. ⏳ Add performance regression tests

