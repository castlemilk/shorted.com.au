package main

import (
	"container/list"
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	flaggr "github.com/flaggr-dev/flaggr-go"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
)

// chatModelFlagKey is the Flaggr flag that picks a user's chat model. Its value
// is a route id, "<provider>:<model>", or "" or "default" for the env default.
const chatModelFlagKey = "chat-model"

// The flag is read on a turn's path, so each read is bounded tightly and the
// answer is cached per user. Only a user's first turn in a TTL window can wait
// on Flaggr.
const (
	defaultChatModelFlagTimeout       = 200 * time.Millisecond
	defaultChatModelFlagLookupTimeout = time.Second
	defaultChatModelFlagTTL           = 30 * time.Second
	defaultChatModelFlagMaxStale      = 5 * time.Minute
	chatModelFlagCacheSize            = 10000
	chatModelFlagBreakerThreshold     = 3
	chatModelFlagBreakerCooldown      = 60 * time.Second
	chatModelFlagLogEvery             = time.Minute
)

// The outcome of one turn's choice. Each turn records exactly one. They are a
// closed set, so they are safe as metric attributes.
const (
	flagOutcomeFlag         = "flag"
	flagOutcomeCache        = "cache"
	flagOutcomeStale        = "stale"
	flagOutcomeUnconfigured = "default_unconfigured"
	flagOutcomeTimeout      = "default_timeout"
	flagOutcomeError        = "default_error"
	flagOutcomeNotFound     = "default_not_found"
	flagOutcomeUnknownRoute = "default_unknown_route"
	flagOutcomeBreaker      = "default_breaker"
	flagOutcomePanic        = "default_panic"
)

// flagEvaluator is the part of the Flaggr client the selector uses. The SDK's
// *flaggr.Client satisfies it, and a test puts in a fake.
type flagEvaluator interface {
	Resolve(ctx context.Context, flagKey string, defaultValue interface{}, evalCtx ...flaggr.EvalContext) (*flaggr.EvaluationDetail, error)
}

// newChatModelFlagClient returns the Flaggr client, or nil when the flag is off.
// The client is made only when both the key and the service id are set. An error
// is returned, not raised: the caller logs it and runs with the flag off.
func newChatModelFlagClient(cfg *Config) (flagEvaluator, error) {
	if cfg.FlaggrAPIKey == "" || cfg.FlaggrServiceID == "" {
		return nil, nil
	}
	lookup := cfg.ChatModelFlagLookupTimeout
	if lookup <= 0 {
		lookup = defaultChatModelFlagLookupTimeout
	}
	opts := []flaggr.Option{
		flaggr.WithAPIKey(cfg.FlaggrAPIKey),
		flaggr.WithServiceID(cfg.FlaggrServiceID),
		flaggr.WithEnvironment(cfg.FlaggrEnvironment),
		// The lookup context is the real bound. This backstop sits above it, so it
		// never cuts a lookup short, and it stops a connection being held forever.
		flaggr.WithHTTPClient(&http.Client{Timeout: lookup + time.Second}),
	}
	if cfg.FlaggrAPIURL != "" {
		opts = append(opts, flaggr.WithAPIURL(cfg.FlaggrAPIURL))
	}
	client, err := flaggr.NewClient(opts...)
	if err != nil {
		return nil, err
	}
	return client, nil
}

// flagTiming holds the bounds of a flag read. A zero field takes its default.
type flagTiming struct {
	Turn     time.Duration // a turn waits at most this long for its answer
	Lookup   time.Duration // one lookup, the first turn's or a refresh, runs at most this long
	TTL      time.Duration // an answer is used as fresh for this long
	MaxStale time.Duration // an answer is served stale for at most this long past its TTL
}

// chatModelSelector chooses the model a turn runs on from the chat-model flag. It
// never fails a turn. Every path that does not yield a usable route answers on
// the env default. A flag can only choose among the routes the registry built,
// so no flag value can bypass a deploy-time guard.
type chatModelSelector struct {
	client      flagEvaluator
	defaultID   string // the env default's route id, which the flag may also name
	environment string // the service environment, sent as a constant targeting attribute
	routes      map[string]*ModelRouter
	turnWait    time.Duration
	lookup      time.Duration
	ttl         time.Duration
	maxStale    time.Duration
	now         func() time.Time

	mu       sync.Mutex
	cache    *flagRouteCache
	inflight map[string]*flagFlight // one running evaluation per user
	breaker  flagBreaker
	lastLog  map[string]time.Time
}

