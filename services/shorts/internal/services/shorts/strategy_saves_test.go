package shorts

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// fakeSaves is an in-memory StrategySavesStore with the store's contract: a
// repeat save returns the existing row, a save at the cap is refused, and an
// unsave of a strategy not saved succeeds. Owners are kept apart by uid, as the
// table keys them.
type fakeSaves struct {
	mu      sync.Mutex
	rows    map[string][]shortsstore.StrategySaveRow // by uid
	missing bool                                     // answer ErrRelationMissing for every call
	unowned map[string]bool                          // variant refs this fake reports as not owned
	clock   time.Time
	// unsaved records the refs unsave was asked for, after the handler's normalisation.
	unsaved []string
}

func newFakeSaves() *fakeSaves {
	return &fakeSaves{rows: map[string][]shortsstore.StrategySaveRow{}, clock: time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)}
}

func (f *fakeSaves) SaveStrategy(_ context.Context, uid, ref string) (shortsstore.StrategySaveRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.missing {
		return shortsstore.StrategySaveRow{}, shortsstore.ErrRelationMissing
	}
	if f.unowned[ref] {
		return shortsstore.StrategySaveRow{}, shortsstore.ErrStrategyRefNotFound
	}
	for _, r := range f.rows[uid] {
		if r.StrategyRef == ref {
			return r, nil
		}
	}
	if len(f.rows[uid]) >= shortsstore.MaxSavedStrategies {
		return shortsstore.StrategySaveRow{}, shortsstore.ErrStrategySaveLimit
	}
	f.clock = f.clock.Add(time.Minute)
	row := shortsstore.StrategySaveRow{StrategyRef: ref, SavedAt: f.clock}
	f.rows[uid] = append([]shortsstore.StrategySaveRow{row}, f.rows[uid]...)
	return row, nil
}

func (f *fakeSaves) UnsaveStrategy(_ context.Context, uid, ref string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.missing {
		return shortsstore.ErrRelationMissing
	}
	f.unsaved = append(f.unsaved, ref)
	kept := f.rows[uid][:0]
	for _, r := range f.rows[uid] {
		if r.StrategyRef != ref {
			kept = append(kept, r)
		}
	}
	f.rows[uid] = kept
	return nil
}

func (f *fakeSaves) ListStrategySaves(_ context.Context, uid string) ([]shortsstore.StrategySaveRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.missing {
		return nil, nil
	}
	return append([]shortsstore.StrategySaveRow(nil), f.rows[uid]...), nil
}

// savesServer is a server over the strategy universe with the saves store set.
func savesServer(t *testing.T, saves shortsstore.StrategySavesStore) *ShortsServer {
	t.Helper()
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	store.EXPECT().ListStrategyCandidates(gomock.Any()).Return(spUniverse(), nil).AnyTimes()
	store.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil).AnyTimes()
	srv := newTestServer(t, store)
	srv.strategySaves = saves
	return srv
}

func connectCode(err error) connect.Code {
	var ce *connect.Error
	if errors.As(err, &ce) {
		return ce.Code()
	}
	return connect.CodeUnknown
}

func saveReq(ref string) *connect.Request[shortsv1alpha1.SaveStrategyRequest] {
	return connect.NewRequest(&shortsv1alpha1.SaveStrategyRequest{StrategyRef: ref})
}

func TestSaveStrategy_RefusesACallerWithNoIdentity(t *testing.T) {
	saves := newFakeSaves()
	srv := savesServer(t, saves)
	_, err := srv.SaveStrategy(context.Background(), saveReq("zanger-breakout"))
	assert.Equal(t, connect.CodeUnauthenticated, connectCode(err))
	assert.Empty(t, saves.rows)
}

func TestSaveStrategy_SavesUnderTheVerifiedUID(t *testing.T) {
	saves := newFakeSaves()
	srv := savesServer(t, saves)
	resp, err := srv.SaveStrategy(vdClaims("user-a", "", false), saveReq("zanger-breakout"))
	require.NoError(t, err)
	assert.Equal(t, "zanger-breakout", resp.Msg.Saved.StrategyRef)
	assert.Equal(t, "zanger-breakout", resp.Msg.Saved.StrategyId)
	assert.NotEmpty(t, resp.Msg.Saved.Name)
	assert.NotEmpty(t, resp.Msg.Saved.SavedAt)
	assert.Len(t, saves.rows["user-a"], 1)
	assert.Empty(t, saves.rows["user-b"], "another user's list is untouched")
}

