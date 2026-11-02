package shorts

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeClock is the holder's clock. The test moves it and the holder reads it.
// It counts its reads, so a test can wait until the holder has reached one.
type fakeClock struct {
	mu    sync.Mutex
	t     time.Time
	reads int
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.reads++
	return c.t
}

func (c *fakeClock) readCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.reads
}

func (c *fakeClock) set(t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = t
}

// snapshot is the holder's current universe and whether a refresh is running.
func (h *ownershipUniverseHolder) snapshot() (*ownershipUniverse, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.cur, h.refreshing
}

// testHolder is a holder whose build counts its runs. Like the server's build,
// it stamps the universe with the clock's time when it starts. before, when
// set, runs after the count and may fail or block.
func testHolder(clock *fakeClock, builds *atomic.Int32, before func(run int32) error) *ownershipUniverseHolder {
	return &ownershipUniverseHolder{
		now: clock.now,
		build: func(context.Context) (*ownershipUniverse, error) {
			run := builds.Add(1)
			builtAt := clock.now()
			if before != nil {
				if err := before(run); err != nil {
					return nil, err
				}
			}
			return newOwnershipUniverse(ownershipFixture(), nil, nil, builtAt), nil
		},
	}
}

func TestNewOwnershipUniverseStampsItsBuild(t *testing.T) {
	u := newOwnershipUniverse(ownershipFixture(), nil, nil, ownershipTestNow)
	assert.Equal(t, ownershipTestNow, u.builtAt)
	assert.Equal(t, ownershipTestNow.Add(ownershipTTL), u.expiresAt)
	assert.Equal(t, ownershipTestNow.UnixNano(), u.generation)
}

func TestOwnershipUniverseFirstGetBuildsSynchronously(t *testing.T) {
	clock := &fakeClock{t: ownershipTestNow}
	var builds atomic.Int32
	h := testHolder(clock, &builds, nil)
	ctx := context.Background()

	u, err := h.get(ctx)
	require.NoError(t, err)
	assert.EqualValues(t, 1, builds.Load())
	assert.Equal(t, ownershipTestNow.Add(ownershipTTL), u.expiresAt)

	again, err := h.get(ctx)
	require.NoError(t, err)
	assert.Same(t, u, again, "outside the window nothing is built on the request path")
	assert.EqualValues(t, 1, builds.Load())
}

func TestOwnershipUniverseRefreshesInsideTheWindowOnce(t *testing.T) {
	clock := &fakeClock{t: ownershipTestNow}
	var builds atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	h := testHolder(clock, &builds, func(run int32) error {
		if run == 2 {
			close(started)
			<-release
		}
		return nil
	})
	ctx := context.Background()
	first, err := h.get(ctx)
	require.NoError(t, err)

	clock.set(first.expiresAt.Add(-time.Minute)) // inside the window, still valid
	served, err := h.get(ctx)
	require.NoError(t, err)
	assert.Same(t, first, served, "the current universe is served while the refresh runs")
	<-started
	again, err := h.get(ctx)
	require.NoError(t, err)
	assert.Same(t, first, again, "a second request in the window starts no second build")
	assert.EqualValues(t, 2, builds.Load())

	close(release)
	require.Eventually(t, func() bool {
		cur, refreshing := h.snapshot()
		return cur != first && !refreshing
	}, 5*time.Second, time.Millisecond)
	assert.EqualValues(t, 2, builds.Load(), "the refresh swapped in; nothing ran twice")
}

