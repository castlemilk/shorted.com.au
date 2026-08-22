package ratelimit

import (
	"context"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
)

// MonthlyLimiter is the app-layer half of the two-tier rate limiting
// architecture introduced after the August 2026 Upstash quota incident.
//
// Architecture
//
//	per-minute limiting -> Cloudflare Workers Rate Limiting API (edge-worker)
//	monthly quotas      -> this limiter (Upstash, batched)
//
// The old SlidingWindowLimiter issued a 7-command Upstash pipeline on EVERY
// request (4 for the minute window, 3 for the month window). That burned the
// shared Upstash database's free-tier command quota; once exhausted, Upstash
// rejected writes while still serving reads, which simultaneously degraded
// rate limiting AND froze the page cache that lives in the same database.
//
// MonthlyLimiter fixes the volume problem three ways:
//
//  1. It does no per-minute accounting at all. Per-minute abuse control is
//     enforced at the Cloudflare edge, before a request ever reaches Cloud Run.
//  2. It never performs I/O on the request path. Increments land in an
//     in-memory counter; a background flusher writes deltas to Upstash with a
//     2-command pipeline (INCRBY + EXPIRE) every MonthlyFlushThreshold
//     increments or every MonthlyFlushInterval, whichever comes first.
//  3. Anonymous (IP-keyed) identifiers are unmetered by default
//     (SkipAnonymousMonthly). Anonymous traffic is an unbounded key space —
//     metering it means one Upstash key per IP per month, which is exactly the
//     long tail that exhausted the quota. Anonymous abuse is now the edge's
//     job.
//
// Worst-case undercount: an instance that dies (or is redeployed) loses at
// most MonthlyFlushThreshold-1 increments per tracked identifier, plus
// anything accumulated in the last MonthlyFlushInterval. At the defaults
// (25 / 30s) that is <= 24 requests per user per instance death — 0.24% of
// the 10,000/month paid API quota and 1.2% of the 2,000/month free quota.
// Monthly quotas are a billing-adjacent fairness control, not a security
// boundary, so a sub-percent undercount is an acceptable trade for a ~35x
// reduction in Upstash command volume.
//
// Failure behaviour: fail OPEN, always and unconditionally. A sick quota
// database must never 500 (or 429) a user. A circuit breaker suppresses
// Upstash calls after BreakerFailureThreshold consecutive failures and logs
// loudly at each state transition so the outage is visible.
type MonthlyLimiter struct {
	client *UpstashClient
	config Config

	mu    sync.Mutex
	state map[string]*monthlyState

	breaker *circuitBreaker

	now      func() time.Time
	flushSig chan struct{}
	stopCh   chan struct{}
	stopOnce sync.Once
	wg       sync.WaitGroup
}

type monthlyState struct {
	month    string // "2006-01" — a month rollover resets the counter
	pending  int    // increments not yet flushed to Upstash
	remote   int    // last total observed from Upstash (INCRBY return value)
	lastSeen time.Time
}

// used returns the best-known monthly total for this identifier.
func (s *monthlyState) used() int {
	return s.remote + s.pending
}

// NewMonthlyLimiter creates a batched, fail-open monthly quota limiter.
//
// Unlike NewSlidingWindowLimiter it does NOT ping Upstash at construction:
// an unreachable quota database must not prevent the service from starting.
// The first flush will discover the problem and trip the circuit breaker.
func NewMonthlyLimiter(cfg Config) (*MonthlyLimiter, error) {
	if cfg.UpstashURL == "" || cfg.UpstashToken == "" {
		return nil, fmt.Errorf("upstash URL and token are required")
	}
	cfg = withMonthlyDefaults(cfg)

	l := &MonthlyLimiter{
		client:   NewUpstashClient(cfg.UpstashURL, cfg.UpstashToken, cfg.Timeout),
		config:   cfg,
		state:    make(map[string]*monthlyState),
		breaker:  newCircuitBreaker(cfg.BreakerFailureThreshold, cfg.BreakerCooldown),
		now:      time.Now,
		flushSig: make(chan struct{}, 1),
		stopCh:   make(chan struct{}),
	}

	l.wg.Add(1)
	go l.runFlusher()

	log.Infof(
		"Monthly quota limiter enabled (batch=%d, interval=%s, anonymous_metered=%t) — per-minute limiting is enforced at the Cloudflare edge",
		cfg.MonthlyFlushThreshold, cfg.MonthlyFlushInterval, !cfg.SkipAnonymousMonthly,
	)

	return l, nil
}