func TestSaveStrategy_ARepeatSaveSucceedsAndKeepsItsFirstSaveTime(t *testing.T) {
	saves := newFakeSaves()
	srv := savesServer(t, saves)
	ctx := vdClaims("user-a", "", false)
	first, err := srv.SaveStrategy(ctx, saveReq("canslim"))
	require.NoError(t, err)
	again, err := srv.SaveStrategy(ctx, saveReq("CANSLIM"))
	require.NoError(t, err)
	assert.Equal(t, first.Msg.Saved.SavedAt, again.Msg.Saved.SavedAt)
	assert.Len(t, saves.rows["user-a"], 1)
}

func TestSaveStrategy_TheTwentyFirstSaveIsRefusedAndARepeatAtTheCapSucceeds(t *testing.T) {
	saves := newFakeSaves()
	srv := savesServer(t, saves)
	ctx := vdClaims("user-a", "", false)
	for i := range shortsstore.MaxSavedStrategies {
		_, err := srv.SaveStrategy(ctx, saveReq(fmt.Sprintf("variant:v%02d", i)))
		require.NoError(t, err, "save %d", i+1)
	}
	_, err := srv.SaveStrategy(ctx, saveReq("variant:v99"))
	assert.Equal(t, connect.CodeFailedPrecondition, connectCode(err))
	assert.Contains(t, err.Error(), "up to 20")

	again, err := srv.SaveStrategy(ctx, saveReq("variant:v03"))
	require.NoError(t, err, "a repeat save at the cap is not a new strategy")
	assert.Equal(t, "variant:v03", again.Msg.Saved.StrategyRef)
	assert.Len(t, saves.rows["user-a"], shortsstore.MaxSavedStrategies)
}

func TestSaveStrategy_AnUnknownStrategyIsNotFound(t *testing.T) {
	srv := savesServer(t, newFakeSaves())
	_, err := srv.SaveStrategy(vdClaims("user-a", "", false), saveReq("no-such-strategy"))
	assert.Equal(t, connect.CodeNotFound, connectCode(err))
}

func TestSaveStrategy_AnEmptyOrMalformedRefIsInvalidArgument(t *testing.T) {
	srv := savesServer(t, newFakeSaves())
	ctx := vdClaims("user-a", "", false)
	for _, ref := range []string{"", "   ", "variant:", "variant:bad id!", "variant:" + string(make([]byte, 65))} {
		_, err := srv.SaveStrategy(ctx, saveReq(ref))
		assert.Equal(t, connect.CodeInvalidArgument, connectCode(err), "ref %q", ref)
	}
}

func TestSaveStrategy_AVariantAnotherUserOwnsIsNotFound(t *testing.T) {
	saves := newFakeSaves()
	saves.unowned = map[string]bool{"variant:someone-elses": true}
	srv := savesServer(t, saves)
	_, err := srv.SaveStrategy(vdClaims("user-a", "premium", true), saveReq("variant:someone-elses"))
	assert.Equal(t, connect.CodeNotFound, connectCode(err))
	assert.Empty(t, saves.rows["user-a"])
}

func TestSaveStrategy_AMissingTableIsUnavailable(t *testing.T) {
	saves := newFakeSaves()
	saves.missing = true
	srv := savesServer(t, saves)
	_, err := srv.SaveStrategy(vdClaims("user-a", "", false), saveReq("canslim"))
	assert.Equal(t, connect.CodeUnavailable, connectCode(err))
}

func TestSaveStrategy_WithoutAStoreIsUnavailable(t *testing.T) {
	srv := savesServer(t, nil)
	_, err := srv.SaveStrategy(vdClaims("user-a", "", false), saveReq("canslim"))
	assert.Equal(t, connect.CodeUnavailable, connectCode(err))
}

func TestUnsaveStrategy_RemovesOnlyTheCallersSave(t *testing.T) {
	saves := newFakeSaves()
	srv := savesServer(t, saves)
	_, err := srv.SaveStrategy(vdClaims("user-a", "", false), saveReq("canslim"))
	require.NoError(t, err)
	_, err = srv.SaveStrategy(vdClaims("user-b", "", false), saveReq("canslim"))
	require.NoError(t, err)

	_, err = srv.UnsaveStrategy(vdClaims("user-a", "", false), connect.NewRequest(&shortsv1alpha1.UnsaveStrategyRequest{StrategyRef: "CANSLIM"}))
	require.NoError(t, err)
	assert.Empty(t, saves.rows["user-a"])
	assert.Len(t, saves.rows["user-b"], 1)
	assert.Equal(t, []string{"canslim"}, saves.unsaved, "the ref is stored in its canonical form")
}

