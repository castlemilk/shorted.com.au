package shorts

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
)

var hexHash = regexp.MustCompile(`^[0-9a-f]{64}$`)

func TestEveryStrategyHasALiveVersion(t *testing.T) {
	for _, st := range engine.Registry() {
		ref := liveVersion(st.ID)
		require.NotNil(t, ref, "no live version for %s", st.ID)
		assert.Equal(t, st.ID, ref.StrategyId)
		assert.Equal(t, "live", ref.Status)
		assert.Equal(t, "canonical", ref.Kind)
		assert.Equal(t, engine.Version, ref.EngineVersion)
		assert.Equal(t, "fs1", ref.FeatureSet)
		assert.Regexp(t, hexHash, ref.RulesHash)

		live, ok := spec.Live(st.ID)
		require.True(t, ok)
		want, err := spec.RulesHash(live.Spec)
		require.NoError(t, err)
		assert.Equal(t, want, ref.RulesHash, "the wire hash is the spec's canonical hash")
	}
}

func TestGetStrategyVersionLiveAndByHash(t *testing.T) {
	srv := newTestServer(t, mocks.NewMockShortsStore(gomock.NewController(t)))
	ctx := context.Background()
	live := liveVersion(engine.Registry()[0].ID)

	for _, hash := range []string{"", live.RulesHash, strings.ToUpper(live.RulesHash)} {
		resp, err := srv.GetStrategyVersion(ctx, connect.NewRequest(&shortsv1alpha1.GetStrategyVersionRequest{
			StrategyId: live.StrategyId, VersionHash: hash,
		}))
		require.NoError(t, err, "hash %q", hash)
		v := resp.Msg.Version
		require.NotNil(t, v)
		assert.Equal(t, live.RulesHash, v.Version.RulesHash)
		assert.Equal(t, "v0", v.Version.Label)
	}
}

func TestGetStrategyVersionRefusesUnknownHashesAndStrategies(t *testing.T) {
	srv := newTestServer(t, mocks.NewMockShortsStore(gomock.NewController(t)))
	ctx := context.Background()
	canslim := liveVersion("canslim")

	cases := []struct {
		name string
		req  *shortsv1alpha1.GetStrategyVersionRequest
		code connect.Code
	}{
		{"empty strategy", &shortsv1alpha1.GetStrategyVersionRequest{}, connect.CodeInvalidArgument},
		{"unknown strategy", &shortsv1alpha1.GetStrategyVersionRequest{StrategyId: "nope"}, connect.CodeNotFound},
		{"unknown hash", &shortsv1alpha1.GetStrategyVersionRequest{StrategyId: "zanger-breakout", VersionHash: strings.Repeat("a", 64)}, connect.CodeNotFound},
		{"another strategy's hash", &shortsv1alpha1.GetStrategyVersionRequest{StrategyId: "zanger-breakout", VersionHash: canslim.RulesHash}, connect.CodeNotFound},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := srv.GetStrategyVersion(ctx, connect.NewRequest(c.req))
			require.Error(t, err)
			assert.Equal(t, c.code, connect.CodeOf(err))
		})
	}
}

func TestListStrategyVersionsIsTheChangelog(t *testing.T) {
	srv := newTestServer(t, mocks.NewMockShortsStore(gomock.NewController(t)))
	ctx := context.Background()

	all, err := srv.ListStrategyVersions(ctx, connect.NewRequest(&shortsv1alpha1.ListStrategyVersionsRequest{}))
	require.NoError(t, err)
	require.Len(t, all.Msg.Versions, len(engine.Registry()), "one v0 per strategy")

	one, err := srv.ListStrategyVersions(ctx, connect.NewRequest(&shortsv1alpha1.ListStrategyVersionsRequest{StrategyId: "crowded-short-breakout"}))
	require.NoError(t, err)
	require.Len(t, one.Msg.Versions, 1)
	v := one.Msg.Versions[0]
	assert.Equal(t, "crowded-short-breakout", v.Version.StrategyId)
	assert.Equal(t, "v0", v.Version.Label)
	assert.Equal(t, "live", v.Version.Status)
	assert.Empty(t, v.SupersededOn)
	assert.Empty(t, v.RetiredOn)
	assert.NotEmpty(t, v.Params)
	assert.Contains(t, v.Policies, "There is no freshness check: a code keeps its last features after its price stops.")
	assert.Len(t, v.KnownIssues, 6, "v0's six known issues are published before v1")
	assert.NotEmpty(t, v.Changes)

	// The canonical JSON is the spec the hash names.
	var s spec.Spec
	require.NoError(t, json.Unmarshal([]byte(v.CanonicalJson), &s))
	h, err := spec.RulesHash(s)
	require.NoError(t, err)
	assert.Equal(t, v.Version.RulesHash, h)

	_, err = srv.ListStrategyVersions(ctx, connect.NewRequest(&shortsv1alpha1.ListStrategyVersionsRequest{StrategyId: "nope"}))
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
}

func TestListStrategyVersionsServesCanonicalOnly(t *testing.T) {
	for _, r := range canonicalVersions("") {
		assert.Equal(t, spec.KindCanonical, r.Spec.Kind)
	}
}

func TestStrategyResponsesNameTheLiveVersion(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(spUniverse(), nil).AnyTimes()
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil).AnyTimes()
	srv := newTestServer(t, mockStore)
	ctx := context.Background()
	live := liveVersion("zanger-breakout")

	picks, err := srv.GetStrategyPicks(ctx, connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: "zanger-breakout"}))
	require.NoError(t, err)
	require.NotNil(t, picks.Msg.Version)
	assert.Equal(t, live.RulesHash, picks.Msg.Version.RulesHash)
	assert.Equal(t, "v0", picks.Msg.Version.Label)

	fit, err := srv.GetStockStrategyFit(ctx, connect.NewRequest(&shortsv1alpha1.GetStockStrategyFitRequest{StockCode: "SET"}))
	require.NoError(t, err)
	require.NotEmpty(t, fit.Msg.Fits)
	for _, f := range fit.Msg.Fits {
		assert.Equal(t, liveRulesHash(f.StrategyId), f.VersionHash, f.StrategyId)
		assert.NotEmpty(t, f.VersionHash)
	}

	list, err := srv.ListStrategies(ctx, connect.NewRequest(&shortsv1alpha1.ListStrategiesRequest{}))
	require.NoError(t, err)
	for _, st := range list.Msg.Strategies {
		require.NotNil(t, st.Version, st.Id)
		assert.Equal(t, liveVersion(st.Id).RulesHash, st.Version.RulesHash)
	}
}
