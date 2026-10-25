package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
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
		ok, gen := b.allow()
		if !ok {
			t.Fatal("a closed breaker refused a call")
		}
		b.failure(gen)
	}
	if ok, _ := b.allow(); ok {
		t.Fatal("an open breaker let a call through before the cooldown")
	}
	clock.advance(breakerCooldown)
	ok, probe := b.allow()
	if !ok {
		t.Fatal("the cooldown elapsed but the half-open probe was refused")
	}
	if ok, _ := b.allow(); ok {
		t.Fatal("a second call got through while the probe was in flight")
	}
	b.release(probe)
	if ok, _ := b.allow(); !ok {
		t.Fatal("releasing the probe did not hand it back")
	}
}

// A call admitted while the breaker was closed reports its failure after the
// breaker opened and a probe started. That failure belongs to an earlier
// generation, so it must not reopen the breaker or release the probe's slot.
func TestBreakerIgnoresAFailureFromACallThatStartedBeforeTheProbe(t *testing.T) {
	clock := &fakeTime{t: time.Unix(0, 0)}
	b := newBreaker(clock.now)

	_, slow := b.allow() // admitted while closed, still in flight
	for range breakerThreshold {
		ok, gen := b.allow()
		if !ok {
			t.Fatal("a closed breaker refused a call")
		}
		b.failure(gen)
	}
	clock.advance(breakerCooldown)
	ok, probe := b.allow()
	if !ok {
		t.Fatal("the cooldown elapsed but the probe was refused")
	}

	b.failure(slow)

	clock.advance(breakerCooldown + time.Second)
	if ok, _ := b.allow(); ok {
		t.Fatal("a stale failure released the probe: a second probe went through while the first was in flight")
	}
	b.success(probe)
	if ok, _ := b.allow(); !ok {
		t.Fatal("the probe's success did not close the breaker")
	}
}

// Many calls race on one breaker. Each admitted call ends with exactly one of
// success, failure or release, so no probe may be left held at the end. The test
// runs under -race, which checks the breaker's locking.
func TestBreakerHoldsOneProbeAtATimeUnderConcurrentCalls(t *testing.T) {
	clock := &fakeTime{t: time.Unix(0, 0)}
	b := newBreaker(clock.now)
	for range breakerThreshold {
		ok, gen := b.allow()
		if !ok {
			t.Fatal("a closed breaker refused a call")
		}
		b.failure(gen)
	}
	clock.advance(breakerCooldown)

	var wg sync.WaitGroup
	for i := range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 20 {
				ok, gen := b.allow()
				if !ok {
					continue
				}
				switch i % 3 {
				case 0:
					b.success(gen)
				case 1:
					b.failure(gen)
				default:
					b.release(gen)
				}
			}
		}()
	}
	wg.Wait()

	clock.advance(breakerCooldown + time.Second)
	if ok, _ := b.allow(); !ok {
		t.Fatal("a probe was left held after every call had ended")
	}
}

// A same-provider retry is only for a call that billed nothing. Here the first
// call was answered and the tool round is refused, so the turn has been billed,
// and it must go to the fallback rather than run again on the primary.
func TestRouterNeverRetriesTheSameProviderAfterAToolRoundBilled(t *testing.T) {
	var executed atomic.Int32
	primary := &routeProvider{name: "primary", plans: func(n int) []fakeReply {
		if n == 1 {
			return []fakeReply{
				{calls: []ToolCall{searchCall("c1", "BHP")}},
				{err: failedCall(false, true, 429)}, // the tool round's Send is refused
			}
		}
		return okPlan()
	}}
	fallback := &routeProvider{name: "fallback", plans: always(okPlan())}
	r := newModelRouter(testRoute(routeEnvDefault, primary), func() *TurnRoute { fb := testRoute(routeFallback, fallback); return &fb }(),
		newTestToolExecutor(httpHandlerCounting(&executed)), 0)
	r.retryDelay = func() time.Duration { return 0 }

	if _, _, err := runTurn(r); err != nil {
		t.Fatalf("RunTurn() error = %v", err)
	}
	if primary.sessions() != 1 {
		t.Fatalf("primary sessions = %d, want 1: the turn was already billed (first call answered, %d tool runs), so it must not be re-run on the same provider", primary.sessions(), executed.Load())
	}
}

