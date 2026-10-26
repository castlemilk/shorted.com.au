package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"sync"
	"time"
)

// TurnInput is what one turn sends to the model: the system prompt, the stored
// history and the user's message.
type TurnInput struct {
	System   string
	History  []Message
	UserText string
}

// turnRunner is what the chat handler needs from the model. ModelRouter is the
// production implementation.
type turnRunner interface {
	RunTurn(ctx context.Context, userID string, in TurnInput, onChunk func(text string)) (*LLMResponse, error)
	// Ready reports whether a primary model is configured.
	Ready() bool
	// Model names the primary model, for the usage ledger.
	Model() string
}

// Route labels, as they appear in LLMResponse.Route and the logs.
const (
	routeEnvDefault = "env_default"
	routeFallback   = "fallback"
)

// Breaker settings: five consecutive failures before any text open a route for
// a minute.
const (
	breakerThreshold = 5
	breakerCooldown  = 60 * time.Second
)

// The turn budget and the per-call first-byte bound depend on the mode, which the
// router decides. The web proxy's limit is 60s, so each budget leaves a margin.
//
//   - With a fallback, the first-byte bound is tight (15s) because its job is to
//     trigger the fallback. The turn is 50s: the primary's bound, the retry jitter
//     and the fallback's own call must all fit, so a turn that runs out fails
//     rather than being cut off by the proxy.
//   - Alone, nothing else can answer. A late answer is worth more than an error,
//     so the first-byte bound is 30s and the turn is 55s.
//
// The idle bound between chunks is the same in both modes (defaultIdleTimeout).
const (
	turnBudgetWithFallback = 50 * time.Second
	turnBudgetAlone        = 55 * time.Second
	firstByteWithFallback  = 15 * time.Second
	firstByteAlone         = 30 * time.Second
	retryJitterBase        = 300 * time.Millisecond
	retryJitterSpread      = 500 * time.Millisecond
)

// errBreakerOpen is the error a route reports when its breaker is open.
var errBreakerOpen = errors.New("the route's circuit breaker is open")

// TurnRoute is one model a turn may run on.
type TurnRoute struct {
	Label    string // routeEnvDefault or routeFallback
	Provider ChatProvider
	Ref      ModelRef
	Spec     ModelSpec
}

// ModelRef names a model the way the config does.
type ModelRef struct {
	Provider        string
	Model           string
	MaxOutputTokens int32
	Params          ModelParams
}

// ModelRouter sends each turn to the primary model and falls back when the
// primary fails before any text reached the person. Each route has a circuit
// breaker. The router holds no per-user state, so every instance decides alone.
type ModelRouter struct {
	primary  *routeState
	fallback *routeState // nil when there is no fallback
	engine   *TurnEngine
	budget   time.Duration
	// retryDelay is the jitter before the same-provider retry. Tests replace it.
	retryDelay func() time.Duration
	now        func() time.Time
	// breakerNote limits the line a turn writes when the primary's open breaker
	// sends it to the fallback.
	breakerNote rateGate
}

// routeState is a route with its breaker.
type routeState struct {
	route   TurnRoute
	breaker *breaker
}

// newModelRouter wires the routes. A zero budget means the with-fallback budget.
func newModelRouter(primary TurnRoute, fallback *TurnRoute, tools *ToolExecutor, budget time.Duration) *ModelRouter {
	if budget <= 0 {
		budget = turnBudgetWithFallback
	}
	r := &ModelRouter{
		engine:     &TurnEngine{tools: tools},
		budget:     budget,
		retryDelay: defaultRetryDelay,
		now:        time.Now,
	}
	// The breakers read the router's clock at each use, so a test that replaces
	// r.now moves them too.
	clock := func() time.Time { return r.now() }
	r.primary = &routeState{route: primary, breaker: newBreaker(clock)}
	if fallback != nil {
		r.fallback = &routeState{route: *fallback, breaker: newBreaker(clock)}
	}
	return r
}

// defaultRetryDelay is the 300-800ms jitter before a same-provider retry.
func defaultRetryDelay() time.Duration {
	return retryJitterBase + time.Duration(rand.Int63n(int64(retryJitterSpread)))
}

