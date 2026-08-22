package ratelimit

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func structFieldNames(v any) []string {
	t := reflect.TypeOf(v)
	names := make([]string, 0, t.NumField())
	for i := 0; i < t.NumField(); i++ {
		names = append(names, t.Field(i).Name)
	}
	return names
}

// fakeStore records every statement the limiter would issue. Each ApplyDeltas
// call is one multi-row statement, so len(applyCalls) IS the statement count —
// which is the property this design is optimising.
type fakeStore struct {
	mu sync.Mutex

	applyCalls  [][]UsageDelta
	totalsCalls [][]string

	persisted map[UsageKey]int64

	applyErr  error
	totalsErr error
}

func newFakeStore() *fakeStore {
	return &fakeStore{persisted: make(map[UsageKey]int64)}
}

func (f *fakeStore) ApplyDeltas(_ context.Context, deltas []UsageDelta) (map[UsageKey]int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	snapshot := append([]UsageDelta(nil), deltas...)
	f.applyCalls = append(f.applyCalls, snapshot)

	if f.applyErr != nil {
		return nil, f.applyErr
	}

	out := make(map[UsageKey]int64, len(deltas))
	for _, d := range deltas {
		k := UsageKey{Identifier: d.Identifier, Month: d.Month}
		f.persisted[k] += d.Delta
		out[k] = f.persisted[k]
	}
	return out, nil
}

func (f *fakeStore) Totals(_ context.Context, month time.Time, identifiers []string) (map[UsageKey]int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.totalsCalls = append(f.totalsCalls, append([]string(nil), identifiers...))

	if f.totalsErr != nil {
		return nil, f.totalsErr
	}

	out := make(map[UsageKey]int64)
	for _, id := range identifiers {
		k := UsageKey{Identifier: id, Month: month}
		if v, ok := f.persisted[k]; ok {
			out[k] = v
		}
	}
	return out, nil
}

func (f *fakeStore) applyCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.applyCalls)
}

func (f *fakeStore) lastApply() []UsageDelta {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.applyCalls) == 0 {
		return nil
	}
	return f.applyCalls[len(f.applyCalls)-1]
}

func (f *fakeStore) setPersisted(id string, month time.Time, count int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.persisted[UsageKey{Identifier: id, Month: normalizeMonth(month)}] = count
}

// testConfig is generous per-minute so monthly behaviour can be tested without
// tripping the minute window, unless a test says otherwise.
func testConfig() Config {
	cfg := DefaultConfig()
	cfg.Enabled = true
	cfg.Tiers = map[string]TierLimits{
		"anonymous": {RequestsPerMinute: 30, RequestsPerMonth: 500, BrowserRequestsPerMinute: 60, BrowserRequestsPerMonth: 5000},
		"free":      {RequestsPerMinute: 1_000_000, RequestsPerMonth: 100, BrowserRequestsPerMinute: 1_000_000, BrowserRequestsPerMonth: 200},
		"premium":   {RequestsPerMinute: 1_000_000, RequestsPerMonth: 10000, BrowserRequestsPerMinute: 0, BrowserRequestsPerMonth: 0},
	}
	return cfg
}

func newTestLimiter(t *testing.T, cfg Config, store UsageStore, clock func() time.Time) *AppLimiter {
	t.Helper()
	l := newAppLimiter(cfg, store)
	l.setNow(clock)
	return l
}

func fixedClock(at time.Time) (func() time.Time, func(d time.Duration)) {
	var mu sync.Mutex
	now := at
	return func() time.Time {
			mu.Lock()
			defer mu.Unlock()
			return now
		}, func(d time.Duration) {
			mu.Lock()
			defer mu.Unlock()
			now = now.Add(d)
		}
}

func checkN(t *testing.T, l *AppLimiter, n int, id, tier string, browser bool) []*Result {
	t.Helper()
	out := make([]*Result, 0, n)
	for i := 0; i < n; i++ {
		r, err := l.Check(context.Background(), id, tier, browser)
		require.NoError(t, err)
		out = append(out, r)
	}
	return out
}

