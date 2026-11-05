package shorts

import (
	"context"
	"errors"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// versionTableFake is the snapshot store with the version tables in it. The
// rows it serves are set per test; the snapshot is the embedded fake's.
type versionTableFake struct {
	*snapshotStoreFake
	canonical []shortsstore.CanonicalRuleVersion
	live      []shortsstore.LiveRuleVersion
	canonErr  error
}

func (f *versionTableFake) ReadCanonicalRuleVersions(context.Context) ([]shortsstore.CanonicalRuleVersion, error) {
	return f.canonical, f.canonErr
}

func (f *versionTableFake) ReadLiveRuleVersions(context.Context) ([]shortsstore.LiveRuleVersion, error) {
	return f.live, nil
}

// tableVersion is one canonical row of the table for a registered version.
func tableVersion(t *testing.T, id, label, status, liveFrom, supersededOn string) shortsstore.CanonicalRuleVersion {
	t.Helper()
	r, ok := spec.Version(id, label)
	require.True(t, ok, id+" "+label)
	hash, err := spec.RulesHash(r.Spec)
	require.NoError(t, err)
	return shortsstore.CanonicalRuleVersion{
		RulesHash: hash, StrategyID: id, Label: label, Status: status,
		LiveFrom: liveFrom, SupersededOn: supersededOn,
	}
}

// liveRow is the live table row a snapshot universe reads for a version.
func liveRow(row shortsstore.CanonicalRuleVersion) shortsstore.LiveRuleVersion {
	return shortsstore.LiveRuleVersion{StrategyID: row.StrategyID, RulesHash: row.RulesHash, Label: row.Label, LiveFrom: row.LiveFrom}
}

func versionFake(t *testing.T, canonical ...shortsstore.CanonicalRuleVersion) *versionTableFake {
	t.Helper()
	ctrl := gomock.NewController(t)
	var live []shortsstore.LiveRuleVersion
	for _, row := range canonical {
		if row.Status == "live" {
			live = append(live, liveRow(row))
		}
	}
	return &versionTableFake{
		snapshotStoreFake: &snapshotStoreFake{MockShortsStore: mocks.NewMockShortsStore(ctrl), snap: snapshotOf()},
		canonical:         canonical,
		live:              live,
	}
}

// Before the job promotes v1, the table marks v0 live from its session and v1
// is a draft: the version RPCs say so, not the registry's live flag.
func TestVersionRPCsStateTheTableBeforePromotion(t *testing.T) {
	fake := versionFake(t,
		tableVersion(t, spec.StrategyZangerBreakout, "v0", "live", "2026-11-12", ""),
	)
	srv := newTestServer(t, fake)
	ctx := context.Background()

	list, err := srv.ListStrategyVersions(ctx, connect.NewRequest(&shortsv1alpha1.ListStrategyVersionsRequest{StrategyId: spec.StrategyZangerBreakout}))
	require.NoError(t, err)
	require.Len(t, list.Msg.Versions, 2)
	assert.Equal(t, "v0", list.Msg.Versions[0].Version.Label)
	assert.Equal(t, "live", list.Msg.Versions[0].Version.Status)
	assert.Equal(t, "2026-11-12", list.Msg.Versions[0].Version.LiveFrom)
	assert.Equal(t, "v1", list.Msg.Versions[1].Version.Label)
	assert.Equal(t, "draft", list.Msg.Versions[1].Version.Status, "a registered version the table does not record yet is a draft")

	live, err := srv.GetStrategyVersion(ctx, connect.NewRequest(&shortsv1alpha1.GetStrategyVersionRequest{StrategyId: spec.StrategyZangerBreakout}))
	require.NoError(t, err)
	assert.Equal(t, "v0", live.Msg.Version.Version.Label)
	assert.Equal(t, "live", live.Msg.Version.Version.Status)
	assert.Equal(t, "2026-11-12", live.Msg.Version.Version.LiveFrom)
}

// After promotion, v1 is live from its session and v0 is superseded on it.
func TestVersionRPCsStateThePromotion(t *testing.T) {
	fake := versionFake(t,
		tableVersion(t, spec.StrategyZangerBreakout, "v0", "superseded", "2026-11-12", "2026-11-16"),
		tableVersion(t, spec.StrategyZangerBreakout, "v1", "live", "2026-11-16", ""),
	)
	srv := newTestServer(t, fake)
	ctx := context.Background()

	list, err := srv.ListStrategyVersions(ctx, connect.NewRequest(&shortsv1alpha1.ListStrategyVersionsRequest{StrategyId: spec.StrategyZangerBreakout}))
	require.NoError(t, err)
	require.Len(t, list.Msg.Versions, 2)
	old, next := list.Msg.Versions[0], list.Msg.Versions[1]
	assert.Equal(t, "superseded", old.Version.Status)
	assert.Equal(t, "2026-11-16", old.SupersededOn)
	assert.Equal(t, "live", next.Version.Status)
	assert.Equal(t, "2026-11-16", next.Version.LiveFrom)

	live, err := srv.GetStrategyVersion(ctx, connect.NewRequest(&shortsv1alpha1.GetStrategyVersionRequest{StrategyId: spec.StrategyZangerBreakout}))
	require.NoError(t, err)
	assert.Equal(t, "v1", live.Msg.Version.Version.Label)
}

// A failed table read is Unavailable: the version is never named from the registry.
func TestVersionRPCsRefuseWhenTheTableCannotBeRead(t *testing.T) {
	fake := versionFake(t)
	fake.canonErr = errors.New("connection reset")
	srv := newTestServer(t, fake)
	ctx := context.Background()

	_, err := srv.GetStrategyVersion(ctx, connect.NewRequest(&shortsv1alpha1.GetStrategyVersionRequest{StrategyId: spec.StrategyZangerBreakout}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeUnavailable, connect.CodeOf(err))

	_, err = srv.ListStrategyVersions(ctx, connect.NewRequest(&shortsv1alpha1.ListStrategyVersionsRequest{}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeUnavailable, connect.CodeOf(err))
}

// On the snapshot path the picks serve the version the table marks live, with
// its live_from and its universe: v0 keeps the all-instruments universe (the
// ETP row stays), v1 drops it, and the response changes only when the table does.
func TestSnapshotPicksServeTheTableLiveVersion(t *testing.T) {
	day := snapDay()
	etp := snapRow(day, "ETF", 120)
	etp.IsOrdinary = false
	etp.OrdinaryFresh60 = false

	v0 := tableVersion(t, spec.StrategyZangerBreakout, "v0", "live", "2026-11-12", "")
	fake := versionFake(t, v0)
	fake.snap.Rows = append(fake.snap.Rows, etp)
	srv := newTestServer(t, fake)
	srv.config.StrategySource = StrategySourceSnapshot
	ctx := context.Background()

	req := connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: spec.StrategyZangerBreakout})
	resp, err := srv.GetStrategyPicks(ctx, req)
	require.NoError(t, err)
	assert.Equal(t, "v0", resp.Msg.Version.Label)
	assert.Equal(t, "live", resp.Msg.Version.Status)
	assert.Equal(t, "2026-11-12", resp.Msg.Version.LiveFrom)
	assert.Equal(t, int32(3), resp.Msg.UniverseCount, "v0 keeps the ETP row: BHP, CBA and ETF")

	// The job promotes v1: a fresh instance reads the new table.
	v1 := tableVersion(t, spec.StrategyZangerBreakout, "v1", "live", "2026-11-16", "")
	v0.Status, v0.LiveFrom = "superseded", "2026-11-12"
	v0.SupersededOn = "2026-11-16"
	fake = versionFake(t, v0, v1)
	fake.snap.Rows = append(fake.snap.Rows, etp)
	srv = newTestServer(t, fake)
	srv.config.StrategySource = StrategySourceSnapshot

	resp, err = srv.GetStrategyPicks(ctx, req)
	require.NoError(t, err)
	assert.Equal(t, "v1", resp.Msg.Version.Label)
	assert.Equal(t, "2026-11-16", resp.Msg.Version.LiveFrom)
	assert.Equal(t, int32(2), resp.Msg.UniverseCount, "v1's ordinary universe drops the ETP row")
}

// The ladder is the served version's: under v1 an unknown trigger is unknown,
// under v0 the same universe has no unknown picks. The Zanger universe's WAT
// and NIL carry no growth figures, so eps_growth is unknown for them.
func TestPicksLadderFollowsTheServedVersion(t *testing.T) {
	cands := spUniverse()
	regime := spUptrend()
	day := "2026-09-24"
	id := spec.StrategyZangerBreakout
	v0, _ := spec.Version(id, "v0")
	v0hash, err := spec.RulesHash(v0.Spec)
	require.NoError(t, err)

	cases := map[string]struct {
		live        map[string]shortsstore.LiveRuleVersion
		label       string
		wantUnknown bool
	}{
		"v1 registered live": {live: nil, label: "v1", wantUnknown: true},
		"table keeps v0":     {live: map[string]shortsstore.LiveRuleVersion{id: {StrategyID: id, RulesHash: v0hash, Label: "v0"}}, label: "v0", wantUnknown: false},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			srv := newTestServer(t, mocks.NewMockShortsStore(gomock.NewController(t)))
			srv.config.StrategySource = StrategySourceSnapshot
			u := newStrategyUniverse(cands, regime, day, StrategySourceSnapshot, tc.live)
			_, err := srv.cache.GetOrSetWithTTL(srv.cache.GetStrategyUniverseKey(), time.Minute, func() (any, error) { return u, nil })
			require.NoError(t, err)

			resp, err := srv.GetStrategyPicks(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: id}))
			require.NoError(t, err)
			assert.Equal(t, tc.label, resp.Msg.Version.Label)
			if tc.wantUnknown {
				assert.Positive(t, resp.Msg.StatusCounts.Unknown, "v1 reads an unknown core rule as unknown")
			} else {
				assert.Zero(t, resp.Msg.StatusCounts.Unknown, "v0 reads it as setup or watch")
			}
		})
	}
}