// newChatModelSelector builds a selector over routes. A nil client turns the
// flag off, and every choice is then the default.
func newChatModelSelector(client flagEvaluator, defaultID, environment string, routes map[string]*ModelRouter, timing flagTiming) *chatModelSelector {
	if timing.Turn <= 0 {
		timing.Turn = defaultChatModelFlagTimeout
	}
	if timing.Lookup <= 0 {
		timing.Lookup = defaultChatModelFlagLookupTimeout
	}
	if timing.TTL <= 0 {
		timing.TTL = defaultChatModelFlagTTL
	}
	if timing.MaxStale <= 0 {
		timing.MaxStale = defaultChatModelFlagMaxStale
	}
	if routes == nil {
		routes = map[string]*ModelRouter{}
	}
	return &chatModelSelector{
		client:      client,
		defaultID:   defaultID,
		environment: environment,
		routes:      routes,
		turnWait:    timing.Turn,
		lookup:      timing.Lookup,
		ttl:         timing.TTL,
		maxStale:    timing.MaxStale,
		now:         time.Now,
		cache:       newFlagRouteCache(chatModelFlagCacheSize),
		inflight:    make(map[string]*flagFlight),
		lastLog:     make(map[string]time.Time),
	}
}

// routeFor returns the flagged router for a route id, or nil for the default.
func (s *chatModelSelector) routeFor(id string) *ModelRouter {
	if id == "" {
		return nil
	}
	return s.routes[id]
}

// flagFlight is one evaluation for one user. The waiters share it, and the
// result is cached when it is cacheable.
type flagFlight struct {
	done      chan struct{}
	route     string
	outcome   string
	cacheable bool
}

// choose returns the route id the turn should run on ("" for the default) and
// how the choice was made. It never returns an error and never panics, and it
// records the outcome once.
func (s *chatModelSelector) choose(ctx context.Context, userID string) (route, outcome string) {
	if s == nil || s.client == nil {
		recordChatModelFlagOutcome(ctx, flagOutcomeUnconfigured)
		return "", flagOutcomeUnconfigured
	}
	defer func() {
		if r := recover(); r != nil {
			s.logFailure(flagOutcomePanic, fmt.Sprintf("panic in the selector (%T)", r))
			route, outcome = "", flagOutcomePanic
		}
		recordChatModelFlagOutcome(ctx, outcome)
	}()

	entry, found := s.cachedEntry(userID)
	now := s.now()
	if found && now.Before(entry.expires) {
		return entry.route, flagOutcomeCache
	}
	if found && now.Before(entry.staleUntil) {
		// Stale: answer at once, and refresh in the background. The refresh has
		// its own bounded lookup, not the request's, so the turn never waits.
		// Past maxStale an answer is no longer served, and the turn waits below.
		s.startFlight(userID, context.Background())
		return entry.route, flagOutcomeStale
	}

	// Nothing usable cached: this turn waits, bounded by the turn wait. The lookup
	// keeps running on the request's values but not its cancel, so a client that
	// hangs up still leaves the answer cached for the next turn.
	f, ok := s.startFlight(userID, context.WithoutCancel(ctx))
	if !ok {
		return "", flagOutcomeBreaker
	}
	wait, cancel := context.WithTimeout(ctx, s.turnWait)
	defer cancel()
	select {
	case <-f.done:
		return f.route, f.outcome
	case <-wait.Done():
		return "", flagOutcomeTimeout
	}
}

// cachedEntry reads the user's entry under the mutex. The unlock is deferred, so a
// panic inside the cache cannot leave the mutex held and deadlock later turns.
func (s *chatModelSelector) cachedEntry(userID string) (flagCacheEntry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cache.get(userID)
}

// startFlight joins the user's running evaluation, or starts one. It reports
// false when the breaker is open and nothing is running.
func (s *chatModelSelector) startFlight(userID string, ctx context.Context) (*flagFlight, bool) {
	now := s.now()
	s.mu.Lock()
	if f, running := s.inflight[userID]; running {
		s.mu.Unlock()
		return f, true
	}
	allowed, closed := s.breaker.allow(now)
	if !allowed {
		s.mu.Unlock()
		return nil, false
	}
	f := &flagFlight{done: make(chan struct{})}
	s.inflight[userID] = f
	s.mu.Unlock()

	if closed {
		log.Printf("chat model flag: circuit closed; Flaggr is called again")
	}
	go s.runFlight(f, userID, ctx)
	return f, true
}

