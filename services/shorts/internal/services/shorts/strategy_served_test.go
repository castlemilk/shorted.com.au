package shorts

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// On the snapshot path the responses read the live version: v1, its ladder
// and its universe. On the views path they read v0, which is what the SQL
// views evaluate, so rolling back to the views serves v0 semantics.
func TestServedVersionFollowsTheStrategySource(t *testing.T) {
	srv := &ShortsServer{config: Config{StrategySource: StrategySourceViews}}
	ctx := context.Background()
	views := srv.servedVersionOf(ctx, spec.StrategyCrowdedShortBreakout)
	assert.Equal(t, "v0", views.reg.Label)
	assert.False(t, views.reg.Spec.Ladder.UnknownStatus)

	srv.config.StrategySource = StrategySourceSnapshot
	u := newStrategyUniverse(nil, engine.Regime{}, "2026-11-05", StrategySourceSnapshot, nil)
	snap := u.served[spec.StrategyCrowdedShortBreakout]
	assert.Equal(t, "v1", snap.reg.Label)
	assert.True(t, snap.reg.Spec.Ladder.UnknownStatus)
	assert.Equal(t, "v1", servedRefOf(snap).Label)
	assert.Equal(t, "live", servedRefOf(snap).Status)
}

// The table is the authority on the served version: until the job promotes
// v1, the snapshot keeps serving the v0 the table marks live, with its live_from.
// A failed or absent table falls back to the registry's live flag only when the
// table has no row for the strategy.
func TestServedVersionFollowsTheLiveTable(t *testing.T) {
	v0, ok := spec.Version(spec.StrategyZangerBreakout, "v0")
	require.True(t, ok)
	v0hash, err := spec.RulesHash(v0.Spec)
	require.NoError(t, err)
	live := map[string]shortsstore.LiveRuleVersion{
		spec.StrategyZangerBreakout: {StrategyID: spec.StrategyZangerBreakout, RulesHash: v0hash, Label: "v0", LiveFrom: "2026-11-12"},
	}
	got := resolveServedOne(spec.StrategyZangerBreakout, StrategySourceSnapshot, live)
	assert.Equal(t, "v0", got.reg.Label)
	assert.Equal(t, "2026-11-12", got.liveFrom)
	assert.False(t, got.reg.Spec.Ladder.UnknownStatus, "the table's v0 keeps the v0 ladder")

	// The views never serve a live row, even when the table has one.
	views := resolveServedOne(spec.StrategyZangerBreakout, StrategySourceViews, live)
	assert.Equal(t, "v0", views.reg.Label)
	assert.Empty(t, views.liveFrom)

	// No row for the strategy: the registry's live flag answers.
	other := resolveServedOne(spec.StrategyCrowdedShortBreakout, StrategySourceSnapshot, live)
	assert.Equal(t, "v1", other.reg.Label)
}

// Crowded-Short ranks only the names the ASIC report lists; the other
// strategies rank the whole shared universe, with the same statistics.
func TestStrategyCandidatesNamesTheReportForCrowdedShortOnly(t *testing.T) {
	srv := &ShortsServer{config: Config{StrategySource: StrategySourceSnapshot}}
	u := newStrategyUniverse([]engine.Candidate{
		{StockCode: "AAA", InASICReport: true, ShortPct: new(9.0)},
		{StockCode: "BBB", InASICReport: false},
	}, engine.Regime{}, "2026-11-05", StrategySourceSnapshot, nil)

	cands, _ := srv.strategyCandidates(spec.StrategyCrowdedShortBreakout, u)
	require.Len(t, cands, 1)
	assert.Equal(t, "AAA", cands[0].StockCode)

	all, env := srv.strategyCandidates(spec.StrategyZangerBreakout, u)
	assert.Len(t, all, 2)
	assert.Same(t, u.env, env)
}