// ---------------------------------------------------------------------------
// batching
// ---------------------------------------------------------------------------

func TestFlushThresholds(t *testing.T) {
	base := time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC)

	tests := []struct {
		name          string
		threshold     int
		nearThreshold int
		monthLimit    int
		requests      int
		wantPending   int64
		wantFlushSig  bool
	}{
		{
			name: "below threshold buffers everything, no statement",
			// The core claim of the design: 199 requests, zero database work.
			threshold: 200, nearThreshold: 10, monthLimit: 100000,
			requests: 199, wantPending: 199, wantFlushSig: false,
		},
		{
			name:      "reaching the threshold signals a flush",
			threshold: 200, nearThreshold: 10, monthLimit: 100000,
			requests: 200, wantPending: 200, wantFlushSig: true,
		},
		{
			name: "near the quota the batch collapses to the tight threshold",
			// 95 of 100 used is inside the 90% band, so batching drops from
			// 200 to 10 — accuracy is bought exactly where it matters.
			threshold: 200, nearThreshold: 10, monthLimit: 100,
			requests: 95, wantPending: 95, wantFlushSig: true,
		},
		{
			name:      "far from the quota the tight threshold does not apply",
			threshold: 200, nearThreshold: 10, monthLimit: 100000,
			requests: 11, wantPending: 11, wantFlushSig: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := testConfig()
			cfg.MonthlyFlushThreshold = tc.threshold
			cfg.MonthlyNearLimitThreshold = tc.nearThreshold
			cfg.Tiers["free"] = TierLimits{RequestsPerMinute: 1_000_000, RequestsPerMonth: tc.monthLimit}

			store := newFakeStore()
			clock, _ := fixedClock(base)
			l := newTestLimiter(t, cfg, store, clock)

			checkN(t, l, tc.requests, "user:a", "free", false)

			assert.Equal(t, 0, store.applyCount(), "Check must never issue a statement itself")

			l.mu.Lock()
			pending := l.state["user:a"].pending
			l.mu.Unlock()
			assert.Equal(t, tc.wantPending, pending)

			select {
			case <-l.flushSig:
				assert.True(t, tc.wantFlushSig, "unexpected flush signal")
			default:
				assert.False(t, tc.wantFlushSig, "expected a flush signal")
			}
		})
	}
}

func TestFlushIsOneStatementForAllIdentifiers(t *testing.T) {
	cfg := testConfig()
	store := newFakeStore()
	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	l := newTestLimiter(t, cfg, store, clock)

	checkN(t, l, 3, "user:a", "free", false)
	checkN(t, l, 5, "user:b", "free", false)
	checkN(t, l, 7, "user:c", "free", false)

	l.Flush(context.Background())

	require.Equal(t, 1, store.applyCount(), "three identifiers must cost ONE statement, not three")

	batch := store.lastApply()
	require.Len(t, batch, 3)

	got := map[string]int64{}
	for _, d := range batch {
		got[d.Identifier] = d.Delta
		assert.Equal(t, normalizeMonth(clock()), d.Month, "month must be normalised to the first of the month")
	}
	assert.Equal(t, map[string]int64{"user:a": 3, "user:b": 5, "user:c": 7}, got)

	// A successful flush doubles as a cache refresh: no read is needed.
	assert.Equal(t, 0, len(store.totalsCalls))
}

func TestFlushWithNothingPendingIssuesNoStatement(t *testing.T) {
	store := newFakeStore()
	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	l := newTestLimiter(t, testConfig(), store, clock)

	l.Flush(context.Background())
	l.Flush(context.Background())

	assert.Equal(t, 0, store.applyCount(), "an idle instance must be silent")
}

// ---------------------------------------------------------------------------
// failure handling
// ---------------------------------------------------------------------------

