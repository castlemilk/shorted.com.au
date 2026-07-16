package main

import (
	"math/rand"
	"time"
)

// crawlCircuitBreaker throttles PER-SOURCE (rea/domain) sweeps when a portal
// starts serving block pages (Akamai `errors.edgesuite.net`, Kasada stubs). It
// exists because the in-sweep breaker in sweepSuburbSource keys off a per-
// listingsCrawler counter, and -mode agent builds a FRESH listingsCrawler per
// suburb job — so that counter resets every suburb and never accumulates. This
// breaker lives at the agent-loop level, so its state persists across suburbs.
//
// Each source has its own circuit. Consecutive blocked sweeps OPEN it for an
// EXPONENTIALLY-growing, jittered cooldown, during which that source is SKIPPED
// (we stop hammering its block page, which is what escalates the residential IP
// flag onto the OTHER portal too) while the healthy source keeps crawling. After
// the cooldown a single probe is allowed (half-open): a clean sweep closes the
// circuit and resets the backoff; another block widens it (doubles, capped).
//
// Key fix for the observed failure: when Domain is blocked but REA still returns
// listings, the job is "succeeded", so the OLD job-level `consecBlocked` counter
// (which only counts fully-failed, zero-event jobs) never trips and Domain is hit
// on every suburb. This breaker trips on the SOURCE's own block streak instead.
type crawlCircuitBreaker struct {
	trip     int           // consecutive blocks that OPEN a source's circuit
	base     time.Duration // first cooldown when a circuit opens
	max      time.Duration // cap on the (doubling) cooldown
	circuits map[string]*sourceCircuit
}

// sourceCircuit is one source's breaker state (persisted across suburbs).
type sourceCircuit struct {
	consec    int           // consecutive blocked sweeps for this source
	openUntil time.Time     // circuit OPEN (skip this source) until here
	backoff   time.Duration // current cooldown; doubles each re-open, capped at max
}

// newCircuitBreaker builds a breaker. trip<1 ⇒ 1; a non-positive base ⇒ 5m; a
// max below base ⇒ base (so the cooldown is at least one base with no growth).
func newCircuitBreaker(trip int, base, max time.Duration) *crawlCircuitBreaker {
	if trip < 1 {
		trip = 1
	}
	if base <= 0 {
		base = 5 * time.Minute
	}
	if max < base {
		max = base
	}
	return &crawlCircuitBreaker{trip: trip, base: base, max: max, circuits: map[string]*sourceCircuit{}}
}

func (cb *crawlCircuitBreaker) circuit(source string) *sourceCircuit {
	sc := cb.circuits[source]
	if sc == nil {
		sc = &sourceCircuit{}
		cb.circuits[source] = sc
	}
	return sc
}

// skip reports whether source's circuit is OPEN at now — i.e. the caller should
// SKIP the sweep rather than hammer a blocked portal — and the cooldown left.
func (cb *crawlCircuitBreaker) skip(source string, now time.Time) (bool, time.Duration) {
	sc := cb.circuit(source)
	if now.Before(sc.openUntil) {
		return true, sc.openUntil.Sub(now)
	}
	return false, 0
}

// record updates a source's circuit after a sweep. blocked reports whether the
// sweep hit a block/poison page. A clean sweep closes the circuit and resets the
// backoff. The trip-th consecutive block OPENS (or, if already open past its
// cooldown, RE-opens) the circuit for a jittered cooldown that doubles each time
// up to max. Returns whether it (re)opened and the cooldown applied.
func (cb *crawlCircuitBreaker) record(source string, blocked bool, now time.Time) (opened bool, cooldown time.Duration) {
	sc := cb.circuit(source)
	if !blocked {
		sc.consec = 0
		sc.backoff = 0
		sc.openUntil = time.Time{}
		return false, 0
	}
	sc.consec++
	if sc.consec < cb.trip {
		return false, 0
	}
	if sc.backoff <= 0 {
		sc.backoff = cb.base
	} else {
		sc.backoff *= 2
		if sc.backoff > cb.max {
			sc.backoff = cb.max
		}
	}
	cooldown = jitterDur(sc.backoff)
	sc.openUntil = now.Add(cooldown)
	return true, cooldown
}

// allOpen reports whether EVERY listed source is currently in an open circuit —
// i.e. the whole session is blocked, so the crawl should PAUSE (or stop) rather
// than spin claiming jobs it will only skip. Returns the longest remaining
// cooldown so the caller can sleep until the first source half-opens.
func (cb *crawlCircuitBreaker) allOpen(sources []string, now time.Time) (bool, time.Duration) {
	if len(sources) == 0 {
		return false, 0
	}
	maxRem := time.Duration(0)
	for _, s := range sources {
		open, rem := cb.skip(s, now)
		if !open {
			return false, 0
		}
		if rem > maxRem {
			maxRem = rem
		}
	}
	return true, maxRem
}

// jitterDur returns d ±20% (math/rand is fine for pacing — same as jitterSleep).
// Non-positive d ⇒ 0.
func jitterDur(d time.Duration) time.Duration {
	if d <= 0 {
		return 0
	}
	delta := int64(d) / 5 // 20%
	if delta <= 0 {
		return d
	}
	return d + time.Duration(rand.Int63n(2*delta+1)) - time.Duration(delta)
}
