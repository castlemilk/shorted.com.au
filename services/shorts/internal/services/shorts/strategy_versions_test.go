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
		assert.Equal(t, "v1", v.Version.Label, "the live version is v1")
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
	require.Len(t, all.Msg.Versions, len(spec.Registry()), "a v0 and a v1 per strategy")

	one, err := srv.ListStrategyVersions(ctx, connect.NewRequest(&shortsv1alpha1.ListStrategyVersionsRequest{StrategyId: "crowded-short-breakout"}))
	require.NoError(t, err)
	require.Len(t, one.Msg.Versions, 2)
	old := one.Msg.Versions[0]
	assert.Equal(t, "v0", old.Version.Label)
	assert.Equal(t, "superseded", old.Version.Status)
	assert.Len(t, old.KnownIssues, 6, "v0's six known issues stay published")

	v := one.Msg.Versions[1]
	assert.Equal(t, "crowded-short-breakout", v.Version.StrategyId)
	assert.Equal(t, "v1", v.Version.Label)
	assert.Equal(t, "live", v.Version.Status)
	assert.Empty(t, v.SupersededOn)
	assert.Empty(t, v.RetiredOn)
	assert.NotEmpty(t, v.Params)
	assert.Contains(t, v.Policies, "A price bar on the session is required; a suspended or delisted code is not evaluated.")
	assert.Empty(t, v.KnownIssues, "v1 publishes no known issues of its own")
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

	// On the views path (this test server's source) the responses name the
	// version the views evaluate, v0; on the snapshot path they name the live one.
	served := servedRefOf(srv.servedVersionOf(ctx, "zanger-breakout"))
	require.NotNil(t, served)
	assert.Equal(t, "v0", served.Label)
	assert.Equal(t, live.RulesHash, liveRulesHash("zanger-breakout"))

	picks, err := srv.GetStrategyPicks(ctx, connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: "zanger-breakout"}))
	require.NoError(t, err)
	require.NotNil(t, picks.Msg.Version)
	assert.Equal(t, served.RulesHash, picks.Msg.Version.RulesHash)
	assert.Equal(t, "v0", picks.Msg.Version.Label)

	fit, err := srv.GetStockStrategyFit(ctx, connect.NewRequest(&shortsv1alpha1.GetStockStrategyFitRequest{StockCode: "SET"}))
	require.NoError(t, err)
	require.NotEmpty(t, fit.Msg.Fits)
	for _, f := range fit.Msg.Fits {
		assert.Equal(t, srv.servedRulesHash(ctx, f.StrategyId), f.VersionHash, f.StrategyId)
		assert.NotEmpty(t, f.VersionHash)
	}

	list, err := srv.ListStrategies(ctx, connect.NewRequest(&shortsv1alpha1.ListStrategiesRequest{}))
	require.NoError(t, err)
	for _, st := range list.Msg.Strategies {
		require.NotNil(t, st.Version, st.Id)
		assert.Equal(t, srv.servedRulesHash(ctx, st.Id), st.Version.RulesHash)
	}
}

func TestPolicyLinesStateLiveSnapshotFundamentalsOnlyWhenRequired(t *testing.T) {
	const sentence = "Fundamentals are the latest reported as of the previous nightly pull, not point-in-time before November 2026."
	base := spec.Spec{Data: spec.DataPolicy{Fundamentals: "live_snapshot"}}

	withReq := base
	withReq.Requires = []spec.DataReq{{Source: "prices", From: "2015-10-01"}, {Source: "fundamentals", From: "computable_from"}}
	assert.Contains(t, policyLines(withReq), sentence)

	withoutReq := base
	withoutReq.Requires = []spec.DataReq{{Source: "prices", From: "2015-10-01"}}
	assert.NotContains(t, policyLines(withoutReq), sentence)

	for _, st := range engine.Registry() {
		live, ok := spec.Live(st.ID)
		require.True(t, ok)
		assert.Equal(t, requiresSource(live.Spec, "fundamentals"), contains(policyLines(live.Spec), sentence), st.ID)
	}
}

func contains(lines []string, want string) bool {
	for _, l := range lines {
		if l == want {
			return true
		}
	}
	return false
}
