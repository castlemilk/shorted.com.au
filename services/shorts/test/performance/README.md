# Performance Tests

## Quick Start

Performance tests are **opt-in** and require explicit enabling:

```bash
# Run performance tests (requires Docker)
RUN_PERFORMANCE_TESTS=1 go test -v ./shorts/test/performance/...

# Or run a specific test
RUN_PERFORMANCE_TESTS=1 go test -v -run TestGetTopShortsLoadTest ./shorts/test/performance/...
```

## Why Are They Disabled By Default?

Performance tests:

- ⏱️ Take several minutes to run (setup + execution)
- 🐳 Require Docker for testcontainers
- 📊 Generate load on the service
- 💾 Create temporary containers and processes

They're meant for:

- Pre-release performance validation
- Performance regression testing
- Load testing before deployments
- Investigating performance issues

## How It Works

When `RUN_PERFORMANCE_TESTS=1` is set:

1. **Check existing service**: If service is already running on port 9091, uses it
2. **Start PostgreSQL**: Spins up container with testcontainers
3. **Load schema**: Initializes test database
4. **Start service**: Runs shorts service locally
5. **Run tests**: Executes performance tests
6. **Cleanup**: Stops service and removes containers

## Available Tests

### Load Tests

- `TestGetTopShortsLoadTest` - Tests GetTopShorts endpoint under load
- `TestGetStockLoadTest` - Tests GetStock endpoint
- `TestGetStockDataLoadTest` - Tests GetStockData endpoint
- `TestGetIndustryTreeMapLoadTest` - Tests tree map endpoint

### Scenario Tests

- `TestConcurrentUsersScenario` - Simulates 10-200 concurrent users
- `TestDatabaseConnectionPoolUnderLoad` - Tests DB connection pooling
- `TestSustainedLoad` - 15-minute sustained load test

## Running Without Setup

If you already have the service running:

```bash
# Terminal 1: Start service manually
cd services
make run.shorts

# Terminal 2: Run performance tests (will detect running service)
RUN_PERFORMANCE_TESTS=1 go test -v ./shorts/test/performance/...
```

## CI/CD

Performance tests are **not run in CI** by default. They can be triggered manually:

```bash
# In CI workflow
- name: Run performance tests
  if: github.event.label.name == 'performance-test'
  env:
    RUN_PERFORMANCE_TESTS: "1"
  run: go test -v ./shorts/test/performance/...
```

## Test Output

Tests generate:

- Console logs with metrics
- JSON results in `results/` directory
- Performance baseline comparisons

Example output:

```
✅ Performance test environment ready!

=== RUN   TestGetTopShortsLoadTest
=== RUN   TestGetTopShortsLoadTest/Light_Load
    Performance Metrics:
    - Requests: 300
    - Success Rate: 100.00%
    - Mean Latency: 45ms
    - P95 Latency: 78ms
    - P99 Latency: 95ms
--- PASS: TestGetTopShortsLoadTest/Light_Load (30.1s)
```

## Troubleshooting

### Tests skip immediately

✅ **Expected behavior!** Set `RUN_PERFORMANCE_TESTS=1` to enable

### Service won't start

- Check port 9091 is available: `lsof -i :9091`
- Clean up: `cd services && make clean.shorts`
- Check Docker is running

### Container startup fails

- Ensure Docker is running
- Check Docker has enough resources
- Try pulling image manually: `docker pull postgres:15-alpine`

### Tests timeout

- Increase timeout: `go test -timeout 30m ...`
- Check service logs in stdout/stderr
- Verify database connectivity

## Performance Baselines

Expected performance for reference hardware (M1 Mac, 16GB RAM):

| Endpoint     | RPS | Mean Latency | P95 Latency | P99 Latency |
| ------------ | --- | ------------ | ----------- | ----------- |
| GetTopShorts | 100 | 45ms         | 78ms        | 95ms        |
| GetStock     | 150 | 32ms         | 65ms        | 82ms        |
| GetStockData | 80  | 58ms         | 95ms        | 120ms       |

## Contributing

When adding performance tests:

1. Add skip check: `if !serviceReady { t.Skip(...) }`
2. Use reasonable durations (30-60 seconds for load tests)
3. Document expected performance in comments
4. Save results for tracking over time
