package ratelimit

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"go.opentelemetry.io/otel/attribute"
)

// refreshCoalesceWindow is how long the refresher waits after the first
// cache-miss signal before issuing its read, so a burst of cold identifiers
// costs one SELECT instead of one each.
const refreshCoalesceWindow = 250 * time.Millisecond

// AppLimiter is the app-layer half of the three-tier rate limiting
// architecture that came out of the August 2026 quota incident.
//
//	tier-blind abuse ceiling -> Cloudflare edge worker (no origin dependency)
//	per-tier per-minute      -> this limiter, IN MEMORY (see minute.go)
//	monthly quotas           -> this limiter, POSTGRES, batched (below)
//
// # Why Postgres, and why this shape
//
// The incident was not "rate limiting was too slow", it was "rate limiting and
// the page cache shared one Upstash command quota, and exhausting it broke
// both". PR #455 cut the command volume ~87x but left the shared dependency in
// place. This moves quota accounting to the database the API already holds a
// pool for: no per-command billing cap to exhaust, and no second tenant to
// take down. The rate-limit path now touches Upstash zero times.
//
// Putting quota counters on the primary database is only defensible because
// the limiter is aggressively lazy:
//
//   - NO I/O ON THE REQUEST PATH, EVER. Check touches memory only. A degraded
//     database cannot add latency, 500s, or spurious 429s to a single request.
//   - WRITES ARE ONE STATEMENT FOR THE WHOLE INSTANCE. Deltas accumulate per
//     identifier and flush as a single multi-row upsert when any identifier
//     reaches its batch threshold, when MonthlyFlushInterval elapses, or on
//     shutdown. Statement count tracks flush frequency, not traffic: ~300-600
//     write statements/day for a 2-instance deployment under continuous load.
//   - READS ARE A CACHE MISS PATH, NOT A LOOKUP. Each identifier's last known
//     total is cached for MonthlyTotalTTL. A miss ALLOWS the request and
//     triggers an async, coalesced refresh. In steady state there are almost
//     no reads at all, because the flush upsert RETURNs the authoritative
//     total and refreshes the cache for free.
//
// # Consistency, stated honestly
//
// Effective check = cached_total + pending_local_delta > limit.
//
// A single instance is exact, because its own flush refreshes its own total.
// Across N instances an identifier can exceed quota by at most N x (the batch
// size in effect), since that is the most any one instance can be holding
// unflushed:
//
//	far from the limit: batch 200 -> up to 200N requests of overshoot
//	                    (3 instances = 600, i.e. 6% of a 10,000/month quota)
//	within 10% of quota: batch collapses to MonthlyNearLimitThreshold = 10
//	                    -> up to 10N (3 instances = 30, i.e. 0.3%)
//
// Batching hard is free while a caller is at 3% of quota and expensive at 97%,
// so the batch size collapses exactly where accuracy starts to matter. The
// time-based flush adds nothing to that bound: if MonthlyFlushInterval elapses
// before the threshold, the pending delta was by definition smaller.
//
// Undercount on instance death is symmetric and bounded the same way.
//
// # Failure behaviour
//
// Fail OPEN, always and unconditionally. A sick quota database must never 429
// or 500 a user. Deltas are RETAINED (never dropped) across failures and
// flushed when the database recovers; a circuit breaker stops hammering a
// degraded database while accumulation continues.
type AppLimiter struct {
	store  UsageStore
	config Config
	minute *minuteLimiter

	mu           sync.Mutex
	state        map[string]*monthlyState
	orphans      []UsageDelta        // deltas stranded by a month rollover
	refreshQueue map[string]struct{} // identifiers awaiting a cold read

	breaker *circuitBreaker

	now        func() time.Time
	flushSig   chan struct{}
	refreshSig chan struct{}
	stopCh     chan struct{}
	stopOnce   sync.Once
	wg         sync.WaitGroup
}

type monthlyState struct {
	month    time.Time // first day of the quota month, UTC
	pending  int64     // increments not yet written
	total    int64     // last known persisted total
	totalAt  time.Time // when total was learned; zero = never
	queued   bool      // a refresh is already queued for this identifier
	lastSeen time.Time
}

