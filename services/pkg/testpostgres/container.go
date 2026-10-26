//go:build testcontainers

package testpostgres

import (
	"context"
	"fmt"
	"os"
	"sync"
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

func startContainer() (string, error) {
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

func terminateContainer() {
	mu.Lock()
	defer mu.Unlock()
	if container == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := container.Terminate(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "terminate alerts postgres container: %v\n", err)
	}
	container, dsn = nil, ""
}
