package main

import (
	"testing"

	"github.com/castlemilk/shorted.com.au/services/market-data-sync/config"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

func TestBuildDBPoolConfigUsesSimpleProtocolAndSmallPool(t *testing.T) {
	cfg := &config.Config{
		DatabaseURL: "postgres://user:pass@localhost:5432/postgres",
		DBMaxConns:  3,
		DBMinConns:  1,
	}

	poolConfig, err := buildDBPoolConfig(cfg)

	require.NoError(t, err)
	require.EqualValues(t, 3, poolConfig.MaxConns)
	require.EqualValues(t, 1, poolConfig.MinConns)
	require.Equal(t, pgx.QueryExecModeSimpleProtocol, poolConfig.ConnConfig.DefaultQueryExecMode)
}

func TestBuildDBPoolConfigBoundsMinConnections(t *testing.T) {
	cfg := &config.Config{
		DatabaseURL: "postgres://user:pass@localhost:5432/postgres",
		DBMaxConns:  2,
		DBMinConns:  8,
	}

	poolConfig, err := buildDBPoolConfig(cfg)

	require.NoError(t, err)
	require.EqualValues(t, 2, poolConfig.MaxConns)
	require.EqualValues(t, 2, poolConfig.MinConns)
}
