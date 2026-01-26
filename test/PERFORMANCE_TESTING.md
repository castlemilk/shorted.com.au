# Performance & Load Testing Suite

This directory contains a comprehensive performance and load testing suite for the shorted.com.au API. The suite uses multiple testing tools and approaches to thoroughly evaluate system performance under various conditions.

## Overview

The performance testing suite includes:
- **Go-based load testing** with Vegeta for high-performance load generation
- **Go benchmark tests** for detailed performance profiling of critical code paths
- **k6 JavaScript tests** for realistic user scenario simulation
- **Artillery tests** for comprehensive load testing with various scenarios
- **Performance baselines** for regression testing and SLA validation

## Architecture Coverage

The tests cover all major API endpoints:
- `GetTopShorts` - Most frequently accessed endpoint
- `GetStock` - Individual stock lookups
- `GetStockData` - Historical time series data
- `GetStockDetails` - Detailed stock metadata
- `GetIndustryTreeMap` - Complex aggregation queries

## Testing Tools

### 1. Go Load Tests (`services/test/performance/`)

**Files:**
- `load_test.go` - Vegeta-based load testing
- `benchmark_test.go` - Go benchmark tests

**Features:**
- High-performance load generation using Vegeta
- Realistic user behavior simulation
- Database connection pool testing
- Cache effectiveness validation
- Memory usage analysis
- Sustained load testing (15+ minutes)

**Usage:**
```bash
# Run all Go load tests
make perf-vegeta

# Run benchmark tests
make benchmark-test

# Test specific scenarios
make perf-concurrent
make perf-db-pool
make perf-sustained
make perf-cache
make perf-memory
```

### 2. k6 Tests (`test/k6/`)

**Files:**
- `load-test.js` - Comprehensive load testing scenarios
- `stress-test.js` - System breaking point analysis
- `spike-test.js` - Traffic spike resilience testing

**Features:**
- Realistic user journeys with think time
- Gradual load ramping and spike testing
- Custom performance metrics tracking
- HTML and JSON report generation
- Threshold-based pass/fail criteria

**Usage:**
```bash
# Standard load testing
make perf-k6

# Stress testing (up to 1000 concurrent users)
make stress-test

# Spike testing (sudden traffic bursts)
make spike-test
```

### 3. Artillery Tests (`test/artillery/`)

**Files:**
- `scenarios.yml` - Comprehensive test scenarios
- `processor.js` - Custom functions and utilities

**Features:**
- Multiple user behavior patterns
- Weighted scenario selection
- Error handling validation
- Cache effectiveness testing
- Database intensive operations
- Performance baseline validation

**Usage:**
```bash
# Run Artillery tests
make perf-artillery
```

## Test Scenarios

### Load Testing Scenarios

1. **Typical User Journey** (40% weight)
   - Browse top shorts
   - View specific stock details
   - Check historical data

2. **Power User Journey** (25% weight)
   - Multiple period analysis
   - Industry treemap exploration
   - Batch stock analysis

3. **Quick Browse** (20% weight)
   - Rapid top shorts check
   - Popular stock lookup

4. **API Stress Test** (10% weight)
   - Rapid successive requests
   - High concurrency patterns

### Concurrent User Testing

- **10 users**: Light load baseline
- **50 users**: Normal operational load
- **100 users**: Peak expected load
- **200-1000 users**: Stress and breaking point testing

### Database Testing

- Connection pool utilization under load
- Query performance with complex aggregations
- Cache hit/miss ratio analysis
- Long-running query behavior

## Performance Baselines

The `test/performance-baseline.json` file defines expected performance metrics:

### Response Time Targets
- **GetTopShorts**: P95 < 500ms, P99 < 1s
- **GetStock**: P95 < 300ms, P99 < 600ms  
- **GetStockData**: P95 < 1.5s, P99 < 3s
- **GetIndustryTreeMap**: P95 < 2s, P99 < 4s

### Throughput Targets
- **GetTopShorts**: 100 RPS sustained, 300 RPS peak
- **GetStock**: 200 RPS sustained, 500 RPS peak
- **GetStockData**: 50 RPS sustained, 100 RPS peak
- **GetIndustryTreeMap**: 25 RPS sustained, 60 RPS peak

