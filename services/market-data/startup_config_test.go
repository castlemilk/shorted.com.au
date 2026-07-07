package main

import (
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

func TestMarketDataPoolConfigFromEnv(t *testing.T) {
	cfg, err := pgxpool.ParseConfig("postgres://user:pass@localhost:5432/postgres")
	require.NoError(t, err)

	t.Setenv("MARKET_DATA_DB_MAX_CONNS", "")
	t.Setenv("MARKET_DATA_DB_MIN_CONNS", "")

	applyMarketDataPoolConfig(cfg)

	require.EqualValues(t, 3, cfg.MaxConns)
	require.EqualValues(t, 0, cfg.MinConns)
	require.Equal(t, pgx.QueryExecModeSimpleProtocol, cfg.ConnConfig.DefaultQueryExecMode)
}

func TestMarketDataPoolConfigAllowsBoundedOverrides(t *testing.T) {
	cfg, err := pgxpool.ParseConfig("postgres://user:pass@localhost:5432/postgres")
	require.NoError(t, err)

	t.Setenv("MARKET_DATA_DB_MAX_CONNS", "6")
	t.Setenv("MARKET_DATA_DB_MIN_CONNS", "8")

	applyMarketDataPoolConfig(cfg)

	require.EqualValues(t, 6, cfg.MaxConns)
	require.EqualValues(t, 6, cfg.MinConns)
}