// NewAppLimiter creates the batched, fail-open app-layer limiter.
//
// It does NOT touch the database at construction: an unreachable quota table
// must not prevent the service from starting. The first flush discovers any
// problem and trips the breaker.
//
// A nil store is valid and disables monthly accounting while leaving per-minute
// tier enforcement fully functional — the two halves have independent failure
// domains on purpose.
func NewAppLimiter(cfg Config, store UsageStore) *AppLimiter {
	l := newAppLimiter(cfg, store)

	l.wg.Add(2)
	go l.runFlusher()
	go l.runRefresher()

	log.Infof(
		"App rate limiter enabled: per-tier per-minute limiting in process (window=%s), monthly quotas in Postgres (batch=%d, near-limit batch=%d, interval=%s, anonymous_metered=%t)",
		l.config.WindowSize, l.config.MonthlyFlushThreshold, l.config.MonthlyNearLimitThreshold,
		l.config.MonthlyFlushInterval, !l.config.SkipAnonymousMonthly,
	)

	return l
}

// newAppLimiter builds the limiter WITHOUT starting background workers, so
// tests can drive Flush/refresh deterministically instead of racing timers.
func newAppLimiter(cfg Config, store UsageStore) *AppLimiter {
	cfg = withDefaults(cfg)

	return &AppLimiter{
		store:        store,
		config:       cfg,
		minute:       newMinuteLimiter(cfg.WindowSize, cfg.MinuteMaxIdentifiers, time.Now),
		state:        make(map[string]*monthlyState),
		refreshQueue: make(map[string]struct{}),
		breaker:      newCircuitBreaker(cfg.BreakerFailureThreshold, cfg.BreakerCooldown),
		now:          time.Now,
		flushSig:     make(chan struct{}, 1),
		refreshSig:   make(chan struct{}, 1),
		stopCh:       make(chan struct{}),
	}
}

// setNow overrides the clock for both halves of the limiter. Tests only.
func (l *AppLimiter) setNow(fn func() time.Time) {
	l.now = fn
	l.minute.now = fn
}

// Check enforces the per-minute window and then the monthly quota.
//
// It performs no I/O and therefore never returns a transport error; the error
// return exists only to satisfy the RateLimiter interface.
//
// Order matters: a request rejected by the per-minute window does NOT consume
// monthly quota. Being throttled should not also cost you your month.
func (l *AppLimiter) Check(_ context.Context, identifier string, tier string, isBrowser bool) (*Result, error) {
	limits := l.config.GetLimits(tier)

	minuteLimit := limits.RequestsPerMinute
	monthLimit := limits.RequestsPerMonth
	if isBrowser {
		minuteLimit = limits.BrowserRequestsPerMinute
		monthLimit = limits.BrowserRequestsPerMonth
	}

	now := l.now()
	monthStart := normalizeMonth(now)
	nextMonth := monthStart.AddDate(0, 1, 0)

	result := &Result{
		Allowed:        true,
		Tier:           tier,
		IsBrowser:      isBrowser,
		MonthlyResetAt: nextMonth,
	}

	// ---- per-minute (in process, per tier) ----
	mr := l.minute.check(identifier, minuteLimit)
	result.Limit = mr.limit
	result.Remaining = mr.remaining
	result.ResetAt = mr.resetAt

	if !mr.allowed {
		used, limitKnown := l.monthlySnapshot(identifier, monthStart)
		if limitKnown {
			result.MonthlyLimit = monthLimit
			result.MonthlyUsed = int(used)
		}
		result.Allowed = false
		result.ExceededKind = LimitKindPerMinute
		result.RetryAfter = mr.resetAt.Sub(now)
		return result, nil
	}

	// ---- monthly (Postgres, batched) ----
	//
	// monthLimit == 0 means unlimited. Anonymous callers are unmetered by
	// default: one row per IP per month is an unbounded key space for no
	// enforcement value, and their per-minute window plus the edge ceiling
	// already bound them.
	if monthLimit == 0 || (l.config.SkipAnonymousMonthly && isAnonymousIdentifier(identifier)) {
		return result, nil
	}

	used, tracked := l.recordMonthly(identifier, monthStart, monthLimit, now)
	result.MonthlyLimit = monthLimit
	result.MonthlyUsed = int(used)

	if tracked && used > int64(monthLimit) {
		result.Allowed = false
		result.ExceededKind = LimitKindMonthly
		result.RetryAfter = nextMonth.Sub(now)
	}

	return result, nil
}