func TestFailedFlushRetainsDeltas(t *testing.T) {
	cfg := testConfig()
	store := newFakeStore()
	store.applyErr = errors.New("connection refused")
	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	l := newTestLimiter(t, cfg, store, clock)

	checkN(t, l, 12, "user:a", "free", false)
	l.Flush(context.Background())

	l.mu.Lock()
	pending := l.state["user:a"].pending
	l.mu.Unlock()
	assert.Equal(t, int64(12), pending, "a failed write must not lose the increments")

	// Recover: the retained delta is written in full, not partially.
	store.mu.Lock()
	store.applyErr = nil
	store.mu.Unlock()

	checkN(t, l, 3, "user:a", "free", false)
	l.Flush(context.Background())

	require.Equal(t, int64(15), store.persisted[UsageKey{Identifier: "user:a", Month: normalizeMonth(clock())}])

	l.mu.Lock()
	pending = l.state["user:a"].pending
	l.mu.Unlock()
	assert.Equal(t, int64(0), pending)
}

func TestFailOpenWhileStoreIsDown(t *testing.T) {
	cfg := testConfig()
	cfg.Tiers["free"] = TierLimits{RequestsPerMinute: 1_000_000, RequestsPerMonth: 5}
	store := newFakeStore()
	store.applyErr = errors.New("db down")
	store.totalsErr = errors.New("db down")
	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	l := newTestLimiter(t, cfg, store, clock)

	// Well past a 5/month quota, with the database refusing everything.
	for i := 0; i < 50; i++ {
		r, err := l.Check(context.Background(), "user:a", "free", false)
		require.NoError(t, err, "Check must never surface a transport error")
		l.Flush(context.Background())
		l.refresh(context.Background())
		require.True(t, r.Allowed, "request %d was denied while the quota store was down", i)
	}
}

func TestCircuitBreakerStopsWritesButKeepsAccumulating(t *testing.T) {
	cfg := testConfig()
	cfg.BreakerFailureThreshold = 2
	cfg.BreakerCooldown = time.Minute
	store := newFakeStore()
	store.applyErr = errors.New("db down")
	clock, advance := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	l := newTestLimiter(t, cfg, store, clock)

	checkN(t, l, 5, "user:a", "free", false)
	l.Flush(context.Background())
	l.Flush(context.Background())
	require.True(t, l.breaker.isOpen())

	before := store.applyCount()
	checkN(t, l, 5, "user:a", "free", false)
	l.Flush(context.Background())
	assert.Equal(t, before, store.applyCount(), "an open breaker must not issue statements")

	l.mu.Lock()
	pending := l.state["user:a"].pending
	l.mu.Unlock()
	assert.Equal(t, int64(10), pending, "accumulation continues while the breaker is open")

	// After the cooldown a probe is allowed through, and it carries everything.
	store.mu.Lock()
	store.applyErr = nil
	store.mu.Unlock()
	advance(2 * time.Minute)

	l.Flush(context.Background())
	assert.Equal(t, int64(10), store.persisted[UsageKey{Identifier: "user:a", Month: normalizeMonth(clock())}])
	assert.False(t, l.breaker.isOpen())
}

// ---------------------------------------------------------------------------
// read caching
// ---------------------------------------------------------------------------