// runFlight runs one evaluation to its end. It recovers a panic into the
// outcome, so a bug in the evaluator never reaches the process.
func (s *chatModelSelector) runFlight(f *flagFlight, userID string, ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			s.logFailure(flagOutcomePanic, fmt.Sprintf("panic in the evaluator (%T)", r))
			f.route, f.outcome, f.cacheable = "", flagOutcomePanic, false
		}
		s.finishFlight(userID, f)
	}()
	f.route, f.outcome, f.cacheable = s.evaluate(ctx, userID)
}

// finishFlight publishes a flight's result to its waiters. A usable answer is
// cached with its TTL and its maximum staleness. A failed lookup evicts the user's
// entry, so the next turn gets the default, not a route Flaggr can no longer vouch for.
func (s *chatModelSelector) finishFlight(userID string, f *flagFlight) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inflight[userID] == f {
		delete(s.inflight, userID)
	}
	if f.cacheable {
		now := s.now()
		s.cache.put(flagCacheEntry{user: userID, route: f.route, expires: now.Add(s.ttl), staleUntil: now.Add(s.maxStale)})
	} else {
		s.cache.remove(userID)
	}
	close(f.done)
}

// evaluate asks Flaggr for the flag and classifies the answer. It reports whether
// the answer may be cached: a usable value, or an answer from Flaggr that means
// "default" (not found, disabled, or a value this service does not run).
func (s *chatModelSelector) evaluate(ctx context.Context, userID string) (route, outcome string, cacheable bool) {
	callCtx, cancel := context.WithTimeout(ctx, s.lookup)
	defer cancel()
	evalCtx := flaggr.EvalContext{TargetingKey: userID, Attributes: s.attributes()}
	detail, err := s.client.Resolve(callCtx, chatModelFlagKey, "", evalCtx)
	if err != nil || detail == nil {
		outcome = flagOutcomeError
		if isTimeoutErr(err) {
			outcome = flagOutcomeTimeout
		}
		s.breakerFailed(outcome, errText(err))
		return "", outcome, false
	}
	if detail.ErrorCode != "" && detail.ErrorCode != flagErrNotFound {
		s.breakerFailed(flagOutcomeError, "error code "+detail.ErrorCode)
		return "", flagOutcomeError, false
	}
	s.breakerSucceeded()

	if detail.ErrorCode == flagErrNotFound || detail.Reason == flagReasonNotFound || detail.Reason == flagReasonDisabled {
		s.logFailure(flagOutcomeNotFound, "the flag is not found or disabled in this service and environment")
		return "", flagOutcomeNotFound, true
	}
	value, ok := detail.Value.(string)
	if !ok {
		s.logFailure(flagOutcomeUnknownRoute, "the flag value is not a string")
		return "", flagOutcomeUnknownRoute, true
	}
	switch {
	case value == "" || value == "default" || value == s.defaultID:
		return "", flagOutcomeFlag, true
	case s.routes[value] != nil:
		return value, flagOutcomeFlag, true
	default:
		s.logFailure(flagOutcomeUnknownRoute, fmt.Sprintf("the flag names no route this deployment runs: %q", truncateForLog(value)))
		return "", flagOutcomeUnknownRoute, true
	}
}

// The strings Flaggr returns for a flag it cannot serve. The SDK does not name
// them, so they are read from the response the way the README describes them.
const (
	flagErrNotFound    = "NOT_FOUND"
	flagReasonNotFound = "NOT_FOUND"
	flagReasonDisabled = "DISABLED"
)

// attributes are the targeting attributes every evaluation sends. They are
// constant, so one cached answer per user is correct for every turn of that user.
// Per-turn values such as the stock code or the retry flag are not sent: a rule on
// them would be decided by whichever turn filled the cache.
func (s *chatModelSelector) attributes() map[string]interface{} {
	return map[string]interface{}{"environment": s.environment}
}

// breakerFailed counts an evaluation failure, and logs the breaker opening once.
func (s *chatModelSelector) breakerFailed(kind, detail string) {
	s.mu.Lock()
	opened := s.breaker.failure(s.now())
	s.mu.Unlock()
	s.logFailure(kind, detail)
	if opened {
		log.Printf("chat model flag: circuit open after %d consecutive failures; turns use the default route for %s",
			chatModelFlagBreakerThreshold, chatModelFlagBreakerCooldown)
	}
}