func TestOwnershipUniverseExpiredRequestJoinsTheRunningRefresh(t *testing.T) {
	clock := &fakeClock{t: ownershipTestNow}
	var builds atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	h := testHolder(clock, &builds, func(run int32) error {
		switch run {
		case 2:
			close(started)
			<-release
		case 3:
			t.Errorf("a request that joined the refresh started a third build")
		}
		return nil
	})
	ctx := context.Background()
	first, err := h.get(ctx)
	require.NoError(t, err)

	clock.set(first.expiresAt.Add(-time.Minute))
	_, err = h.get(ctx) // starts the refresh, which blocks
	require.NoError(t, err)
	<-started

	clock.set(first.expiresAt.Add(time.Second)) // the first universe has expired
	reads := clock.readCount()
	type answer struct {
		u   *ownershipUniverse
		err error
	}
	joined := make(chan answer, 1)
	go func() {
		u, err := h.get(ctx)
		joined <- answer{u, err}
	}()
	// The request reads the clock under the holder's lock, after it has taken
	// the expired universe. A request that read the clock after the refresh
	// swapped would find the fresh universe and prove nothing, so the refresh
	// waits for this read.
	require.Eventually(t, func() bool { return clock.readCount() > reads }, 5*time.Second, time.Millisecond)
	close(release)

	got := <-joined
	require.NoError(t, got.err)
	assert.EqualValues(t, 2, builds.Load(), "the request joined the refresh; it did not start a third build")
	cur, _ := h.snapshot()
	assert.Same(t, cur, got.u)
}

// A refresh can fail on its own deadline, because the instance had no request
// in flight to run it. The request that joins that failure must not inherit it:
// it builds for itself.
func TestOwnershipUniverseExpiredRequestSurvivesAStalledRefresh(t *testing.T) {
	clock := &fakeClock{t: ownershipTestNow}
	var builds atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	h := testHolder(clock, &builds, func(run int32) error {
		if run == 2 {
			close(started)
			<-release
			return context.DeadlineExceeded // the refresh ran past its own deadline
		}
		return nil
	})
	ctx := context.Background()
	first, err := h.get(ctx)
	require.NoError(t, err)

	clock.set(first.expiresAt.Add(-time.Minute))
	_, err = h.get(ctx) // starts the refresh, which stalls
	require.NoError(t, err)
	<-started

	now := first.expiresAt.Add(time.Second)
	clock.set(now) // the first universe has expired while the refresh is stalled
	reads := clock.readCount()
	type answer struct {
		u   *ownershipUniverse
		err error
	}
	joined := make(chan answer, 1)
	go func() {
		u, err := h.get(ctx)
		joined <- answer{u, err}
	}()
	require.Eventually(t, func() bool { return clock.readCount() > reads }, 5*time.Second, time.Millisecond)
	close(release)

	got := <-joined
	require.NoError(t, got.err, "a stalled refresh must not fail the request that joins it")
	assert.Equal(t, now, got.u.builtAt, "the request is served a universe it built for itself")
	assert.EqualValues(t, 3, builds.Load(), "the joined refresh failed, so the request built once more")
	cur, _ := h.snapshot()
	assert.Same(t, cur, got.u)
}

// A build that panics fails that build alone: the request that ran it is told,
// and the next request builds again.
func TestOwnershipUniverseBuildPanicFailsOnlyThatBuild(t *testing.T) {
	clock := &fakeClock{t: ownershipTestNow}
	var builds atomic.Int32
	h := testHolder(clock, &builds, func(run int32) error {
		if run == 1 {
			panic("a row the build cannot read")
		}
		return nil
	})
	ctx := context.Background()

	_, err := h.get(ctx)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "panicked")
	u, err := h.get(ctx)
	require.NoError(t, err)
	assert.NotNil(t, u)
	assert.EqualValues(t, 2, builds.Load())
}

// A refresh that panics keeps the universe it could not replace, and clears its
// flag so the next request in the window tries again.
func TestOwnershipUniversePanickingRefreshKeepsTheCurrentUniverse(t *testing.T) {
	clock := &fakeClock{t: ownershipTestNow}
	var builds atomic.Int32
	h := testHolder(clock, &builds, func(run int32) error {
		if run == 2 {
			panic("a row the refresh cannot read")
		}
		return nil
	})
	ctx := context.Background()
	first, err := h.get(ctx)
	require.NoError(t, err)

	clock.set(first.expiresAt.Add(-time.Minute))
	served, err := h.get(ctx)
	require.NoError(t, err)
	assert.Same(t, first, served)
	require.Eventually(t, func() bool {
		_, refreshing := h.snapshot()
		return !refreshing
	}, 5*time.Second, time.Millisecond)
	cur, _ := h.snapshot()
	assert.Same(t, first, cur, "a panicking refresh keeps the universe it could not replace")

	_, err = h.get(ctx)
	require.NoError(t, err)
	require.Eventually(t, func() bool { return builds.Load() == 3 }, 5*time.Second, time.Millisecond)
}