// The first call of a failed primary attempt is billed, and it must reach the
// answer's usage and cost, while the model that answered is the fallback.
func TestRouterChargesTheFailedAttemptsUsageToTheAnswer(t *testing.T) {
	primary := &routeProvider{name: "primary", plans: always([]fakeReply{
		{calls: []ToolCall{searchCall("c1", "BHP")}, usage: TokenUsage{PromptTokens: 7, CandidateTokens: 3, TotalTokens: 10}},
		{err: failedCall(false, true, 429)},
	})}
	fallback := &routeProvider{name: "fallback", plans: always([]fakeReply{
		{calls: []ToolCall{searchCall("c1", "BHP")}},
		{texts: []string{"ok"}, usage: TokenUsage{PromptTokens: 10, CandidateTokens: 2, TotalTokens: 12}},
	})}
	r, _ := routerFor(primary, fallback, 0)

	resp, _, err := runTurn(r)
	if err != nil {
		t.Fatalf("RunTurn() error = %v", err)
	}
	if resp.Route != routeFallback || resp.Model != "m-fallback" {
		t.Fatalf("answered by route %q model %q, want the fallback", resp.Route, resp.Model)
	}
	if resp.Usage.PromptTokens != 17 || resp.Usage.CandidateTokens != 5 || resp.Usage.TotalTokens != 22 {
		t.Fatalf("usage = %+v, want the primary's billed call plus the fallback's answer", resp.Usage)
	}
}

// A failed turn returns what it billed, so the ledger still counts a send whose
// calls all failed after the model had billed them.
func TestRouterAFailedTurnKeepsWhatItBilled(t *testing.T) {
	primary := &routeProvider{name: "primary", plans: always([]fakeReply{
		{calls: []ToolCall{searchCall("c1", "BHP")}, usage: TokenUsage{PromptTokens: 7, CandidateTokens: 3}},
		{err: failedCall(false, true, 429)},
	})}
	r, _ := routerFor(primary, nil, 0)

	_, _, err := runTurn(r)
	if err == nil {
		t.Fatal("RunTurn() succeeded, want the primary's failure")
	}
	if !modelAnswered(err) {
		t.Fatal("a failed turn that billed a call must count as having reached the model")
	}
	if got := billedBy(err).usage.PromptTokens; got != 7 {
		t.Fatalf("billed prompt tokens = %d, want the first call's 7", got)
	}
}