### Error Rate Limits
- **Normal load**: < 1% error rate
- **Peak load**: < 5% error rate
- **Stress conditions**: < 15% error rate

## Running Tests

### Prerequisites

Install testing tools:
```bash
make perf-install
```

Setup test environment:
```bash
make perf-setup
```

### Quick Performance Check
```bash
# Standard performance validation
make perf-test
```

### Comprehensive Testing
```bash
# All performance tests (2+ hours)
make perf-all

# Load testing with multiple tools
make load-test
```

### Individual Endpoint Testing
```bash
make perf-test-gettopshorts
make perf-test-getstock
make perf-test-getstockdata
make perf-test-gettreemap
```

### Specialized Testing
```bash
# Test concurrent user scenarios
make perf-concurrent

# Test database connection pool
make perf-db-pool  

# 15-minute sustained load
make perf-sustained

# Cache effectiveness
make perf-cache

# Memory usage patterns
make perf-memory
```

## Test Results & Reports

### Result Locations
- **Go tests**: `services/test/performance/results/`
- **k6 tests**: `test/k6/results/`
- **Artillery tests**: `test/artillery/results/`

### Report Generation
```bash
# Generate consolidated performance report
make perf-report
```

### Key Metrics to Monitor

1. **Response Times**
   - P50, P95, P99 latencies
   - Degradation under load
   - Recovery after spikes

2. **Throughput**
   - Requests per second
   - Sustainable load levels
   - Peak capacity

3. **Error Rates** 
   - HTTP error percentages
   - Timeout occurrences
   - Database connection failures

4. **Resource Usage**
   - Memory allocation patterns
   - CPU utilization
   - Database connection pool usage

5. **System Behavior**
   - Cache hit rates
   - Database query performance
   - Connection acquisition times

## Continuous Integration

### CI Quick Tests
```bash
# Fast validation for CI/CD pipeline
make perf-ci-quick
```

### CI Full Tests  
```bash
# Comprehensive CI testing
make perf-ci-full
```

## Troubleshooting

### Common Issues

1. **Connection Refused Errors**
   - Ensure API server is running on port 9091
   - Check `BASE_URL` environment variable

2. **Database Connection Errors**
   - Verify `DATABASE_URL` is configured
   - Check database is accessible

3. **High Memory Usage**
   - Monitor for memory leaks during sustained tests
   - Check garbage collection efficiency

4. **Cache Miss Rate**
   - Verify cache configuration
   - Check cache eviction policies

### Performance Degradation

If tests show performance regression:

1. Compare against baseline metrics
2. Check recent code changes
3. Analyze database query performance
4. Monitor resource utilization trends
5. Validate cache effectiveness

## Environment Variables

- `BASE_URL`: API server URL (default: http://localhost:9091)
- `DATABASE_URL`: PostgreSQL connection string
- `PERF_BASE_URL`: Override base URL for performance tests

## Tool Versions

- **k6**: v0.47.0+
- **Artillery**: Latest via npm
- **Vegeta**: v12+ 
- **Go**: 1.23+

## Best Practices

### Running Tests

1. **Warm up the system** before measurement
2. **Run tests multiple times** for consistency
3. **Monitor system resources** during tests
4. **Use realistic test data** and scenarios
5. **Test during off-peak hours** to avoid interference

### Interpreting Results

1. **Focus on percentiles** not just averages
2. **Look for performance trends** over time
3. **Compare against baselines** regularly
4. **Identify breaking points** and limits
5. **Validate system recovery** after load

### Maintenance

1. **Update baselines** after significant changes
2. **Review test scenarios** for realism
3. **Monitor test stability** and consistency
4. **Keep tools updated** to latest versions
5. **Document performance expectations**

## Integration with Monitoring

The performance tests complement production monitoring by:
- Validating SLA compliance
- Identifying performance regressions
- Testing system limits safely
- Providing baseline metrics
- Validating infrastructure changes

For production monitoring, use the baseline metrics as alerting thresholds and performance targets.