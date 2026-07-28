package marketdata

import (
	"testing"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/config"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

func TestBuildDBPoolConfigUsesSimpleProtocolAndSmallPool(t *testing.T) {
	t.Parallel()

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
	t.Parallel()

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

// TestGroupSubcommands pins the four subcommand names the cutover Terraform and
// the existing operator runbooks type; renaming one silently would break both.
func TestGroupSubcommands(t *testing.T) {
	t.Parallel()

	group, ok := Group().(*runner.Group)
	require.True(t, ok, "market-data must be a runner.Group")
	require.Equal(t, "market-data", group.Name())
	require.Equal(t,
		[]string{"serve", "sync", "audit-gaps", "historical-backfill"},
		group.Sub().Names(),
	)
}

// TestSubcommandsRefuseGlobalDryRun documents that no market-data subcommand
// declares dry-run support: the runner must refuse a global -dry-run rather
// than let it silently write. None of the ported paths has a preview mode.
func TestSubcommandsRefuseGlobalDryRun(t *testing.T) {
	t.Parallel()

	group := Group().(*runner.Group)
	for _, name := range group.Sub().Names() {
		job, ok := group.Sub().Lookup(name)
		require.True(t, ok)
		aware, isAware := job.(runner.DryRunAware)
		require.False(t, isAware && aware.SupportsDryRun(),
			"%s must not declare dry-run support (it has no preview path)", name)
	}
}
