package picks

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
)

func TestRevalidateAfterRefreshWaitsThenPings(t *testing.T) {
	var slept []time.Duration
	var pings []platform.RevalidateRequest
	rv := revalidator{
		wait:  revalidateWait,
		sleep: func(_ context.Context, d time.Duration) error { slept = append(slept, d); return nil },
		ping:  func(r platform.RevalidateRequest) { pings = append(pings, r) },
	}
	revalidateAfterRefresh(context.Background(), rv, false, func(string, ...any) {})
	assert.Equal(t, []time.Duration{16 * time.Minute}, slept, "the API's 15-minute strategy cache, plus one")
	require.Len(t, pings, 1)
	assert.Equal(t, "strategy-picks", pings[0].Tag, "always after a successful refresh")
	assert.Empty(t, pings[0].Paths, "no path list: the web decides what a tag covers")
	assert.Equal(t, "picks", pings[0].Reason)

	pings = nil
	revalidateAfterRefresh(context.Background(), rv, true, func(string, ...any) {})
	require.Len(t, pings, 1)
	assert.Equal(t, "strategy-picks,fundamentals", pings[0].Tag, "plus fundamentals when this execution changed them")

	pings = nil
	rv.sleep = func(context.Context, time.Duration) error { return context.Canceled }
	revalidateAfterRefresh(context.Background(), rv, true, func(string, ...any) {})
	assert.Empty(t, pings, "a cancelled wait (SIGTERM) skips the ping; the pages self-heal on their TTL")
}

func TestDefaultRevalidatorUsesPlatformPing(t *testing.T) {
	rv := defaultRevalidator()
	assert.Equal(t, revalidateWait, rv.wait)
	require.NotNil(t, rv.ping)
	require.NotNil(t, rv.sleep)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	assert.ErrorIs(t, rv.sleep(ctx, time.Hour), context.Canceled, "the wait is ctx-aware")
}

func TestJobRevalidatesOnlyAfterASuccessfulRefresh(t *testing.T) {
	// Structural: the ping sits behind the refresh's error and the dry run.
	src := readText(t, "job.go")
	r := strings.Index(src, "err := runRefresh(ctx, st, *dryRun, log.Printf)")
	v := strings.Index(src, "if err == nil && !*dryRun {\n\t\trevalidateAfterRefresh(ctx, defaultRevalidator(), fundamentalsChanged, log.Printf)")
	require.True(t, r > 0 && v > r, "revalidation follows a successful, real refresh")
}

func TestAcquireLease(t *testing.T) {
	var logged []string
	logf := func(format string, args ...any) { logged = append(logged, fmt.Sprintf(format, args...)) }

	st := &fakeStore{}
	l, proceed, err := acquireLease(context.Background(), st, "exec-1", logf)
	require.NoError(t, err)
	assert.True(t, proceed)
	require.NotNil(t, l)
	assert.Equal(t, "exec-1", st.leaseHolder)

	// A second execution finds it held: exit 0 without work.
	l2, proceed, err := acquireLease(context.Background(), st, "exec-2", logf)
	require.NoError(t, err)
	assert.False(t, proceed)
	assert.Nil(t, l2)
	assert.Contains(t, strings.Join(logged, "\n"), "another execution holds the run lease (exec-1)")

	// The same execution (a task retry) takes it back.
	_, proceed, err = acquireLease(context.Background(), st, "exec-1", logf)
	require.NoError(t, err)
	assert.True(t, proceed)

	require.NoError(t, l.extend(context.Background()))
	assert.Equal(t, 1, st.leaseExtends)
	l.release()
	l.release()
	assert.Equal(t, 1, st.leaseRelease, "release is idempotent")
	assert.Equal(t, "", st.leaseHolder)
	require.NoError(t, l.extend(context.Background()), "a released lease is not extended")
	assert.Equal(t, 1, st.leaseExtends)

	// 42P01: run without the lease.
	absent := &fakeStore{leaseAbsent: true}
	l, proceed, err = acquireLease(context.Background(), absent, "exec-1", logf)
	require.NoError(t, err)
	assert.True(t, proceed)
	assert.Nil(t, l)
	l.release() // a nil lease is valid and does nothing
	require.NoError(t, l.extend(context.Background()))

	// Any other error fails the run.
	_, _, err = acquireLease(context.Background(), &errLeaseStore{}, "exec-1", logf)
	require.Error(t, err)
}

type errLeaseStore struct{ fakeStore }

func (e *errLeaseStore) ClaimLease(context.Context, string) (bool, string, error) {
	return false, "", errors.New("connection refused")
}

func TestLeaseHolder(t *testing.T) {
	t.Setenv("CLOUD_RUN_EXECUTION", "shorted-picks-abc12")
	assert.Equal(t, "shorted-picks-abc12", leaseHolder(), "a task retry shares its execution's name")
	t.Setenv("CLOUD_RUN_EXECUTION", "")
	assert.True(t, strings.HasPrefix(leaseHolder(), "local:"))
}

func TestFundamentalsBudget(t *testing.T) {
	t.Setenv("PICKS_FUNDAMENTALS_BUDGET_MIN", "")
	t.Setenv("CLOUD_RUN_TASK_ATTEMPT", "")
	assert.Equal(t, 170*time.Minute, fundamentalsBudget(), "the default")
	t.Setenv("PICKS_FUNDAMENTALS_BUDGET_MIN", "170")
	t.Setenv("CLOUD_RUN_TASK_ATTEMPT", "0")
	assert.Equal(t, 170*time.Minute, fundamentalsBudget(), "the first attempt")
	t.Setenv("CLOUD_RUN_TASK_ATTEMPT", "1")
	assert.Equal(t, 20*time.Minute, fundamentalsBudget(), "a retry finishes filings and the refresh, not a second pass")
	t.Setenv("PICKS_FUNDAMENTALS_BUDGET_MIN", "5")
	assert.Equal(t, 5*time.Minute, fundamentalsBudget(), "min(budget, 20)")
}

// The job's timeout must hold the budget, the steps after it and the wait.
func TestTerraformPicksJobFitsTheBudget(t *testing.T) {
	main := readText(t, "../../../../../terraform/environments/prod/main.tf")
	start := strings.Index(main, `module "shorted_job_picks" {`)
	require.GreaterOrEqual(t, start, 0)
	block := main[start : start+strings.Index(main[start:], "\n}\n")]
	assert.Contains(t, block, "timeout_seconds = 12600")
	assert.Contains(t, block, "max_retries     = 1")
	assert.Contains(t, block, `PICKS_FUNDAMENTALS_BUDGET_MIN = "170"`)
	assert.Contains(t, block, `REVALIDATION_URL              = "https://shorted.com.au/api/revalidate"`)
	assert.Contains(t, block, `REVALIDATION_SECRET = "REVALIDATION_SECRET"`)
	assert.NotContains(t, block, "PICKS_FUNDAMENTALS_MAX_CODES", "no count cap: the budget decides (§3.7)")
	budget := time.Duration(defaultBudgetMin)*time.Minute + revalidateWait
	assert.Less(t, budget, 12600*time.Second-10*time.Minute, "room for the last fetch, filings and the refresh")
}

func readText(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	require.NoError(t, err)
	return string(b)
}
