package platform

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DefaultMaxConns matches the hand-rolled pools this replaces (influence-collector
// and economy-collector used 4; the report tools used 3). Batch jobs are
// single-writer, and Supabase caps max_connections at 60.
const DefaultMaxConns = 4

// PoolOption customises the pool built by Connect.
type PoolOption func(*pgxpool.Config)

// WithMaxConns overrides DefaultMaxConns.
func WithMaxConns(n int32) PoolOption {
	return func(cfg *pgxpool.Config) { cfg.MaxConns = n }
}

// Connect opens a pgxpool against dbURL.
//
// QueryExecModeSimpleProtocol is NOT optional here: it is what keeps the
// Supabase transaction pooler (port 6543) happy — the pooler cannot carry
// prepared statements across connections. Every collector in services/ set this
// by hand; this is the one copy.
func Connect(ctx context.Context, dbURL string, opts ...PoolOption) (*pgxpool.Pool, error) {
	if dbURL == "" {
		return nil, errors.New("database url is empty")
	}
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	cfg.MaxConns = DefaultMaxConns
	for _, opt := range opts {
		opt(cfg)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("open pool: %w", err)
	}
	return pool, nil
}

// ConnectFromEnv is Connect over the DATABASE_URL env var, erroring when unset.
func ConnectFromEnv(ctx context.Context, opts ...PoolOption) (*pgxpool.Pool, error) {
	dbURL, err := RequireEnv("DATABASE_URL")
	if err != nil {
		return nil, err
	}
	return Connect(ctx, dbURL, opts...)
}