// Ready reports whether a primary route exists. A nil router is not ready.
func (r *ModelRouter) Ready() bool { return r != nil && r.primary != nil }

// Model names the primary model.
func (r *ModelRouter) Model() string {
	if !r.Ready() {
		return ""
	}
	return r.primary.route.Ref.Model
}

// RouterBounds is what the router resolved at startup: the primary's first-byte
// and idle bounds, the turn cap, and whether a fallback is set.
type RouterBounds struct {
	FirstByte   time.Duration
	Idle        time.Duration
	Turn        time.Duration
	HasFallback bool
}

// Bounds reports the bounds the router will enforce. They are read from the
// providers, so a log line shows what runs, not what the config asked for.
func (r *ModelRouter) Bounds() RouterBounds {
	b := RouterBounds{Turn: r.budget, HasFallback: r.fallback != nil}
	if t, ok := streamTimeoutsOf(r.primary.route.Provider); ok {
		b.FirstByte, b.Idle = t.FirstByte, t.Idle
	}
	return b
}

// streamTimeoutsOf returns a provider's bounds, when it has any.
func streamTimeoutsOf(p ChatProvider) (streamTimeouts, bool) {
	switch v := p.(type) {
	case *geminiProvider:
		return v.timeouts, true
	case *openAICompatProvider:
		return v.timeouts, true
	}
	return streamTimeouts{}, false
}

// Close closes every provider the router holds.
func (r *ModelRouter) Close() {
	if r == nil {
		return
	}
	for _, rs := range []*routeState{r.primary, r.fallback} {
		if rs != nil {
			_ = rs.route.Provider.Close()
		}
	}
}

// RunTurn plays one turn on the primary route, and on the fallback route when
// the rules allow it. Its text reaches onChunk only from the route that answers.
func (r *ModelRouter) RunTurn(ctx context.Context, userID string, in TurnInput, onChunk func(text string)) (*LLMResponse, error) {
	turnCtx, cancel := context.WithTimeout(ctx, r.budget)
	defer cancel()
	endUser := endUserID(userID)

	hasFallback := r.fallback != nil
	resp, emitted, err := r.attempt(ctx, turnCtx, r.primary, endUser, in, onChunk, hasFallback)
	if err == nil {
		return annotate(resp, r.primary.route), nil
	}
	if !r.fallbackAllowed(ctx, turnCtx, err, emitted) {
		return nil, err
	}

	// Retry the same provider once only when nothing in the turn reached the
	// model: a refused connection, or a 429 or 5xx before the first byte, billed
	// nothing. A timeout is not retryable, so it goes straight to the fallback.
	if pe := providerErrorOf(err); pe.Retryable && !pe.Reached && !modelAnswered(err) {
		if !sleepCtx(turnCtx, r.retryDelay()) {
			return nil, err
		}
		resp, emitted, err = r.attempt(ctx, turnCtx, r.primary, endUser, in, onChunk, hasFallback)
		if err == nil {
			return annotate(resp, r.primary.route), nil
		}
		if !r.fallbackAllowed(ctx, turnCtx, err, emitted) {
			return nil, err
		}
	}

	if r.fallback == nil {
		return nil, err
	}
	// The error about to be superseded may have billed calls. They are charged to
	// the answer that follows, or to the fallback's error, so they are kept once.
	spent := billedBy(err)
	r.noteFallback(r.primary.route, r.fallback.route, err)
	resp, _, err = r.attempt(ctx, turnCtx, r.fallback, endUser, in, onChunk, false)
	if err != nil {
		return nil, withBilled(err, spent)
	}
	return annotate(settle(resp, spent), r.fallback.route), nil
}

// settle adds the spend of failed attempts to the answer that followed them.
func settle(resp *LLMResponse, spent turnTally) *LLMResponse {
	resp.Usage.Add(spent.usage)
	resp.EstCostMicroUSD += spent.cost
	return resp
}

