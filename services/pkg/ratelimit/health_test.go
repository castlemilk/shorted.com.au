package ratelimit

import (
	"context"
	"errors"
	"testing"
	"time"
)

// CAN WE TELL, FROM OUTSIDE, THAT QUOTAS STOPPED BEING ENFORCED?
//
// The limiter is unconditionally fail-open: a sick quota database never 429s or
// 500s a caller, it just quietly stops metering. That is the right behaviour,
// and it makes the degraded state invisible — successful requests look
// identical either way. Health() is the only thing that can distinguish them,
// so these tests are about observability, not about limiting.
//
// The precedent is the 7,045 self-inflicted 429s of August 2026: fully
// instrumented, entirely unnoticed, for two days.

func healthLimiter(t *testing.T, store UsageStore) (*AppLimiter, func(time.Duration)) {
	t.Helper()
	cfg := testConfig()
	clock, advance := fixedClock(time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC))
	l := newTestLimiter(t, cfg, store, clock)
	t.Cleanup(func() { _ = l.Close() })
	return l, advance
}

// A healthy limiter must not report degradation, or the signal is noise and
// will be muted.
func TestHealthIsQuietWhenNothingIsWrong(t *testing.T) {
	l, _ := healthLimiter(t, newFakeStore())

	if _, err := l.Check(context.Background(), "user:a", "free", false); err != nil {
		t.Fatal(err)
	}

	h := l.Health()
	if h.Degraded {
		t.Error("reported degraded with a working store")
	}
	if h.MaxIdentifiers == 0 {
		t.Error("MaxIdentifiers is 0, so a reader cannot tell how close the cap is")
	}
}

// THE SIGNAL THAT MATTERS. When writes fail persistently the breaker opens,
// monthly quotas stop being enforced, and every request still succeeds.
func TestHealthReportsDegradedWhenQuotaWritesAreFailing(t *testing.T) {
	store := newFakeStore()
	store.applyErr = errors.New("connection refused")
	l, _ := healthLimiter(t, store)

	// Drive enough traffic to force flush attempts and trip the breaker.
	for i := 0; i < 3; i++ {
		for j := 0; j < l.config.MonthlyFlushThreshold+1; j++ {
			if _, err := l.Check(context.Background(), "user:a", "free", false); err != nil {
				t.Fatalf("the limiter surfaced an error to the caller: %v", err)
			}
		}
		l.Flush(context.Background())
	}

	h := l.Health()
	if !h.Degraded {
		t.Fatal("quota writes are failing and Health() says everything is fine — this is the state nobody could see")
	}
	// And the durable-loss signal: how much quota disappears if this instance
	// is replaced right now.
	if h.RetainedDeltas <= 0 {
		t.Error("RetainedDeltas = 0 while writes are failing; nothing indicates data is at risk")
	}
}

// Requests must keep succeeding throughout. If a degraded quota store could
// reject a caller, the fail-open promise would be broken and this endpoint
// would be the least of the problems.
func TestADegradedQuotaStoreNeverRejectsACaller(t *testing.T) {
	store := newFakeStore()
	store.applyErr = errors.New("down")
	l, _ := healthLimiter(t, store)

	for i := 0; i < 500; i++ {
		r, err := l.Check(context.Background(), "user:a", "free", false)
		if err != nil {
			t.Fatalf("request %d errored: %v", i, err)
		}
		if !r.Allowed {
			t.Fatalf("request %d was REJECTED by a limiter whose store is down", i)
		}
	}
}

// Recovery has to be visible too. A degraded flag that never clears trains
// people to ignore it.
func TestHealthClearsOnceWritesSucceedAgain(t *testing.T) {
	store := newFakeStore()
	store.applyErr = errors.New("down")
	l, advance := healthLimiter(t, store)

	for i := 0; i < 3; i++ {
		for j := 0; j < l.config.MonthlyFlushThreshold+1; j++ {
			_, _ = l.Check(context.Background(), "user:a", "free", false)
		}
		l.Flush(context.Background())
	}
	if !l.Health().Degraded {
		t.Fatal("precondition: expected degraded")
	}

	store.mu.Lock()
	store.applyErr = nil
	store.mu.Unlock()

	// Past the cooldown so the breaker probes, then a successful flush.
	advance(2 * l.config.BreakerCooldown)
	l.Flush(context.Background())

	if h := l.Health(); h.Degraded {
		t.Errorf("still degraded after recovery: %+v", h)
	}
}

// Reading health must not change it. allow() half-opens the breaker as a side
// effect, so a health check built on it would let a probe through every time it
// was polled — a monitor that perturbs what it measures.
func TestReadingHealthDoesNotDisturbTheBreaker(t *testing.T) {
	store := newFakeStore()
	store.applyErr = errors.New("down")
	l, _ := healthLimiter(t, store)

	for i := 0; i < 3; i++ {
		for j := 0; j < l.config.MonthlyFlushThreshold+1; j++ {
			_, _ = l.Check(context.Background(), "user:a", "free", false)
		}
		l.Flush(context.Background())
	}

	store.mu.Lock()
	before := len(store.applyCalls)
	store.mu.Unlock()

	for i := 0; i < 20; i++ {
		_ = l.Health()
	}

	store.mu.Lock()
	after := len(store.applyCalls)
	store.mu.Unlock()

	if after != before {
		t.Errorf("polling health issued %d extra store calls", after-before)
	}
}