// withMonthlyDefaults fills in zero-valued batching knobs so a hand-built
// Config (or one deserialized from partial YAML) still behaves sanely.
func withMonthlyDefaults(cfg Config) Config {
	if cfg.MonthlyFlushThreshold <= 0 {
		cfg.MonthlyFlushThreshold = defaultMonthlyFlushThreshold
	}
	if cfg.MonthlyFlushInterval <= 0 {
		cfg.MonthlyFlushInterval = defaultMonthlyFlushInterval
	}
	if cfg.MonthlyIdleEviction <= 0 {
		cfg.MonthlyIdleEviction = defaultMonthlyIdleEviction
	}
	if cfg.BreakerFailureThreshold <= 0 {
		cfg.BreakerFailureThreshold = defaultBreakerFailureThreshold
	}
	if cfg.BreakerCooldown <= 0 {
		cfg.BreakerCooldown = defaultBreakerCooldown
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 5 * time.Second
	}
	return cfg
}

// Check records one request against the identifier's monthly quota and reports
// whether it is still within budget.
//
// It performs no network I/O and therefore never returns a transport error;
// the error return exists only to satisfy the RateLimiter interface.
//
// Result.Limit is deliberately 0 (and Remaining/ResetAt zero-valued): the app
// layer no longer owns a per-minute window, so emitting per-minute numbers
// here would be a lie. The interceptor omits the per-minute headers when
// Limit == 0.
func (l *MonthlyLimiter) Check(_ context.Context, identifier string, tier string, isBrowser bool) (*Result, error) {
	limits := l.config.GetLimits(tier)

	monthLimit := limits.RequestsPerMonth
	if isBrowser {
		monthLimit = limits.BrowserRequestsPerMonth
	}

	now := l.now()
	monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	nextMonth := monthStart.AddDate(0, 1, 0)

	// monthLimit == 0 means unlimited (paid browser tiers, and paid API tiers
	// configured as unmetered). Nothing to count, nothing to store.
	if monthLimit == 0 {
		return &Result{Allowed: true, MonthlyResetAt: nextMonth}, nil
	}

	// Anonymous traffic is unmetered by default — see the type doc. Reporting
	// MonthlyLimit: 0 keeps the response headers honest: no monthly quota is
	// being enforced for this caller.
	if l.config.SkipAnonymousMonthly && isAnonymousIdentifier(identifier) {
		return &Result{Allowed: true, MonthlyResetAt: nextMonth}, nil
	}

	month := now.Format("2006-01")

	l.mu.Lock()
	st, ok := l.state[identifier]
	if !ok || st.month != month {
		st = &monthlyState{month: month}
		l.state[identifier] = st
	}
	st.pending++
	st.lastSeen = now
	used := st.used()
	shouldFlush := st.pending >= l.config.MonthlyFlushThreshold
	l.mu.Unlock()

	if shouldFlush {
		l.signalFlush()
	}

	return &Result{
		Allowed:        used <= monthLimit,
		MonthlyLimit:   monthLimit,
		MonthlyUsed:    used,
		MonthlyResetAt: nextMonth,
		RetryAfter:     nextMonth.Sub(now),
	}, nil
}

// Close stops the background flusher and performs one final flush so an
// orderly shutdown does not drop the in-memory tail.
func (l *MonthlyLimiter) Close() error {
	l.stopOnce.Do(func() {
		close(l.stopCh)
	})
	l.wg.Wait()
	return nil
}

func (l *MonthlyLimiter) signalFlush() {
	select {
	case l.flushSig <- struct{}{}:
	default: // a flush is already queued
	}
}

func (l *MonthlyLimiter) runFlusher() {
	defer l.wg.Done()

	ticker := time.NewTicker(l.config.MonthlyFlushInterval)
	defer ticker.Stop()

	for {
		select {
		case <-l.stopCh:
			l.flush(context.Background())
			return
		case <-ticker.C:
			l.flush(context.Background())
			l.evictIdle()
		case <-l.flushSig:
			l.flush(context.Background())
		}
	}
}

// pendingFlush is one identifier's delta, snapshotted under the lock.
type pendingFlush struct {
	identifier string
	month      string
	delta      int
}

