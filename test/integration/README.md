# Integration Testing

This directory contains **integration tests** that validate the backend API against a running service.

## Test Types

### Integration Tests (This Directory)

- **Purpose**: Test the backend API endpoints and service behavior
- **Environment**: Can run against local OR deployed services
- **Scope**: Backend API only (no frontend)
- **Authentication**: Direct API calls, no user authentication needed

### E2E Tests (web/e2e)

- **Purpose**: Test complete user flows through the web UI
- **Environment**: Runs against deployed preview environments
- **Scope**: Full stack (frontend + backend + database)
- **Authentication**: Simulates real user authentication

## Test Categories

### 1. Health Check Tests (`health_test.go`)

- Basic connectivity tests
- Service startup validation
- Database connectivity

### 2. API Integration Tests (`api_test.go`)

- GetTopShorts endpoint
- GetStock endpoint
- GetStockData endpoint
- Input validation
- Rate limiting
- Response format validation

### 3. E2E User Flows (`e2e_test.go`)

- Complete user journeys
- Cross-service interaction testing
- Data consistency validation

## Running Tests

### Local Development

Run integration tests against a **local** backend service:

```bash
# From services/ directory
cd services
make test-integration-local
```

This will:

1. Start the shorts service on `localhost:9091`
2. Run integration tests
3. Clean up the service

### CI/CD Environment

Integration tests in CI run against the **deployed preview** backend:

```bash
# CI sets BACKEND_URL automatically
BACKEND_URL=https://shorts-pr-123.run.app make test-integration-ci
```

### Manual Testing Against Remote Service

```bash
# Test against any deployed backend
cd test/integration
BACKEND_URL=https://your-backend-url.run.app go test -v ./...
```

## Environment Variables

- `BACKEND_URL` - Backend service URL (default: `http://localhost:9091`)
- `FRONTEND_URL` - Frontend URL for e2e tests (default: `http://localhost:3001`)
- `DATABASE_URL` - Direct database connection (for data validation)

## Test Configuration

Tests automatically retry connections with:

- **Max Retries**: 30 attempts
- **Retry Delay**: 2 seconds between attempts
- **Timeout**: 10 minutes per test

This allows services time to start up and become healthy.

## Prerequisites

- Go 1.23+
- Running backend service (local or deployed)
- Network access to backend service

## Test Architecture

```
┌─────────────────────────────────────┐
│  Integration Tests (this dir)      │
│  - Direct API calls                 │
│  - No browser/UI needed             │
│  - Tests backend logic              │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Backend Service                    │
│  - REST/gRPC endpoints              │
│  - Business logic                   │
│  - Database queries                 │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Database                           │
│  - PostgreSQL                       │
│  - Test data                        │
└─────────────────────────────────────┘
```

## Troubleshooting

### Connection Refused Errors

If you see `connection refused` errors:

1. **Check if service is running**:

   ```bash
   curl http://localhost:9091/health
   ```

2. **Verify the port**:

   - Local development uses port `9091`
   - Make sure `BACKEND_URL` is set correctly

3. **Check for conflicting processes**:

   ```bash
   lsof -i :9091
   ```

4. **Clean up dangling processes**:
   ```bash
   cd services
   make clean.shorts
   ```

### Tests Timing Out

If tests timeout waiting for the service:

1. Increase retry settings in `health_test.go`
2. Check service logs for startup errors
3. Ensure database is accessible
4. Verify network connectivity

### CI Integration Test Failures

If integration tests fail in CI:

1. Check that `BACKEND_URL` is set in the workflow
2. Verify the backend deployment succeeded
3. Check backend health endpoint is accessible
4. Review CI logs for connection errors
