package shorts

import (
	"context"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// mcp_admin_strategy.go: the adapter behind the admin strategy_status tool
// (internal/mcp/admin_strategy.go). The store reads the daily snapshot's aggregates; this
// converts them into the tool's types and passes nothing else through.

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
	return out, nil
}
