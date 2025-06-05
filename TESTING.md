# Testing Guide

This document provides comprehensive guidance for running and maintaining tests in the Shorted.com.au project.

## Overview

The project uses a multi-layered testing strategy:

- **Unit Tests**: Test individual components and functions in isolation
- **Integration Tests**: Test API endpoints and database interactions  
- **E2E Tests**: Test complete user workflows across the full stack
- **Performance Tests**: Validate response times and concurrent load handling

## Test Structure

```
├── web/
│   ├── src/**/*.test.ts(x)     # Frontend unit tests
│   ├── e2e/*.spec.ts           # Playwright E2E tests
│   └── playwright.config.ts    # Playwright configuration
├── services/
│   └── **/*_test.go            # Backend unit tests
└── test/
    └── integration/            # Full-stack integration tests
        ├── health_test.go      # Service health checks
        ├── api_test.go         # API endpoint tests
        └── e2e_test.go         # End-to-end workflows
```

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Node.js 18+
- Go 1.23+
- Git

### Running All Tests

```bash
# Install dependencies
make install

# Run all unit tests
make test

# Run all integration tests
make test-all-integration

# Run everything
make ci-test
```

## Detailed Testing Guide

### 1. Unit Tests

#### Frontend Unit Tests

```bash
# Run tests once
cd web && npm test

# Watch mode (re-runs on file changes)
cd web && npm run test:watch

# With coverage report
cd web && npm run test:coverage

# Run specific test file
cd web && npm test -- StockChart.test.tsx
```

**Coverage Requirements:**
- Lines: 40% minimum (target: 80%)
- Functions: 40% minimum (target: 80%)
- Branches: 40% minimum (target: 80%)
- Statements: 40% minimum (target: 80%)

#### Backend Unit Tests

```bash
# Run all Go tests
cd services && make test

# Run with coverage
cd services && make test.coverage

# Run specific service tests
cd services && make test.shorts

# Run specific test
cd services && go test -v ./shorts/internal/services/shorts -run TestGetTopShorts
```

### 2. Integration Tests

Integration tests run against a full test environment with:
- PostgreSQL test database
- Backend services in Docker containers
- Frontend application

#### Starting Test Environment

```bash
# Start all test services
make test-stack-up

# Check service status
make test-stack-status

# View service logs
make test-stack-logs

# Stop test services
make test-stack-down
```

#### Running Integration Tests

```bash
# Full integration test suite
make test-integration

# Manual integration test run (after test-stack-up)
cd test/integration && go test -v ./...

# Run specific integration test
cd test/integration && go test -v -run TestServiceHealth
```

### 3. End-to-End (E2E) Tests

E2E tests use Playwright to test complete user workflows in real browsers.

#### Running E2E Tests

```bash
# Run E2E tests (starts test environment automatically)
make test-e2e

# Run with Playwright UI (interactive mode)
make test-e2e-ui

# Run E2E tests manually (after test-stack-up)
cd web && npm run test:e2e

# Run specific E2E test
cd web && npx playwright test homepage.spec.ts

# Debug mode
cd web && npm run test:e2e:debug

# Run in specific browser
cd web && npx playwright test --project=chromium
```

#### Playwright Configuration

Tests run across multiple browsers:
- Desktop Chrome
- Desktop Firefox  
- Desktop Safari
- Mobile Chrome (Pixel 5)
- Mobile Safari (iPhone 12)

#### E2E Test Categories

1. **Homepage Tests** (`homepage.spec.ts`)
   - Page loading
   - Navigation menu
   - Stock table functionality
   - Period filtering
   - Mobile responsiveness

2. **Stock Detail Tests** (`stock-detail.spec.ts`)
   - Stock information display
   - Chart functionality
   - Time period selection
   - Error handling

3. **TreeMap Tests** (`treemap.spec.ts`)
   - Visualization loading
   - Hover interactions
   - Click navigation
   - Industry filtering

4. **API Integration Tests** (`api-integration.spec.ts`)
   - Error handling
   - Slow responses
   - Empty responses
   - Retry logic