// A provider that never answers fails with a timeout, which the adapter marks
// not retryable. The router must send the turn straight to the fallback, with
// one request to the primary and none of the queued retries.
func TestRouterATimedOutPrimaryGoesStraightToTheFallback(t *testing.T) {
	var requests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		// Drain the body first: an HTTP/1.1 server reports a client disconnect only
		// once the request body has been read.
		_, _ = io.Copy(io.Discard, r.Body)
		<-r.Context().Done() // the provider holds the request and never answers
	}))
	defer srv.Close()

	primary := newOAProvider(t, "deepseek", srv.URL)
	primary.timeouts = streamTimeouts{FirstByte: 50 * time.Millisecond, Idle: time.Second}
	fallback := &routeProvider{name: "fallback", plans: always(okPlan())}
	r := newModelRouter(testRoute(routeEnvDefault, primary), func() *TurnRoute { fb := testRoute(routeFallback, fallback); return &fb }(),
		newTestToolExecutor(httpHandlerCounting(new(atomic.Int32))), 0)
	r.retryDelay = func() time.Duration { return 0 }

	resp, _, err := runTurn(r)
	if err != nil || resp.Route != routeFallback {
		t.Fatalf("turn: route %v, error %v, want the fallback's answer", resp, err)
	}
	if n := requests.Load(); n != 1 {
		t.Fatalf("primary requests = %d, want 1: a timed-out call must not be retried on the same provider", n)
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

// newRouterFor builds the production router from a config, failing the test on error.
func newRouterFor(t *testing.T, cfg *Config) *ModelRouter {
	t.Helper()
	r, err := NewModelRouter(context.Background(), cfg, nil)
	if err != nil || r == nil {
		t.Fatalf("NewModelRouter() = %v, %v; want a router", r, err)
	}
	return r
}

// The bounds follow the mode. Alone (the prod Gemini default) the first byte is 30s
// and the turn 55s. With a fallback the first byte is 15s on both routes and the
// turn is 50s. An env value overrides either mode.
func TestNewModelRouterPicksTheBoundsForItsMode(t *testing.T) {
	alone := &Config{ChatProvider: "gemini", ChatModel: "gemini-2.5-flash", ChatMaxOutputTokens: 1024,
		ProviderKeys: map[string]string{"gemini": "gemini-test-key"}}
	r := newRouterFor(t, alone)
	if got := r.primary.route.Provider.(*geminiProvider).timeouts.FirstByte; got != 30*time.Second {
		t.Fatalf("alone: first byte = %s, want 30s", got)
	}
	if r.budget != 55*time.Second {
		t.Fatalf("alone: turn budget = %s, want 55s", r.budget)
	}

	withFallback := &Config{ChatProvider: "deepseek", ChatModel: "deepseek-flash", ChatMaxOutputTokens: 1024,
		ChatFallbackProvider: "gemini", ChatFallbackModel: "gemini-2.5-flash", ChatFallbackImplicit: true,
		ProviderKeys: map[string]string{"deepseek": "ds-test-key", "gemini": "gemini-test-key"}}
	r = newRouterFor(t, withFallback)
	if got := r.primary.route.Provider.(*openAICompatProvider).timeouts.FirstByte; got != 15*time.Second {
		t.Fatalf("with fallback: primary first byte = %s, want 15s", got)
	}
	if got := r.fallback.route.Provider.(*geminiProvider).timeouts.FirstByte; got != 15*time.Second {
		t.Fatalf("with fallback: fallback first byte = %s, want 15s", got)
	}
	if r.budget != 50*time.Second {
		t.Fatalf("with fallback: turn budget = %s, want 50s", r.budget)
	}

	override := *withFallback
	override.ChatFirstByteTimeout, override.ChatTurnTimeout = 12*time.Second, 45*time.Second
	r = newRouterFor(t, &override)
	if got := r.primary.route.Provider.(*openAICompatProvider).timeouts.FirstByte; got != 12*time.Second || r.budget != 45*time.Second {
		t.Fatalf("with fallback and env values: first byte %s, budget %s, want 12s and 45s", got, r.budget)
	}
	overrideAlone := *alone
	overrideAlone.ChatFirstByteTimeout, overrideAlone.ChatTurnTimeout = 20*time.Second, 40*time.Second
	r = newRouterFor(t, &overrideAlone)
	if got := r.primary.route.Provider.(*geminiProvider).timeouts.FirstByte; got != 20*time.Second || r.budget != 40*time.Second {
		t.Fatalf("alone with env values: first byte %s, budget %s, want 20s and 40s", got, r.budget)
	}
}

// The Gemini fallback keeps Gemini's output limit. The primary keeps CHAT_MAX_OUTPUT_TOKENS.
func TestNewModelRouterGivesTheGeminiFallbackItsOwnOutputLimit(t *testing.T) {
	cfg := &Config{ChatProvider: "deepseek", ChatModel: "deepseek-flash", ChatMaxOutputTokens: 512, GeminiMaxOutputTokens: 1024,
		ChatFallbackProvider: "gemini", ChatFallbackModel: "gemini-2.5-flash", ChatFallbackImplicit: true,
		ProviderKeys: map[string]string{"deepseek": "ds-test-key", "gemini": "gemini-test-key"}}
	r := newRouterFor(t, cfg)
	if r.primary.route.Ref.MaxOutputTokens != 512 {
		t.Fatalf("primary max output = %d, want CHAT_MAX_OUTPUT_TOKENS 512", r.primary.route.Ref.MaxOutputTokens)
	}
	if r.fallback.route.Ref.MaxOutputTokens != 1024 {
		t.Fatalf("fallback max output = %d, want the Gemini limit 1024", r.fallback.route.Ref.MaxOutputTokens)
	}
}

// The cost of a failed primary attempt is part of the answering turn's cost, as
// its usage is. A price of 1 micro-USD per token makes the primary's billed call
// cost 10 (7 prompt and 3 output tokens), and the fallback's route is free.
func TestRouterChargesTheFailedAttemptsCostToTheAnswer(t *testing.T) {
	primary := &routeProvider{name: "primary", plans: always([]fakeReply{
		{calls: []ToolCall{searchCall("c1", "BHP")}, usage: TokenUsage{PromptTokens: 7, CandidateTokens: 3}},
		{err: failedCall(false, true, 429)},
	})}
	fallback := &routeProvider{name: "fallback", plans: always(okPlan())}
	primaryRoute := testRoute(routeEnvDefault, primary)
	primaryRoute.Spec.Price = Pricing{Input: 1, Output: 1}
	fallbackRoute := testRoute(routeFallback, fallback)
	r := newModelRouter(primaryRoute, &fallbackRoute, newTestToolExecutor(httpHandlerCounting(new(atomic.Int32))), 0)
	r.retryDelay = func() time.Duration { return 0 }

	resp, _, err := runTurn(r)
	if err != nil {
		t.Fatalf("RunTurn() error = %v", err)
	}
	if resp.EstCostMicroUSD != 10 {
		t.Fatalf("EstCostMicroUSD = %d, want 10: the failed primary call was billed and belongs to this turn", resp.EstCostMicroUSD)
	}
}

// End to end: the primary's filtered first call is billed (900/12), the
// fallback answers, and the answer's usage must include the primary's tokens
// (F1: a failed attempt's billed tokens reach the ledger).
func TestRouterFilteredPrimaryTokensReachTheAnswer(t *testing.T) {
	srv, _ := oaServer(t, scriptedReply{file: "finish_content_filter.sse"})
	primary := newOAProvider(t, "deepseek", srv.URL)
	fallback := &routeProvider{name: "fallback", plans: always(okPlan())}
	fb := testRoute(routeFallback, fallback)
	r := newModelRouter(testRoute(routeEnvDefault, primary), &fb, newTestToolExecutor(httpHandlerCounting(new(atomic.Int32))), 0)
	r.retryDelay = func() time.Duration { return 0 }

	resp, _, err := runTurn(r)
	if err != nil {
		t.Fatalf("RunTurn() error = %v", err)
	}
	if resp.Route != routeFallback {
		t.Fatalf("route = %q, want the fallback", resp.Route)
	}
	if resp.Usage.PromptTokens < 900 {
		t.Fatalf("answer usage = %+v, want the primary's billed 900 prompt tokens included", resp.Usage)
	}
}

// A call admitted while the breaker was closed can finish after the breaker has
// opened. Its success says nothing about the route now, so it must not close it.
func TestBreakerAStaleSuccessDoesNotCloseAnOpenedBreaker(t *testing.T) {
	clock := &fakeTime{t: time.Unix(0, 0)}
	b := newBreaker(clock.now)

	_, slow := b.allow() // admitted while closed, still in flight
	for range breakerThreshold {
		ok, gen := b.allow()
		if !ok {
			t.Fatal("a closed breaker refused a call")
		}
		b.failure(gen)
	}
	if ok, _ := b.allow(); ok {
		t.Fatal("the breaker should be open after the failures")
	}

	b.success(slow)
	if ok, _ := b.allow(); ok {
		t.Fatal("a stale success closed the breaker before its cooldown ended")
	}
}

// A call admitted before the breaker opened can release after a probe is held.
// Its release must not hand back the probe, or a second probe goes through while
// the first is still in flight.
func TestBreakerAStaleReleaseDoesNotFreeAHeldProbe(t *testing.T) {
	clock := &fakeTime{t: time.Unix(0, 0)}
	b := newBreaker(clock.now)

	_, stale := b.allow() // admitted while closed
	for range breakerThreshold {
		ok, gen := b.allow()
		if !ok {
			t.Fatal("a closed breaker refused a call")
		}
		b.failure(gen)
	}
	clock.advance(breakerCooldown)
	ok, probe := b.allow()
	if !ok {
		t.Fatal("the cooldown elapsed but the probe was refused")
	}

	b.release(stale)
	if ok, _ := b.allow(); ok {
		t.Fatal("a stale release freed the held probe: a second probe went through")
	}
	b.success(probe)
	if ok, _ := b.allow(); !ok {
		t.Fatal("the probe's success did not close the breaker")
	}
}

// The startup log reports the bounds the router resolved. On the prod env the
// alone-mode bounds apply and no fallback is set.
func TestModelRouterBoundsReportTheResolvedValuesOnProd(t *testing.T) {
	setTerraformProdEnv(t)
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}
	r, err := NewModelRouter(context.Background(), cfg, NewToolExecutor("http://127.0.0.1:1"))
	if err != nil || r == nil {
		t.Fatalf("NewModelRouter() = %v, %v", r, err)
	}
	want := RouterBounds{FirstByte: 30 * time.Second, Idle: 20 * time.Second, Turn: 55 * time.Second, HasFallback: false}
	if got := r.Bounds(); got != want {
		t.Fatalf("Bounds() = %+v, want %+v", got, want)
	}
}

