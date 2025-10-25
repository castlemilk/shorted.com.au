# Search Functionality Test Suite

This document describes the comprehensive test suite for the new stock search functionality implemented in the Go backend and React frontend.

## Overview

The search functionality allows users to search for ASX stocks by stock code or company name, with real-time dropdown results and comprehensive error handling. The test suite covers:

- **Integration Tests**: Backend API functionality
- **E2E Tests**: Full user workflows
- **Performance Tests**: Response times and caching
- **Security Tests**: Input validation and SQL injection protection
- **Frontend Tests**: UI components and user interactions

## Test Structure

### 1. Integration Tests (`test/integration/`)

#### `api_test.go`

- **SearchStocks API Tests**: Core API functionality
  - Valid search queries (stock codes, company names)
  - Invalid inputs (empty queries, special characters)
  - Limit parameter validation
  - Response format validation
  - Error handling

#### `search_e2e_test.go`

- **Search Performance Tests**: Response time benchmarks
- **Search Cache Behavior**: Caching effectiveness
- **Search Result Consistency**: Data consistency across requests
- **Search Edge Cases**: Special characters, mixed case, high limits
- **Concurrent Search Requests**: Load testing
- **Search Load Testing**: Performance under load

### 2. Frontend E2E Tests (`web/e2e/search.spec.ts`)

#### Playwright-based tests covering:

- **Search Input Display**: UI components visibility
- **Search Dropdown**: Real-time results display
- **Search Execution**: Button clicks and keyboard navigation
- **Error Handling**: Graceful error states
- **Responsive Design**: Mobile, tablet, desktop layouts
- **Loading States**: User feedback during searches
- **API Error Simulation**: Network failures and timeouts

### 3. CI Pipeline Tests (`.github/workflows/search-tests.yml`)

#### Test Jobs:

1. **Integration Tests**: Backend API with PostgreSQL
2. **Search API Tests**: Dedicated search endpoint testing
3. **Frontend Tests**: Unit tests and build validation
4. **E2E Tests**: Full-stack user workflows
5. **Performance Tests**: Response time and load testing
6. **Security Tests**: Input validation and injection protection

## Test Data

### Sample Test Queries

```go
testCases := []struct {
    name        string
    query       string
    limit       int32
    expectError bool
    minResults  int
}{
    {
        name:        "Search by stock code CBA",
        query:       "CBA",
        limit:       10,
        expectError: false,
        minResults:  1,
    },
    {
        name:        "Search by company name containing Bank",
        query:       "Bank",
        limit:       10,
        expectError: false,
        minResults:  0, // May or may not have results
    },
    {
        name:        "Search with empty query",
        query:       "",
        limit:       10,
        expectError: true,
        minResults:  0,
    },
}
```

### Expected Response Format

```json
{
  "query": "CBA",
  "stocks": [
    {
      "product_code": "CBA",
      "name": "COMMONWEALTH BANK. ORDINARY",
      "percentage_shorted": 1.25,
      "total_product_in_issue": 1000000.0,
      "reported_short_positions": 12500.0
    }
  ],
  "count": 1
}
```

## Performance Benchmarks

### Response Time Thresholds

- **Stock code search**: < 1 second
- **Company name search**: < 2 seconds
- **Single character search**: < 2 seconds
- **Broad search with high limit**: < 5 seconds

### Cache Performance

- **Cache hit**: Should be faster than cache miss
- **Cache consistency**: Multiple requests should return identical results
- **Cache TTL**: 5 minutes (configurable)

## Security Tests

### Input Validation

- **SQL Injection**: Protection against malicious SQL queries
- **XSS Prevention**: Script tag filtering
- **Path Traversal**: Directory traversal protection
- **Special Characters**: Graceful handling of special characters

### Error Handling

- **Empty queries**: Proper error responses
- **Invalid limits**: Boundary validation
- **Network timeouts**: Graceful degradation
- **API errors**: User-friendly error messages

## Running Tests

### Local Development

#### Integration Tests

```bash
cd test/integration
go test -v -timeout 10m ./...
```