// recordMonthly buffers one increment and reports the best-known monthly total.
// The second return is false when the increment was not tracked at all (state
// map at capacity, or the total has never been read), in which case the caller
// must ALLOW: an unknown total is not evidence of an exceeded quota.
func (l *AppLimiter) recordMonthly(identifier string, month time.Time, monthLimit int, now time.Time) (int64, bool) {
	var (
		queueRefresh bool
		shouldFlush  bool
	)

	l.mu.Lock()

	st, ok := l.state[identifier]
	if !ok {
		if len(l.state) >= l.config.MonthlyMaxIdentifiers {
			l.evictIdleLocked(now)
		}
		if len(l.state) >= l.config.MonthlyMaxIdentifiers {
			// Refuse to grow. Memory is a hard bound; quota accuracy is not.
			l.mu.Unlock()
			// This increment is discarded, so the caller is under-counted
			// against their quota. Silent under-counting is exactly the kind
			// of drift nobody notices until a bill argument, so it is counted.
			// In-memory counter Add, and only on the degenerate over-cap path.
			addCount(context.Background(), shortedotel.RateLimitDeltasDropped, 1,
				attribute.String(attrReason, dropReasonMonthlyCap))
			return 0, false
		}
		st = &monthlyState{month: month}
		l.state[identifier] = st
	}

	// Month rollover. The old month's unflushed delta is stranded on a state
	// object that is about to be reset, so it is moved to the orphan list —
	// dropping it would silently under-report the month that just closed.
	if !st.month.Equal(month) {
		if st.pending > 0 {
			l.strandLocked(UsageDelta{Identifier: identifier, Month: st.month, Delta: st.pending})
		}
		*st = monthlyState{month: month}
	}

	st.pending++
	st.lastSeen = now
	used := st.total + st.pending
	cold := st.totalAt.IsZero()

	if (cold || now.Sub(st.totalAt) > l.config.MonthlyTotalTTL) && !st.queued {
		st.queued = true
		l.refreshQueue[identifier] = struct{}{}
		queueRefresh = true
	}

	shouldFlush = st.pending >= int64(l.flushThresholdFor(used, monthLimit))

	l.mu.Unlock()

	if queueRefresh {
		signal(l.refreshSig)
	}
	if shouldFlush {
		signal(l.flushSig)
	}

	// A cold identifier has no persisted total yet, so `used` is only this
	// instance's own contribution. Allow, and let the refresh settle it.
	return used, !cold
}

// flushThresholdFor collapses the batch size as a caller approaches their
// quota. See the overshoot maths on AppLimiter.
func (l *AppLimiter) flushThresholdFor(used int64, monthLimit int) int {
	if monthLimit > 0 && used*int64(nearLimitDenominator) >= int64(monthLimit)*int64(nearLimitNumerator) {
		return l.config.MonthlyNearLimitThreshold
	}
	return l.config.MonthlyFlushThreshold
}

// monthlySnapshot reads the best-known total WITHOUT recording a request. Used
// on the per-minute rejection path so the response can still report monthly
// state accurately.
func (l *AppLimiter) monthlySnapshot(identifier string, month time.Time) (int64, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()

	st, ok := l.state[identifier]
	if !ok || !st.month.Equal(month) || st.totalAt.IsZero() {
		return 0, false
	}
	return st.total + st.pending, true
}

// strandLocked parks a delta that no longer belongs to any live state object.
// The list is capped: retaining deltas through an outage must not become an
// unbounded memory leak.
func (l *AppLimiter) strandLocked(d UsageDelta) {
	if len(l.orphans) >= l.config.MonthlyMaxIdentifiers {
		// A dropped delta is quota that was consumed and will never be billed
		// or enforced. Count the increments lost, not just the events, so the
		// magnitude of the under-count is recoverable from the metric alone.
		dropped := l.orphans[0].Delta
		log.Warnf(
			"Monthly quota orphan buffer full (%d entries); dropping the oldest pending delta (%d increments for %s) — this month is now UNDER-COUNTED for that caller",
			len(l.orphans), dropped, redactIdentifier(l.orphans[0].Identifier),
		)
		addCount(context.Background(), shortedotel.RateLimitDeltasDropped, dropped,
			attribute.String(attrReason, dropReasonOrphanCap))
		l.orphans = l.orphans[1:]
	}
	l.orphans = append(l.orphans, d)
}

// Close stops the background workers and performs one final flush so an
// orderly shutdown does not drop the in-memory tail.
func (l *AppLimiter) Close() error {
	l.stopOnce.Do(func() {
		close(l.stopCh)
	})
	l.wg.Wait()
	return nil
}

func signal(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default: // already queued
	}
}

func (l *AppLimiter) runFlusher() {
	defer l.wg.Done()

	ticker := time.NewTicker(l.config.MonthlyFlushInterval)
	defer ticker.Stop()

	for {
		select {
		case <-l.stopCh:
			l.Flush(context.Background())
			return
		case <-ticker.C:
			l.Flush(context.Background())
			l.evictIdle()
			l.minute.sweep()
			l.publishGauges()
		case <-l.flushSig:
			l.Flush(context.Background())
		}
	}
}

