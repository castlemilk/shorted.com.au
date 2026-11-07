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

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
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

// QueueStrategyBacktest queues one canonical version's backtest publish, or refuses it.
// The request is resolved against the code registry first, so the pair of hashes the
// store queues is the one the backtest job matches on, and then the store checks what
// the database records.
func (s *StoreAdapter) QueueStrategyBacktest(ctx context.Context, req shorts.QueueStrategyBacktestRequest) (shorts.QueueStrategyBacktestResult, error) {
	st, ok := s.store.(shorts.StrategyBacktestQueueAdminStore)
	if !ok {
		return shorts.QueueStrategyBacktestResult{}, fmt.Errorf("the store backend (%T) does not queue strategy backtests", s.store)
	}
	target, err := registeredBacktestRequest(req)
	if err != nil {
		return shorts.QueueStrategyBacktestResult{}, err
	}
	return st.QueueStrategyBacktest(ctx, target)
}

// registeredBacktestRequest resolves a queue request to the registered canonical version
// the backtest job runs: the version of its strategy the registry marks live, with a
// recipe, and not the pre-recipe v0. The rules and recipe hashes are the pair the job
// matches its requests on, so a request the job would fail is refused here. A variant is
// never registered, so its hash is refused as not registered.
func registeredBacktestRequest(req shorts.QueueStrategyBacktestRequest) (shorts.QueueStrategyBacktestRequest, error) {
	refuse := func(format string, args ...any) error {
		return fmt.Errorf("%w: "+format, append([]any{shorts.ErrBacktestRefused}, args...)...)
	}
	var (
		r  spec.Registered
		ok bool
	)
	switch {
	case len(req.Version) == 64:
		r, ok = spec.ByHash(req.Version)
	case req.StrategyID == "":
		return req, refuse("a label needs its strategy_id")
	default:
		for _, c := range spec.Registry() {
			if c.Spec.StrategyID == req.StrategyID && c.Label == req.Version {
				r, ok = c, true
				break
			}
		}
	}
	if !ok {
		return req, refuse("no registered canonical version matches %q", req.Version)
	}
	if req.StrategyID != "" && req.StrategyID != r.Spec.StrategyID {
		return req, refuse("%s belongs to %s, not %s", req.Version, r.Spec.StrategyID, req.StrategyID)
	}
	if !r.Live {
		return req, refuse("%s %s is superseded, not live", r.Spec.StrategyID, r.Label)
	}
	if r.Label == "v0" || r.Recipe == nil {
		return req, refuse("%s %s has no recipe to backtest", r.Spec.StrategyID, r.Label)
	}
	if req.RecipeID != "" && req.RecipeID != r.Recipe.ID {
		return req, refuse("%s %s trades with recipe %s, not %s", r.Spec.StrategyID, r.Label, r.Recipe.ID, req.RecipeID)
	}
	rules, err := spec.RulesHash(r.Spec)
	if err != nil {
		return req, fmt.Errorf("hash %s %s: %w", r.Spec.StrategyID, r.Label, err)
	}
	recipe, err := spec.RecipeHash(*r.Recipe)
	if err != nil {
		return req, fmt.Errorf("hash recipe %s: %w", r.Recipe.ID, err)
	}
	req.StrategyID, req.Version = r.Spec.StrategyID, r.Label
	req.RulesHash, req.RecipeHash = rules, recipe
	return req, nil
}
