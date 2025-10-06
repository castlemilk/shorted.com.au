# Integration Testing Architecture

## Current State

### Authentication Status

- **AuthMiddleware is currently DISABLED** (commented out in `serve.go`)
- Firebase initialization has been changed to **lazy loading**
- Integration tests run **without authentication** for now

### What Gets Tested

✅ **Backend API logic** - All business logic and endpoints
✅ **Database interactions** - Real PostgreSQL queries  
✅ **Request/Response handling** - Full HTTP cycle
✅ **Data validation** - Input validation and error handling

### What's NOT Tested

❌ **Firebase Authentication** - Disabled for now
❌ **Google Cloud services** - No mocking yet
❌ **User authorization flows** - Future work

## Test Architecture

### Integration Tests (This Directory)

**Purpose**: Test backend API without external dependencies

```
┌─────────────────────────────┐
│   Integration Tests         │
│   (test/integration)        │
└──────────┬──────────────────┘
           │ HTTP Requests
           ▼
┌─────────────────────────────┐
│   Shorts Service            │
│   - Business Logic          │
│   - No Auth (disabled)      │
│   - Real Database           │
└──────────┬──────────────────┘
           │ SQL Queries
           ▼
┌─────────────────────────────┐
│   PostgreSQL Database       │
│   (Test data)               │
└─────────────────────────────┘
```

### E2E Tests (web/e2e)

**Purpose**: Test complete user flows with authentication

```
┌─────────────────────────────┐
│   E2E Tests (Playwright)    │
│   - User workflows          │
│   - Authentication flows    │
└──────────┬──────────────────┘
           │ Browser Actions
           ▼
┌─────────────────────────────┐
│   Frontend (Next.js)        │
│   - UI Components           │
│   - Firebase Auth           │
└──────────┬──────────────────┘
           │ API Calls
           ▼
┌─────────────────────────────┐
│   Backend Service           │
│   (Deployed to Cloud Run)   │
└─────────────────────────────┘
```

## Future Improvements

### 1. Mock Firebase Authentication for E2E Tests

When authentication is re-enabled, we'll need:

```go
// Test-only auth bypass
type MockAuthProvider struct{}

func (m *MockAuthProvider) VerifyToken(ctx context.Context, token string) (*AuthClaims, error) {
    // Return mock user for testing
    return &AuthClaims{UserID: "test-user"}, nil
}
```

### 2. Environment-Based Auth Toggle

```go
func NewAuthMiddleware(testMode bool) http.Handler {
    if testMode {
        return MockAuthMiddleware()
    }
    return RealAuthMiddleware()
}
```

### 3. Mock External Services

If the service adds dependencies on:

- **Cloud Storage**: Use fake-gcs-server or memory-based mock
- **BigQuery**: Use test fixtures or in-memory data
- **PubSub**: Use memory-based message queue

### 4. Test Fixtures

```bash
test/
  fixtures/
    auth/
      - mock-tokens.json
      - test-users.json
    data/
      - test-stocks.csv
      - sample-shorts.json
```

## Running Tests

### Local Development (No Auth Required)

```bash
# Run integration tests with local backend
make test-integration-local
```

This will:

1. Start shorts service on `localhost:9091` (NO Firebase needed)
2. Run all integration tests
3. Clean up automatically

### CI/CD (Against Deployed Service)

```bash
# Run integration tests against deployed backend
BACKEND_URL=https://shorts-pr-123.run.app make test-integration-ci
```

### E2E Tests (With Auth)

```bash
# Run full e2e tests (when auth is enabled)
cd web
npm run test:e2e
```

## Best Practices

### ✅ DO

- Mock external dependencies (Firebase, GCP services)
- Use test databases with isolated data
- Clean up resources after tests
- Use environment variables for configuration
- Write self-contained tests that don't depend on external state

### ❌ DON'T

- Make real API calls to external services in tests
- Require production credentials for tests
- Share state between test cases
- Rely on specific database records existing
- Leave test processes running

## Authentication Strategy for E2E Tests

When authentication is re-enabled, we'll implement:

### Option 1: Test User Accounts

- Create dedicated test Firebase accounts
- Store credentials in CI secrets
- Authenticate at test setup time

### Option 2: Mock Authentication

- Bypass Firebase in test mode
- Use test-only JWT tokens
- Validate based on test environment flag

### Option 3: Service Account Impersonation

- Use service account to generate test tokens
- Impersonate different user types (admin, regular user, etc.)
- No need for real user accounts

## Troubleshooting

### Service Won't Start

- **Check database connection**: Ensure DATABASE_URL is set
- **Port already in use**: Run `make clean.shorts`
- **Missing dependencies**: Run `go mod download`

### Tests Fail with "Connection Refused"

- Service isn't ready yet - increase retry timeout
- Check `shorts.log` for startup errors
- Verify port 9091 is available

### Firebase Errors (When Auth is Enabled)

- Ensure GOOGLE_APPLICATION_CREDENTIALS is set
- Check service account has correct permissions
- Verify Firebase project configuration

## References

- [Integration Tests README](./README.md)
- [Preview Deployment Guide](../../docs/PREVIEW_DEPLOYMENTS.md)
- [E2E Testing Guide](../../E2E_TESTING.md)