func TestCacheMissAllowsAndQueuesAsyncRefresh(t *testing.T) {
	cfg := testConfig()
	cfg.Tiers["free"] = TierLimits{RequestsPerMinute: 1_000_000, RequestsPerMonth: 10}
	store := newFakeStore()
	month := normalizeMonth(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	store.setPersisted("user:a", month, 999) // already way over quota, elsewhere

	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	l := newTestLimiter(t, cfg, store, clock)

	// First request: nothing cached. It is ALLOWED — an unknown total is not
	// evidence of an exceeded quota, and blocking on a read is forbidden.
	r, err := l.Check(context.Background(), "user:a", "free", false)
	require.NoError(t, err)
	assert.True(t, r.Allowed)
	assert.Equal(t, 0, len(store.totalsCalls), "the read must not happen on the request path")

	l.mu.Lock()
	_, queued := l.refreshQueue["user:a"]
	l.mu.Unlock()
	assert.True(t, queued, "a miss must queue an async refresh")

	// Once the async refresh lands, the caller is correctly over quota.
	l.refresh(context.Background())
	require.Equal(t, 1, len(store.totalsCalls))

	r, err = l.Check(context.Background(), "user:a", "free", false)
	require.NoError(t, err)
	assert.False(t, r.Allowed)
	assert.Equal(t, LimitKindMonthly, r.ExceededKind)
}

func TestRefreshCoalescesIntoOneRead(t *testing.T) {
	store := newFakeStore()
	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	l := newTestLimiter(t, testConfig(), store, clock)

	for _, id := range []string{"user:a", "user:b", "user:c", "user:d"} {
		checkN(t, l, 1, id, "free", false)
	}
	l.refresh(context.Background())

	require.Equal(t, 1, len(store.totalsCalls), "four cold identifiers must cost ONE read")
	assert.Len(t, store.totalsCalls[0], 4)
}

func TestCachedTotalIsReusedUntilTTLExpires(t *testing.T) {
	cfg := testConfig()
	cfg.MonthlyTotalTTL = 5 * time.Minute
	store := newFakeStore()
	clock, advance := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	l := newTestLimiter(t, cfg, store, clock)

	checkN(t, l, 1, "user:a", "free", false)
	l.refresh(context.Background())
	require.Equal(t, 1, len(store.totalsCalls))

	// Within the TTL: no further reads no matter how much traffic arrives.
	advance(4 * time.Minute)
	checkN(t, l, 100, "user:a", "free", false)
	l.refresh(context.Background())
	assert.Equal(t, 1, len(store.totalsCalls), "a warm cache must not read")

	// Past the TTL: exactly one more read is queued.
	advance(2 * time.Minute)
	checkN(t, l, 1, "user:a", "free", false)
	l.refresh(context.Background())
	assert.Equal(t, 2, len(store.totalsCalls))
}

func TestEffectiveUsageIsCachedTotalPlusPendingDelta(t *testing.T) {
	cfg := testConfig()
	cfg.Tiers["free"] = TierLimits{RequestsPerMinute: 1_000_000, RequestsPerMonth: 100}
	store := newFakeStore()
	month := normalizeMonth(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	store.setPersisted("user:a", month, 95)

	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	l := newTestLimiter(t, cfg, store, clock)

	checkN(t, l, 1, "user:a", "free", false)
	l.refresh(context.Background())

	// 95 persisted + local increments. The 100th is the last allowed one.
	results := checkN(t, l, 6, "user:a", "free", false)
	assert.Equal(t, 97, results[0].MonthlyUsed)
	assert.True(t, results[2].Allowed, "usage 99 is within a 100 quota")
	assert.True(t, results[3].Allowed, "usage 100 is exactly the quota")
	assert.False(t, results[4].Allowed, "usage 101 exceeds the quota")
	assert.Equal(t, LimitKindMonthly, results[4].ExceededKind)
}

// ---------------------------------------------------------------------------
// month rollover
// ---------------------------------------------------------------------------

func TestMonthRolloverStrandsAndFlushesTheOldMonth(t *testing.T) {
	cfg := testConfig()
	store := newFakeStore()
	clock, advance := fixedClock(time.Date(2026, 8, 31, 23, 59, 0, 0, time.UTC))
	l := newTestLimiter(t, cfg, store, clock)

	checkN(t, l, 4, "user:a", "free", false)

	advance(2 * time.Minute) // crosses into September
	checkN(t, l, 3, "user:a", "free", false)

	l.Flush(context.Background())

	batch := store.lastApply()
	require.Len(t, batch, 2, "the closed month and the new month are separate rows")

	byMonth := map[time.Time]int64{}
	for _, d := range batch {
		byMonth[d.Month] = d.Delta
	}
	assert.Equal(t, int64(4), byMonth[time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)], "August's tail must not be dropped")
	assert.Equal(t, int64(3), byMonth[time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)])

	l.mu.Lock()
	orphans := len(l.orphans)
	l.mu.Unlock()
	assert.Equal(t, 0, orphans, "flushed orphans must be cleared")
}

