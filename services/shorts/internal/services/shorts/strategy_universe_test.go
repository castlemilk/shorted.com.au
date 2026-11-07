package shorts

import (
	"context"
	"errors"
	"testing"

	"go.uber.org/mock/gomock"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// Each strategy's universe kind follows its live canonical version's ASICReported flag: Crowded-Short reads
// asic_reported under v1, and every other strategy reads asx_ordinary. The kind is the same whichever source
// serves the answer, because it reads the registry's live entry.
func TestUniverseKindFollowsTheLiveVersion(t *testing.T) {
	for _, st := range engine.Registry() {
		live, ok := spec.Live(st.ID)
		require.True(t, ok, st.ID)
		want := universeASXOrdinary
		if live.Spec.Universe.ASICReported {
			want = universeASICReported
		}
		assert.Equal(t, want, universeKindOf(st.ID), st.ID)
	}
	assert.Equal(t, universeASICReported, universeKindOf(spec.StrategyCrowdedShortBreakout), "Crowded-Short is ASIC-reported under v1")
	assert.Equal(t, universeASXOrdinary, universeKindOf(spec.StrategyZangerBreakout))
	assert.Equal(t, "", universeKindOf("no-such-strategy"), "no live entry is no kind, never a guess")
}

// The list and the evidence carry the same kind for each strategy.
func TestListStrategiesAndEvidenceCarryTheUniverseKind(t *testing.T) {
	fake := newBacktestFake()
	srv := backtestServer(t, fake)
	// The hub also reads the market regime, which this test has none of: the regime is then left out.
	srv.store.(*mocks.MockShortsStore).EXPECT().GetMarketRegime(gomock.Any(), gomock.Any()).Return(engine.Regime{}, errors.New("no regime in this test")).AnyTimes()
	ev, err := srv.ListStrategyEvidence(context.Background(), connect.NewRequest(&shortsv1alpha1.ListStrategyEvidenceRequest{}))
	require.NoError(t, err)
	for _, e := range ev.Msg.Strategies {
		assert.Equal(t, universeKindOf(e.StrategyId), e.UniverseKind, e.StrategyId)
	}
	list, err := srv.ListStrategies(context.Background(), connect.NewRequest(&shortsv1alpha1.ListStrategiesRequest{}))
	require.NoError(t, err)
	for _, st := range list.Msg.Strategies {
		assert.Equal(t, universeKindOf(st.Id), st.Metadata.UniverseKind, st.Id)
	}
	kinds := map[string]string{}
	for _, st := range list.Msg.Strategies {
		kinds[st.Id] = st.Metadata.UniverseKind
	}
	assert.Equal(t, universeASICReported, kinds[spec.StrategyCrowdedShortBreakout])
}
