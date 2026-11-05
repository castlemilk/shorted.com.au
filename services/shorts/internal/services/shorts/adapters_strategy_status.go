package shorts

// adapters_strategy_status.go forwards the strategy daily snapshot's status view through StoreAdapter.
//
// The admin strategy_status tool reaches the snapshot by type assertion
// (adminMCPSource.StrategyStatus in mcp_admin_strategy.go). serve.go hands the admin source
// the adapter, not the Postgres store under it, so StrategyStatusAdminStore must be forwarded
// here. Without this method the assertion fails and the tool reports "not wired on this
// deployment", the same gap #815 shipped for the crawl ledger (adapters_crawl_ops.go).
// TestStrategyStatusReachableThroughTheAdapter pins it.

import (
	"context"
	"fmt"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// StrategyDailyStatus reads the daily snapshot's status from the underlying store, or
// returns an error naming the gap when the backend does not provide it.
func (s *StoreAdapter) StrategyDailyStatus(ctx context.Context, sessions int) (shorts.StrategyDailyStatus, error) {
	st, ok := s.store.(shorts.StrategyStatusAdminStore)
	if !ok {
		return shorts.StrategyDailyStatus{}, fmt.Errorf("the store backend (%T) does not provide the strategy daily status", s.store)
	}
	return st.StrategyDailyStatus(ctx, sessions)
}
