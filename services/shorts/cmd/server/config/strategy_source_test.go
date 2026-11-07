package config

import (
	"testing"

	flag "github.com/spf13/pflag"
	"github.com/spf13/viper"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// loadWithEnv loads the server configuration with the given environment
// variables set, the way the server does at startup.
func loadWithEnv(t *testing.T, env map[string]string) (*Config, error) {
	t.Helper()
	for k, v := range env {
		t.Setenv(k, v)
	}
	v := viper.New()
	f := flag.NewFlagSet("test", flag.ContinueOnError)
	registerEnv(v)
	registerFlags(f)
	return load(v, f)
}

// STRATEGY_SOURCE selects where the stock picker reads, and defaults to the views.
func TestStrategySourceEnvironment(t *testing.T) {
	cfg, err := loadWithEnv(t, nil)
	require.NoError(t, err)
	assert.Equal(t, "views", cfg.AppSpec.StrategySource, "the views until the cutover")

	cfg, err = loadWithEnv(t, map[string]string{"STRATEGY_SOURCE": "snapshot"})
	require.NoError(t, err)
	assert.Equal(t, "snapshot", cfg.AppSpec.StrategySource)
}

// A value other than views or snapshot stops the server at startup rather than
// serving an unnamed source.
func TestStrategySourceRefusesAnUnknownValue(t *testing.T) {
	_, err := loadWithEnv(t, map[string]string{"STRATEGY_SOURCE": "parquet"})
	require.Error(t, err)
}
