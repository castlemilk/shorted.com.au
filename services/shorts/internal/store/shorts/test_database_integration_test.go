//go:build integration

package shorts

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

// isolatedTestDatabase creates a fresh database on the server at adminURL (an
// existing Postgres, e.g. SHORTS_TEST_POSTGRES_URL) and returns a pool on it.
// The cleanup closes the pool and drops the database.
func isolatedTestDatabase(t *testing.T, adminURL, prefix string) (*pgxpool.Pool, func()) {
	t.Helper()
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, adminURL)
	require.NoError(t, err, "connect to the integration PostgreSQL server")

	name := fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
	_, err = admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize())
	require.NoError(t, err, "create isolated integration database")

	config, err := pgxpool.ParseConfig(adminURL)
	require.NoError(t, err)
	config.ConnConfig.Database = name
	pool, err := pgxpool.NewWithConfig(ctx, config)
	require.NoError(t, err)

	return pool, func() {
		pool.Close()
		if _, err := admin.Exec(ctx, "DROP DATABASE "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)"); err != nil {
			t.Logf("drop integration database %s: %v", name, err)
		}
		admin.Close(ctx)
	}
}
