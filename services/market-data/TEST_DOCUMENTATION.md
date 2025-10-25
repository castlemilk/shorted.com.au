# Enhanced ASX Stock Data Processor - Test Suite

## Overview

This comprehensive test suite validates the enhanced ASX stock data processor with mocked API calls, resilient fallback logic, and database operations. The tests ensure the system can handle various failure scenarios and maintain data quality.

## Test Structure

### 1. **Unit Tests with Mocked APIs** (`test_enhanced_processor_mocked.py`)

Tests the core logic with completely mocked external dependencies:

- **ASX Stock Resolver Tests**

  - Symbol validation and resolution
  - Stock information retrieval
  - Market cap ranking and industry filtering
  - Search functionality

- **Enhanced Processor Tests**

  - Successful Alpha Vantage data fetch
  - Fallback to Yahoo Finance when Alpha Vantage fails
  - Handling of both provider failures
  - Invalid symbol handling
  - DataFrame to database record conversion
  - Data quality validation (NaN handling)

- **Database Operation Tests**

  - Stock updates with no existing data
  - Skipping stocks with existing data
  - Handling of no data availability
  - Database insert error handling

- **Enhanced Daily Sync Tests**
  - Successful stock sync
  - Sync with fallback scenarios
  - Handling of no data scenarios
  - Concurrent sync operations

### 2. **Resilient Fallback Logic Tests** (`test_resilient_fallback.py`)

Focuses specifically on failure scenarios and recovery:

- **Alpha Vantage Failure Scenarios**

  - Rate limit errors → Yahoo Finance fallback
  - Network errors → Yahoo Finance fallback
  - Symbol not found → Yahoo Finance fallback
  - Empty data → Yahoo Finance fallback

- **Data Quality Scenarios**

  - Partial data handling
  - Corrupted data (NaN values) → Data cleaning
  - Empty data from both providers
  - Slow API responses

- **Concurrent Request Handling**

  - Mixed success/failure scenarios
  - Rate limit recovery
  - Concurrent fallback operations

- **Data Validation**
  - Data quality validation and cleaning
  - Invalid symbol handling
  - Record structure validation

### 3. **Test Configuration** (`test_config.py`)

Provides utilities and fixtures for testing:

- **Mock Database**: Simulates PostgreSQL operations
- **Test Data Generators**: Creates realistic stock data
- **Test Fixtures**: Common test scenarios
- **Test Utilities**: Validation and assertion helpers

## Running Tests

### Prerequisites

```bash
# Install test dependencies
pip install -r requirements.txt

# Set environment variables (optional for unit tests)
export DATABASE_URL="postgresql://user:pass@localhost:5432/test_db"
export ALPHA_VANTAGE_API_KEY="your-api-key"
```

### Test Commands

```bash
# Run unit tests with mocked APIs (fast, no external dependencies)
make test-unit

# Run integration tests with real APIs (slower, requires API keys)
make test-integration

# Run basic connectivity tests
make test

# Run specific test files
python -m pytest test_enhanced_processor_mocked.py -v
python -m pytest test_resilient_fallback.py -v
```

## Test Scenarios Covered

### ✅ **API Failure Handling**

1. **Alpha Vantage Rate Limiting**

   - Simulates rate limit errors
   - Validates automatic fallback to Yahoo Finance
   - Ensures data is still retrieved successfully

2. **Network Errors**

   - Simulates network timeouts and connection errors
   - Tests fallback mechanism
   - Validates error logging and recovery

3. **Symbol Not Found**

   - Tests handling of invalid symbols
   - Validates fallback to alternative provider
   - Ensures graceful degradation

4. **Empty Data Responses**
   - Tests when providers return no data
   - Validates fallback logic
   - Ensures system doesn't crash

### ✅ **Data Quality Validation**

1. **NaN Value Handling**

   - Tests data with missing values
   - Validates automatic cleaning
   - Ensures only valid records are stored

2. **Partial Data Acceptance**

   - Tests when providers return incomplete data
   - Validates data acceptance criteria
   - Ensures system continues processing

3. **Data Type Validation**
   - Tests data type conversion
   - Validates numeric constraints
   - Ensures database compatibility

### ✅ **Concurrent Operations**

