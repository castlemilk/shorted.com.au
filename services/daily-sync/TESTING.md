# Testing Guide

## Unit Tests

The checkpoint and retry limit functionality is covered by comprehensive unit tests in `test_checkpoint_retry.py`.

### Running Tests

```bash
# Run all tests
make test-unit

# Or directly with pytest
pytest test_checkpoint_retry.py -v

# With coverage
make test-coverage
```

### Test Coverage

The test suite covers:

1. **SyncStatusRecorder Tests**:

   - Initial checkpoint data structure
   - Updating checkpoint with success/failure
   - Tracking multiple failures
   - Resetting failure count on success
   - Resuming from existing checkpoint

2. **Retry Limit Tests**:

   - Skipping permanently failed stocks (3+ failures)
   - Retrying stocks under limit (1-2 failures)
   - Marking stocks as permanently failed on 3rd failure

3. **Rate Limiting Tests**:

   - Alpha Vantage rate limit delay (12s)
   - Exponential backoff on consecutive failures
   - Circuit breaker behavior

4. **Checkpoint Resume Tests**:
   - Skipping already processed stocks
   - Resuming from correct index

### Mocking External Dependencies

All external dependencies are mocked:

- Database connections (`asyncpg`)
- Alpha Vantage API calls
- Yahoo Finance API calls
- Time delays (`asyncio.sleep`, `time.sleep`)

### Example Test Run

```bash
$ pytest test_checkpoint_retry.py -v

test_checkpoint_retry.py::TestSyncStatusRecorder::test_initial_checkpoint_data PASSED
test_checkpoint_retry.py::TestSyncStatusRecorder::test_update_checkpoint_success PASSED
test_checkpoint_retry.py::TestRetryLimits::test_skip_permanently_failed_stock PASSED
test_checkpoint_retry.py::TestRateLimiting::test_alpha_vantage_rate_limit_delay PASSED
...
======================== 12 passed in 10.62s ========================
```

## Integration Tests

For integration tests that require a real database, see `test_daily_sync.py`.

## Continuous Integration

Tests should be run in CI before deployment. Add to your CI pipeline:

```yaml
- name: Run unit tests
  run: |
    cd services/daily-sync
    pip install -r requirements.txt
    pytest test_checkpoint_retry.py -v
```