#### Frontend Tests

```bash
cd web
npm run test:unit
npm run test:e2e
```

#### Full Test Suite

```bash
# Start services
make dev-backend &
make dev-frontend &

# Run tests
make test-integration
make test-e2e
```

### CI Pipeline

Tests run automatically on:

- **Push to main/develop**: Full test suite
- **Pull requests**: Full test suite
- **Feature branches**: Integration and API tests

## Test Environment

### Database Setup

- **PostgreSQL 15**: Test database with sample data
- **Testcontainers**: Isolated test environment
- **Sample Data**: 3 stocks with historical data (CBA, BHP, WBC)

### Service Configuration

```bash
# Environment variables for tests
DATABASE_URL=postgres://test_user:test_password@localhost:5432/shorts_test?sslmode=disable
APP_STORE_POSTGRES_ADDRESS=localhost:5432
APP_STORE_POSTGRES_DATABASE=shorts_test
APP_STORE_POSTGRES_USERNAME=test_user
APP_STORE_POSTGRES_PASSWORD=test_password
APP_PORT=9091
BACKEND_URL=http://localhost:9091
```

## Test Coverage

### Backend Coverage

- ✅ Search API endpoint (`/api/stocks/search`)
- ✅ Database query functionality
- ✅ Caching implementation
- ✅ Error handling
- ✅ Input validation
- ✅ Performance benchmarks

### Frontend Coverage

- ✅ Search input component
- ✅ Dropdown results display
- ✅ Search button functionality
- ✅ Keyboard navigation
- ✅ Loading states
- ✅ Error handling
- ✅ Responsive design

### Integration Coverage

- ✅ Full user workflows
- ✅ API-to-database integration
- ✅ Frontend-to-backend communication
- ✅ Caching behavior
- ✅ Performance under load
- ✅ Security validation

## Monitoring and Alerts

### Test Metrics

- **Response times**: Tracked and reported
- **Success rates**: Monitored across test runs
- **Cache hit rates**: Performance optimization
- **Error rates**: Quality assurance

### Failure Handling

- **Automatic retries**: For flaky tests
- **Test artifacts**: Logs and screenshots preserved
- **Notification**: Failed tests reported to team
- **Rollback**: Automatic rollback on critical failures

## Maintenance

### Regular Updates

- **Test data**: Keep sample data current
- **Performance thresholds**: Adjust based on infrastructure
- **Security tests**: Update with new attack vectors
- **Browser compatibility**: Test on latest browsers

### Test Optimization

- **Parallel execution**: Tests run in parallel where possible
- **Test isolation**: Each test is independent
- **Resource cleanup**: Proper cleanup after tests
- **Caching**: Reuse test containers and dependencies

## Troubleshooting

### Common Issues

#### Test Failures

1. **Database connection**: Check PostgreSQL service
2. **Service startup**: Verify backend service health
3. **Network timeouts**: Increase timeout values
4. **Resource limits**: Check memory and CPU usage

#### Performance Issues

1. **Slow queries**: Check database indexes
2. **Cache misses**: Verify cache configuration
3. **Network latency**: Check service connectivity
4. **Resource contention**: Monitor system resources

### Debug Commands

```bash
# Check service health
curl http://localhost:9091/health

# Test search API directly
curl "http://localhost:9091/api/stocks/search?q=CBA&limit=5"

# Check database connection
psql postgres://test_user:test_password@localhost:5432/shorts_test

# View test logs
tail -f services/shorts-test.log
```

## Future Enhancements

### Planned Improvements

- **Fuzzy search**: Implement fuzzy matching
- **Search suggestions**: Auto-complete functionality
- **Search analytics**: Track search patterns
- **Advanced filtering**: Filter by industry, market cap
- **Search history**: User search history
- **Personalized results**: User-specific rankings

### Test Enhancements

- **Visual regression tests**: UI consistency
- **Accessibility tests**: WCAG compliance
- **Internationalization**: Multi-language support
- **Mobile-specific tests**: Native mobile testing
- **API versioning**: Backward compatibility tests
