package main

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// routeProvider is a provider whose n-th session follows plans(n). It counts the
// sessions it opened, so a test can tell whether a route was called at all.
type routeProvider struct {
	name  string
	plans func(session int) []fakeReply

	mu      sync.Mutex
	started int
}

func (p *routeProvider) Name() string { return p.name }

func (p *routeProvider) NewSession(SessionConfig) (ModelSession, error) {
	p.mu.Lock()
	p.started++
	n := p.started
	p.mu.Unlock()
	return &fakeSession{replies: p.plans(n)}, nil
}

func (p *routeProvider) Close() error { return nil }

func (p *routeProvider) sessions() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.started
}

// always gives every session the same plan.
func always(plan []fakeReply) func(int) []fakeReply {
	return func(int) []fakeReply { return plan }
}

// okPlan is a turn that calls one tool and then answers "ok".
func okPlan() []fakeReply {
	return []fakeReply{{calls: []ToolCall{searchCall("c1", "BHP")}}, {texts: []string{"ok"}}}
}

// failedCall builds a ProviderError the way an adapter does.
func failedCall(reached, retryable bool, status int) *ProviderError {
	return &ProviderError{Provider: "test", Reached: reached, Retryable: retryable, Status: status, Err: errors.New("provider failed")}
}

// testRoute is a forced route with no price.
func testRoute(label string, p ChatProvider) TurnRoute {
	return TurnRoute{
		Label:    label,
		Provider: p,
		Ref:      ModelRef{Provider: p.Name(), Model: "m-" + p.Name()},
		Spec:     ModelSpec{ID: "m-" + p.Name(), Caps: ModelCapabilities{ForcedToolChoice: true}},
	}
}

// fakeTime is a clock the breaker reads.
type fakeTime struct{ t time.Time }

func (c *fakeTime) now() time.Time { return c.t }

func (c *fakeTime) advance(d time.Duration) { c.t = c.t.Add(d) }

// routerFor builds a router with no retry jitter and a fake clock.
func routerFor(primary ChatProvider, fallback ChatProvider, budget time.Duration) (*ModelRouter, *fakeTime) {
	clock := &fakeTime{t: time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)}
	var fb *TurnRoute
	if fallback != nil {
		route := testRoute(routeFallback, fallback)
		fb = &route
	}
	r := newModelRouter(testRoute(routeEnvDefault, primary), fb, newTestToolExecutor(httpHandlerCounting(new(atomic.Int32))), budget)
	r.now = clock.now
	r.retryDelay = func() time.Duration { return 0 }
	return r, clock
}

// runTurn plays one turn and returns the response, the text the person saw, and the error.
func runTurn(r *ModelRouter) (*LLMResponse, string, error) {
	var got []string
	resp, err := r.RunTurn(context.Background(), "uid-1", TurnInput{System: "s", UserText: "q"}, func(s string) { got = append(got, s) })
	return resp, strings.Join(got, ""), err
}

func TestRouterFallsBackBeforeAnyTextWhenTheCallIsRefused(t *testing.T) {
	primary := &routeProvider{name: "primary", plans: always([]fakeReply{{err: failedCall(false, false, 400)}})}
	fallback := &routeProvider{name: "fallback", plans: always(okPlan())}
	r, _ := routerFor(primary, fallback, 0)

	resp, text, err := runTurn(r)
	if err != nil {
		t.Fatalf("RunTurn() error = %v, want the fallback's answer", err)
	}
	if resp.Route != routeFallback || resp.Provider != "fallback" {
		t.Fatalf("answered by route %q provider %q, want fallback", resp.Route, resp.Provider)
	}
	if text != "ok" {
		t.Fatalf("text = %q, want the fallback's answer", text)
	}
	if primary.sessions() != 1 {
		t.Fatalf("primary sessions = %d, want 1: a 400 is not retried", primary.sessions())
	}
}

func TestRouterRetriesTheSameProviderOnceWhenTheCallNeverReachedIt(t *testing.T) {
	primary := &routeProvider{name: "primary", plans: func(n int) []fakeReply {
		if n == 1 {
			return []fakeReply{{err: failedCall(false, true, 429)}}
		}
		return okPlan()
	}}
	fallback := &routeProvider{name: "fallback", plans: always(okPlan())}
	r, _ := routerFor(primary, fallback, 0)

	resp, _, err := runTurn(r)
	if err != nil {
		t.Fatalf("RunTurn() error = %v", err)
	}
	if resp.Route != routeEnvDefault {
		t.Fatalf("route = %q, want the primary after its retry succeeded", resp.Route)
	}
	if primary.sessions() != 2 || fallback.sessions() != 0 {
		t.Fatalf("primary sessions = %d, fallback = %d; want 2 and 0", primary.sessions(), fallback.sessions())
	}
}

