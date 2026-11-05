package shorts

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// On the snapshot path the responses read the live version: v1, its ladder
// and its universe. On the views path they read v0, which is what the SQL
// views evaluate, so rolling back to the views serves v0 semantics.
func TestServedVersionFollowsTheStrategySource(t *testing.T) {
	srv := &ShortsServer{config: Config{StrategySource: StrategySourceViews}}
	views, ok := srv.servedRegistered(spec.StrategyCrowdedShortBreakout)
	require.True(t, ok)
	assert.Equal(t, "v0", views.Label)
	assert.False(t, srv.servedUnknownStatus(spec.StrategyCrowdedShortBreakout))

	srv.config.StrategySource = StrategySourceSnapshot
	snap, ok := srv.servedRegistered(spec.StrategyCrowdedShortBreakout)
	require.True(t, ok)
	assert.Equal(t, "v1", snap.Label)
	assert.True(t, srv.servedUnknownStatus(spec.StrategyCrowdedShortBreakout))
	assert.Equal(t, "v1", srv.servedVersion(spec.StrategyCrowdedShortBreakout).Label)
}

// Crowded-Short ranks only the names the ASIC report lists; the other
// strategies rank the whole shared universe, with the same statistics.
func TestStrategyCandidatesNamesTheReportForCrowdedShortOnly(t *testing.T) {
	srv := &ShortsServer{config: Config{StrategySource: StrategySourceSnapshot}}
	u := newStrategyUniverse([]engine.Candidate{
		{StockCode: "AAA", InASICReport: true, ShortPct: new(9.0)},
		{StockCode: "BBB", InASICReport: false},
	}, engine.Regime{}, "2026-11-05", StrategySourceSnapshot)

	cands, _ := srv.strategyCandidates(spec.StrategyCrowdedShortBreakout, u)
	require.Len(t, cands, 1)
	assert.Equal(t, "AAA", cands[0].StockCode)

	all, env := srv.strategyCandidates(spec.StrategyZangerBreakout, u)
	assert.Len(t, all, 2)
	assert.Same(t, u.env, env)
}