func TestOwnershipUniverseFailedRefreshKeepsTheCurrentUniverse(t *testing.T) {
	clock := &fakeClock{t: ownershipTestNow}
	var builds atomic.Int32
	h := testHolder(clock, &builds, func(run int32) error {
		if run == 2 {
			return errors.New("database unavailable")
		}
		return nil
	})
	ctx := context.Background()
	first, err := h.get(ctx)
	require.NoError(t, err)

	clock.set(first.expiresAt.Add(-time.Minute))
	served, err := h.get(ctx)
	require.NoError(t, err)
	assert.Same(t, first, served)
	require.Eventually(t, func() bool {
		_, refreshing := h.snapshot()
		return !refreshing
	}, 5*time.Second, time.Millisecond)
	cur, _ := h.snapshot()
	assert.Same(t, first, cur, "a failed refresh keeps the universe it could not replace")

	// The flag is cleared, so the next request in the window tries again.
	_, err = h.get(ctx)
	require.NoError(t, err)
	require.Eventually(t, func() bool { return builds.Load() == 3 }, 5*time.Second, time.Millisecond)
}

func TestOwnershipUniverseFailedBuildIsNotCached(t *testing.T) {
	clock := &fakeClock{t: ownershipTestNow}
	var builds atomic.Int32
	h := testHolder(clock, &builds, func(run int32) error {
		if run == 1 {
			return errors.New("database unavailable")
		}
		return nil
	})
	ctx := context.Background()

	_, err := h.get(ctx)
	require.Error(t, err)
	u, err := h.get(ctx)
	require.NoError(t, err)
	assert.NotNil(t, u)
	assert.EqualValues(t, 2, builds.Load(), "the failure was not kept: the next request built again")
}

// No universe is served past its expiry, whatever the request times are. The
// walk crosses the refresh window, the expiry and the rebuild between requests.
func TestOwnershipUniverseNeverServesPastItsExpiry(t *testing.T) {
	clock := &fakeClock{t: ownershipTestNow}
	var builds atomic.Int32
	h := testHolder(clock, &builds, nil)
	ctx := context.Background()
	for at := time.Duration(0); at <= 3*ownershipTTL; at += 7 * time.Second {
		clock.set(ownershipTestNow.Add(at))
		u, err := h.get(ctx)
		require.NoError(t, err)
		now := clock.now()
		assert.True(t, now.Before(u.expiresAt), "served at %v by a universe that expires at %v", now, u.expiresAt)
	}
	assert.Greater(t, builds.Load(), int32(2), "the walk crossed expiry at least twice")
}

// fakeOwnershipStore serves the rows of one ownershipData the way the Postgres
// store does, and counts the reads it serves by method.
type fakeOwnershipStore struct {
	d        *ownershipData
	notices  []shortsstore.SubstantialNoticeRow
	counts   map[string]int
	attempts []shortsstore.AttemptOutcomeRow

	mu    sync.Mutex
	reads map[string]int
}

func newFakeOwnershipStore(d *ownershipData) *fakeOwnershipStore {
	return &fakeOwnershipStore{
		d:        d,
		counts:   ownershipFixtureCounts(),
		attempts: ownershipFixtureAttempts(),
		reads:    map[string]int{},
	}
}

func (f *fakeOwnershipStore) read(method string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reads[method]++
}

func (f *fakeOwnershipStore) readCount(method string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reads[method]
}

func (f *fakeOwnershipStore) OwnershipInstitutions(context.Context) ([]shortsstore.OwnershipInstitutionRow, error) {
	f.read("OwnershipInstitutions")
	return f.d.institutions, nil
}

func (f *fakeOwnershipStore) CurrentSubstantialHoldings(_ context.Context, filter shortsstore.OwnershipFilter) ([]shortsstore.SubstantialHoldingRow, error) {
	f.read("CurrentSubstantialHoldings")
	var out []shortsstore.SubstantialHoldingRow
	for _, h := range f.d.holdings {
		if (filter.StockCode == "" || h.StockCode == filter.StockCode) && (filter.HolderKey == "" || h.HolderKey == filter.HolderKey) {
			out = append(out, h)
		}
	}
	return out, nil
}