func TestRouterDoesNotRetryTheSameProviderOnceTheCallWasBilled(t *testing.T) {
	// A retryable failure after the model answered is billed, so the same
	// provider is not called again; the fallback answers instead.
	primary := &routeProvider{name: "primary", plans: always([]fakeReply{
		{calls: []ToolCall{searchCall("c1", "BHP")}},
		{err: failedCall(true, true, 503)},
	})}
	fallback := &routeProvider{name: "fallback", plans: always(okPlan())}
	r, _ := routerFor(primary, fallback, 0)

	resp, _, err := runTurn(r)
	if err != nil {
		t.Fatalf("RunTurn() error = %v", err)
	}
	if resp.Route != routeFallback {
		t.Fatalf("route = %q, want the fallback", resp.Route)
	}
	if primary.sessions() != 1 {
		t.Fatalf("primary sessions = %d, want 1: a billed failure is not retried on the same provider", primary.sessions())
	}
}

func TestRouterNeverFallsBackAfterTextReachedThePerson(t *testing.T) {
	primary := &routeProvider{name: "primary", plans: always([]fakeReply{
		{calls: []ToolCall{searchCall("c1", "BHP")}},
		{texts: []string{"partial "}, err: failedCall(true, false, 0)},
	})}
	fallback := &routeProvider{name: "fallback", plans: always(okPlan())}
	r, _ := routerFor(primary, fallback, 0)

	_, text, err := runTurn(r)
	if err == nil {
		t.Fatal("RunTurn() error = nil, want the primary's failure after text")
	}
	if text != "partial " {
		t.Fatalf("text = %q, want only what arrived before the failure", text)
	}
	if fallback.sessions() != 0 {
		t.Fatalf("fallback sessions = %d: a fallback after text would splice two answers", fallback.sessions())
	}
}

// cancelProvider cancels the caller's context inside its first call, then fails.
type cancelProvider struct {
	cancel context.CancelFunc
}

func (p *cancelProvider) Name() string { return "primary" }

func (p *cancelProvider) NewSession(SessionConfig) (ModelSession, error) {
	return &cancelSession{cancel: p.cancel}, nil
}

func (p *cancelProvider) Close() error { return nil }

type cancelSession struct{ cancel context.CancelFunc }

func (s *cancelSession) Send(context.Context, SendInput, ToolChoice, func(ModelEvent)) (ModelReply, error) {
	s.cancel()
	return ModelReply{}, failedCall(false, false, 0)
}

func TestRouterNeverFallsBackOnAClientCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fallback := &routeProvider{name: "fallback", plans: always(okPlan())}
	r, _ := routerFor(&cancelProvider{cancel: cancel}, fallback, 0)

	_, err := r.RunTurn(ctx, "uid-1", TurnInput{System: "s", UserText: "q"}, func(string) {})
	if err == nil {
		t.Fatal("RunTurn() error = nil after the caller cancelled")
	}
	if fallback.sessions() != 0 {
		t.Fatal("a client cancel fell back to another provider")
	}
}

// blockingProvider holds its call until the turn's context ends.
type blockingProvider struct{}

func (blockingProvider) Name() string { return "primary" }

func (blockingProvider) NewSession(SessionConfig) (ModelSession, error) {
	return blockingSession{}, nil
}

func (blockingProvider) Close() error { return nil }

type blockingSession struct{}

func (blockingSession) Send(ctx context.Context, _ SendInput, _ ToolChoice, _ func(ModelEvent)) (ModelReply, error) {
	<-ctx.Done()
	return ModelReply{}, failedCall(false, false, 0)
}

func TestRouterAnExhaustedTurnBudgetDoesNotFallBack(t *testing.T) {
	fallback := &routeProvider{name: "fallback", plans: always(okPlan())}
	r, _ := routerFor(blockingProvider{}, fallback, 40*time.Millisecond)

	_, _, err := runTurn(r)
	if err == nil {
		t.Fatal("RunTurn() error = nil after the budget ran out")
	}
	if fallback.sessions() != 0 {
		t.Fatal("a turn out of budget fell back, with no time left to answer")
	}
}