func TestUnsaveStrategy_ANotSavedStrategySucceeds(t *testing.T) {
	srv := savesServer(t, newFakeSaves())
	_, err := srv.UnsaveStrategy(vdClaims("user-a", "", false), connect.NewRequest(&shortsv1alpha1.UnsaveStrategyRequest{StrategyRef: "canslim"}))
	require.NoError(t, err)
}

func TestUnsaveStrategy_RefusesACallerWithNoIdentity(t *testing.T) {
	srv := savesServer(t, newFakeSaves())
	_, err := srv.UnsaveStrategy(context.Background(), connect.NewRequest(&shortsv1alpha1.UnsaveStrategyRequest{StrategyRef: "canslim"}))
	assert.Equal(t, connect.CodeUnauthenticated, connectCode(err))
}

func TestListSavedStrategies_NamesCountsAndTheLimit(t *testing.T) {
	saves := newFakeSaves()
	srv := savesServer(t, saves)
	ctx := vdClaims("user-a", "", false)
	for _, ref := range []string{"canslim", "zanger-breakout", "variant:mine"} {
		_, err := srv.SaveStrategy(ctx, saveReq(ref))
		require.NoError(t, err)
	}
	resp, err := srv.ListSavedStrategies(ctx, connect.NewRequest(&shortsv1alpha1.ListSavedStrategiesRequest{}))
	require.NoError(t, err)
	require.Len(t, resp.Msg.Strategies, 3)
	assert.Equal(t, int32(shortsstore.MaxSavedStrategies), resp.Msg.Limit)

	// Most recent save first.
	assert.Equal(t, "variant:mine", resp.Msg.Strategies[0].StrategyRef)
	assert.Empty(t, resp.Msg.Strategies[0].Name, "a variant carries no registry name")
	assert.Nil(t, resp.Msg.Strategies[0].StatusCounts, "a variant carries no counts here")

	for _, s := range resp.Msg.Strategies[1:] {
		assert.NotEmpty(t, s.Name)
		require.NotNil(t, s.StatusCounts, "a canonical strategy carries today's counts")
	}
}

func TestListSavedStrategies_ACountThatCannotBeReadIsLeftOut(t *testing.T) {
	saves := newFakeSaves()
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	store.EXPECT().ListStrategyCandidates(gomock.Any()).Return(nil, errors.New("database down")).AnyTimes()
	store.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil).AnyTimes()
	srv := newTestServer(t, store)
	srv.strategySaves = saves
	ctx := vdClaims("user-a", "", false)
	_, err := srv.SaveStrategy(ctx, saveReq("canslim"))
	require.NoError(t, err)

	resp, err := srv.ListSavedStrategies(ctx, connect.NewRequest(&shortsv1alpha1.ListSavedStrategiesRequest{}))
	require.NoError(t, err, "a failed evaluation does not fail the list")
	require.Len(t, resp.Msg.Strategies, 1)
	assert.Equal(t, "canslim", resp.Msg.Strategies[0].StrategyId)
	assert.Nil(t, resp.Msg.Strategies[0].StatusCounts)
}

func TestListSavedStrategies_AnEmptyListWhenNothingIsSaved(t *testing.T) {
	srv := savesServer(t, newFakeSaves())
	resp, err := srv.ListSavedStrategies(vdClaims("user-a", "", false), connect.NewRequest(&shortsv1alpha1.ListSavedStrategiesRequest{}))
	require.NoError(t, err)
	assert.Empty(t, resp.Msg.Strategies)
	assert.Equal(t, int32(20), resp.Msg.Limit)
}

func TestListSavedStrategies_RefusesACallerWithNoIdentity(t *testing.T) {
	srv := savesServer(t, newFakeSaves())
	_, err := srv.ListSavedStrategies(context.Background(), connect.NewRequest(&shortsv1alpha1.ListSavedStrategiesRequest{}))
	assert.Equal(t, connect.CodeUnauthenticated, connectCode(err))
}

func TestParseStrategyRef_NormalisesCanonicalIdsAndKeepsVariantIdCase(t *testing.T) {
	ref, err := parseStrategyRef("  CANSLIM ")
	require.NoError(t, err)
	assert.Equal(t, "canslim", ref)

	ref, err = parseStrategyRef("Variant:Abc-123")
	require.NoError(t, err)
	assert.Equal(t, "variant:Abc-123", ref)
}
