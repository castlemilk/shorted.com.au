package sync

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/providers"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// hangingProvider never answers: it waits on its context, as a request the
// server accepted and never answered does.
type hangingProvider struct{}

func (hangingProvider) Name() string                { return "hanging" }
func (hangingProvider) GetRateLimit() time.Duration { return 0 }
func (hangingProvider) FetchHistoricalData(ctx context.Context, _ string, _, _ time.Time) ([]providers.PriceRecord, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func TestOneStockCannotHoldTheRun(t *testing.T) {
	t.Parallel()
	m := manager(hangingProvider{})
	m.stockTimeout = 50 * time.Millisecond
	latest, lastClosed := mustDate("2026-09-18"), mustDate("2026-09-25")

	began := time.Now()
	_, err := m.syncStockWithin(context.Background(), "HANG", latest, lastClosed, RunOptions{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no answer within 50ms")
	assert.False(t, providers.IsNoDataError(err), "a stock that does not answer is not a strike against it")
	assert.Less(t, time.Since(began), 5*time.Second)

	// The run's own cancellation is not reported as the stock's deadline.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = m.syncStockWithin(ctx, "HANG", latest, lastClosed, RunOptions{})
	assert.ErrorIs(t, err, context.Canceled)
	assert.NotContains(t, err.Error(), "no answer within")
}

func TestRunStatsSayWhereTheTimeWent(t *testing.T) {
	t.Parallel()
	s := newRunStats()
	s.request("yahoo", 2*time.Second, 5, nil)
	s.request("yahoo", time.Second, 0, providers.NewNoDataError("X", "none"))
	s.request("yahoo", 45*time.Second, 0, errors.New("unexpected status: 429"))
	s.request("av", 3*time.Second, 5, nil)
	s.wait(12 * time.Second)
	for i := 0; i < 12; i++ {
		s.stock(fmt.Sprintf("S%02d", i), time.Duration(i)*time.Second, "synced")
	}

	var r RunReport
	s.fill(&r)
	assert.Equal(t, ProviderStats{Requests: 3, Answered: 1, NoData: 1, Failed: 1, Seconds: 48}, r.Providers["yahoo"])
	assert.Equal(t, ProviderStats{Requests: 1, Answered: 1, Seconds: 3}, r.Providers["av"])
	assert.Equal(t, 12.0, r.PacedSeconds)
	require.Len(t, r.Slowest, slowestKept)
	assert.Equal(t, StockTiming{Code: "S11", Seconds: 11, Outcome: "synced"}, r.Slowest[0])
	assert.Equal(t, "S02", r.Slowest[slowestKept-1].Code)

	// Outside a run (the API's single-stock sync) recording is a no-op.
	var none *runStats
	none.request("yahoo", time.Second, 1, nil)
	none.wait(time.Second)
	none.stock("BHP", time.Second, "synced")
	none.fill(&r)
	assert.Nil(t, runStatsFrom(context.Background()))
}

func TestFetchRecordsEachProviderRequest(t *testing.T) {
	t.Parallel()
	s := newRunStats()
	ctx := withRunStats(context.Background(), s)
	yahoo := &fakeProvider{name: "yahoo", fn: refused}
	av := &fakeProvider{name: "av", fn: weekdaySessions}
	_, err := manager(yahoo, av).fetch(ctx, "BHP", mustDate("2026-09-21"), mustDate("2026-09-25"))
	require.NoError(t, err)

	var r RunReport
	s.fill(&r)
	assert.Equal(t, 1, r.Providers["yahoo"].Failed)
	assert.Equal(t, 1, r.Providers["av"].Answered)
}

func TestEachAttemptKeepsItsReport(t *testing.T) {
	assert.Equal(t, []string{
		"price-sync/shorted-price-sync-t8ckm.json",
		"price-sync/shorted-price-sync-t8ckm/attempt-1.json",
	}, reportObjects("shorted-price-sync-t8ckm", 1))

	t.Setenv("CLOUD_RUN_TASK_ATTEMPT", "1")
	assert.Equal(t, 1, taskAttempt())
	t.Setenv("CLOUD_RUN_TASK_ATTEMPT", "")
	assert.Zero(t, taskAttempt())
}