// Crowded-Short ranks only the names the report lists, and its fundamentals
// counts are over those names: they never exceed its universe_count, while the
// other strategies keep the shared universe's counts.
func TestCrowdedShortFundamentalsCountOnlyItsOwnUniverse(t *testing.T) {
	cands := qualityUniverse()
	for i := range cands {
		cands[i].InASICReport = cands[i].StockCode == "WAT" || cands[i].StockCode == "NIL"
	}
	srv := newTestServer(t, mocks.NewMockShortsStore(gomock.NewController(t)))
	srv.config.StrategySource = StrategySourceSnapshot
	u := newStrategyUniverse(cands, spUptrend(), "2026-09-24", StrategySourceSnapshot, nil)
	_, err := srv.cache.GetOrSetWithTTL(srv.cache.GetStrategyUniverseKey(), time.Minute, func() (any, error) { return u, nil })
	require.NoError(t, err)
	ctx := context.Background()

	crowded, err := srv.GetStrategyPicks(ctx, connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
	require.NoError(t, err)
	assert.Equal(t, int32(2), crowded.Msg.UniverseCount, "WAT and NIL are the report's names")
	assert.Equal(t, int32(0), crowded.Msg.FundamentalsRowsCount, "neither of them holds a fundamentals row")
	assert.Equal(t, int32(0), crowded.Msg.FundamentalsCoverageCount)

	zanger, err := srv.GetStrategyPicks(ctx, connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: spec.StrategyZangerBreakout}))
	require.NoError(t, err)
	assert.Equal(t, int32(7), zanger.Msg.UniverseCount)
	assert.Equal(t, int32(5), zanger.Msg.FundamentalsRowsCount, "RDY, SET, QAA, QBB and CBA hold a row")
}