func TestRouterBreakerOpensAfterFiveFailuresThenHalfOpens(t *testing.T) {
	healthy := false
	primary := &routeProvider{name: "primary", plans: func(int) []fakeReply {
		if healthy {
			return okPlan()
		}
		return []fakeReply{{err: failedCall(false, false, 500)}}
	}}
	fallback := &routeProvider{name: "fallback", plans: always(okPlan())}
	r, clock := routerFor(primary, fallback, 0)

	for i := range breakerThreshold {
		resp, _, err := runTurn(r)
		if err != nil || resp.Route != routeFallback {
			t.Fatalf("turn %d: route %v, error %v, want the fallback", i+1, resp, err)
		}
	}
	if primary.sessions() != breakerThreshold {
		t.Fatalf("primary sessions = %d after %d failures", primary.sessions(), breakerThreshold)
	}

	// Open: the primary is not called at all.
	if _, _, err := runTurn(r); err != nil {
		t.Fatalf("turn with the breaker open: %v", err)
	}
	if primary.sessions() != breakerThreshold {
		t.Fatalf("primary was called with its breaker open: sessions = %d", primary.sessions())
	}

	// Cooldown passes and the primary has recovered: one probe goes through and closes it.
	clock.advance(breakerCooldown + time.Second)
	healthy = true
	resp, _, err := runTurn(r)
	if err != nil || resp.Route != routeEnvDefault {
		t.Fatalf("half-open probe: route %v, error %v, want the primary", resp, err)
	}
	if primary.sessions() != breakerThreshold+1 {
		t.Fatalf("primary sessions = %d after the probe, want one more", primary.sessions())
	}
	if _, _, err := runTurn(r); err != nil {
		t.Fatalf("turn after the breaker closed: %v", err)
	}
	if primary.sessions() != breakerThreshold+2 {
		t.Fatalf("a closed breaker must let the primary through: sessions = %d", primary.sessions())
	}
}

func TestRouterFailedProbeReopensTheBreaker(t *testing.T) {
	primary := &routeProvider{name: "primary", plans: always([]fakeReply{{err: failedCall(false, false, 500)}})}
	fallback := &routeProvider{name: "fallback", plans: always(okPlan())}
	r, clock := routerFor(primary, fallback, 0)

	for range breakerThreshold {
		_, _, _ = runTurn(r)
	}
	clock.advance(breakerCooldown + time.Second)
	_, _, _ = runTurn(r) // the probe, which fails
	before := primary.sessions()

	if _, _, err := runTurn(r); err != nil {
		t.Fatalf("turn after a failed probe: %v", err)
	}
	if primary.sessions() != before {
		t.Fatal("a failed probe must reopen the breaker, and the next turn must not call the primary")
	}
}

func TestRouterOpenBreakerWithoutFallbackStillTriesThePrimary(t *testing.T) {
	// A single-provider deployment has nothing to fall back to, so an open breaker
	// does not stop calls: today's behaviour is kept.
	primary := &routeProvider{name: "primary", plans: always([]fakeReply{{err: failedCall(false, false, 500)}})}
	r, _ := routerFor(primary, nil, 0)

	for range breakerThreshold {
		_, _, _ = runTurn(r)
	}
	before := primary.sessions()
	_, _, _ = runTurn(r)
	if primary.sessions() != before+1 {
		t.Fatalf("primary sessions = %d, want %d: with no fallback the open breaker is ignored", primary.sessions(), before+1)
	}
}

func TestRouterTracksTheCallOnlyWhenTheBreakerAllowsIt(t *testing.T) {
	clock := &fakeTime{t: time.Unix(0, 0)}
	b := newBreaker(clock.now)
	for range breakerThreshold {
		if !b.allow() {
			t.Fatal("a closed breaker refused a call")
		}
		b.failure()
	}
	if b.allow() {
		t.Fatal("an open breaker let a call through before the cooldown")
	}
	clock.advance(breakerCooldown)
	if !b.allow() {
		t.Fatal("the cooldown elapsed but the half-open probe was refused")
	}
	if b.allow() {
		t.Fatal("a second call got through while the probe was in flight")
	}
	b.release()
	if !b.allow() {
		t.Fatal("releasing the probe did not hand it back")
	}
}

func TestNewModelRouterWithoutAGeminiKeyIsNotConfigured(t *testing.T) {
	cfg := &Config{ChatProvider: "gemini", ChatModel: "gemini-2.5-flash", ChatMaxOutputTokens: 1024, ProviderKeys: map[string]string{}}
	router, err := NewModelRouter(context.Background(), cfg, nil)
	if err != nil || router != nil {
		t.Fatalf("NewModelRouter() = %v, %v; want no router and no error, as before the router existed", router, err)
	}
}