// With a fallback, the first-byte bound and the turn cap are the fallback-mode
// values, and the log reports that a fallback is set.
func TestModelRouterBoundsReportTheFallbackMode(t *testing.T) {
	primary := testRoute(routeEnvDefault, &geminiProvider{timeouts: streamTimeouts{FirstByte: 15 * time.Second, Idle: 20 * time.Second}})
	fallback := testRoute(routeFallback, &routeProvider{name: "fallback", plans: always(okPlan())})
	r := newModelRouter(primary, &fallback, newTestToolExecutor(httpHandlerCounting(new(atomic.Int32))), 0)
	want := RouterBounds{FirstByte: 15 * time.Second, Idle: 20 * time.Second, Turn: 50 * time.Second, HasFallback: true}
	if got := r.Bounds(); got != want {
		t.Fatalf("Bounds() = %+v, want %+v", got, want)
	}
}

// A turn sent on by an open primary breaker is not a new failure, so it writes no
// ERROR line. The breaker's own line already says the route is down, and a WARNING
// is written at most once a minute.
func TestRouterTurnsOnAnOpenBreakerWriteNoErrorLines(t *testing.T) {
	primary := &routeProvider{name: "primary", plans: always([]fakeReply{{err: failedCall(false, false, 400)}})}
	fallback := &routeProvider{name: "fallback", plans: always(okPlan())}
	r, _ := routerFor(primary, fallback, 0)

	var logs bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(prev) })

	// breakerThreshold real failures open the primary's breaker.
	for i := 0; i < breakerThreshold; i++ {
		if _, _, err := runTurn(r); err != nil {
			t.Fatalf("turn %d: %v, want the fallback's answer", i+1, err)
		}
	}
	if n := strings.Count(logs.String(), "chat_provider_fallback"); n != breakerThreshold {
		t.Fatalf("fallback ERROR lines = %d before the breaker opened, want %d", n, breakerThreshold)
	}
	for i := 0; i < 5; i++ {
		if _, _, err := runTurn(r); err != nil {
			t.Fatalf("turn on an open breaker: %v, want the fallback's answer", err)
		}
	}
	if n := strings.Count(logs.String(), "chat_provider_fallback"); n != breakerThreshold {
		t.Fatalf("fallback ERROR lines = %d after 5 turns on an open breaker, want still %d", n, breakerThreshold)
	}
	if n := strings.Count(logs.String(), "circuit breaker is open"); n != 1 {
		t.Fatalf("breaker-open WARNING lines = %d, want 1 a minute", n)
	}
}