// fallbackAllowed says whether a failed attempt may be retried elsewhere. All
// three must hold: the caller and the turn budget are still live, no text has
// reached the person, and the error is a provider failure.
func (r *ModelRouter) fallbackAllowed(ctx, turnCtx context.Context, err error, emitted bool) bool {
	if ctx.Err() != nil || turnCtx.Err() != nil || emitted {
		return false
	}
	return providerErrorOf(err) != nil
}

// attempt runs the turn on one route, and records the outcome in its breaker.
// It reports whether any text reached onChunk. When the breaker is open and a
// fallback exists, the route is not called at all. With no fallback an open
// breaker is ignored, so a single-provider deployment keeps working.
func (r *ModelRouter) attempt(ctx, turnCtx context.Context, rs *routeState, endUser string, in TurnInput, onChunk func(string), hasFallback bool) (*LLMResponse, bool, error) {
	allowed, gen := rs.breaker.allow()
	if !allowed && hasFallback {
		return nil, false, &ProviderError{Provider: rs.route.Provider.Name(), Err: errBreakerOpen}
	}
	track := allowed // an open breaker, when forced, is not tracked

	emitted := false
	emit := func(text string) {
		emitted = true
		onChunk(text)
	}
	spec := turnSpec{
		provider: rs.route.Provider,
		cfg: SessionConfig{
			Model:           rs.route.Ref.Model,
			System:          in.System,
			History:         in.History,
			Tools:           chatToolDefinitions(),
			MaxOutputTokens: rs.route.Ref.MaxOutputTokens,
			Params:          rs.route.Ref.Params,
			EndUser:         endUser,
		},
		userText:        in.UserText,
		forcedFirstCall: rs.route.Spec.Caps.ForcedToolChoice,
		meta: turnMeta{
			Provider: rs.route.Provider.Name(),
			Model:    rs.route.Ref.Model,
			Pricing:  rs.route.Spec.Price,
			Start:    r.now(),
		},
	}
	resp, err := r.engine.run(turnCtx, spec, emit)

	if !track {
		return resp, emitted, err
	}
	switch {
	case err == nil:
		rs.breaker.success(gen)
	case ctx.Err() != nil || turnCtx.Err() != nil:
		// A cancel or an exhausted budget is not evidence about the provider.
		rs.breaker.release(gen)
	case providerErrorOf(err) != nil && !emitted:
		if rs.breaker.failure(gen) {
			logBreakerOpen(rs.route)
		}
	default:
		rs.breaker.release(gen)
	}
	return resp, emitted, err
}

// annotate records which route answered.
func annotate(resp *LLMResponse, route TurnRoute) *LLMResponse {
	resp.Provider = route.Provider.Name()
	resp.Model = route.Ref.Model
	resp.Route = route.Label
	return resp
}

// providerErrorOf returns the ProviderError in err's chain, or nil.
func providerErrorOf(err error) *ProviderError {
	var pe *ProviderError
	if errors.As(err, &pe) {
		return pe
	}
	return nil
}

// sleepCtx waits for d, or returns false when ctx ends first.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}

// logFallback writes the ERROR line that every fallback leaves. An operator alerts
// on its rate, because a 400 from a bad request would otherwise hide here.
func logFallback(from, to TurnRoute, err error) {
	event := map[string]any{
		"type":          "chat_provider_fallback",
		"severity":      "ERROR",
		"feature":       "chat",
		"from_provider": from.Provider.Name(),
		"from_model":    from.Ref.Model,
		"to_provider":   to.Provider.Name(),
		"to_model":      to.Ref.Model,
		"error":         err.Error(),
	}
	if pe := providerErrorOf(err); pe != nil {
		event["status"] = pe.Status
		event["retryable"] = pe.Retryable
		event["reached"] = pe.Reached
	}
	log.Printf("ERROR %s", mustMarshalLogEvent(event))
}

// breakerNoteEvery is how often a turn sent on by an open breaker is noted.
const breakerNoteEvery = time.Minute

// rateGate lets one event through per interval. It is safe for concurrent use.
type rateGate struct {
	mu   sync.Mutex
	open bool
	last time.Time
}

// allow reports whether an event at now may be logged.
func (g *rateGate) allow(now time.Time, every time.Duration) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.open && now.Sub(g.last) < every {
		return false
	}
	g.open, g.last = true, now
	return true
}

