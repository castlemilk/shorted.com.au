# Integration Tests - Quick Start

## ✅ What We Built

A **fully self-contained integration test setup** using testcontainers-go that requires:

- ❌ **NO** manual database setup
- ❌ **NO** GCP credentials
- ❌ **NO** Firebase authentication
- ✅ **JUST** Docker and Go

## 🚀 Run Tests (One Command)

```bash
# From project root
make test-integration-local

# Or from services directory
cd services && make test-integration-local
```

That's it! The test setup automatically:

1. 📦 Starts PostgreSQL container
2. 📝 Initializes database schema with sample data
3. 🚀 Starts shorts service
4. 🧪 Runs all integration tests
5. 🧹 Cleans up everything

## 📋 What Gets Tested

✅ **API Endpoints**: GetTopShorts, GetStock, GetStockData  
✅ **Input Validation**: Request validation and error handling  
✅ **Database Queries**: Real PostgreSQL interactions  
✅ **Response Formats**: JSON serialization  
✅ **Caching**: Cache behavior and performance  
✅ **Health Checks**: Service readiness

## 🏗️ Architecture

```
TestMain (setup_test.go)
├── Start PostgreSQL container (testcontainers)
├── Load schema + sample data (init-db.sql)
├── Start shorts service (go run)
└── Run all tests
    └── Cleanup on exit
```

## 🔧 Key Technologies

- **testcontainers-go**: Automatic Docker container management
- **golang-migrate**: Database migration support (available but not currently used)
- **PostgreSQL 15**: Test database with sample data
- **No mocks needed**: Real service, real database

## 📁 Files

- `setup_test.go` - Test environment setup with TestMain
- `api_test.go` - API endpoint tests
- `health_test.go` - Health check and connectivity tests
- `e2e_test.go` - End-to-end user flow tests

## 🎯 Sample Output

```
🚀 Setting up integration test environment...
  📦 Starting PostgreSQL container...
✅ PostgreSQL container ready at localhost:63688
  📝 Initializing database schema...
✅ Database schema initialized
  📊 Sample data loaded (3 stocks with historical data)
  🚀 Starting shorts service...
✅ Shorts service process started (health checks will validate readiness)
✅ Test environment ready!

=== RUN   TestAPIEndpoints
=== RUN   TestAPIEndpoints/GetTopShorts_API
--- PASS: TestAPIEndpoints/GetTopShorts_API (0.02s)
=== RUN   TestAPIEndpoints/GetStock_API
--- PASS: TestAPIEndpoints/GetStock_API (0.00s)
...
PASS
ok      github.com/castlemilk/shorted.com.au/test/integration   5.234s

🧹 Cleaning up test environment...
  Stopping shorts service...
  Stopping PostgreSQL container...
✅ Cleanup complete
```

## 💡 How It Works

### 1. TestMain Setup

The `TestMain` function runs before all tests:

```go
func TestMain(m *testing.M) {
    // Start PostgreSQL container
    postgresContainer, err = postgres.Run(ctx, "postgres:15-alpine", ...)

    // Initialize schema
    initializeSchema(ctx, postgresContainer)

    // Start shorts service
    startShortsService()

    // Run tests
    code := m.Run()

    // Cleanup
    cleanup(ctx)
    os.Exit(code)
}
```

### 2. Environment Variables

Automatically set for the service:

```go
APP_STORE_POSTGRES_ADDRESS=localhost:random_port
APP_STORE_POSTGRES_DATABASE=shorts_test
APP_STORE_POSTGRES_USERNAME=test_user
APP_STORE_POSTGRES_PASSWORD=test_password
BACKEND_URL=http://localhost:9091
```

### 3. Sample Data

The `init-db.sql` includes:

- Table schemas with correct uppercase columns
- 3 sample companies (SMPA, SMPB, SMPC)
- Historical short position data
- Proper indexes

## 🔄 Comparison to Old Approach

### ❌ Before

```bash
# Start database manually
docker-compose up -d postgres

# Set environment variables
export DATABASE_URL=...
export GOOGLE_APPLICATION_CREDENTIALS=...

# Run service manually
go run shorts/cmd/server/main.go &

# Run tests
go test ./test/integration/...

# Clean up manually
kill $(lsof -t -i:9091)
docker-compose down
```

### ✅ After

```bash
make test-integration-local
```

## 🐛 Troubleshooting

### Docker Not Running

```
Error: Cannot connect to the Docker daemon
```

**Solution**: Start Docker Desktop

### Port Already In Use

```
Error: bind: address already in use
```

**Solution**:

```bash
cd services && make clean.shorts
```

### Tests Timeout

```
panic: test timed out after 20m0s
```

**Solution**: Database or service took too long to start. Check Docker resources.

## 📚 Related Documentation

- [Testing Architecture](./TESTING_ARCHITECTURE.md) - Detailed architecture
- [Integration Tests README](./README.md) - Complete test documentation
- [Setup Summary](../../INTEGRATION_TEST_SETUP.md) - What was changed

## 🎉 Benefits

1. **Developer Experience**: One command to run everything
2. **CI/CD Ready**: Same tests run in CI with real deployed service
3. **No External Dependencies**: Everything runs in containers
4. **Fast Feedback**: Tests complete in ~10 seconds
5. **Realistic Testing**: Real database, real service, real data
6. **Easy Debugging**: Logs and errors are clear and actionable
7. **Maintainable**: Standard Go testing practices

## 🔮 Future Enhancements

- [ ] Use `initializeSchemaWithMigrate()` when services/migrations match production schema
- [ ] Add test data fixtures for different scenarios
- [ ] Add performance benchmarks
- [ ] Add database seeding with production-like data
- [ ] Add container health checks with retry logic