func (l *AppLimiter) runRefresher() {
	defer l.wg.Done()

	for {
		select {
		case <-l.stopCh:
			return
		case <-l.refreshSig:
			// Coalesce: a deploy or a cache expiry wave produces a burst of
			// misses, and they should cost one SELECT between them.
			select {
			case <-time.After(refreshCoalesceWindow):
			case <-l.stopCh:
				return
			}
			l.refresh(context.Background())
		}
	}
}

// Flush writes every pending delta as ONE multi-row upsert and refreshes the
// cached totals from what the statement returns. Exported so shutdown paths
// and tests can force it.
func (l *AppLimiter) Flush(ctx context.Context) {
	if l.store == nil {
		return
	}

	now := l.now()

	l.mu.Lock()
	batch := make([]UsageDelta, 0, len(l.state)+len(l.orphans))
	for id, st := range l.state {
		if st.pending > 0 {
			batch = append(batch, UsageDelta{Identifier: id, Month: st.month, Delta: st.pending})
		}
	}
	orphanCount := len(l.orphans)
	batch = append(batch, l.orphans...)
	l.mu.Unlock()

	if len(batch) == 0 {
		return
	}

	if !l.breaker.allow(now) {
		// Circuit open: keep accumulating locally and stay fail-open. Nothing
		// is dropped; it flushes once the breaker closes. Counted separately
		// from a failure so "the database is sick" and "we are not even trying
		// because it is sick" are distinguishable on a dashboard.
		recordFlush(ctx, flushSkippedBreaker, len(batch))
		return
	}

	totals, err := l.store.ApplyDeltas(ctx, batch)
	if err != nil {
		recordFlush(ctx, flushFailure, len(batch))
		if opened := l.breaker.recordFailure(l.now()); opened {
			log.Errorf(
				"RATE LIMIT QUOTA DB DEGRADED: api_usage_monthly writes failing (%v). Failing OPEN — monthly quotas are NOT being enforced until Postgres recovers. Per-minute limiting and the Cloudflare edge ceiling are unaffected. Deltas are retained in memory and will be written on recovery.",
				err,
			)
		} else {
			log.Warnf("Monthly quota flush failed for %d identifiers: %v (failing open, deltas retained)", len(batch), err)
		}
		return
	}

	recordFlush(ctx, flushSuccess, len(batch))
	l.breaker.recordSuccess()

	l.mu.Lock()
	for _, item := range batch {
		st, ok := l.state[item.Identifier]
		if !ok || !st.month.Equal(item.Month) {
			continue
		}
		st.pending -= item.Delta
		if st.pending < 0 {
			st.pending = 0
		}
		// The upsert RETURNs the authoritative post-increment total across all
		// instances, so a successful flush doubles as a cache refresh — this
		// is why steady-state read volume is ~zero.
		if total, ok := totals[UsageKey{Identifier: item.Identifier, Month: item.Month}]; ok {
			// `total` is the post-upsert count, which already includes
			// item.Delta. st.pending now holds only increments that arrived
			// while the statement was in flight, so used = total + pending
			// stays correct.
			st.total = total
			st.totalAt = now
			st.queued = false
			delete(l.refreshQueue, item.Identifier)
		}
	}
	// Only the orphans included in this batch are cleared; any stranded while
	// the statement was in flight survive to the next flush.
	if orphanCount > 0 {
		l.orphans = append([]UsageDelta(nil), l.orphans[orphanCount:]...)
	}
	l.mu.Unlock()
}

// refresh loads persisted totals for identifiers this instance has never seen
// persisted (or whose cache has aged past MonthlyTotalTTL). One SELECT per
// coalesced burst, never on the request path.
func (l *AppLimiter) refresh(ctx context.Context) {
	if l.store == nil {
		return
	}

	now := l.now()
	month := normalizeMonth(now)

	l.mu.Lock()
	if len(l.refreshQueue) == 0 {
		l.mu.Unlock()
		return
	}
	identifiers := make([]string, 0, len(l.refreshQueue))
	for id := range l.refreshQueue {
		identifiers = append(identifiers, id)
	}
	l.mu.Unlock()

	if !l.breaker.allow(now) {
		return
	}

	totals, err := l.store.Totals(ctx, month, identifiers)
	if err != nil {
		if opened := l.breaker.recordFailure(l.now()); opened {
			log.Errorf("RATE LIMIT QUOTA DB DEGRADED: api_usage_monthly reads failing (%v). Failing OPEN — callers with no cached total are allowed through.", err)
		} else {
			log.Warnf("Monthly quota refresh failed for %d identifiers: %v (failing open)", len(identifiers), err)
		}
		return
	}

	l.breaker.recordSuccess()

	l.mu.Lock()
	for _, id := range identifiers {
		delete(l.refreshQueue, id)
		st, ok := l.state[id]
		if !ok || !st.month.Equal(month) {
			continue
		}
		st.total = totals[UsageKey{Identifier: id, Month: month}] // absent = 0, which is the truth
		st.totalAt = now
		st.queued = false
	}
	l.mu.Unlock()
}

