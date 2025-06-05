# Test Strategy for Shorted.com.au

## Current State Analysis

### Testing Coverage Overview
- **Frontend**: ~0% coverage (only one test for sync script)
- **Backend**: ~0% coverage (test files exist but are empty)
- **Integration**: No integration tests
- **E2E**: No end-to-end tests

## Test Strategy Goals

1. **Immediate** (Week 1-2)
   - Critical path coverage: 40%
   - Core business logic tests
   - API endpoint tests

2. **Short-term** (Month 1)
   - Overall coverage: 60%
   - Integration tests for data flow
   - Component testing setup

3. **Long-term** (Month 2-3)
   - Overall coverage: 80%
   - E2E test suite
   - Performance testing

## Testing Pyramid

```
        ┌─────┐
        │ E2E │ 10%
      ┌─┴─────┴─┐
      │Integration│ 20%
    ┌─┴─────────┴─┐
    │ Component  │ 30%
  ┌─┴─────────────┴─┐
  │   Unit Tests   │ 40%
  └─────────────────┘
```

## Frontend Testing Strategy

### 1. Unit Tests (Priority: HIGH)

#### Components to Test First
- `StockChart` - Critical visualization component
- `DataTable` - Complex sorting/filtering logic
- Server Actions - Data fetching functions
- Utility functions - Date formatting, calculations

#### Testing Tools
- **Framework**: Jest + React Testing Library
- **Mocking**: MSW for API mocking
- **Coverage**: Istanbul

### 2. Component Tests (Priority: HIGH)

#### Key Components
```typescript
// Example test structure
- /web/src/__tests__/
  ├── components/
  │   ├── StockChart.test.tsx
  │   ├── DataTable.test.tsx
  │   └── TreeMap.test.tsx
  ├── actions/
  │   ├── getTopShorts.test.ts
  │   └── getStockData.test.ts
  └── utils/
      └── formatting.test.ts
```

### 3. Integration Tests (Priority: MEDIUM)

#### Test Scenarios
- Authentication flow
- Data fetching with error states
- Form submissions
- Navigation flows

### 4. E2E Tests (Priority: LOW)

#### Tools
- Playwright or Cypress
- Test critical user journeys:
  - View top shorts
  - Search and view stock details
  - Navigate treemap
  - Sign in/out flow

## Backend Testing Strategy

### 1. Unit Tests (Priority: HIGH)

#### Go Service Tests
```go
// services/shorts/internal/services/shorts/
├── service_test.go      // Service logic tests
├── queries_test.go      // Database query tests
├── middleware_test.go   // Auth middleware tests
└── testdata/           // Test fixtures
```

#### Test Categories
- Business logic functions
- Data transformations
- Query builders
- Error handling

### 2. Database Tests (Priority: HIGH)

#### Test Approach
- Use test database or transactions
- Test all SQL queries
- Verify indexes are used
- Test edge cases (nulls, empty results)

### 3. API Tests (Priority: HIGH)

#### Connect RPC Tests
- Test each endpoint
- Verify request/response formats
- Test error scenarios
- Authentication tests

### 4. Integration Tests (Priority: MEDIUM)

#### Test Scenarios
- End-to-end data flow
- Database to API to client
- Authentication flow
- Data sync process

## Data Sync Service Testing

### Python Tests (Priority: MEDIUM)

```python
# services/short-data-sync/tests/
├── test_data_processing.py
├── test_file_handling.py
├── test_database_operations.py
└── fixtures/
    └── sample_data.csv
```

#### Test Areas
- CSV parsing with various encodings
- Data normalization
- Bulk insert operations
- Error handling

## Implementation Plan

### Phase 1: Foundation (Week 1)

1. **Setup Testing Infrastructure**
   ```bash
   # Frontend
   npm install --save-dev @testing-library/react @testing-library/jest-dom msw
   
   # Backend
   go get github.com/stretchr/testify
   go get github.com/golang/mock
   ```

2. **Create Test Templates**
   - Component test template
   - Service test template
   - API test template

3. **CI/CD Integration**
   - Add test runs to GitHub Actions
   - Coverage reporting
   - Fail builds on test failures

### Phase 2: Critical Path Tests (Week 2)

1. **Frontend Priority Tests**
   - `getTopShorts` action
   - `StockChart` component
   - Authentication flow

2. **Backend Priority Tests**
   - `GetTopShorts` endpoint
   - Database connection/queries
   - Auth middleware

### Phase 3: Expand Coverage (Week 3-4)

1. **Additional Unit Tests**
   - All server actions
   - All API endpoints
   - Utility functions

2. **Integration Tests**
   - Data flow tests
   - Error scenario tests

### Phase 4: Advanced Testing (Month 2)

1. **Performance Tests**
   - Load testing with k6
   - Database query performance
   - Frontend bundle size

2. **E2E Tests**
   - Critical user journeys
   - Cross-browser testing

## Testing Best Practices

### 1. Test Naming Convention
```typescript
// Frontend
describe('StockChart', () => {
  it('should render chart with valid data', () => {});
  it('should handle empty data gracefully', () => {});
  it('should update when props change', () => {});
});

// Backend
func TestGetTopShorts_ValidRequest_ReturnsData(t *testing.T) {}
func TestGetTopShorts_InvalidPeriod_ReturnsError(t *testing.T) {}
```

### 2. Test Data Management
- Use factories for test data
- Keep fixtures minimal
- Use realistic data
- Clean up after tests

### 3. Mocking Strategy
- Mock external dependencies
- Use real implementations when possible
- Document mock behavior
- Keep mocks simple

### 4. Coverage Goals
- Aim for 80% coverage
- 100% for critical paths
- Focus on behavior, not lines
- Exclude generated code

## Monitoring Test Health

### Metrics to Track
1. **Coverage Percentage**
   - Overall
   - By component/service
   - Critical path coverage

2. **Test Execution Time**
   - Keep under 5 minutes for unit tests
   - Under 15 minutes for all tests

3. **Test Reliability**
   - Track flaky tests
   - Fix or remove unreliable tests

4. **Test Maintenance**
   - Time spent fixing tests
   - Test code quality

## Quick Wins

### Immediate Actions (Today)

1. **Add First Frontend Test**
   ```typescript
   // web/src/app/actions/__tests__/getTopShorts.test.ts
   ```

2. **Add First Backend Test**
   ```go
   // services/shorts/internal/services/shorts/service_test.go
   ```

3. **Setup GitHub Actions**
   ```yaml
   # .github/workflows/test.yml
   ```

### This Week

1. Test critical API endpoints
2. Test data transformation functions
3. Add component snapshot tests
4. Setup coverage reporting

## Success Criteria

- [ ] All PRs require passing tests
- [ ] Coverage increases with each PR
- [ ] No production bugs from tested code
- [ ] Tests run in < 5 minutes
- [ ] New features have tests
- [ ] Documentation for test patterns