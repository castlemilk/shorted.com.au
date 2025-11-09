# Testing Guide

## Quick Start

Before pushing your changes, run:

```bash
make test
```

This single command runs **everything** you need for pre-push validation:

1. ✅ TypeScript/ESLint linting
2. ✅ Go linting (golangci-lint)
3. ✅ Frontend unit tests
4. ✅ Backend unit tests
5. ✅ Backend integration tests

## Test Commands Reference

### Complete Test Suite

```bash
make test                    # Run EVERYTHING (lint + unit + integration)
make pre-push                # Alias for make test
make pre-commit              # Alias for make test
```

**What it does:**

- Lints all TypeScript/JavaScript code with ESLint
- Lints all Go code with golangci-lint (comprehensive static analysis)
- Runs all frontend unit tests (Jest)
- Runs all backend unit tests (Go)
- Runs backend integration tests with testcontainers (fully isolated)

**Expected output:**

```
🔍 Linting frontend...
🔍 Linting backend with golangci-lint...
🧪 Running frontend tests...
🧪 Running backend tests...
🧪 Running integration tests...

✅ All tests and linting completed successfully!
   🔍 Linting: TypeScript + Go
   🧪 Unit Tests: Frontend + Backend
   🔗 Integration Tests: Backend
```

### Individual Test Commands

```bash
# Unit tests only (no linting, no integration)
make test-unit               # Frontend + Backend unit tests
make test-frontend           # Frontend unit tests only
make test-backend            # Backend unit tests only

# Integration tests
make test-integration-local  # Backend integration tests (testcontainers)
make test-integration        # Full-stack integration tests (Docker)

# E2E tests
make test-e2e               # Playwright end-to-end tests
make test-e2e-ui            # Playwright tests in UI mode
make test-e2e-headed        # Playwright tests in headed browser
```

### Linting Commands

```bash
# Lint everything
make lint                    # Lint frontend + backend
make lint-frontend           # ESLint for TypeScript/JavaScript
make lint-backend            # golangci-lint for Go

# Quick linting (less comprehensive)
make lint-backend-quick      # go vet + go fmt (faster than golangci-lint)

# Auto-fix linting issues
make format                  # Format all code
make format-frontend         # Prettier for frontend
make format-backend          # gofmt for backend
```

### Coverage Reports

```bash
make test-coverage           # Run tests with coverage (frontend + backend)
make test-frontend-coverage  # Frontend coverage only
make test-backend-coverage   # Backend coverage only
```

## Linting Configuration

### Go (golangci-lint)

Configuration: `.golangci.yml`

**Enabled linters:**

- errcheck - Check for unchecked errors
- gosimple - Simplify code
- govet - Vet examines Go source code
- ineffassign - Detect ineffectual assignments
- staticcheck - Advanced static analysis
- unused - Check for unused code
- gofmt - Check formatting
- goimports - Check imports
- revive - Fast, configurable linter
- misspell - Find commonly misspelled words
- unconvert - Remove unnecessary type conversions
- bodyclose - Check HTTP response body closure
- noctx - Find http requests without context
- gosec - Security-focused linter
- errname - Check sentinel error naming
- errorlint - Error wrapping checks

**Installation:**
golangci-lint will be automatically installed when you run `make lint-backend` or `make test`.

Manual installation:

```bash
# macOS
brew install golangci-lint

# Linux
curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh | sh -s -- -b $(go env GOPATH)/bin v1.61.0
```

### TypeScript (ESLint)

Configuration: `web/.eslintrc.cjs` and `web/.eslintignore`

Uses Next.js recommended ESLint config with TypeScript support.

## Test Structure

### Frontend Tests (Jest)

Location: `web/src/**/__tests__/**/*.test.ts(x)`

```bash
cd web
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage
```

### Backend Unit Tests (Go)

Location: `services/**/*_test.go`

```bash
cd services
make test             # Run all unit tests
make test.shorts      # Shorts service only
make test.coverage    # With coverage
```

### Backend Integration Tests (Testcontainers)

Location: `test/integration/**/*_test.go`

Uses testcontainers for fully isolated testing:

- Automatically spins up PostgreSQL container
- Starts the shorts service
- Runs all integration tests
- Cleans up everything automatically

```bash
make test-integration-local
```

**No manual setup required!** Testcontainers handles everything.

## CI/CD Integration

The `make test` command is designed to run in CI/CD pipelines:

```yaml
# GitHub Actions example
- name: Run tests
  run: make test
```

The command will:

- Exit with code 0 if all tests pass ✅
- Exit with non-zero code if any test fails ❌
- Show clear error messages for failures

## Development Workflow

### Before Committing

```bash
# Option 1: Run everything
make test

# Option 2: Quick validation (unit tests only)
make test-unit

# Option 3: Just linting
make lint
```

### During Development

```bash
# Frontend: Watch mode for quick feedback
cd web && npm run test:watch

# Backend: Run specific tests
cd services && go test ./shorts/internal/services/shorts -v -run TestGetTopShorts
```

### Before Pushing

```bash
# Always run the full suite
make test

# Or use the alias
make pre-push
```

## Troubleshooting

### golangci-lint not found

The Makefile will auto-install it, but if you see errors:

```bash
# macOS
brew install golangci-lint

# Linux
curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh | sh -s
```

### Frontend tests failing

```bash
# Clean and reinstall
cd web
rm -rf node_modules package-lock.json
npm install
npm test
```

### Backend tests failing

```bash
# Clean test cache
cd services
go clean -testcache
make test
```

### Integration tests timeout

```bash
# Clean Docker resources
docker system prune -f
make test-integration-local
```

### Port conflicts

```bash
# Clean up stale processes
make clean-ports
```

## Performance

**Typical run times** (on M1 MacBook Pro):

| Command                       | Time    |
| ----------------------------- | ------- |
| `make lint`                   | ~30s    |
| `make test-unit`              | ~45s    |
| `make test-integration-local` | ~3-5min |
| `make test` (full suite)      | ~6-8min |

## Best Practices

1. **Always run `make test` before pushing**

   - Catches issues early
   - Ensures code quality
   - Validates integration

2. **Use watch mode during development**

   ```bash
   cd web && npm run test:watch
   ```

3. **Fix linting issues immediately**

   - Don't accumulate linting debt
   - Use auto-fix when possible: `make format`

4. **Write tests for new features**

   - Unit tests for business logic
   - Integration tests for API endpoints
   - E2E tests for critical user flows

5. **Check coverage regularly**
   ```bash
   make test-coverage
   ```

## Related Documentation

- [Backend Test Summary](BACKEND_TEST_SUMMARY.md)
- [Integration Test Strategy](INTEGRATION_TEST_STRATEGY.md)
- [E2E Testing Guide](E2E_TESTING.md)
- [CI/CD Pipeline](CI_PIPELINE_FIX_SUMMARY.md)

## Summary

**Single command to rule them all:**

```bash
make test
```

This ensures your code is:

- ✅ Well-formatted
- ✅ Lint-free
- ✅ Unit tested
- ✅ Integration tested
- ✅ Ready to push
