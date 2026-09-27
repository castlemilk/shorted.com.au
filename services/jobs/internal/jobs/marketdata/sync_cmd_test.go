package marketdata

import (
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseSyncFlags(t *testing.T) {
	t.Parallel()

	opts, err := parseSyncFlags(false, nil)
	require.NoError(t, err)
	assert.False(t, opts.DryRun)
	assert.True(t, opts.From.IsZero(), "the scheduled run re-fetches nothing")
	assert.Empty(t, opts.Codes)

	opts, err = parseSyncFlags(false, []string{"-from", "2025-10-01", "-codes", " bhp, CBA ,,wbt", "-dry-run"})
	require.NoError(t, err)
	assert.Equal(t, time.Date(2025, 10, 1, 0, 0, 0, 0, time.UTC), opts.From)
	assert.Equal(t, []string{"BHP", "CBA", "WBT"}, opts.Codes)
	assert.True(t, opts.DryRun)

	opts, err = parseSyncFlags(true, nil)
	require.NoError(t, err)
	assert.True(t, opts.DryRun, "the global -dry-run is the default")

	for _, bad := range [][]string{
		{"-from", "01/10/2025"},
		{"-codes", "BHP;DROP TABLE"},
		{"-codes", "B"},
		{"stray"},
	} {
		_, err := parseSyncFlags(false, bad)
		assert.Error(t, err, "%v", bad)
	}
	_, err = parseSyncFlags(false, []string{"-h"})
	assert.ErrorIs(t, err, runner.ErrUsage)
}