func TestMonthRolloverResetsUsage(t *testing.T) {
	cfg := testConfig()
	cfg.Tiers["free"] = TierLimits{RequestsPerMinute: 1_000_000, RequestsPerMonth: 3}
	store := newFakeStore()
	clock, advance := fixedClock(time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC))
	l := newTestLimiter(t, cfg, store, clock)

	checkN(t, l, 1, "user:a", "free", false)
	l.refresh(context.Background())
	results := checkN(t, l, 4, "user:a", "free", false)
	require.False(t, results[3].Allowed, "5 requests against a 3/month quota")

	advance(48 * time.Hour) // September
	r, err := l.Check(context.Background(), "user:a", "free", false)
	require.NoError(t, err)
	assert.True(t, r.Allowed, "a new month starts a new quota")
	assert.Equal(t, 1, r.MonthlyUsed)
}

// ---------------------------------------------------------------------------
// exemptions and bounds
// ---------------------------------------------------------------------------

func TestAnonymousIsUnmeteredMonthlyByDefault(t *testing.T) {
	cfg := testConfig()
	store := newFakeStore()
	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	l := newTestLimiter(t, cfg, store, clock)

	checkN(t, l, 25, "ip:1.2.3.4", "anonymous", false)
	l.Flush(context.Background())

	assert.Equal(t, 0, store.applyCount(), "one row per IP per month is an unbounded key space for no benefit")

	l.mu.Lock()
	tracked := len(l.state)
	l.mu.Unlock()
	assert.Equal(t, 0, tracked)
}

func TestUnlimitedTierDoesNoBookkeeping(t *testing.T) {
	cfg := testConfig()
	store := newFakeStore()
	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	l := newTestLimiter(t, cfg, store, clock)

	// premium browser access: 0/0 = unlimited on both windows.
	results := checkN(t, l, 500, "user:paid", "premium", true)
	for _, r := range results {
		require.True(t, r.Allowed)
		require.Equal(t, 0, r.Limit)
		require.Equal(t, 0, r.MonthlyLimit)
	}

	l.Flush(context.Background())
	assert.Equal(t, 0, store.applyCount())

	l.mu.Lock()
	monthlyTracked := len(l.state)
	l.mu.Unlock()
	assert.Equal(t, 0, monthlyTracked, "unlimited tiers must cost no memory")
	assert.Equal(t, 0, l.minute.size(), "unlimited tiers must cost no memory")
}

func TestMonthlyStateMapIsCapped(t *testing.T) {
	cfg := testConfig()
	cfg.MonthlyMaxIdentifiers = 4
	cfg.MonthlyIdleEviction = time.Hour
	store := newFakeStore()
	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	l := newTestLimiter(t, cfg, store, clock)

	for _, id := range []string{"user:a", "user:b", "user:c", "user:d", "user:e", "user:f"} {
		r, err := l.Check(context.Background(), id, "free", false)
		require.NoError(t, err)
		assert.True(t, r.Allowed, "over-cap callers fail OPEN, they are not rejected")
	}

	l.mu.Lock()
	size := len(l.state)
	l.mu.Unlock()
	assert.LessOrEqual(t, size, 4, "memory is a hard bound; quota accuracy is not")
}

func TestIdleEvictionNeverDiscardsPendingDeltas(t *testing.T) {
	cfg := testConfig()
	cfg.MonthlyIdleEviction = time.Minute
	store := newFakeStore()
	clock, advance := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	l := newTestLimiter(t, cfg, store, clock)

	checkN(t, l, 3, "user:pending", "free", false)
	checkN(t, l, 2, "user:flushed", "free", false)

	// Flush only user:flushed by draining, then re-dirty user:pending.
	l.Flush(context.Background())
	checkN(t, l, 3, "user:pending", "free", false)

	advance(time.Hour)
	l.evictIdle()

	l.mu.Lock()
	_, pendingKept := l.state["user:pending"]
	_, flushedKept := l.state["user:flushed"]
	l.mu.Unlock()

	assert.True(t, pendingKept, "an entry with unflushed increments must never be evicted")
	assert.False(t, flushedKept, "a settled, idle entry is evicted")
}

