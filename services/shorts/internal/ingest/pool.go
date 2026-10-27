package ingest

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// OpenPool opens the ingest's own database pool, sized by HOUSING_INGEST_DB_MAX_CONNS.
// It never shares the public API's pool: a rig push holds a connection for the length
// of its transaction, and the public API's pool is capped at a handful of connections.
//
// The URL is HOUSING_INGEST_DATABASE_URL, falling back to DATABASE_URL. It returns an
// error when neither is set. pgxpool connects lazily, so opening the pool does not
// contact the database.
func OpenPool(ctx context.Context, getenv func(string) string, cfg Config) (*pgxpool.Pool, error) {
	dsn := strings.TrimSpace(getenv(EnvDatabaseURL))
	if dsn == "" {
		dsn = strings.TrimSpace(getenv(EnvDatabaseFallback))
	}
	if dsn == "" {
		return nil, errors.New(EnvDatabaseURL + " (or " + EnvDatabaseFallback + ") is not set")
	}
	return newPool(ctx, dsn, cfg.DBMaxConns)
}

// newPool builds a pool for the ingest. It uses the simple query protocol, so
// nothing is prepared on the server. A transaction-mode pooler (Supavisor on 6543,
// pgbouncer in transaction mode) can hand each statement to a different backend, and
// a named prepared statement would not exist on the next one.
func newPool(ctx context.Context, dsn string, maxConns int32) (*pgxpool.Pool, error) {
	pc, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	pc.MaxConns = maxConns
	pc.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	return pgxpool.NewWithConfig(ctx, pc)
}
