# Parallel Testing with Random Ports

## Overview

All integration tests use testcontainers-go which **automatically assigns random host ports** to prevent conflicts when running tests in parallel.

## How Random Ports Work

When you create a PostgreSQL container using `postgres.Run()`:

1. **Container port 5432** is exposed inside the container
2. **Docker automatically maps** this to a **random available host port** (e.g., 32768, 49152, etc.)
3. **Each test gets its own container** with a unique random port
4. **No port conflicts** occur, even when running many tests in parallel

## Example

```go
// Container is created with random port mapping
postgresContainer, err := postgres.Run(ctx, "postgres:15-alpine", ...)

// Get the randomly assigned host port
mappedPort, err := postgresContainer.MappedPort(ctx, "5432")
// mappedPort.Port() returns something like "49152" (random)

// Connect using the random port
connString := fmt.Sprintf("postgres://user:pass@localhost:%s/db", mappedPort.Port())
```

## Parallel Test Execution

Tests are marked with `t.Parallel()` to enable safe parallel execution:

```go
func TestSearchStocks(t *testing.T) {
    t.Parallel() // Each test gets its own container with random port
    WithTestDatabase(t, func(container *TestContainer) {
        // Test code...
    })
}
```

## Benefits

- ✅ **No port conflicts** - Each container gets a unique random port
- ✅ **Parallel execution** - Tests can run simultaneously
- ✅ **Isolation** - Each test has its own database container
- ✅ **Automatic cleanup** - Containers are destroyed after each test

## Running Tests in Parallel

```bash
# Run with default parallelism (GOMAXPROCS)
go test ./test/integration -v

# Run with explicit parallelism
go test ./test/integration -v -parallel 8

# Run specific test in parallel
go test ./test/integration -run TestSearchStocks -v -parallel 4
```

## Troubleshooting

If you see port conflicts:

1. **Check Docker is running**: `docker ps`
2. **Clean up old containers**: `docker container prune -f`
3. **Verify testcontainers is working**: Check that containers are being created
4. **Check for port binding issues**: Ensure no other process is binding to random ports

## Implementation Details

The `SetupTestDatabase` function:

- Creates a PostgreSQL container using `postgres.Run()`
- Automatically gets a random host port via `MappedPort()`
- Returns connection details with the random port
- Each call creates a **new container** with a **new random port**

No manual port configuration is needed - testcontainers handles everything automatically!



