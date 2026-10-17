package marketdata

import (
	"errors"
	"fmt"
	"testing"
	"time"

	msync "github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/sync"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseSyncFlags(t *testing.T) {
	t.Parallel()

	opts, err := parseSyncFlags(false, "", nil)
	require.NoError(t, err)
	assert.False(t, opts.DryRun)
	assert.True(t, opts.From.IsZero(), "the scheduled run re-fetches nothing")
	assert.Empty(t, opts.Codes)

	opts, err = parseSyncFlags(false, "", []string{"-from", "2025-10-01", "-codes", " bhp, CBA ,,wbt", "-dry-run"})
	require.NoError(t, err)
	assert.Equal(t, time.Date(2025, 10, 1, 0, 0, 0, 0, time.UTC), opts.From)
	assert.Equal(t, []string{"BHP", "CBA", "WBT"}, opts.Codes)
	assert.True(t, opts.DryRun)

	opts, err = parseSyncFlags(true, "", nil)
	require.NoError(t, err)
	assert.True(t, opts.DryRun, "the global -dry-run is the default")
	assert.Zero(t, opts.Budget, "no budget unless the deployment or the caller sets one")

	// The deployment's budget is the default; a run's -budget overrides it.
	opts, err = parseSyncFlags(false, "5h30m", nil)
	require.NoError(t, err)
	assert.Equal(t, 5*time.Hour+30*time.Minute, opts.Budget)
	opts, err = parseSyncFlags(false, "5h30m", []string{"-budget", "11h30m"})
	require.NoError(t, err)
	assert.Equal(t, 11*time.Hour+30*time.Minute, opts.Budget)
	opts, err = parseSyncFlags(false, "5h30m", []string{"-budget", "0"})
	require.NoError(t, err)
	assert.Zero(t, opts.Budget, "-budget 0 lifts the deployment's budget for one run")

	for _, bad := range [][]string{
		{"-from", "01/10/2025"},
		{"-codes", "BHP;DROP TABLE"},
		{"-codes", "B"},
		{"-budget", "5.5 hours"},
		{"-budget", "-1h"},
		{"stray"},
	} {
		_, err := parseSyncFlags(false, "", bad)
		assert.Error(t, err, "%v", bad)
	}
	// A misspelt SYNC_RUN_BUDGET fails the run at the start, not silently
	// unbounded: the budget exists so the platform never has to kill the task.
	_, err = parseSyncFlags(false, "5h30", nil)
	assert.Error(t, err)
	_, err = parseSyncFlags(false, "", []string{"-h"})
	assert.ErrorIs(t, err, runner.ErrUsage)
}

// A sweep that stopped on its budget did some of the work and reported it, so
// it exits with the partial-run code, which Cloud Run retries; anything else a
// sweep returns is a plain failure.
func TestSyncOutcome(t *testing.T) {
	t.Parallel()

	spent := fmt.Errorf("stopped at 1700/1825 stocks after 5h30m0s: %w (5h30m0s)", msync.ErrBudgetSpent)
	err := syncOutcome(spent)
	var ec *runner.ExitCodeError
	require.True(t, errors.As(err, &ec), "%v", err)
	assert.Equal(t, exitCodeBudgetSpent, ec.Code)
	assert.Equal(t, exitCodeBudgetSpent, runner.ExitCodeOf(err))
	assert.ErrorIs(t, err, msync.ErrBudgetSpent)

	refused := errors.New("stopped after 25 consecutive fetch failures")
	err = syncOutcome(refused)
	assert.False(t, errors.As(err, &ec))
	assert.Equal(t, 1, runner.ExitCodeOf(err))
	assert.ErrorIs(t, err, refused)
}

func TestParsePruneFlags(t *testing.T) {
	t.Parallel()

	opts, err := parsePruneFlags(false, nil)
	require.NoError(t, err)
	assert.False(t, opts.DryRun)

	opts, err = parsePruneFlags(true, nil)
	require.NoError(t, err)
	assert.True(t, opts.DryRun, "the global -dry-run is the default")

	opts, err = parsePruneFlags(false, []string{"-dry-run"})
	require.NoError(t, err)
	assert.True(t, opts.DryRun)

	opts, err = parsePruneFlags(false, []string{"-from", "2016-01-01"})
	require.NoError(t, err)
	assert.Equal(t, time.Date(2016, 1, 1, 0, 0, 0, 0, time.UTC), opts.From)

	_, err = parsePruneFlags(false, []string{"-from", "1/1/2016"})
	assert.Error(t, err)
	_, err = parsePruneFlags(false, []string{"stray"})
	assert.Error(t, err)
	_, err = parsePruneFlags(false, []string{"-h"})
	assert.ErrorIs(t, err, runner.ErrUsage)
}
