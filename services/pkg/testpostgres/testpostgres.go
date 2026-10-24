// Package testpostgres gives the alerts end-to-end suites a disposable PostgreSQL
// server. A server named by an environment variable is used as is: that is the
// local path, and the suite creates and drops its own databases or schemas on it.
// Otherwise the suite starts a postgres container through testcontainers, the
// mechanism test-integration-ci uses. A container is needed on the CI runners:
// their Docker daemon is the host's, so a port published on 127.0.0.1 inside the
// runner is not the port the daemon published.
package testpostgres

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go/modules/postgres"
)

// image matches the market-data and test/integration suites, so the
// test-integration-images prefetch has already pulled it.
const image = "postgres:15-alpine"

var (
	mu        sync.Mutex
	container *postgres.PostgresContainer
	dsn       string
)

// Admin returns a DSN for a disposable server, or "" when the suite should skip.
// The URL in urlEnv wins when set. Otherwise, when optInEnv is "1", one container
// serves the whole test binary and Main removes it. The DSN targets the "postgres"
// database, so callers create their own databases or schemas.
func Admin(urlEnv, optInEnv string) (string, error) {
	if url := os.Getenv(urlEnv); url != "" {
		return url, nil
	}
	if os.Getenv(optInEnv) != "1" {
		return "", nil
	}
	mu.Lock()
	defer mu.Unlock()
	if dsn != "" {
		return dsn, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	// BasicWaitStrategies, not the default: the image starts an init server, logs
	// "ready" and restarts. Waiting for the port alone can hand out a connection
	// that is reset during that restart, which is how the first run failed.
	c, err := postgres.Run(ctx, image,
		postgres.WithDatabase("postgres"),
		postgres.WithUsername("alerts_test"),
		postgres.WithPassword("alerts_test"),
		postgres.BasicWaitStrategies(),
	)
	if err != nil {
		return "", fmt.Errorf("start postgres container: %w", err)
	}
	s, err := c.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		_ = c.Terminate(context.Background())
		return "", fmt.Errorf("postgres connection string: %w", err)
	}
	container, dsn = c, s
	return dsn, nil
}

// Main is the TestMain body for a package that calls Admin. It runs the tests,
// then removes the container Admin started, if any, so no container outlives
// the test binary.
//
//	func TestMain(m *testing.M) { os.Exit(testpostgres.Main(m)) }
func Main(m *testing.M) int {
	code := m.Run()
	mu.Lock()
	defer mu.Unlock()
	if container != nil {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if err := container.Terminate(ctx); err != nil {
			fmt.Fprintf(os.Stderr, "terminate alerts postgres container: %v\n", err)
		}
		container, dsn = nil, ""
	}
	return code
}