func (f *fakeOwnershipStore) SubstantialNotices(ctx context.Context, filter shortsstore.OwnershipFilter, limit int) ([]shortsstore.SubstantialNoticeRow, error) {
	f.read("SubstantialNotices")
	if err := ctx.Err(); err != nil {
		return nil, err // a read for a caller that has gone fails, as the database's does
	}
	var out []shortsstore.SubstantialNoticeRow
	for _, n := range f.notices {
		if (filter.StockCode == "" || n.StockCode == filter.StockCode) && (filter.HolderKey == "" || n.HolderKey == filter.HolderKey) {
			out = append(out, n)
		}
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (f *fakeOwnershipStore) NoticeStats(context.Context) (*shortsstore.NoticeStats, error) {
	f.read("NoticeStats")
	return f.d.stats, nil
}

func (f *fakeOwnershipStore) NoticeCountsByStock(context.Context) (map[string]int, error) {
	f.read("NoticeCountsByStock")
	return f.counts, nil
}

func (f *fakeOwnershipStore) AttemptOutcomes(context.Context) ([]shortsstore.AttemptOutcomeRow, error) {
	f.read("AttemptOutcomes")
	return f.attempts, nil
}

func (f *fakeOwnershipStore) LatestFundHoldings(_ context.Context, filter shortsstore.OwnershipFilter) ([]shortsstore.FundHoldingRow, error) {
	f.read("LatestFundHoldings")
	var out []shortsstore.FundHoldingRow
	for _, h := range f.d.fundHoldings {
		if (filter.StockCode == "" || h.StockCode == filter.StockCode) && (filter.InstitutionSlug == "" || h.InstitutionSlug == filter.InstitutionSlug) {
			out = append(out, h)
		}
	}
	return out, nil
}

func (f *fakeOwnershipStore) OwnershipFunds(_ context.Context, slug string) ([]shortsstore.OwnershipFundRow, error) {
	f.read("OwnershipFunds")
	var out []shortsstore.OwnershipFundRow
	for _, row := range f.d.funds {
		if slug == "" || row.InstitutionSlug == slug {
			out = append(out, row)
		}
	}
	return out, nil
}

func (f *fakeOwnershipStore) LatestShortPositions(context.Context) (map[string]shortsstore.ShortPosition, error) {
	f.read("LatestShortPositions")
	return f.d.shorts, nil
}

func (f *fakeOwnershipStore) OwnershipCompanies(context.Context) (map[string]shortsstore.OwnershipCompany, error) {
	f.read("OwnershipCompanies")
	return f.d.companies, nil
}

// newOwnershipTestServer serves the fake store through the real handlers, with
// the real cache and a universe holder on the fake clock.
func newOwnershipTestServer(store *fakeOwnershipStore, clock *fakeClock) *ShortsServer {
	s := &ShortsServer{ownershipStore: store, cache: NewMemoryCache(time.Minute)}
	s.ownershipUniverse = &ownershipUniverseHolder{
		now: clock.now,
		build: func(ctx context.Context) (*ownershipUniverse, error) {
			return s.buildOwnershipUniverse(ctx, clock.now())
		},
	}
	return s
}

func TestHandlersShareOneUniverseBuild(t *testing.T) {
	clock := &fakeClock{t: ownershipTestNow}
	store := newFakeOwnershipStore(ownershipFixture())
	s := newOwnershipTestServer(store, clock)
	ctx := context.Background()

	ov, err := s.GetOwnershipOverview(ctx, connect.NewRequest(&shortsv1alpha1.GetOwnershipOverviewRequest{}))
	require.NoError(t, err)
	assert.NotEmpty(t, ov.Msg.Kinds)
	_, err = s.ListInstitutions(ctx, connect.NewRequest(&shortsv1alpha1.ListInstitutionsRequest{}))
	require.NoError(t, err)
	inst, err := s.GetInstitution(ctx, connect.NewRequest(&shortsv1alpha1.GetInstitutionRequest{Slug: "citigroup"}))
	require.NoError(t, err)
	assert.EqualValues(t, 3, inst.Msg.Institution.Notices)
	stock, err := s.GetStockOwnership(ctx, connect.NewRequest(&shortsv1alpha1.GetStockOwnershipRequest{StockCode: "BHP"}))
	require.NoError(t, err)
	assert.Len(t, stock.Msg.Holders, 2)
	assert.Equal(t, 1, store.readCount("OwnershipInstitutions"), "four rpcs, one universe")
}

// A holder's or a stock's notices are cached beside the universe they were read
// under. When a new universe replaces it, the notices are read again: the entry
// built under the old generation is not served.
func TestStockNoticesAreReadAgainForEachUniverse(t *testing.T) {
	clock := &fakeClock{t: ownershipTestNow}
	store := newFakeOwnershipStore(ownershipFixture())
	store.notices = []shortsstore.SubstantialNoticeRow{
		{StockCode: "BHP", HolderKey: "citigroup", Kind: "bank_broker", AnnouncedOn: "2026-10-07"},
	}
	s := newOwnershipTestServer(store, clock)
	ctx := context.Background()
	req := connect.NewRequest(&shortsv1alpha1.GetStockOwnershipRequest{StockCode: "BHP"})

	first, err := s.GetStockOwnership(ctx, req)
	require.NoError(t, err)
	require.Len(t, first.Msg.History, 1)

	// A notice is released and the universe expires; the next universe sees it.
	store.notices = append(store.notices, shortsstore.SubstantialNoticeRow{StockCode: "BHP", HolderKey: "vanguard", Kind: "index_manager", AnnouncedOn: "2026-10-09"})
	clock.set(ownershipTestNow.Add(ownershipTTL))
	second, err := s.GetStockOwnership(ctx, req)
	require.NoError(t, err)
	assert.Len(t, second.Msg.History, 2, "the entry built under the old generation is not served")
}

// A stock's notices are one read, shared by every caller of its key and kept for
// them, so the caller that started the read may leave before the store runs it.
func TestStockNoticesSurviveTheCallerLeaving(t *testing.T) {
	clock := &fakeClock{t: ownershipTestNow}
	store := newFakeOwnershipStore(ownershipFixture())
	store.notices = []shortsstore.SubstantialNoticeRow{
		{StockCode: "BHP", HolderKey: "citigroup", Kind: "bank_broker", AnnouncedOn: "2026-10-07"},
	}
	s := newOwnershipTestServer(store, clock)
	req := connect.NewRequest(&shortsv1alpha1.GetStockOwnershipRequest{StockCode: "BHP"})
	gone, leave := context.WithCancel(context.Background())
	leave()

	first, err := s.GetStockOwnership(gone, req)
	require.NoError(t, err, "a caller that left must not fail the read the others share")
	require.Len(t, first.Msg.History, 1)

	reads := store.readCount("SubstantialNotices")
	second, err := s.GetStockOwnership(context.Background(), req)
	require.NoError(t, err)
	assert.Len(t, second.Msg.History, 1)
	assert.Equal(t, reads, store.readCount("SubstantialNotices"), "the second caller is served the entry the first one kept")
}

func TestOwnershipRpcsWithoutAStoreAnswerAsBefore(t *testing.T) {
	s := &ShortsServer{cache: NewMemoryCache(time.Minute)}
	ctx := context.Background()

	ov, err := s.GetOwnershipOverview(ctx, connect.NewRequest(&shortsv1alpha1.GetOwnershipOverviewRequest{}))
	require.NoError(t, err)
	assert.Empty(t, ov.Msg.Kinds)

	list, err := s.ListInstitutions(ctx, connect.NewRequest(&shortsv1alpha1.ListInstitutionsRequest{}))
	require.NoError(t, err)
	assert.Zero(t, list.Msg.Total)

	_, err = s.GetInstitution(ctx, connect.NewRequest(&shortsv1alpha1.GetInstitutionRequest{Slug: "citigroup"}))
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))

	stock, err := s.GetStockOwnership(ctx, connect.NewRequest(&shortsv1alpha1.GetStockOwnershipRequest{StockCode: "BHP"}))
	require.NoError(t, err)
	assert.Nil(t, stock.Msg.Summary)
}
