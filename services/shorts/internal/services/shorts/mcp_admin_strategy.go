package shorts

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// mcp_admin_strategy.go: the adapter behind the admin strategy_status tool
// (internal/mcp/admin_strategy.go). The store reads the daily snapshot's aggregates; this
// converts them into the tool's types and passes nothing else through.

// The admin server's operator must provide the strategy capability.
var _ mcp.AdminStrategyOperator = (*adminMCPSource)(nil)

// The admin server's operator provides the backtest queue as well.
var _ mcp.AdminStrategyBacktestOperator = (*adminMCPSource)(nil)

// StrategyStatus returns the snapshot's status reader, or nil when the store does not provide it.
func (a *adminMCPSource) StrategyStatus() mcp.StrategyStatusStore {
	if a == nil || a.server == nil {
		return nil
	}
	s, ok := a.server.store.(shortsstore.StrategyStatusAdminStore)
	if !ok {
		return nil
	}
	return strategyStatusAdapter{store: s}
}

// StrategyBacktestQueue returns the backtest queue writer, or nil when the store does not provide it.
func (a *adminMCPSource) StrategyBacktestQueue() mcp.StrategyBacktestQueueStore {
	if a == nil || a.server == nil {
		return nil
	}
	s, ok := a.server.store.(shortsstore.StrategyBacktestQueueAdminStore)
	if !ok {
		return nil
	}
	return strategyBacktestQueueAdapter{store: s}
}

// strategyBacktestQueueAdapter converts a queue request and its result between the store and the tool.
type strategyBacktestQueueAdapter struct {
	store shortsstore.StrategyBacktestQueueAdminStore
}

// QueueStrategyBacktest queues the request and converts the store's result.
func (a strategyBacktestQueueAdapter) QueueStrategyBacktest(ctx context.Context, req mcp.StrategyBacktestQueueRequest) (mcp.StrategyBacktestQueueResult, error) {
	res, err := a.store.QueueStrategyBacktest(ctx, shortsstore.QueueStrategyBacktestRequest{
		StrategyID: req.StrategyID, Version: req.Version, RecipeID: req.RecipeID, Actor: req.Actor,
	})
	if errors.Is(err, shortsstore.ErrBacktestRefused) {
		reason := strings.TrimPrefix(err.Error(), shortsstore.ErrBacktestRefused.Error()+": ")
		return mcp.StrategyBacktestQueueResult{}, fmt.Errorf("%w: %s", mcp.ErrStrategyBacktestRefused, reason)
	}
	if err != nil {
		return mcp.StrategyBacktestQueueResult{}, err
	}
	return mcp.StrategyBacktestQueueResult{RequestID: res.RequestID, StrategyID: res.StrategyID, Label: res.Label, Status: res.Status}, nil
}

// strategyStatusAdapter converts the store's rows into the tool's read.
type strategyStatusAdapter struct {
	store shortsstore.StrategyStatusAdminStore
}

// StrategyStatus reads the newest sessions and converts them.
func (a strategyStatusAdapter) StrategyStatus(ctx context.Context, sessions int) (mcp.StrategyStatusRead, error) {
	raw, err := a.store.StrategyDailyStatus(ctx, sessions)
	if err != nil {
		return mcp.StrategyStatusRead{}, err
	}
	out := mcp.StrategyStatusRead{
		LateLast30:    raw.LateLast30,
		LastCompleted: raw.LastCompleted,
		Migrated:      raw.Migrated,
	}
	for _, p := range raw.Sessions {
		out.Sessions = append(out.Sessions, mcp.StrategyPhase{AsOf: p.AsOf, Phase: p.Phase, Status: p.Status, Note: p.Note, Counts: p.Counts})
	}
	for _, v := range raw.Versions {
		out.Versions = append(out.Versions, mcp.StrategyVersion{StrategyID: v.StrategyID, Label: v.Label, Status: v.Status, LiveFrom: v.LiveFrom})
	}
	for _, t := range raw.Tables {
		out.Tables = append(out.Tables, mcp.StrategyTable{Name: t.Name, RowsEst: t.RowsEst, SizeBytes: t.SizeBytes})
	}
	for _, q := range raw.BacktestQueue {
		out.BacktestQueue = append(out.BacktestQueue, mcp.StrategyBacktestQueue{Kind: q.Kind, Status: q.Status, Count: q.Count, OldestAt: q.OldestAt})
	}
	for _, r := range raw.BacktestRuns {
		out.BacktestRuns = append(out.BacktestRuns, mcp.StrategyBacktestRun{
			StrategyID: r.StrategyID, Label: r.Label, Kind: r.Kind, Status: r.Status, State: r.State,
			EngineVersion: r.EngineVersion, Published: r.Published, WindowEnd: r.WindowEnd, FinishedAt: r.FinishedAt,
			DiffState: r.DiffState, RewrittenCodes: r.RewrittenCodes,
		})
	}
	return out, nil
}
