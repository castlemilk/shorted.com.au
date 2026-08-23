package ratelimit

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"go.opentelemetry.io/otel/attribute"
)

// minuteLimiter enforces the documented PER-TIER per-minute limits entirely in
// process, with zero external I/O.
//
// # WHY IN MEMORY AND NOT AT THE EDGE
//
// The Cloudflare worker enforces a tier-BLIND abuse ceiling, because resolving
// a caller's subscription tier at the edge needs a database lookup and that
// lookup is exactly the shared-dependency coupling that caused the August 2026
// incident. So the per-tier numbers the pricing page promises have to be
// enforced somewhere that already knows the tier: here, after auth.
//
// # WHY IN MEMORY AND NOT IN POSTGRES
//
// A minute window is a write per request. That is precisely the shape that
// exhausted Upstash, and it would be no better against Postgres. A per-instance
// counter costs one map operation.
//
// # THE APPROXIMATION, STATED HONESTLY
//
// Counters are per instance and not shared. With N Cloud Run instances the
// effective ceiling is up to N x the limit, and a caller's requests are spread
// across instances by the load balancer, so the practical ceiling sits between
// limit and N x limit. This is accepted:
//
//   - It is tier SHAPING, not abuse control. The hard abuse ceiling is the
//     edge worker's tier-blind bucket, which bounds the worst case regardless.
//   - It is strictly better than the alternative on offer, which is zero
//     per-tier enforcement.
//   - Cloud Run for this service runs a small instance count, so N is single
//     digits, and shorted.com.au's tiers differ by 2-4x — an N-fold blur does
//     not let a free caller reach a paid caller's throughput in practice.
//
// A fixed window (not a sliding one) is used deliberately: it costs one int,
// and its known weakness (2x the limit across a window boundary) is smaller
// than the N-instance blur already accepted above. Paying for a sliding window
// here would be precision theatre.
type minuteLimiter struct {
	mu     sync.Mutex
	states map[string]*minuteState

	window        time.Duration
	maxIdentifers int
	now           func() time.Time

	lastCapWarn time.Time
}

type minuteState struct {
	windowStart time.Time
	count       int
	lastSeen    time.Time
}

func newMinuteLimiter(window time.Duration, maxIdentifiers int, now func() time.Time) *minuteLimiter {
	return &minuteLimiter{
		states:        make(map[string]*minuteState),
		window:        window,
		maxIdentifers: maxIdentifiers,
		now:           now,
	}
}

// minuteResult is the outcome of one per-minute check.
type minuteResult struct {
	allowed   bool
	limit     int
	remaining int
	resetAt   time.Time
}

// check records one request and reports whether the caller is within their
// per-minute allowance.
//
// limit == 0 means unlimited: the caller short-circuits with NO bookkeeping at
// all — no map entry, no lock contention, no memory. Paid tiers are the
// highest-volume callers and it would be perverse to spend the most work on
// the users who are exempt.
func (l *minuteLimiter) check(identifier string, limit int) minuteResult {
	if limit <= 0 {
		return minuteResult{allowed: true}
	}

	now := l.now()

	l.mu.Lock()
	defer l.mu.Unlock()

	st, ok := l.states[identifier]
	if !ok {
		if len(l.states) >= l.maxIdentifers {
			l.evictLocked(now)
		}
		if len(l.states) >= l.maxIdentifers {
			// Still full after eviction: refuse to grow. An unbounded key
			// space is what caused the incident, so the failure mode here is
			// "this caller is unmetered for a minute", not "the process OOMs".
			//
			// NOTE (2026-08): this branch is currently defence in depth rather
			// than a live path — evictLocked always frees at least one slot, so
			// a caller reaching here means the eviction policy changed or the
			// cap was configured to zero. That is precisely why it is
			// instrumented: an unreachable branch that silently disables
			// limiting is the worst kind to leave unobserved.
			l.capReachedLocked(now)
			return minuteResult{allowed: true, limit: limit, remaining: limit, resetAt: now.Add(l.window)}
		}
		st = &minuteState{windowStart: now}
		l.states[identifier] = st
	}

	if now.Sub(st.windowStart) >= l.window {
		st.windowStart = now
		st.count = 0
	}

	st.count++
	st.lastSeen = now

	resetAt := st.windowStart.Add(l.window)
	remaining := limit - st.count
	if remaining < 0 {
		remaining = 0
	}

	return minuteResult{
		allowed:   st.count <= limit,
		limit:     limit,
		remaining: remaining,
		resetAt:   resetAt,
	}
}