// A universe that cannot be read still names the table's live version, not the
// registry's: the served version never comes from a guess the table contradicts.
func TestServedVersionWhenTheUniverseFailsFollowsTheTable(t *testing.T) {
	v0 := tableVersion(t, spec.StrategyZangerBreakout, "v0", "live", "2026-11-12", "")
	fake := versionFake(t, v0)
	fake.snapErr = errors.New("connection reset")
	srv := newTestServer(t, fake)
	srv.config.StrategySource = StrategySourceSnapshot

	got := srv.servedVersionOf(context.Background(), spec.StrategyZangerBreakout)
	assert.Equal(t, "v0", got.reg.Label, "the table marks v0 live")
	assert.Equal(t, "2026-11-12", got.liveFrom)
}

// adapterVersionStore is the store the binary builds the server on: the Postgres
// store behind StoreAdapter. Its embedded shortsstore.Store is nil, so a call to
// any method the adapter does not forward panics, which is the point.
type adapterVersionStore struct {
	shortsstore.Store
	*versionTableFake
}

// The version tables reach the server through the adapter, as in production. The
// handler tests fake the store directly and pass even when the adapter forwards
// nothing: then the table reads as unmigrated and the registry answers.
func TestServedVersionReadsThroughTheStoreAdapter(t *testing.T) {
	v0 := tableVersion(t, spec.StrategyZangerBreakout, "v0", "live", "2026-11-12", "")
	v1 := tableVersion(t, spec.StrategyZangerBreakout, "v1", "draft", "", "")
	fake := versionFake(t, v0, v1)
	srv := &ShortsServer{
		store:  NewStoreAdapter(adapterVersionStore{versionTableFake: fake}),
		cache:  NewMemoryCache(time.Minute),
		logger: NewLoggerAdapter(),
	}
	srv.config.StrategySource = StrategySourceSnapshot
	ctx := context.Background()

	resp, err := srv.GetStrategyPicks(ctx, connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{StrategyId: spec.StrategyZangerBreakout}))
	require.NoError(t, err)
	assert.Equal(t, "v0", resp.Msg.Version.Label, "the table's live row, not the registry's v1")
	assert.Equal(t, "live", resp.Msg.Version.Status)
	assert.Equal(t, "2026-11-12", resp.Msg.Version.LiveFrom)

	live, err := srv.GetStrategyVersion(ctx, connect.NewRequest(&shortsv1alpha1.GetStrategyVersionRequest{StrategyId: spec.StrategyZangerBreakout}))
	require.NoError(t, err)
	assert.Equal(t, "v0", live.Msg.Version.Version.Label)
	assert.Equal(t, "2026-11-12", live.Msg.Version.Version.LiveFrom)

	list, err := srv.ListStrategyVersions(ctx, connect.NewRequest(&shortsv1alpha1.ListStrategyVersionsRequest{StrategyId: spec.StrategyZangerBreakout}))
	require.NoError(t, err)
	require.Len(t, list.Msg.Versions, 2)
	assert.Equal(t, "live", list.Msg.Versions[0].Version.Status)
	assert.Equal(t, "2026-11-12", list.Msg.Versions[0].Version.LiveFrom)
	assert.Equal(t, "draft", list.Msg.Versions[1].Version.Status)
}

// A store without the version tables answers unavailable through the adapter, so
// the API falls back to the registry rather than failing the read.
func TestAdapterOverAStoreWithoutTheVersionTablesIsUnavailable(t *testing.T) {
	_, err := NewStoreAdapter(plainStore{}).ReadLiveRuleVersions(context.Background())
	assert.ErrorIs(t, err, shortsstore.ErrStrategySnapshotUnavailable)
	_, err = NewStoreAdapter(plainStore{}).ReadCanonicalRuleVersions(context.Background())
	assert.ErrorIs(t, err, shortsstore.ErrStrategySnapshotUnavailable)
}