// publishGauges samples the limiter's in-memory state onto gauges. It runs on
// the flusher's ticker — never on the request path — and takes the same lock a
// flush already takes, once per MonthlyFlushInterval.
//
// The backlog gauges are the durable-loss signal: a flush failure counter goes
// back to zero when flushes recover, but retained_deltas keeps climbing for as
// long as the database is unable to accept writes, and it is what says how much
// quota is at risk of being lost if the instance is replaced.
func (l *AppLimiter) publishGauges() {
	l.mu.Lock()
	var pending int64
	for _, st := range l.state {
		pending += st.pending
	}
	var orphaned int64
	for _, d := range l.orphans {
		orphaned += d.Delta
	}
	tracked := int64(len(l.state))
	l.mu.Unlock()

	ctx := context.Background()
	setGauge(ctx, shortedotel.RateLimitRetained, pending, attribute.String(attrBuffer, bufferPending))
	setGauge(ctx, shortedotel.RateLimitRetained, orphaned, attribute.String(attrBuffer, bufferOrphan))
	setGauge(ctx, shortedotel.RateLimitMonthlyIdentifiers, tracked)
}

func (l *AppLimiter) evictIdle() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.evictIdleLocked(l.now())
}

// evictIdleLocked bounds memory. Only zero-pending entries are evicted, so no
// unflushed delta is ever discarded here.
func (l *AppLimiter) evictIdleLocked(now time.Time) {
	cutoff := now.Add(-l.config.MonthlyIdleEviction)
	for id, st := range l.state {
		if st.pending == 0 && st.lastSeen.Before(cutoff) {
			delete(l.state, id)
			delete(l.refreshQueue, id)
		}
	}
}

// isAnonymousIdentifier reports whether the identifier is IP-derived (the
// shape produced by extractIdentifierAndTier for unauthenticated callers).
func isAnonymousIdentifier(identifier string) bool {
	return strings.HasPrefix(identifier, "ip:")
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

// circuitBreaker suppresses quota-store traffic after repeated failures so a
// sick database is hit once per cooldown rather than once per flush. It never
// changes the allow/deny decision for a user request — the limiter is
// unconditionally fail-open — it only gates outbound statements and logging.
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

// allow reports whether a statement may proceed at time now.
func (b *circuitBreaker) allow(now time.Time) bool {
	b.mu.Lock()

	if !b.open {
		b.mu.Unlock()
		return true
	}
	if now.Before(b.openUntil) {
		b.mu.Unlock()
		return false
	}
	// Cooldown elapsed: half-open — let one probe through. Recorded once per
	// probe so "we are retrying" is visible and an operator can tell a breaker
	// that is oscillating from one that is stuck open.
	//
	// The mutex is released BEFORE the metric record: an instrument is an
	// in-memory write, but holding the breaker lock across any third-party
	// call is how a lock ordering bug gets born.
	b.mu.Unlock()
	recordBreakerTransition(breakerHalfOpen)
	return true
}

// recordFailure counts a failure and reports true if this call opened the
// circuit (so the caller can log the transition exactly once).
func (b *circuitBreaker) recordFailure(now time.Time) bool {
	b.mu.Lock()

	b.consecutiveFailures++
	wasOpen := b.open
	if b.consecutiveFailures >= b.failureThreshold {
		b.open = true
		b.openUntil = now.Add(b.cooldown)
	}
	opened := b.open && !wasOpen
	b.mu.Unlock()

	if opened {
		recordBreakerTransition(breakerOpen)
	}
	return opened
}

// recordSuccess closes the circuit.
func (b *circuitBreaker) recordSuccess() {
	b.mu.Lock()
	wasOpen := b.open
	b.consecutiveFailures = 0
	b.open = false
	b.openUntil = time.Time{}
	b.mu.Unlock()

	if wasOpen {
		recordBreakerTransition(breakerClosed)
		log.Infof("RATE LIMIT QUOTA DB RECOVERED: api_usage_monthly statements succeeding again; quota enforcement resumed")
	}
}

// isOpen is used by tests and diagnostics.
func (b *circuitBreaker) isOpen() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.open
}
