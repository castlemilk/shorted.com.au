# CI Integration Tests Setup

## ✅ What Changed

Integration tests now use **testcontainers-go** in CI, providing:

- ✅ **Self-contained**: No manual database setup
- ✅ **Consistent**: Same tests locally and in CI
- ✅ **Flexible**: Tests against deployed service OR runs fully local
- ✅ **No GCP deps**: Works without any cloud credentials

## 🔄 How It Works in CI

The workflow has two modes:

### Mode 1: Test Against Deployed Preview (Preferred)

When GCP secrets are configured and backend deploys:

```yaml
- Run integration tests (testcontainers)
  if: deployed preview exists
  env:
    BACKEND_URL: ${{ deployed-shorts-url }}
  run: make test-integration-ci
```

This runs tests against the **real deployed service** using testcontainers only for test infrastructure if needed.

### Mode 2: Fully Local (Fallback)

When no preview deployment (missing secrets, failed deployment, etc.):

```yaml
- Run integration tests (local with testcontainers)
  if: no deployed preview
  run: make test-integration-local
```

This runs the **complete local setup**:

1. Testcontainers starts PostgreSQL
2. Starts shorts service locally
3. Runs all integration tests
4. Cleans up automatically

## 📋 GitHub Actions Configuration

### Docker Availability

GitHub Actions runners have Docker pre-installed:

- ✅ Ubuntu runners: Docker 20.10+
- ✅ No additional setup needed
- ✅ Testcontainers works out of the box

### Workflow Changes

**Before:**

```yaml
services:
  postgres:
    image: postgres:15
    # Manual service configuration

steps:
  - Setup database manually
  - Load schema manually
  - Run tests
```

**After:**

```yaml
steps:
  - Verify Docker is available
  - Run integration tests
    # Testcontainers handles everything
```

## 🚀 Local vs CI Comparison

| Aspect         | Local Development             | CI (with preview)          | CI (no preview)               |
| -------------- | ----------------------------- | -------------------------- | ----------------------------- |
| Database       | Testcontainers                | Deployed Cloud SQL         | Testcontainers                |
| Backend        | Local process                 | Deployed Cloud Run         | Local process                 |
| Test Execution | `make test-integration-local` | `make test-integration-ci` | `make test-integration-local` |
| Duration       | ~10 seconds                   | ~5 seconds                 | ~15 seconds                   |
| Cleanup        | Automatic                     | N/A                        | Automatic                     |

## 🔧 Makefile Commands

### test-integration-local

**Purpose**: Run complete local test environment  
**Requirements**: Docker  
**What it does**:

1. Starts PostgreSQL container (testcontainers)
2. Loads schema and sample data
3. Starts shorts service locally
4. Runs all integration tests
5. Cleans up containers and processes

**Usage:**

```bash
cd services
make test-integration-local
```

### test-integration-ci

**Purpose**: Test against deployed backend  
**Requirements**: `BACKEND_URL` environment variable  
**What it does**:

1. Validates backend is accessible
2. Runs integration tests against deployed service
3. No local service or database needed

**Usage:**

```bash
BACKEND_URL=https://shorts-pr-123.run.app
cd services
make test-integration-ci
```

## 📊 Test Results in CI

### Success Case

```
🧪 Running integration tests against deployed preview...
Backend URL: https://shorts-pr-456.run.app
Shorts URL: https://shorts-pr-456.run.app
Market Data URL: https://market-data-pr-456.run.app

Testing against: https://shorts-pr-456.run.app
✅ Backend is healthy

=== RUN   TestAPIEndpoints
--- PASS: TestAPIEndpoints (0.45s)
=== RUN   TestServiceHealth
--- PASS: TestServiceHealth (0.23s)
...
PASS
ok      github.com/castlemilk/shorted.com.au/test/integration   5.234s
```

### Fallback Case (No Preview)

```
🧪 Running integration tests with local testcontainers setup...
  📦 Testcontainers will start PostgreSQL and shorts service

🚀 Setting up integration test environment...
✅ PostgreSQL container ready at localhost:63688
✅ Database schema initialized
✅ Shorts service process started
✅ Test environment ready!

=== RUN   TestAPIEndpoints
--- PASS: TestAPIEndpoints (0.04s)
...
PASS
```

## 🐛 Troubleshooting CI Issues

### Test Timeout

```yaml
Error: test timed out after 20m0s
```

**Cause**: Container pull or startup taking too long  
**Solution**: Already configured with 20min timeout

### Docker Not Available

```
Error: Cannot connect to Docker daemon
```

**Cause**: Runner doesn't have Docker (shouldn't happen on ubuntu-latest)  
**Solution**: Verify runner type in workflow

### Testcontainers Can't Pull Images

```
Error: failed to pull image postgres:15-alpine
```

**Cause**: Network issues or rate limiting  
**Solution**: Tests will retry, usually transient

### Port Conflicts

```
Error: bind: address already in use
```

**Cause**: Previous test didn't clean up  
**Solution**: Testcontainers uses random ports, shouldn't happen

## 🎯 Benefits

### For Developers

1. **Same tests everywhere**: Local and CI use identical setup
2. **Fast feedback**: Tests run in seconds
3. **Easy debugging**: Can reproduce CI failures locally
4. **No manual setup**: Just run one command

### For CI/CD

1. **Reliable**: No flaky manual database setup
2. **Fast**: Parallel container startup
3. **Isolated**: Each test run is completely independent
4. **Cost-effective**: No persistent test databases needed

### For Testing

1. **Realistic**: Tests against real database and service
2. **Complete**: Full integration coverage
3. **Maintainable**: Standard Go testing patterns
4. **Extensible**: Easy to add more test scenarios

## 📈 Performance

### Container Startup Times

- PostgreSQL: ~5-8 seconds
- Shorts service: ~2-3 seconds
- Total overhead: ~10 seconds
- Test execution: ~5 seconds
- **Total**: ~15 seconds per run

### Resource Usage

- Memory: ~500MB (PostgreSQL + service)
- CPU: Minimal during waiting, normal during tests
- Disk: ~200MB (container images, cached after first run)

## 🔮 Future Enhancements

### Potential Improvements

- [ ] Add test database seeding with more realistic data
- [ ] Cache Docker images between workflow runs
- [ ] Add performance benchmarks to CI
- [ ] Run tests in parallel (separate test suites)
- [ ] Add integration test coverage reporting

### Migration Path

When all services use consistent schemas:

- Switch to `initializeSchemaWithMigrate()`
- Use `services/migrations` for all environments
- Remove dependency on `analysis/sql/init-db.sql`

## 📝 Related Files

- `.github/workflows/preview-test.yml` - CI workflow configuration
- `services/Makefile` - Test commands
- `test/integration/setup_test.go` - Testcontainers setup
- `test/integration/QUICKSTART.md` - Quick start guide
- `test/integration/TESTING_ARCHITECTURE.md` - Architecture details

## ✅ Verification

To verify the CI setup works:

1. **Push a branch**:

   ```bash
   git push origin feature/your-branch
   ```

2. **Check workflow run**:

   - Go to GitHub Actions
   - Find "Preview Test" workflow
   - Check "test-integration" job

3. **Expected result**:
   - ✅ Docker verification passes
   - ✅ Tests run (either against preview or locally)
   - ✅ Cleanup happens automatically
   - ✅ Workflow completes in <20 minutes