// breakerSucceeded resets the failure count after Flaggr answered.
func (s *chatModelSelector) breakerSucceeded() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.breaker.success()
}

// logFailure writes one line for a failure kind, at most once a minute per kind.
func (s *chatModelSelector) logFailure(kind, detail string) {
	now := s.now()
	s.mu.Lock()
	last, seen := s.lastLog[kind]
	if seen && now.Sub(last) < chatModelFlagLogEvery {
		s.mu.Unlock()
		return
	}
	s.lastLog[kind] = now
	s.mu.Unlock()
	log.Printf("chat model flag: %s: %s", kind, detail)
}

// flightsIdle reports whether no evaluation is running. Tests wait on it.
func (s *chatModelSelector) flightsIdle() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.inflight) == 0
}

// flagBreaker stops calls to Flaggr after a run of failures. It is closed, or open
// until a cooldown ends. It is guarded by the selector's mutex.
type flagBreaker struct {
	failures  int
	openUntil time.Time // zero while closed
}

// allow reports whether Flaggr may be called at now. It also reports whether this
// call is the first after the cooldown, so the close can be logged once.
func (b *flagBreaker) allow(now time.Time) (allowed, closed bool) {
	if b.openUntil.IsZero() {
		return true, false
	}
	if now.Before(b.openUntil) {
		return false, false
	}
	b.openUntil = time.Time{}
	b.failures = 0
	return true, true
}

// failure counts one failure and reports whether it opened the breaker.
func (b *flagBreaker) failure(now time.Time) bool {
	if !b.openUntil.IsZero() {
		return false
	}
	b.failures++
	if b.failures < chatModelFlagBreakerThreshold {
		return false
	}
	b.openUntil = now.Add(chatModelFlagBreakerCooldown)
	b.failures = 0
	return true
}

// success clears the failure count.
func (b *flagBreaker) success() {
	b.failures = 0
}

// flagRouteCache holds each user's last route, bounded by least recent use.
type flagRouteCache struct {
	max   int
	order *list.List // the front is the most recently used
	items map[string]*list.Element
}

// flagCacheEntry is one user's answer. It is fresh until expires, and served stale
// until staleUntil. Past staleUntil it is not used, and the turn waits for Flaggr.
type flagCacheEntry struct {
	user       string
	route      string
	expires    time.Time
	staleUntil time.Time
}

func newFlagRouteCache(max int) *flagRouteCache {
	return &flagRouteCache{max: max, order: list.New(), items: make(map[string]*list.Element)}
}

// get returns the user's entry and marks it as used. It is guarded by the mutex.
func (c *flagRouteCache) get(user string) (flagCacheEntry, bool) {
	el, ok := c.items[user]
	if !ok {
		return flagCacheEntry{}, false
	}
	c.order.MoveToFront(el)
	return el.Value.(flagCacheEntry), true
}

// put stores an entry, evicting the least recently used when the cache is full.
func (c *flagRouteCache) put(e flagCacheEntry) {
	if el, ok := c.items[e.user]; ok {
		el.Value = e
		c.order.MoveToFront(el)
		return
	}
	c.items[e.user] = c.order.PushFront(e)
	for c.order.Len() > c.max {
		oldest := c.order.Back()
		c.order.Remove(oldest)
		delete(c.items, oldest.Value.(flagCacheEntry).user)
	}
}

// remove drops a user's entry, if it has one.
func (c *flagRouteCache) remove(user string) {
	if el, ok := c.items[user]; ok {
		c.order.Remove(el)
		delete(c.items, user)
	}
}

// recordChatModelFlagOutcome counts one turn's choice.
func recordChatModelFlagOutcome(ctx context.Context, outcome string) {
	if shortedotel.ChatModelFlagEvaluations == nil {
		return
	}
	shortedotel.ChatModelFlagEvaluations.Add(ctx, 1, otelmetric.WithAttributes(attribute.String("outcome", outcome)))
}

// isTimeoutErr reports whether err is a timeout, either a context deadline or
// the HTTP client's own timeout.
func isTimeoutErr(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var t interface{ Timeout() bool }
	return errors.As(err, &t) && t.Timeout()
}

// errText is an error's text, or "" for nil.
func errText(err error) string {
	if err == nil {
		return "no answer from Flaggr"
	}
	return err.Error()
}

// truncateForLog cuts a value named by the flag before it reaches the log.
func truncateForLog(s string) string {
	const max = 64
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}