// flush writes every pending delta to Upstash. Each identifier costs exactly
// two Upstash commands (INCRBY + EXPIRE) in a single pipeline request.
func (l *MonthlyLimiter) flush(ctx context.Context) {
	now := l.now()

	l.mu.Lock()
	batch := make([]pendingFlush, 0, len(l.state))
	for id, st := range l.state {
		if st.pending > 0 {
			batch = append(batch, pendingFlush{identifier: id, month: st.month, delta: st.pending})
		}
	}
	l.mu.Unlock()

	if len(batch) == 0 {
		return
	}

	if !l.breaker.allow(now) {
		// Circuit open: keep accumulating locally and stay fail-open. Deltas
		// are NOT dropped — they flush once the breaker closes.
		return
	}

	for _, item := range batch {
		total, err := l.incrementRemote(ctx, item)
		if err != nil {
			if opened := l.breaker.recordFailure(l.now()); opened {
				log.Errorf(
					"RATE LIMIT QUOTA DB DEGRADED: Upstash monthly-quota writes failing (%v). Failing OPEN — monthly quotas are NOT being enforced until Upstash recovers. Per-minute limiting is unaffected (enforced at the Cloudflare edge).",
					err,
				)
			} else {
				log.Warnf("Monthly quota flush failed for %s: %v (failing open, delta retained locally)", item.identifier, err)
			}
			return
		}

		l.breaker.recordSuccess()

		l.mu.Lock()
		if st, ok := l.state[item.identifier]; ok && st.month == item.month {
			st.pending -= item.delta
			if st.pending < 0 {
				st.pending = 0
			}
			// INCRBY returns the authoritative post-increment total across all
			// instances, so this is where a multi-instance deployment converges.
			if total > st.remote {
				st.remote = total
			}
		}
		l.mu.Unlock()
	}
}

func (l *MonthlyLimiter) incrementRemote(ctx context.Context, item pendingFlush) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, l.config.Timeout)
	defer cancel()

	key := fmt.Sprintf("%smonth:%s:%s", l.config.KeyPrefix, item.month, item.identifier)

	// Expire one day after the month ends so late flushes still land on the
	// right bucket, then the key self-cleans.
	ttl := monthTTLSeconds(item.month) + 86400

	results, err := l.client.Pipeline(ctx, [][]interface{}{
		{"INCRBY", key, strconv.Itoa(item.delta)},
		{"EXPIRE", key, ttl},
	})
	if err != nil {
		return 0, err
	}
	if len(results) < 1 {
		return 0, fmt.Errorf("unexpected pipeline result length: %d (expected 2)", len(results))
	}
	if results[0].Error != "" {
		return 0, fmt.Errorf("redis error: %s", results[0].Error)
	}

	return parseCount(results[0].Result), nil
}

// evictIdle bounds memory. Only zero-pending entries are evicted, so no
// unflushed delta is ever discarded here.
func (l *MonthlyLimiter) evictIdle() {
	cutoff := l.now().Add(-l.config.MonthlyIdleEviction)

	l.mu.Lock()
	defer l.mu.Unlock()
	for id, st := range l.state {
		if st.pending == 0 && st.lastSeen.Before(cutoff) {
			delete(l.state, id)
		}
	}
}

// monthTTLSeconds returns the number of seconds in the given "2006-01" month.
func monthTTLSeconds(month string) int {
	start, err := time.Parse("2006-01", month)
	if err != nil {
		return 31 * 86400
	}
	return int(start.AddDate(0, 1, 0).Sub(start).Seconds())
}

// isAnonymousIdentifier reports whether the identifier is IP-derived (the
// shape produced by extractIdentifierAndTier for unauthenticated callers).
func isAnonymousIdentifier(identifier string) bool {
	return len(identifier) >= 3 && identifier[:3] == "ip:"
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

// circuitBreaker suppresses Upstash traffic after repeated failures so a sick
// quota database is hit once per cooldown rather than once per flush. It never
// changes the allow/deny decision for a user request — the limiter is
// unconditionally fail-open — it only gates outbound writes and logging.
type circuitBreaker struct {
	mu sync.Mutex

	failureThreshold int
	cooldown         time.Duration

	consecutiveFailures int
	openUntil           time.Time
	open                bool
}

func newCircuitBreaker(failureThreshold int, cooldown time.Duration) *circuitBreaker {
	return &circuitBreaker{failureThreshold: failureThreshold, cooldown: cooldown}
}

// allow reports whether an Upstash call may proceed at time now.
func (b *circuitBreaker) allow(now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	if !b.open {
		return true
	}
	if now.Before(b.openUntil) {
		return false
	}
	// Cooldown elapsed: half-open — let one probe through.
	return true
}

// recordFailure counts a failure and reports true if this call opened the
// circuit (so the caller can log the transition exactly once).
func (b *circuitBreaker) recordFailure(now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.consecutiveFailures++
	wasOpen := b.open
	if b.consecutiveFailures >= b.failureThreshold {
		b.open = true
		b.openUntil = now.Add(b.cooldown)
	}
	return b.open && !wasOpen
}

// recordSuccess closes the circuit.
func (b *circuitBreaker) recordSuccess() {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.open {
		log.Infof("RATE LIMIT QUOTA DB RECOVERED: Upstash monthly-quota writes succeeding again; quota enforcement resumed")
	}
	b.consecutiveFailures = 0
	b.open = false
	b.openUntil = time.Time{}
}

// isOpen is used by tests and diagnostics.
func (b *circuitBreaker) isOpen() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.open
}
