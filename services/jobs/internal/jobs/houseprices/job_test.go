package houseprices

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/stretchr/testify/require"
)

// TestJobIdentity pins the subcommand token. The residential-rig launchers
// (services/house-price-collector/deploy/*.sh) will invoke
// `shorted house-prices -mode …`; renaming this silently breaks every plist.
func TestJobIdentity(t *testing.T) {
	t.Parallel()

	j := Job()
	require.Equal(t, "house-prices", j.Name())
	require.NotEmpty(t, j.Synopsis())
}

// TestRefusesGlobalDryRun documents that house-prices declares no dry-run
// support: the crawl modes each own an env-driven dry-run switch
// (CRAWL_DRY_RUN / PURGE_DRY_RUN / CRIME_DRY_RUN), and the ingest modes always
// write, so a global -dry-run must be refused BEFORE anything opens a pool
// rather than silently writing.
func TestRefusesGlobalDryRun(t *testing.T) {
	t.Parallel()

	reg := runner.NewRegistry(Job())
	ctx := runner.WithGlobals(context.Background(), runner.Globals{DryRun: true})

	var out bytes.Buffer
	err := reg.Dispatch(ctx, "shorted", []string{"house-prices"}, &out)
	require.Error(t, err)
	require.Contains(t, err.Error(), "does not support -dry-run")
}

// TestRunRequiresDatabaseURL asserts the standalone binary's
// log.Fatal("DATABASE_URL is required") became a returned error with the same
// text, so deferred cleanup and the runner's end-of-job line still happen.
func TestRunRequiresDatabaseURL(t *testing.T) {
	t.Setenv("DATABASE_URL", "")

	err := Run(context.Background(), []string{"-mode", "refresh"})
	require.EqualError(t, err, "DATABASE_URL is required")
}

// TestRunRejectsUnknownMode asserts the unknown-mode path returns the original
// log.Fatalf text as an ordinary error (exit 1), not one of the rig codes.
func TestRunRejectsUnknownMode(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://user:pass@127.0.0.1:1/none")

	err := Run(context.Background(), []string{"-mode", "nope"})
	require.Error(t, err)
	require.Contains(t, err.Error(), `unknown -mode "nope"`)
	require.Equal(t, 1, runner.ExitCodeOf(err), "an unknown mode is an ordinary failure")
}

// TestRunRejectsStrayArguments — the standalone binary ignored positional args
// (flag.Parse leaves them in flag.Args()), so `house-price-collector official`
// silently ran the DEFAULT mode `all`. Here it is an error.
func TestRunRejectsStrayArguments(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://user:pass@127.0.0.1:1/none")

	err := Run(context.Background(), []string{"official"})
	require.Error(t, err)
	require.Contains(t, err.Error(), `unexpected argument "official"`)
}

// TestHelpIsUsage asserts -h prints the flag contract and maps to exit 2
// (ErrUsage) rather than being reported as a job failure.
func TestHelpIsUsage(t *testing.T) {
	t.Parallel()

	err := Run(context.Background(), []string{"-h"})
	require.ErrorIs(t, err, runner.ErrUsage)
}

// TestModeListCoversEveryDispatchCase is the parity guard: every -mode value the
// dispatch switch accepts must be advertised in the -mode help string, and vice
// versa. A new mode added without touching the help text (or a mode dropped from
// the switch) fails here rather than on a rig at 3am.
func TestModeListCoversEveryDispatchCase(t *testing.T) {
	t.Parallel()

	// The dispatch switch in Run, in source order. "abs" is a documented
	// undocumented alias for "official" and is deliberately NOT in modeList.
	dispatch := []string{
		"official", "vg-nsw", "all", "crawl", "listings", "details", "property", "agent",
		"enqueue", "freshness", "purge", "warmcheck", "backfill-address",
		"census", "electorates", "banners", "amenities", "lga", "connectivity",
		"funding", "council-financials", "crime", "refresh",
	}

	advertised := map[string]bool{}
	for _, m := range strings.Split(modeList, "|") {
		advertised[strings.TrimSpace(m)] = true
	}

	require.Len(t, advertised, len(dispatch), "modeList and the dispatch switch must have the same size")
	for _, m := range dispatch {
		require.True(t, advertised[m], "-mode %s is dispatched but not advertised in modeList", m)
	}
}

// TestExitForPreservesRigContract is the exit-code contract test.
//
// deploy/run-housing-crawl.sh branches on 3/4/5, run-housing-delta.sh and
// run-housing-full.sh on 3/4 plus the freshness code, and none of them would
// survive the runner's default "every error is exit 1". exitFor must therefore
// turn a mode helper's int into an error that runner.ExitCodeOf maps back to
// the SAME int.
func TestExitForPreservesRigContract(t *testing.T) {
	t.Parallel()

	require.NoError(t, exitFor("warmcheck", 0), "0 is success, not an error")

	for _, tc := range []struct {
		mode string
		code int
		want string
	}{
		{"crawl", 3, "re-warm"},
		{"agent", 4, "Chrome/CDP unusable"},
		{"warmcheck", 5, "cold"},
		{"freshness", 6, "ALARM"},
	} {
		err := exitFor(tc.mode, tc.code)
		require.Error(t, err)
		require.Equal(t, tc.code, runner.ExitCodeOf(err),
			"-mode %s must exit %d — deploy/*.sh branches on it", tc.mode, tc.code)
		require.Contains(t, err.Error(), tc.mode)
		require.Contains(t, err.Error(), tc.want)

		var ec *runner.ExitCodeError
		require.True(t, errors.As(err, &ec))
		require.Equal(t, tc.code, ec.ExitCode())
	}

	// An unmapped non-zero code still surfaces verbatim (freshness returns 1
	// when its own query fails).
	require.Equal(t, 1, runner.ExitCodeOf(exitFor("freshness", 1)))
}

// TestRevalidateContract pins the housing cache-bust paths that the shared
// platform helper is handed. Changing them silently would leave /price-drops
// serving stale ISR after a crawl.
func TestRevalidateContract(t *testing.T) {
	t.Parallel()

	require.Equal(t, []string{"/price-drops", "/housing"}, housingRevalidatePaths)
}