1. **Mixed Success/Failure**

   - Tests concurrent requests with different outcomes
   - Validates independent processing
   - Ensures no cross-contamination

2. **Rate Limit Recovery**

   - Tests recovery from rate limiting
   - Validates retry logic
   - Ensures eventual success

3. **Concurrent Fallbacks**
   - Tests multiple fallback operations
   - Validates resource management
   - Ensures system stability

### ✅ **Database Operations**

1. **Insert Operations**

   - Tests batch insert operations
   - Validates transaction handling
   - Ensures data integrity

2. **Update Operations**

   - Tests upsert logic
   - Validates conflict resolution
   - Ensures data consistency

3. **Error Handling**
   - Tests database error scenarios
   - Validates graceful error handling
   - Ensures system continues operating

## Mock Providers

### ResilientMockProvider

Simulates various failure scenarios:

```python
# Rate limit error
provider = ResilientMockProvider("Alpha Vantage", "rate_limit")

# Network error
provider = ResilientMockProvider("Alpha Vantage", "network_error")

# Empty data
provider = ResilientMockProvider("Alpha Vantage", "empty_data")

# Corrupted data (NaN values)
provider = ResilientMockProvider("Alpha Vantage", "corrupted_data")

# Slow response
provider = ResilientMockProvider("Alpha Vantage", "slow_response")
```

### MockDatabase

Simulates PostgreSQL operations:

```python
mock_db = MockDatabase()

# Simulates existing data check
await mock_db.fetchrow("SELECT COUNT(*) FROM stock_prices WHERE stock_code = $1", "CBA")

# Simulates insert operations
await mock_db.execute("INSERT INTO stock_prices ...", ...)
```

## Test Data Generation

### Realistic Stock Data

```python
# Generate 30 days of realistic stock data
df = TestDataGenerator.generate_stock_data("CBA", days=30, start_price=100.0)

# Generate corrupted data for testing
df = TestDataGenerator.generate_corrupted_data("TEST", days=10)

# Generate empty data
df = TestDataGenerator.generate_empty_data()
```

## Assertion Utilities

### Data Quality Assertions

```python
# Validate DataFrame quality
TestUtilities.assert_dataframe_quality(df, expected_columns=['Open', 'High', 'Low', 'Close', 'Volume'])

# Validate record quality
TestUtilities.assert_records_quality(records, expected_count=5)
```

## Test Coverage

The test suite covers:

- ✅ **Symbol validation and resolution**
- ✅ **API provider initialization**
- ✅ **Data fetching with fallbacks**
- ✅ **Data quality validation**
- ✅ **Database operations**
- ✅ **Error handling and recovery**
- ✅ **Concurrent operations**
- ✅ **Rate limiting**
- ✅ **Network error handling**
- ✅ **Data transformation**
- ✅ **Record conversion**

## Continuous Integration

The tests are designed to run in CI/CD pipelines:

```yaml
# Example GitHub Actions workflow
- name: Run Unit Tests
  run: make test-unit

- name: Run Integration Tests
  run: make test-integration
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
    ALPHA_VANTAGE_API_KEY: ${{ secrets.ALPHA_VANTAGE_API_KEY }}
```

## Performance Considerations

- **Unit Tests**: Run in ~30 seconds (no external dependencies)
- **Integration Tests**: Run in ~2-3 minutes (with API calls)
- **Mocked Tests**: Run in ~10 seconds (fast execution)

## Troubleshooting

### Common Issues

1. **Import Errors**

   ```bash
   # Ensure Python path is set correctly
   export PYTHONPATH="${PYTHONPATH}:$(pwd)"
   ```

2. **Missing Dependencies**

   ```bash
   # Install all dependencies
   pip install -r requirements.txt
   ```

3. **Database Connection Issues**

   ```bash
   # Unit tests use mock database, no real DB needed
   make test-unit
   ```

4. **API Key Issues**
   ```bash
   # Set API key for integration tests
   export ALPHA_VANTAGE_API_KEY="your-key"
   ```

## Future Enhancements

- **Load Testing**: Add tests for high-volume scenarios
- **Performance Testing**: Add timing assertions
- **Memory Testing**: Add memory usage validation
- **Integration Testing**: Add tests with real database
- **End-to-End Testing**: Add complete workflow tests