func TestNewModelRouterNeedsTheKeyOfANonGeminiPrimary(t *testing.T) {
	cfg := &Config{ChatProvider: "deepseek", ChatModel: "deepseek-flash", ProviderKeys: map[string]string{}}
	if _, err := NewModelRouter(context.Background(), cfg, nil); err == nil || !errors.Is(err, errMissingKey) {
		t.Fatalf("NewModelRouter() error = %v, want a missing-key error", err)
	}
}

func TestNewModelRouterDefaultsToGeminiWithNoFallback(t *testing.T) {
	cfg := &Config{ChatProvider: "gemini", ChatModel: "gemini-2.5-flash", ChatMaxOutputTokens: 1024,
		ProviderKeys: map[string]string{"gemini": "gemini-test-key"}}
	router, err := NewModelRouter(context.Background(), cfg, nil)
	if err != nil || router == nil {
		t.Fatalf("NewModelRouter() = %v, %v; want a router", router, err)
	}
	if router.Model() != "gemini-2.5-flash" || router.fallback != nil {
		t.Fatalf("model = %q, fallback = %v; want gemini-2.5-flash with no fallback", router.Model(), router.fallback)
	}
	if router.primary.route.Label != routeEnvDefault {
		t.Fatalf("label = %q, want env_default", router.primary.route.Label)
	}
}

func TestNewModelRouterFallsBackToGeminiWhenThePrimaryIsNotGemini(t *testing.T) {
	cfg := &Config{
		ChatProvider: "deepseek", ChatModel: "deepseek-flash", ChatMaxOutputTokens: 1024,
		ChatFallbackProvider: "gemini", ChatFallbackModel: "gemini-2.5-flash", ChatFallbackImplicit: true,
		ProviderKeys: map[string]string{"deepseek": "ds-test-key", "gemini": "gemini-test-key"},
	}
	router, err := NewModelRouter(context.Background(), cfg, nil)
	if err != nil || router == nil {
		t.Fatalf("NewModelRouter() = %v, %v", router, err)
	}
	if router.fallback == nil || router.fallback.route.Provider.Name() != "gemini" || router.fallback.route.Label != routeFallback {
		t.Fatalf("fallback = %+v, want gemini labelled fallback", router.fallback)
	}
}

func TestNewModelRouterDropsAnImplicitFallbackWithoutItsKey(t *testing.T) {
	cfg := &Config{
		ChatProvider: "deepseek", ChatModel: "deepseek-flash", ChatMaxOutputTokens: 1024,
		ChatFallbackProvider: "gemini", ChatFallbackModel: "gemini-2.5-flash", ChatFallbackImplicit: true,
		ProviderKeys: map[string]string{"deepseek": "ds-test-key"},
	}
	router, err := NewModelRouter(context.Background(), cfg, nil)
	if err != nil {
		t.Fatalf("NewModelRouter() error = %v, want the primary alone", err)
	}
	if router.fallback != nil {
		t.Fatal("an implicit Gemini fallback was kept with no Gemini key")
	}
}

func TestNewModelRouterAnExplicitFallbackNeedsItsKey(t *testing.T) {
	cfg := &Config{
		ChatProvider: "deepseek", ChatModel: "deepseek-flash", ChatMaxOutputTokens: 1024,
		ChatFallbackProvider: "gemini", ChatFallbackModel: "gemini-2.5-flash",
		ProviderKeys: map[string]string{"deepseek": "ds-test-key"},
	}
	if _, err := NewModelRouter(context.Background(), cfg, nil); err == nil {
		t.Fatal("an explicitly named fallback without its key was accepted")
	}
}

func TestEndUserIDIsNotTheRawUIDOnTheRouterPath(t *testing.T) {
	// The router derives the end-user id from the uid, so the provider never sees the uid.
	var seen SessionConfig
	primary := &routeProvider{name: "primary", plans: always(okPlan())}
	capture := &captureProvider{inner: primary, seen: &seen}
	r, _ := routerFor(capture, nil, 0)
	if _, _, err := runTurn(r); err != nil {
		t.Fatalf("RunTurn() error = %v", err)
	}
	if seen.EndUser != endUserID("uid-1") || strings.Contains(seen.EndUser, "uid-1") {
		t.Fatalf("EndUser = %q, want the pseudonymous id", seen.EndUser)
	}
}

// captureProvider records the config the router hands to the provider.
type captureProvider struct {
	inner *routeProvider
	seen  *SessionConfig
}

func (c *captureProvider) Name() string { return c.inner.name }

func (c *captureProvider) NewSession(cfg SessionConfig) (ModelSession, error) {
	*c.seen = cfg
	return c.inner.NewSession(cfg)
}

func (c *captureProvider) Close() error { return nil }
