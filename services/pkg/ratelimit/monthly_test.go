package ratelimit

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// upstashStub records the pipelines it receives so tests can assert on the
// exact Upstash command volume — the whole point of the batching rework.
type upstashStub struct {
	server *httptest.Server

	mu        sync.Mutex
	pipelines [][][]interface{}
	total     int64 // running INCRBY total returned to the client

	failing atomic.Bool
	calls   atomic.Int64
}

func newUpstashStub(t *testing.T) *upstashStub {
	t.Helper()
	s := &upstashStub{}
	s.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/pipeline" {
			_ = json.NewEncoder(w).Encode(map[string]any{"result": "PONG"})
			return
		}

		s.calls.Add(1)

		if s.failing.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"quota exceeded"}`))
			return
		}

		var commands [][]interface{}
		_ = json.NewDecoder(r.Body).Decode(&commands)

		s.mu.Lock()
		s.pipelines = append(s.pipelines, commands)
		// Emulate INCRBY: accumulate the delta and return the new total.
		if len(commands) > 0 && len(commands[0]) >= 3 {
			if delta, ok := commands[0][2].(string); ok {
				var n int64
				for _, c := range delta {
					n = n*10 + int64(c-'0')
				}
				s.total += n
			}
		}
		total := s.total
		s.mu.Unlock()

		_ = json.NewEncoder(w).Encode([]PipelineResult{
			{Result: float64(total)},
			{Result: float64(1)},
		})
	}))
	t.Cleanup(s.server.Close)
	return s
}

func (s *upstashStub) pipelineCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.pipelines)
}

func (s *upstashStub) commandCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, p := range s.pipelines {
		n += len(p)
	}
	return n
}

func testMonthlyConfig(url string) Config {
	cfg := DefaultConfig()
	cfg.Enabled = true
	cfg.UpstashURL = url
	cfg.UpstashToken = "test-token"
	// Long interval so tests drive flushes via the threshold, not the ticker.
	cfg.MonthlyFlushInterval = time.Hour
	cfg.MonthlyFlushThreshold = 10
	cfg.Timeout = 2 * time.Second
	return cfg
}

// eventually polls until cond is true or the deadline passes.
func eventually(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met within deadline")
}

func TestMonthlyLimiter_NoPerMinuteLimiting(t *testing.T) {
	stub := newUpstashStub(t)
	limiter, err := NewMonthlyLimiter(testMonthlyConfig(stub.server.URL))
	require.NoError(t, err)
	defer func() { _ = limiter.Close() }()

	// Far more requests than any per-minute tier allows. The app layer must
	// not block them — per-minute limiting belongs to the Cloudflare edge.
	for range 500 {
		result, err := limiter.Check(context.Background(), "user:123", "free", false)
		require.NoError(t, err)
		require.True(t, result.Allowed, "app layer must never enforce a per-minute window")
		assert.Zero(t, result.Limit, "per-minute limit must not be advertised by the app layer")
		assert.Zero(t, result.Remaining)
	}
}

func TestMonthlyLimiter_EnforcesMonthlyQuota(t *testing.T) {
	stub := newUpstashStub(t)
	cfg := testMonthlyConfig(stub.server.URL)
	cfg.Tiers["free"] = TierLimits{RequestsPerMonth: 5, BrowserRequestsPerMonth: 5}

	limiter, err := NewMonthlyLimiter(cfg)
	require.NoError(t, err)
	defer func() { _ = limiter.Close() }()

	for i := range 5 {
		result, err := limiter.Check(context.Background(), "user:quota", "free", false)
		require.NoError(t, err)
		assert.True(t, result.Allowed, "request %d should be within quota", i+1)
		assert.Equal(t, 5, result.MonthlyLimit)
		assert.Equal(t, i+1, result.MonthlyUsed)
	}

	result, err := limiter.Check(context.Background(), "user:quota", "free", false)
	require.NoError(t, err)
	assert.False(t, result.Allowed, "6th request exceeds the 5/month quota")
	assert.Equal(t, 6, result.MonthlyUsed)
	assert.True(t, result.MonthlyResetAt.After(time.Now()))
}

func TestMonthlyLimiter_UnlimitedTierNeverTouchesUpstash(t *testing.T) {
	stub := newUpstashStub(t)
	limiter, err := NewMonthlyLimiter(testMonthlyConfig(stub.server.URL))
	require.NoError(t, err)
	defer func() { _ = limiter.Close() }()

	// Paid browser access is unlimited (0 = unlimited) in DefaultConfig.
	for range 100 {
		result, err := limiter.Check(context.Background(), "user:paid", "premium", true)
		require.NoError(t, err)
		require.True(t, result.Allowed)
		assert.Zero(t, result.MonthlyLimit)
	}

	limiter.flush(context.Background())
	assert.Zero(t, stub.pipelineCount(), "unlimited tiers must generate zero Upstash traffic")
}

func TestMonthlyLimiter_AnonymousIsUnmeteredByDefault(t *testing.T) {
	stub := newUpstashStub(t)
	cfg := testMonthlyConfig(stub.server.URL)
	require.True(t, cfg.SkipAnonymousMonthly, "anonymous metering must be off by default")

	limiter, err := NewMonthlyLimiter(cfg)
	require.NoError(t, err)
	defer func() { _ = limiter.Close() }()

	for range 200 {
		result, err := limiter.Check(context.Background(), "ip:203.0.113.7", "anonymous", false)
		require.NoError(t, err)
		require.True(t, result.Allowed)
		assert.Zero(t, result.MonthlyLimit, "unmetered callers must not advertise a quota")
	}

	limiter.flush(context.Background())
	assert.Zero(t, stub.pipelineCount(),
		"anonymous IPs are an unbounded key space — they must not create Upstash keys")
}

func TestMonthlyLimiter_AnonymousMeteredWhenEnabled(t *testing.T) {
	stub := newUpstashStub(t)
	cfg := testMonthlyConfig(stub.server.URL)
	cfg.SkipAnonymousMonthly = false

	limiter, err := NewMonthlyLimiter(cfg)
	require.NoError(t, err)
	defer func() { _ = limiter.Close() }()

	result, err := limiter.Check(context.Background(), "ip:203.0.113.7", "anonymous", false)
	require.NoError(t, err)
	assert.Equal(t, 500, result.MonthlyLimit)
	assert.Equal(t, 1, result.MonthlyUsed)
}

func TestMonthlyLimiter_BatchesWrites(t *testing.T) {
	stub := newUpstashStub(t)
	cfg := testMonthlyConfig(stub.server.URL)
	cfg.MonthlyFlushThreshold = 25

	limiter, err := NewMonthlyLimiter(cfg)
	require.NoError(t, err)
	defer func() { _ = limiter.Close() }()

	const requests = 250
	for range requests {
		_, err := limiter.Check(context.Background(), "user:batch", "pro", false)
		require.NoError(t, err)
	}

	require.NoError(t, limiter.Close())

	// The old limiter cost 7 commands per request — 1,750 here. Batched
	// accounting costs 2 commands per flush, and flush signals coalesce, so
	// the ceiling is 2 x ceil(requests/threshold) = 20 and the floor is 2.
	maxCommands := 2 * ((requests + cfg.MonthlyFlushThreshold - 1) / cfg.MonthlyFlushThreshold)
	assert.LessOrEqual(t, stub.commandCount(), maxCommands)
	assert.Less(t, stub.commandCount(), requests/10,
		"batched accounting must cost far fewer commands than requests")

	stub.mu.Lock()
	total := stub.total
	stub.mu.Unlock()
	assert.EqualValues(t, requests, total, "batching must not lose increments")
}

func TestMonthlyLimiter_FlushUsesIncrByAndExpire(t *testing.T) {
	stub := newUpstashStub(t)
	cfg := testMonthlyConfig(stub.server.URL)
	cfg.MonthlyFlushThreshold = 3

	limiter, err := NewMonthlyLimiter(cfg)
	require.NoError(t, err)
	defer func() { _ = limiter.Close() }()

	for range 3 {
		_, err := limiter.Check(context.Background(), "user:cmd", "pro", false)
		require.NoError(t, err)
	}

	eventually(t, func() bool { return stub.pipelineCount() >= 1 })

	stub.mu.Lock()
	first := stub.pipelines[0]
	stub.mu.Unlock()

	require.Len(t, first, 2, "each flush must be exactly two Upstash commands")
	assert.Equal(t, "INCRBY", first[0][0])
	assert.Equal(t, "3", first[0][2], "the flush writes the accumulated delta, not one increment")
	assert.Equal(t, "EXPIRE", first[1][0])
	assert.Contains(t, first[0][1], "month:")
	assert.Contains(t, first[0][1], "user:cmd")
}

func TestMonthlyLimiter_RemoteTotalConverges(t *testing.T) {
	stub := newUpstashStub(t)
	cfg := testMonthlyConfig(stub.server.URL)
	cfg.MonthlyFlushThreshold = 2
	cfg.Tiers["pro"] = TierLimits{RequestsPerMonth: 100}

	// Pre-seed the shared counter as if another instance had already written.
	stub.mu.Lock()
	stub.total = 40
	stub.mu.Unlock()

	limiter, err := NewMonthlyLimiter(cfg)
	require.NoError(t, err)
	defer func() { _ = limiter.Close() }()

	for range 2 {
		_, err := limiter.Check(context.Background(), "user:multi", "pro", false)
		require.NoError(t, err)
	}
	eventually(t, func() bool { return stub.pipelineCount() >= 1 })

	// The next Check must reflect the authoritative cross-instance total.
	eventually(t, func() bool {
		result, err := limiter.Check(context.Background(), "user:multi", "pro", false)
		require.NoError(t, err)
		return result.MonthlyUsed >= 42
	})
}

func TestMonthlyLimiter_FailsOpenWhenUpstashIsDown(t *testing.T) {
	stub := newUpstashStub(t)
	stub.failing.Store(true)

	cfg := testMonthlyConfig(stub.server.URL)
	cfg.MonthlyFlushThreshold = 2
	cfg.Tiers["free"] = TierLimits{RequestsPerMonth: 5}

	limiter, err := NewMonthlyLimiter(cfg)
	require.NoError(t, err, "an unreachable quota DB must not prevent construction")
	defer func() { _ = limiter.Close() }()

	// Requests keep flowing and never error, even though every flush fails.
	for range 4 {
		result, err := limiter.Check(context.Background(), "user:down", "free", false)
		require.NoError(t, err, "a sick quota DB must never surface an error to the request path")
		require.True(t, result.Allowed)
	}
}

func TestMonthlyLimiter_CircuitBreakerOpensAndSuppressesCalls(t *testing.T) {
	stub := newUpstashStub(t)
	stub.failing.Store(true)

	cfg := testMonthlyConfig(stub.server.URL)
	cfg.MonthlyFlushThreshold = 1
	cfg.BreakerFailureThreshold = 3
	cfg.BreakerCooldown = time.Hour

	limiter, err := NewMonthlyLimiter(cfg)
	require.NoError(t, err)
	defer func() { _ = limiter.Close() }()

	for range 3 {
		_, err := limiter.Check(context.Background(), "user:breaker", "pro", false)
		require.NoError(t, err)
		limiter.flush(context.Background())
	}

	require.True(t, limiter.breaker.isOpen(), "3 consecutive failures must open the circuit")

	callsWhenOpen := stub.calls.Load()
	for range 10 {
		_, err := limiter.Check(context.Background(), "user:breaker", "pro", false)
		require.NoError(t, err)
		limiter.flush(context.Background())
	}
	assert.Equal(t, callsWhenOpen, stub.calls.Load(),
		"an open circuit must stop hammering the sick quota DB")
}

func TestMonthlyLimiter_CircuitBreakerRecoversAndDoesNotLoseDeltas(t *testing.T) {
	stub := newUpstashStub(t)
	stub.failing.Store(true)

	cfg := testMonthlyConfig(stub.server.URL)
	cfg.MonthlyFlushThreshold = 1
	cfg.BreakerFailureThreshold = 2
	cfg.BreakerCooldown = 10 * time.Millisecond

	limiter, err := NewMonthlyLimiter(cfg)
	require.NoError(t, err)
	defer func() { _ = limiter.Close() }()

	for range 5 {
		_, err := limiter.Check(context.Background(), "user:recover", "pro", false)
		require.NoError(t, err)
		limiter.flush(context.Background())
	}
	require.True(t, limiter.breaker.isOpen())

	// Upstash recovers; after the cooldown the retained deltas must land.
	stub.failing.Store(false)
	time.Sleep(20 * time.Millisecond)
	limiter.flush(context.Background())

	require.False(t, limiter.breaker.isOpen(), "a successful probe must close the circuit")

	stub.mu.Lock()
	total := stub.total
	stub.mu.Unlock()
	assert.EqualValues(t, 5, total, "deltas accumulated while the circuit was open must not be lost")
}

func TestMonthlyLimiter_CloseFlushesTail(t *testing.T) {
	stub := newUpstashStub(t)
	cfg := testMonthlyConfig(stub.server.URL)
	cfg.MonthlyFlushThreshold = 1000 // never threshold-triggers

	limiter, err := NewMonthlyLimiter(cfg)
	require.NoError(t, err)

	for range 7 {
		_, err := limiter.Check(context.Background(), "user:tail", "pro", false)
		require.NoError(t, err)
	}
	require.Zero(t, stub.pipelineCount())

	require.NoError(t, limiter.Close())

	stub.mu.Lock()
	total := stub.total
	stub.mu.Unlock()
	assert.EqualValues(t, 7, total, "an orderly shutdown must flush the in-memory tail")
}

func TestMonthlyLimiter_MonthRollover(t *testing.T) {
	stub := newUpstashStub(t)
	cfg := testMonthlyConfig(stub.server.URL)
	cfg.MonthlyFlushThreshold = 1000

	limiter, err := NewMonthlyLimiter(cfg)
	require.NoError(t, err)
	defer func() { _ = limiter.Close() }()

	now := time.Date(2026, 8, 31, 23, 59, 0, 0, time.UTC)
	limiter.now = func() time.Time { return now }

	result, err := limiter.Check(context.Background(), "user:rollover", "pro", false)
	require.NoError(t, err)
	assert.Equal(t, 1, result.MonthlyUsed)

	// Roll into September: the counter must restart, not carry over.
	now = time.Date(2026, 9, 1, 0, 0, 1, 0, time.UTC)
	result, err = limiter.Check(context.Background(), "user:rollover", "pro", false)
	require.NoError(t, err)
	assert.Equal(t, 1, result.MonthlyUsed)
	assert.Equal(t, time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC), result.MonthlyResetAt)
}

func TestMonthlyLimiter_EvictsIdleEntries(t *testing.T) {
	stub := newUpstashStub(t)
	cfg := testMonthlyConfig(stub.server.URL)
	cfg.MonthlyFlushThreshold = 1
	cfg.MonthlyIdleEviction = time.Minute

	limiter, err := NewMonthlyLimiter(cfg)
	require.NoError(t, err)
	defer func() { _ = limiter.Close() }()

	_, err = limiter.Check(context.Background(), "user:idle", "pro", false)
	require.NoError(t, err)
	limiter.flush(context.Background())

	limiter.now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	limiter.evictIdle()

	limiter.mu.Lock()
	_, present := limiter.state["user:idle"]
	limiter.mu.Unlock()
	assert.False(t, present, "flushed, idle counters must be evicted to bound memory")
}

func TestMonthlyLimiter_EvictionNeverDropsPendingDeltas(t *testing.T) {
	stub := newUpstashStub(t)
	cfg := testMonthlyConfig(stub.server.URL)
	cfg.MonthlyFlushThreshold = 1000
	cfg.MonthlyIdleEviction = time.Minute

	limiter, err := NewMonthlyLimiter(cfg)
	require.NoError(t, err)
	defer func() { _ = limiter.Close() }()

	_, err = limiter.Check(context.Background(), "user:pending", "pro", false)
	require.NoError(t, err)

	limiter.now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	limiter.evictIdle()

	limiter.mu.Lock()
	st, present := limiter.state["user:pending"]
	limiter.mu.Unlock()
	require.True(t, present, "an entry with unflushed increments must survive eviction")
	assert.Equal(t, 1, st.pending)
	_ = stub
}

func TestMonthlyLimiter_ConcurrentChecks(t *testing.T) {
	stub := newUpstashStub(t)
	cfg := testMonthlyConfig(stub.server.URL)
	cfg.MonthlyFlushThreshold = 1000

	limiter, err := NewMonthlyLimiter(cfg)
	require.NoError(t, err)

	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 50 {
				_, err := limiter.Check(context.Background(), "user:race", "pro", false)
				assert.NoError(t, err)
			}
		}()
	}
	wg.Wait()
	require.NoError(t, limiter.Close())

	stub.mu.Lock()
	total := stub.total
	stub.mu.Unlock()
	assert.EqualValues(t, 1000, total, "no increment may be lost under concurrency")
}

func TestCircuitBreaker_HalfOpenProbe(t *testing.T) {
	b := newCircuitBreaker(2, time.Minute)
	base := time.Date(2026, 8, 22, 0, 0, 0, 0, time.UTC)

	assert.True(t, b.allow(base))
	assert.False(t, b.recordFailure(base), "first failure must not open the circuit")
	assert.True(t, b.recordFailure(base), "threshold failure opens the circuit and reports the transition")
	assert.False(t, b.recordFailure(base), "subsequent failures must not re-report the transition")

	assert.False(t, b.allow(base.Add(30*time.Second)), "circuit stays closed to traffic during cooldown")
	assert.True(t, b.allow(base.Add(2*time.Minute)), "after cooldown one probe is allowed")

	b.recordSuccess()
	assert.False(t, b.isOpen())
	assert.True(t, b.allow(base))
}

func TestMonthlyConfigDefaults(t *testing.T) {
	cfg := DefaultConfig()

	assert.Equal(t, 25, cfg.MonthlyFlushThreshold)
	assert.Equal(t, 30*time.Second, cfg.MonthlyFlushInterval)
	assert.True(t, cfg.SkipAnonymousMonthly)
	assert.Equal(t, 3, cfg.BreakerFailureThreshold)
	assert.Equal(t, 60*time.Second, cfg.BreakerCooldown)

	// Zero-valued knobs must be backfilled rather than producing a 0-tick
	// ticker (which panics) or an every-request flush.
	filled := withMonthlyDefaults(Config{})
	assert.Equal(t, defaultMonthlyFlushThreshold, filled.MonthlyFlushThreshold)
	assert.Equal(t, defaultMonthlyFlushInterval, filled.MonthlyFlushInterval)
	assert.Equal(t, defaultBreakerCooldown, filled.BreakerCooldown)
}

func TestIsAnonymousIdentifier(t *testing.T) {
	assert.True(t, isAnonymousIdentifier("ip:1.2.3.4"))
	assert.False(t, isAnonymousIdentifier("user:abc"))
	assert.False(t, isAnonymousIdentifier(""))
	assert.False(t, isAnonymousIdentifier("ip"))
}