// evictLocked reclaims space. Expired windows go first (they carry no
// information); only if that is not enough does it drop the least recently
// seen tenth, which is the closest thing to "oldest" a map can offer cheaply.
func (l *minuteLimiter) evictLocked(now time.Time) {
	cutoff := now.Add(-2 * l.window)
	expired := 0
	for id, st := range l.states {
		if st.lastSeen.Before(cutoff) {
			delete(l.states, id)
			expired++
		}
	}
	if expired > 0 {
		addCount(context.Background(), shortedotel.RateLimitMinuteEvictions, int64(expired),
			attribute.String(attrReason, evictReasonExpired))
	}
	if len(l.states) < l.maxIdentifers {
		return
	}

	type entry struct {
		id       string
		lastSeen time.Time
	}
	entries := make([]entry, 0, len(l.states))
	for id, st := range l.states {
		entries = append(entries, entry{id: id, lastSeen: st.lastSeen})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].lastSeen.Before(entries[j].lastSeen) })

	drop := len(entries) / 10
	if drop == 0 {
		drop = 1
	}
	for i := 0; i < drop; i++ {
		delete(l.states, entries[i].id)
	}
	addCount(context.Background(), shortedotel.RateLimitMinuteEvictions, int64(drop),
		attribute.String(attrReason, evictReasonLeastRecent))
}

// sweep drops expired windows on a timer so an idle process does not hold a
// map sized to its busiest minute.
//
// It doubles as the sampling point for map-size pressure: it runs on the
// flusher's ticker, which is already off the request path, so publishing the
// gauge here costs a request nothing. Map size against MinuteMaxIdentifiers is
// the early warning for the cap-reached event above.
func (l *minuteLimiter) sweep() {
	now := l.now()
	cutoff := now.Add(-2 * l.window)

	l.mu.Lock()
	expired := 0
	for id, st := range l.states {
		if st.lastSeen.Before(cutoff) {
			delete(l.states, id)
			expired++
		}
	}
	size := len(l.states)
	l.mu.Unlock()

	ctx := context.Background()
	if expired > 0 {
		addCount(ctx, shortedotel.RateLimitMinuteEvictions, int64(expired),
			attribute.String(attrReason, evictReasonExpired))
	}
	setGauge(ctx, shortedotel.RateLimitMinuteIdentifiers, int64(size))
}

// capReachedLocked records that a caller went UNMETERED because the identifier
// map was full.
//
// The COUNTER fires every time, because "how many requests escaped per-tier
// limiting" is the number an operator needs. The LOG is throttled to once a
// minute, because the condition that triggers it is by definition
// high-frequency and would otherwise be its own outage.
func (l *minuteLimiter) capReachedLocked(now time.Time) {
	addCount(context.Background(), shortedotel.RateLimitMinuteCapReached, 1)

	if now.Sub(l.lastCapWarn) < time.Minute {
		return
	}
	l.lastCapWarn = now
	log.Warnf(
		"Per-minute rate limit table at capacity (%d identifiers); new callers are unmetered in this instance until it drains. The Cloudflare edge abuse ceiling still applies.",
		l.maxIdentifers,
	)
}

// size is used by tests and diagnostics.
func (l *minuteLimiter) size() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.states)
}