// noteFallback writes the line for a turn sent to the fallback. A real failure of the
// primary writes the ERROR that operators alert on. A turn the open breaker sent on
// is not a new failure: the breaker's own line already says the route is down, so
// it writes a WARNING at most once a minute, and no ERROR.
func (r *ModelRouter) noteFallback(from, to TurnRoute, err error) {
	if errors.Is(err, errBreakerOpen) {
		if r.breakerNote.allow(r.now(), breakerNoteEvery) {
			log.Printf("WARNING chat turn sent to fallback %s/%s: %s/%s's circuit breaker is open",
				to.Provider.Name(), to.Ref.Model, from.Provider.Name(), from.Ref.Model)
		}
		return
	}
	logFallback(from, to, err)
}

// logBreakerOpen writes the line that a route's breaker opened.
func logBreakerOpen(route TurnRoute) {
	log.Printf("%s", mustMarshalLogEvent(map[string]any{
		"type":         "cost_event",
		"event_type":   "chat_breaker_open",
		"feature":      "chat",
		"provider":     route.Provider.Name(),
		"model":        route.Ref.Model,
		"cooldown_sec": int(breakerCooldown / time.Second),
	}))
}

// breaker is one route's circuit breaker. It is closed, open for a cooldown, or
// half-open: after the cooldown one probe call may go through at a time.
type breaker struct {
	now func() time.Time

	mu        sync.Mutex
	failures  int
	openUntil time.Time // zero while closed
	probing   bool      // a half-open probe is in flight
	// gen counts the breaker's state changes: each time it opens, and each time a
	// probe is let through. A call remembers the generation it was admitted in,
	// and a result from an earlier generation says nothing about the present, so
	// it is ignored. Without this a call that started before the probe could
	// re-open the breaker while the probe was still running.
	gen uint64
}

func newBreaker(now func() time.Time) *breaker {
	return &breaker{now: now}
}

// allow reports whether a call may go to the route now, and the generation the
// call belongs to. After the cooldown one call at a time is let through as the
// half-open probe, which starts a new generation. A call that was allowed must
// end in success, failure or release, or a held probe is never handed back.
func (b *breaker) allow() (bool, uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.openUntil.IsZero() {
		return true, b.gen
	}
	if b.now().Before(b.openUntil) || b.probing {
		return false, b.gen
	}
	b.probing = true
	b.gen++
	return true, b.gen
}

// success closes the breaker, unless the call belongs to an earlier generation.
func (b *breaker) success(gen uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if gen != b.gen {
		return
	}
	b.failures = 0
	b.openUntil = time.Time{}
	b.probing = false
}

// failure counts a failure before any text from a call of the current generation.
// It reports whether the breaker opened. A failure from an earlier generation is
// ignored.
func (b *breaker) failure(gen uint64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if gen != b.gen {
		return false
	}
	b.failures++
	if b.probing || b.failures >= breakerThreshold {
		b.openUntil = b.now().Add(breakerCooldown)
		b.probing = false
		b.failures = 0
		b.gen++
		return true
	}
	return false
}

// release ends a call that said nothing about the route, such as a cancel. A
// held probe is handed back, but only by the call that holds it.
func (b *breaker) release(gen uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if gen != b.gen {
		return
	}
	b.probing = false
}

// newRouteFor builds the route for one provider and model from the config. It
// fails with errMissingKey when the provider's key is not set.
func newRouteFor(ctx context.Context, cfg *Config, provider, model, label string, maxOutput int32) (TurnRoute, error) {
	return newRouteForAt(ctx, cfg, provider, model, label, maxOutput, "")
}

