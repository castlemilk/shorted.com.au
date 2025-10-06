# Integration Test Setup - Summary

## ✅ What's Been Fixed

### 1. Removed GCP Dependency

- **Problem**: Service required `GOOGLE_APPLICATION_CREDENTIALS` to start, even though auth was disabled
- **Solution**: Changed Firebase initialization from `init()` to lazy loading
- **Result**: Service now starts without any GCP credentials

### 2. Local Integration Tests

- **Command**: `make test-integration-local` (from root) or `make test-integration-local` (from services/)
- **What it does**:
  1. Starts shorts service on `localhost:9091` (NO Firebase needed)
  2. Waits for service to be healthy
  3. Runs all integration tests
  4. Cleans up automatically

### 3. CI Integration Tests

- **Command**: `make test-integration-ci` (expects `BACKEND_URL` to be set)
- **What it does**:
  1. Checks backend health
  2. Runs integration tests against deployed service
  3. Reports results

### 4. Fixed Port Configuration

- Changed default from `8081` to `9091` (matches actual service port)

## Current Architecture

### What IS Being Tested

✅ **Backend API endpoints** - GetTopShorts, GetStock, GetStockData, etc.  
✅ **Database queries** - Real PostgreSQL interactions  
✅ **Business logic** - All application logic  
✅ **Request validation** - Input validation and error handling  
✅ **Response formats** - JSON serialization and structure

### What is NOT Being Tested (Yet)

❌ **Firebase Authentication** - Currently disabled (commented out)  
❌ **Google Cloud services** - None currently in use  
❌ **External APIs** - Would need mocking when added

## Key Changes Made

### 1. `services/shorts/internal/services/shorts/middleware.go`

```go
// Before: init() would crash if Firebase couldn't initialize
func init() {
    app, err := firebase.NewApp(ctx, nil)
    if err != nil {
        log.Fatalf("error initializing app: %v\n", err)  // FATAL!
    }
    firebaseApp = app
}

// After: Lazy loading, only initializes when auth is actually needed
func initFirebase() (*firebase.App, error) {
    firebaseAppOnce.Do(func() {
        firebaseApp, firebaseAppErr = firebase.NewApp(ctx, nil)
        // Logs error but doesn't crash
    })
    return firebaseApp, firebaseAppErr
}
```

### 2. `services/Makefile`

- Removed `GOOGLE_APPLICATION_CREDENTIALS` requirement
- Added robust error handling and logging
- Added health checks before running tests

### 3. `.github/workflows/preview-test.yml`

- Set `BACKEND_URL` to deployed service URL
- Added health check verification
- Uses makefile command for consistency

## Running Tests

### Local Development

```bash
# From project root
make test-integration-local

# Or from services directory
cd services
make test-integration-local
```

**Output:**

```
🚀 Starting local integration test environment...
📦 Starting local shorts service on port 9091 (without GCP credentials)...
  Note: Firebase auth is disabled for integration tests
⏳ Waiting for service to be ready...
✅ Service is ready on port 9091

🧪 Running integration tests...
=== RUN   TestAPIEndpoints
=== RUN   TestAPIEndpoints/GetTopShorts_API
=== RUN   TestAPIEndpoints/GetStock_API
...
✅ Integration tests passed!
```

### CI/CD

```bash
# Set backend URL from deployment
export BACKEND_URL=https://shorts-pr-123.run.app

# Run tests
cd services
make test-integration-ci
```

## Future: When Authentication is Re-Enabled

When you uncomment `AuthMiddleware` in `serve.go`, you'll need:

### Option 1: Environment-Based Auth Toggle

```go
// In config
type Config struct {
    TestMode bool  // Set via APP_TEST_MODE env var
    // ... other config
}

// In serve.go
if !s.config.TestMode {
    shortsHandler = AuthMiddleware(shortsHandler)
}
```

### Option 2: Mock Auth Provider

```go
// Create interface
type AuthProvider interface {
    VerifyToken(ctx context.Context, token string) (*Claims, error)
}

// Production implementation
type FirebaseAuthProvider struct { ... }

// Test implementation
type MockAuthProvider struct { ... }

func (m *MockAuthProvider) VerifyToken(ctx context.Context, token string) (*Claims, error) {
    // Return test user
    return &Claims{UserID: "test-user", Email: "test@example.com"}, nil
}
```

### Option 3: Test Tokens

```go
// Generate test JWT tokens
func generateTestToken(userID string) string {
    // Create JWT with known secret for testing
    return jwt.Sign(...)
}

// In tests
resp := makeRequest("GetTopShorts", req, "Authorization": generateTestToken("test-user"))
```

## Best Practices

### ✅ Integration Tests SHOULD:

- Test the API endpoints directly
- Use real database connections (test DB)
- Be self-contained and repeatable
- Run without external service dependencies
- Mock external APIs (Firebase, third-party services)

### ❌ Integration Tests Should NOT:

- Require production credentials
- Make real calls to external services
- Depend on specific production data
- Share state between tests
- Leave resources dangling

## Troubleshooting

### "Connection refused" error

```bash
# Check if port is already in use
lsof -i :9091

# Clean up any dangling processes
cd services
make clean.shorts
```

### Service fails to start

```bash
# Check the log file
cat services/shorts.log

# Common issues:
# - Database not accessible
# - Port already in use
# - Missing environment variables
```

### Tests timeout

```bash
# Increase retry count in health_test.go
maxRetries = 30  # Currently 30 attempts = 60 seconds
retryDelay = 2 * time.Second
```

## Next Steps

1. **Run integration tests locally**:

   ```bash
   make test-integration-local
   ```

2. **Verify CI tests pass** in next PR

3. **When auth is re-enabled**: Implement one of the auth mocking strategies above

4. **If external services are added**: Create mock implementations

## Files Changed

- ✅ `services/shorts/internal/services/shorts/middleware.go` - Lazy Firebase loading
- ✅ `services/Makefile` - Integration test commands
- ✅ `test/integration/health_test.go` - Changed default port to 9091
- ✅ `.github/workflows/preview-test.yml` - Set BACKEND_URL, use makefile
- ✅ `test/integration/README.md` - Updated documentation
- ✅ `test/integration/TESTING_ARCHITECTURE.md` - Architecture guide
- ✅ `Makefile` - Added root-level integration test command

## Documentation

- [Integration Tests README](./test/integration/README.md)
- [Testing Architecture](./test/integration/TESTING_ARCHITECTURE.md)
- [E2E Testing Guide](./E2E_TESTING.md)