// ---------------------------------------------------------------------------
// lifecycle and concurrency
// ---------------------------------------------------------------------------

func TestCloseFlushesTheTail(t *testing.T) {
	cfg := testConfig()
	cfg.MonthlyFlushInterval = time.Hour // never fires during the test
	store := newFakeStore()

	l := NewAppLimiter(cfg, store)
	checkN(t, l, 7, "user:a", "free", false)

	require.NoError(t, l.Close())

	month := normalizeMonth(time.Now())
	assert.Equal(t, int64(7), store.persisted[UsageKey{Identifier: "user:a", Month: month}],
		"shutdown must not drop the in-memory tail — SIGTERM is routine on Cloud Run")
}

func TestBackgroundFlusherWritesOnThreshold(t *testing.T) {
	cfg := testConfig()
	cfg.MonthlyFlushThreshold = 5
	cfg.MonthlyFlushInterval = time.Hour
	store := newFakeStore()

	l := NewAppLimiter(cfg, store)
	defer func() { _ = l.Close() }()

	checkN(t, l, 5, "user:a", "free", false)

	require.Eventually(t, func() bool { return store.applyCount() >= 1 }, 2*time.Second, 10*time.Millisecond)
}

func TestConcurrentChecksAreAccountedExactly(t *testing.T) {
	cfg := testConfig()
	cfg.MonthlyFlushThreshold = 1_000_000 // no auto flush; count what is buffered
	store := newFakeStore()
	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	l := newTestLimiter(t, cfg, store, clock)

	const goroutines, perGoroutine = 16, 100

	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < perGoroutine; i++ {
				_, err := l.Check(context.Background(), "user:hot", "free", false)
				if err != nil {
					t.Error(err)
					return
				}
			}
		}()
	}
	wg.Wait()

	l.Flush(context.Background())

	assert.Equal(t, int64(goroutines*perGoroutine),
		store.persisted[UsageKey{Identifier: "user:hot", Month: normalizeMonth(clock())}],
		"no increment may be lost or double-counted under concurrency")
}

func TestConcurrentCheckAndFlush(t *testing.T) {
	cfg := testConfig()
	store := newFakeStore()
	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	l := newTestLimiter(t, cfg, store, clock)

	var wg sync.WaitGroup
	stop := make(chan struct{})

	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				l.Flush(context.Background())
				l.refresh(context.Background())
			}
		}
	}()

	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				_, _ = l.Check(context.Background(), "user:hot", "free", false)
			}
		}(g)
	}

	time.Sleep(20 * time.Millisecond)
	close(stop)
	wg.Wait()

	l.Flush(context.Background())

	l.mu.Lock()
	pending := int64(0)
	if st, ok := l.state["user:hot"]; ok {
		pending = st.pending
	}
	l.mu.Unlock()

	total := store.persisted[UsageKey{Identifier: "user:hot", Month: normalizeMonth(clock())}] + pending
	assert.Equal(t, int64(1600), total, "flushing concurrently with traffic must neither lose nor duplicate increments")
}

func TestNilStoreKeepsPerMinuteEnforcementAlive(t *testing.T) {
	cfg := testConfig()
	cfg.Tiers["free"] = TierLimits{RequestsPerMinute: 3, RequestsPerMonth: 100}
	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	l := newTestLimiter(t, cfg, nil, clock)

	results := checkN(t, l, 4, "user:a", "free", false)
	assert.True(t, results[2].Allowed)
	assert.False(t, results[3].Allowed)
	assert.Equal(t, LimitKindPerMinute, results[3].ExceededKind)

	// Flush/refresh with no store must be inert, not a panic.
	l.Flush(context.Background())
	l.refresh(context.Background())
}