// newRouteForAt is newRouteFor with the provider's base URL overridden. Tests use
// it to point a real provider at a fake endpoint; an empty baseURL is production.
func newRouteForAt(ctx context.Context, cfg *Config, provider, model, label string, maxOutput int32, baseURL string) (TurnRoute, error) {
	spec, ok := lookupProvider(provider)
	if !ok {
		return TurnRoute{}, fmt.Errorf("unknown chat provider %q", provider)
	}
	key := cfg.ProviderKeys[provider]
	if key == "" {
		return TurnRoute{}, fmt.Errorf("%s: %w (%s)", provider, errMissingKey, spec.KeyEnv)
	}
	if model == "" {
		model = spec.DefaultModel
	}
	modelSpec, known := modelOrUnverified(provider, model)
	if !known {
		log.Printf("WARNING: chat model %s/%s is not in the catalog: it gets the verify policy and no price", provider, model)
	}

	var p ChatProvider
	var err error
	switch spec.Kind {
	case kindGemini:
		p, err = newGeminiProviderAt(ctx, key, baseURL)
	case kindOpenAICompat:
		base := spec.BaseURL
		if baseURL != "" {
			base = baseURL
		}
		p, err = newOpenAICompatProvider(spec, base, key, nil)
	default:
		err = fmt.Errorf("provider %q has an unknown kind %q", provider, spec.Kind)
	}
	if err != nil {
		return TurnRoute{}, err
	}

	ref := ModelRef{Provider: provider, Model: model, MaxOutputTokens: maxOutput}
	if provider == "openrouter" {
		ref.Params.OpenRouterOnly = append([]string(nil), modelSpec.DefaultOnly...)
	}
	return TurnRoute{Label: label, Provider: p, Ref: ref, Spec: modelSpec}, nil
}

// errMissingKey is wrapped when a provider's key variable is empty.
var errMissingKey = errors.New("no API key is set")

// withFirstByteTimeout applies the configured first-byte bound to a provider.
func withFirstByteTimeout(p ChatProvider, d time.Duration) {
	if d <= 0 {
		return
	}
	switch v := p.(type) {
	case *geminiProvider:
		v.timeouts.FirstByte = d
	case *openAICompatProvider:
		v.timeouts.FirstByte = d
	}
}

// NewModelRouter builds the router from the config. It returns (nil, nil) when
// the primary is Gemini and no Gemini key is set, which is the state chat has
// always been in without one. Any other missing key is an error.
//
// The bounds follow the mode: with a fallback the first byte is 15s and the turn
// 50s, and alone they are 30s and 55s. An env value overrides either mode.
func NewModelRouter(ctx context.Context, cfg *Config, tools *ToolExecutor) (*ModelRouter, error) {
	primary, err := newRouteFor(ctx, cfg, cfg.ChatProvider, cfg.ChatModel, routeEnvDefault, cfg.ChatMaxOutputTokens)
	if err != nil {
		if errors.Is(err, errMissingKey) && cfg.ChatProvider == "gemini" {
			return nil, nil
		}
		return nil, err
	}

	var fallback *TurnRoute
	if cfg.ChatFallbackProvider != "" {
		// The Gemini fallback keeps Gemini's own output limit, not the primary's.
		fallbackMax := cfg.ChatMaxOutputTokens
		if cfg.ChatFallbackProvider == "gemini" {
			fallbackMax = cfg.GeminiMaxOutputTokens
		}
		fb, err := newRouteFor(ctx, cfg, cfg.ChatFallbackProvider, cfg.ChatFallbackModel, routeFallback, fallbackMax)
		switch {
		case err == nil:
			fallback = &fb
		case errors.Is(err, errMissingKey) && cfg.ChatFallbackImplicit:
			log.Printf("WARNING: chat has no fallback: GEMINI_API_KEY is not set")
		default:
			return nil, err
		}
	}

	firstByte, budget := firstByteAlone, turnBudgetAlone
	if fallback != nil {
		firstByte, budget = firstByteWithFallback, turnBudgetWithFallback
	}
	if cfg.ChatFirstByteTimeout > 0 {
		firstByte = cfg.ChatFirstByteTimeout
	}
	if cfg.ChatTurnTimeout > 0 {
		budget = cfg.ChatTurnTimeout
	}
	withFirstByteTimeout(primary.Provider, firstByte)
	if fallback != nil {
		withFirstByteTimeout(fallback.Provider, firstByte)
	}
	return newModelRouter(primary, fallback, tools, budget), nil
}
