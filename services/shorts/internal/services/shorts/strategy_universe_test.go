package shorts

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// The universe kind of a strategy is its live version's (ASICReported), and the live version is the version
// table's: the table's live row, or the registry only when the table has none (item 6).
func TestUniverseKindOfLiveFollowsTheRegistryEntry(t *testing.T) {
	for _, st := range engine.Registry() {
		live, ok := spec.Live(st.ID)
		require.True(t, ok, st.ID)
		want := universeASXOrdinary
		if live.Spec.Universe.ASICReported {
			want = universeASICReported
		}
		assert.Equal(t, want, universeKindOfLive(live, true), st.ID)
	}
	assert.Equal(t, "", universeKindOfLive(spec.Registered{}, false), "no live entry is no kind, never a guess")
}

// The list and the evidence carry the same kind for each strategy, and Crowded-Short is ASIC-reported under v1.
func TestListStrategiesAndEvidenceCarryTheUniverseKind(t *testing.T) {
	srv := backtestServer(t, newBacktestFake())
	ev, err := srv.ListStrategyEvidence(context.Background(), connect.NewRequest(&shortsv1alpha1.ListStrategyEvidenceRequest{}))
	require.NoError(t, err)
	evKinds := map[string]string{}
	for _, e := range ev.Msg.Strategies {
		evKinds[e.StrategyId] = e.UniverseKind
	}
	list, err := srv.ListStrategies(context.Background(), connect.NewRequest(&shortsv1alpha1.ListStrategiesRequest{}))
	require.NoError(t, err)
	for _, st := range list.Msg.Strategies {
		assert.Equal(t, evKinds[st.Id], st.Metadata.UniverseKind, st.Id)
	}
	assert.Equal(t, universeASICReported, evKinds[spec.StrategyCrowdedShortBreakout])
	assert.Equal(t, universeASXOrdinary, evKinds[spec.StrategyZangerBreakout])
}

// Under a table whose live Crowded-Short is v0, the kind comes from v0 (asx_ordinary), even though the registry's
// live entry is v1: the kind follows the version the evidence names (item 6).
func TestUniverseKindFollowsTheTableNotTheRegistryWhileItSaysV0(t *testing.T) {
	v0, ok := spec.Version(spec.StrategyCrowdedShortBreakout, "v0")
	require.True(t, ok)
	v0hash, err := spec.RulesHash(v0.Spec)
	require.NoError(t, err)
	v1, _ := spec.Live(spec.StrategyCrowdedShortBreakout)
	v1hash, err := spec.RulesHash(v1.Spec)
	require.NoError(t, err)
	require.NotEqual(t, v0hash, v1hash)

	table := []shortsstore.CanonicalRuleVersion{
		{RulesHash: v0hash, StrategyID: spec.StrategyCrowdedShortBreakout, Label: "v0", Status: "live", LiveFrom: "2026-01-01"},
		{RulesHash: v1hash, StrategyID: spec.StrategyCrowdedShortBreakout, Label: "v1", Status: "draft"},
	}
	srv := backtestServerWithRows(t, newBacktestFake(), table)
	ev, err := srv.ListStrategyEvidence(context.Background(), connect.NewRequest(&shortsv1alpha1.ListStrategyEvidenceRequest{}))
	require.NoError(t, err)
	evidence := findEvidence(t, ev.Msg.Strategies, spec.StrategyCrowdedShortBreakout)
	assert.Equal(t, "v0", evidence.Version.Label, "the evidence names the table's live version")
	assert.Equal(t, universeASXOrdinary, evidence.UniverseKind, "v0 is not ASIC-reported")

	list, err := srv.ListStrategies(context.Background(), connect.NewRequest(&shortsv1alpha1.ListStrategiesRequest{}))
	require.NoError(t, err)
	assert.Equal(t, universeASXOrdinary, findStrategy(t, list.Msg.Strategies, spec.StrategyCrowdedShortBreakout).Metadata.UniverseKind)

	// Once the table says v1 is live, the same strategy is ASIC-reported.
	table[0].Status, table[1].Status = "superseded", "live"
	table[1].LiveFrom = "2026-10-01"
	srv = backtestServerWithRows(t, newBacktestFake(), table)
	ev, err = srv.ListStrategyEvidence(context.Background(), connect.NewRequest(&shortsv1alpha1.ListStrategyEvidenceRequest{}))
	require.NoError(t, err)
	assert.Equal(t, universeASICReported, findEvidence(t, ev.Msg.Strategies, spec.StrategyCrowdedShortBreakout).UniverseKind)
}

func findEvidence(t *testing.T, all []*shortsv1alpha1.StrategyEvidence, id string) *shortsv1alpha1.StrategyEvidence {
	t.Helper()
	for _, e := range all {
		if e.StrategyId == id {
			return e
		}
	}
	t.Fatalf("no evidence for %s", id)
	return nil
}

func findStrategy(t *testing.T, all []*shortsv1alpha1.Strategy, id string) *shortsv1alpha1.Strategy {
	t.Helper()
	for _, s := range all {
		if s.Id == id {
			return s
		}
	}
	t.Fatalf("no strategy %s", id)
	return nil
}