5. **User Authentication Tests** (`user-auth.spec.ts`)
   - Login/logout flows
   - Authentication state
   - Protected routes

### 4. Performance Tests

Performance tests are included in the integration test suite:

```bash
# Run performance-focused tests
cd test/integration && go test -v -run TestPerformance
```

**Performance Criteria:**
- Homepage load: < 5 seconds
- API health check: < 1 second
- Database queries: < 5 seconds
- Concurrent requests: 50%+ success rate

### 5. CI/CD Testing

Tests run automatically in GitHub Actions:

- **Frontend Tests**: Unit tests + linting
- **Backend Tests**: Unit tests + coverage
- **Integration Tests**: Full-stack API testing
- **E2E Tests**: Cross-browser Playwright tests
- **Build Tests**: Verify production builds

#### Viewing CI Results

- Test results are available in the GitHub Actions tab
- Coverage reports are uploaded to Codecov
- Playwright reports are available as GitHub artifacts

## Test Data and Fixtures

### Database Test Data

The integration test database is populated with:
- Sample stock data (if available)
- Test company metadata
- Sample short position data

### Mock Data

E2E tests can use mocked API responses for testing edge cases:

```typescript
// Mock API failure
await page.route('**/GetTopShorts', route => {
  route.fulfill({
    status: 500,
    body: JSON.stringify({ error: 'Server Error' })
  });
});
```

## Debugging Tests

### Frontend Debugging

```bash
# Debug Jest tests
cd web && npm test -- --runInBand --no-cache

# Debug Playwright tests
cd web && npx playwright test --debug

# Headed mode (see browser)
cd web && npx playwright test --headed
```

### Backend Debugging

```bash
# Verbose Go test output
cd services && go test -v ./...

# Run with debugging
cd services && go test -v -run TestSpecificTest ./shorts/internal/services/shorts
```

### Integration Environment Debugging

```bash
# Check service health
curl http://localhost:8081/health
curl http://localhost:3001/api/health

# View database
docker exec -it integration_postgres-test_1 psql -U test_user -d shorted_test

# Check service logs
make test-stack-logs

# Access individual service logs
docker logs integration_shorts-service-test_1
docker logs integration_web-test_1
```

## Test Maintenance

### Adding New Tests

1. **Unit Tests**: Add `*.test.ts(x)` files next to source code
2. **Integration Tests**: Add test functions to `test/integration/*.go`
3. **E2E Tests**: Add `*.spec.ts` files to `web/e2e/`

### Updating Test Data

1. Update test database fixtures in `test/integration/docker-compose.test.yml`
2. Update mock data in test files
3. Refresh test snapshots if using snapshot testing

### Test Performance

Monitor test execution times:

```bash
# Time frontend tests
cd web && time npm test

# Time backend tests  
cd services && time make test

# Time integration tests
time make test-integration
```

## Troubleshooting

### Common Issues

1. **Tests fail locally but pass in CI**
   - Check environment variables
   - Verify test data consistency
   - Check for timing issues

2. **Database connection errors**
   - Ensure test database is running: `make test-stack-status`
   - Check connection parameters in docker-compose.test.yml

3. **Frontend tests timeout**
   - Increase timeout in playwright.config.ts
   - Check for proper test cleanup

4. **Flaky E2E tests**
   - Add explicit waits for dynamic content
   - Use proper Playwright locators
   - Check for race conditions

### Getting Help

1. Check GitHub Actions logs for CI failures
2. Run tests locally with verbose output
3. Check service health endpoints
4. Review test environment logs with `make test-stack-logs`

## Best Practices

### Writing Tests

1. **Test behavior, not implementation**
2. **Use descriptive test names**
3. **Keep tests independent and isolated**
4. **Mock external dependencies**
5. **Test edge cases and error conditions**

### Maintaining Tests

1. **Keep tests up-to-date with code changes**
2. **Remove obsolete tests**
3. **Monitor test execution time**
4. **Review test coverage regularly**
5. **Update test data as needed**

### Performance

1. **Run fast tests first**
2. **Parallelize where possible**
3. **Use appropriate test granularity**
4. **Clean up test resources**
5. **Monitor CI build times**