package shorts

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// backtestQueueBackend is a backend with the admin backtest queue. It records the
// requests the store receives.
type backtestQueueBackend struct {
	shorts.Store
	got   []shorts.QueueStrategyBacktestRequest
	calls int
}

func (f *backtestQueueBackend) QueueStrategyBacktest(_ context.Context, req shorts.QueueStrategyBacktestRequest) (shorts.QueueStrategyBacktestResult, error) {
	f.calls++
	f.got = append(f.got, req)
	return shorts.QueueStrategyBacktestResult{RequestID: 9, StrategyID: req.StrategyID, Label: req.Version, Status: "queued"}, nil
}

// The queue write must be reachable through the adapter that serve.go hands the admin
// source, the same gap the status forwarder was pinned against (#815). The forwarder
// resolves the request from the registry first, so a request the registry does not
// register is refused before the backend, and that refusal (not "not wired") is the
// proof the forwarder is reached.
func TestStrategyBacktestQueueReachableThroughTheAdapter(t *testing.T) {
	backend := &backtestQueueBackend{}
	src := newAdminMCPSource(&ShortsServer{store: NewStoreAdapter(backend), logger: NewLoggerAdapter()}, nil)
	queue := src.StrategyBacktestQueue()
	require.NotNil(t, queue, "the adapter must expose the backtest queue writer")

	_, err := queue.QueueStrategyBacktest(context.Background(), mcp.StrategyBacktestQueueRequest{StrategyID: "zanger-breakout", Version: "v9", Actor: "oauth:uid"})
	require.Error(t, err)
	assert.True(t, errors.Is(err, mcp.ErrStrategyBacktestRefused), "an unregistered version is refused by the resolver: %v", err)
	assert.Equal(t, 0, backend.calls, "a refused request never reaches the store")
}

// A variant hash is never registered, so it is refused before the store.
func TestStrategyBacktestQueueRefusesAVariantHashBeforeTheStore(t *testing.T) {
	backend := &backtestQueueBackend{}
	adapter := NewStoreAdapter(backend)
	_, err := adapter.QueueStrategyBacktest(context.Background(), shorts.QueueStrategyBacktestRequest{Version: strings.Repeat("b", 64)})
	require.Error(t, err)
	assert.True(t, errors.Is(err, shorts.ErrBacktestRefused), "%v", err)
	assert.Equal(t, 0, backend.calls)
}

// The registry holds only v0 on this base, and v0 is never backtested. A label that
// names it is refused, and so is a request without its strategy.
func TestRegisteredBacktestRequestRefusesWhatTheJobWouldNotRun(t *testing.T) {
	_, err := registeredBacktestRequest(mcpQueueRequest("zanger-breakout", "v0"))
	assert.True(t, errors.Is(err, shorts.ErrBacktestRefused), "v0 has no recipe: %v", err)

	_, err = registeredBacktestRequest(shorts.QueueStrategyBacktestRequest{Version: "v1"})
	assert.True(t, errors.Is(err, shorts.ErrBacktestRefused), "a label needs its strategy: %v", err)
}

func mcpQueueRequest(strategyID, version string) shorts.QueueStrategyBacktestRequest {
	return shorts.QueueStrategyBacktestRequest{StrategyID: strategyID, Version: version, Actor: "oauth:uid"}
}
