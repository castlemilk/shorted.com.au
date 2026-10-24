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

// Turn budget and the same-provider retry delay. The budget sits under the web
// proxy's 60s, so a turn that runs out of time fails rather than being cut off.
const (
	defaultTurnBudget = 50 * time.Second
	retryJitterBase   = 300 * time.Millisecond
	retryJitterSpread = 500 * time.Millisecond
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
}

// routeState is a route with its breaker.
type routeState struct {
	route   TurnRoute
	breaker *breaker
}

// newModelRouter wires the routes. A zero budget means defaultTurnBudget.
func newModelRouter(primary TurnRoute, fallback *TurnRoute, tools *ToolExecutor, budget time.Duration) *ModelRouter {
	if budget <= 0 {
		budget = defaultTurnBudget
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

	// Retry the same provider once when the call never reached it: a refused
	// connection, or a 429 or 5xx, billed nothing.
	if pe := providerErrorOf(err); pe.Retryable && !pe.Reached {
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
	logFallback(r.primary.route, r.fallback.route, err)
	resp, _, err = r.attempt(ctx, turnCtx, r.fallback, endUser, in, onChunk, false)
	if err != nil {
		return nil, err
	}
	return annotate(resp, r.fallback.route), nil
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
	allowed := rs.breaker.allow()
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
		rs.breaker.success()
	case ctx.Err() != nil || turnCtx.Err() != nil:
		// A cancel or an exhausted budget is not evidence about the provider.
		rs.breaker.release()
	case providerErrorOf(err) != nil && !emitted:
		if rs.breaker.failure() {
			logBreakerOpen(rs.route)
		}
	default:
		rs.breaker.release()
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
}

func newBreaker(now func() time.Time) *breaker {
	return &breaker{now: now}
}

// allow reports whether a call may go to the route now. After the cooldown one
// call at a time is let through as the half-open probe. A call that was allowed
// must end in success, failure or release, or a held probe is never handed back.
func (b *breaker) allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.openUntil.IsZero() {
		return true
	}
	if b.now().Before(b.openUntil) || b.probing {
		return false
	}
	b.probing = true
	return true
}

// success closes the breaker.
func (b *breaker) success() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.failures = 0
	b.openUntil = time.Time{}
	b.probing = false
}

// failure counts a failure before any text. It reports whether the breaker opened.
func (b *breaker) failure() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.failures++
	if b.probing || b.failures >= breakerThreshold {
		b.openUntil = b.now().Add(breakerCooldown)
		b.probing = false
		b.failures = 0
		return true
	}
	return false
}

// release ends a call that said nothing about the route, such as a cancel. A
// held probe is handed back.
func (b *breaker) release() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.probing = false
}

// newRouteFor builds the route for one provider and model from the config. It
// fails with errMissingKey when the provider's key is not set.
func newRouteFor(ctx context.Context, cfg *Config, provider, model, label string, maxOutput int32) (TurnRoute, error) {
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
		p, err = newGeminiProvider(ctx, key)
	case kindOpenAICompat:
		p, err = newOpenAICompatProvider(spec, spec.BaseURL, key, nil)
	default:
		err = fmt.Errorf("provider %q has an unknown kind %q", provider, spec.Kind)
	}
	if err != nil {
		return TurnRoute{}, err
	}
	withFirstByteTimeout(p, cfg.ChatFirstByteTimeout)

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
		fb, err := newRouteFor(ctx, cfg, cfg.ChatFallbackProvider, cfg.ChatFallbackModel, routeFallback, cfg.ChatMaxOutputTokens)
		switch {
		case err == nil:
			fallback = &fb
		case errors.Is(err, errMissingKey) && cfg.ChatFallbackImplicit:
			log.Printf("WARNING: chat has no fallback: GEMINI_API_KEY is not set")
		default:
			return nil, err
		}
	}
	return newModelRouter(primary, fallback, tools, cfg.ChatTurnTimeout), nil
}
