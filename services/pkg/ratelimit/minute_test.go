package ratelimit

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The documented per-tier per-minute contract. The edge worker cannot enforce
// this — it cannot resolve a caller's subscription tier without a lookup, and
// that lookup is the coupling that caused the incident. So it lives here, and
// this test is the contract.
func TestPerMinuteTierLimits(t *testing.T) {
	tests := []struct {
		name      string
		tier      string
		isBrowser bool
		wantLimit int
	}{
		{name: "anonymous api", tier: "anonymous", wantLimit: 30},
		{name: "free api", tier: "free", wantLimit: 60},
		{name: "premium api", tier: "premium", wantLimit: 120},
		{name: "enterprise api", tier: "enterprise", wantLimit: 300},
		{name: "anonymous browser", tier: "anonymous", isBrowser: true, wantLimit: 60},
		{name: "free browser", tier: "free", isBrowser: true, wantLimit: 120},
		{name: "premium browser is unlimited", tier: "premium", isBrowser: true, wantLimit: 0},
		{name: "enterprise browser is unlimited", tier: "enterprise", isBrowser: true, wantLimit: 0},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := DefaultConfig()
			cfg.Enabled = true
			clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
			l := newTestLimiter(t, cfg, newFakeStore(), clock)

			id := "user:" + tc.name
			if tc.tier == "anonymous" {
				id = "ip:10.0.0.1"
			}

			if tc.wantLimit == 0 {
				// Unlimited must short-circuit with NO bookkeeping at all.
				results := checkN(t, l, 1000, id, tc.tier, tc.isBrowser)
				for _, r := range results {
					require.True(t, r.Allowed)
				}
				assert.Equal(t, 0, l.minute.size(), "an unlimited tier must not allocate a counter")
				return
			}

			results := checkN(t, l, tc.wantLimit+1, id, tc.tier, tc.isBrowser)

			assert.True(t, results[tc.wantLimit-1].Allowed, "request %d must be allowed", tc.wantLimit)
			assert.Equal(t, tc.wantLimit, results[0].Limit)
			assert.Equal(t, tc.wantLimit-1, results[0].Remaining)

			last := results[tc.wantLimit]
			assert.False(t, last.Allowed, "request %d must be rejected", tc.wantLimit+1)
			assert.Equal(t, LimitKindPerMinute, last.ExceededKind)
			assert.Equal(t, 0, last.Remaining)
			assert.True(t, last.RetryAfter > 0 && last.RetryAfter <= time.Minute)
		})
	}
}

func TestPerMinuteWindowResets(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Enabled = true
	cfg.Tiers["free"] = TierLimits{RequestsPerMinute: 2, RequestsPerMonth: 100000}
	clock, advance := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	l := newTestLimiter(t, cfg, newFakeStore(), clock)

	results := checkN(t, l, 3, "user:a", "free", false)
	require.False(t, results[2].Allowed)

	advance(61 * time.Second)

	r, err := l.Check(context.Background(), "user:a", "free", false)
	require.NoError(t, err)
	assert.True(t, r.Allowed, "a new window starts a fresh allowance")
	assert.Equal(t, 1, r.Remaining)
}

// A per-minute rejection must not also cost the caller their monthly quota.
// Being throttled and being billed for it are different things.
func TestPerMinuteRejectionDoesNotConsumeMonthlyQuota(t *testing.T) {
	cfg := testConfig()
	cfg.Tiers["free"] = TierLimits{RequestsPerMinute: 2, RequestsPerMonth: 1000}
	store := newFakeStore()
	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	l := newTestLimiter(t, cfg, store, clock)

	checkN(t, l, 10, "user:a", "free", false)
	l.Flush(context.Background())

	assert.Equal(t, int64(2),
		store.persisted[UsageKey{Identifier: "user:a", Month: normalizeMonth(clock())}],
		"only the 2 requests that were actually served may count against the month")
}

func TestMinuteMapIsCappedAndEvicts(t *testing.T) {
	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	ml := newMinuteLimiter(time.Minute, 50, clock)

	for i := 0; i < 500; i++ {
		res := ml.check(fmt.Sprintf("ip:10.0.0.%d", i), 30)
		require.True(t, res.allowed, "a full table fails OPEN; the edge ceiling still applies")
	}

	assert.LessOrEqual(t, ml.size(), 50, "an unbounded key space is what caused the incident")
}

func TestMinuteSweepDropsExpiredWindows(t *testing.T) {
	clock, advance := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	ml := newMinuteLimiter(time.Minute, 1000, clock)

	for i := 0; i < 20; i++ {
		ml.check(fmt.Sprintf("ip:10.0.0.%d", i), 30)
	}
	require.Equal(t, 20, ml.size())

	advance(5 * time.Minute)
	ml.sweep()

	assert.Equal(t, 0, ml.size(), "an idle process must not hold a map sized to its busiest minute")
}

func TestMinuteLimiterConcurrency(t *testing.T) {
	clock, _ := fixedClock(time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC))
	ml := newMinuteLimiter(time.Minute, 10_000, clock)

	const goroutines, perGoroutine = 16, 100

	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		allowed int
	)
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			local := 0
			for i := 0; i < perGoroutine; i++ {
				if ml.check("user:hot", 500).allowed {
					local++
				}
			}
			mu.Lock()
			allowed += local
			mu.Unlock()
		}()
	}
	wg.Wait()

	assert.Equal(t, 500, allowed, "exactly the limit is admitted, no more and no fewer")
}
