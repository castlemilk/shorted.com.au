package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	flaggr "github.com/flaggr-dev/flaggr-go"
)

// flaggrFake is a stand-in for the Flaggr evaluate endpoint. It records each
// request body, so a test can see what the selector sent, and it counts calls.
type flaggrFake struct {
	srv   *httptest.Server
	calls atomic.Int32

	mu     sync.Mutex
	bodies []map[string]any
	auth   []string
}

// newFlaggrFake serves handle. Each call is numbered from 1.
func newFlaggrFake(t *testing.T, handle func(w http.ResponseWriter, r *http.Request, call int32)) *flaggrFake {
	t.Helper()
	f := &flaggrFake{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := f.calls.Add(1)
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.bodies = append(f.bodies, body)
		f.auth = append(f.auth, r.Header.Get("Authorization"))
		f.mu.Unlock()
		handle(w, r, n)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// lastBody is the most recent request body the fake received.
func (f *flaggrFake) lastBody(t *testing.T) map[string]any {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.bodies) == 0 {
		t.Fatal("the fake Flaggr received no request")
	}
	return f.bodies[len(f.bodies)-1]
}

// answer is a handler that returns the flag value with Flaggr's usual fields.
func answer(value any) func(http.ResponseWriter, *http.Request, int32) {
	return func(w http.ResponseWriter, _ *http.Request, _ int32) {
		writeFlagAnswer(w, map[string]any{"value": value, "reason": "TARGETING_MATCH", "variant": "on"})
	}
}

func writeFlagAnswer(w http.ResponseWriter, body map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}

// flagClock is the injectable clock the selector reads for its TTL, breaker and
// log limits. It is safe for the background flights to read.
type flagClock struct {
	mu sync.Mutex
	t  time.Time
}

func newFlagClock() *flagClock {
	return &flagClock{t: time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)}
}

func (c *flagClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *flagClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// flagSelectorWith builds a selector over the real SDK client, pointed at url,
// with every timing bound chosen by the test.
func flagSelectorWith(t *testing.T, url string, routes map[string]*ModelRouter, timing flagTiming) (*chatModelSelector, *flagClock) {
	t.Helper()
	client, err := newChatModelFlagClient(&Config{
		FlaggrAPIKey:      "fgr_test_key",
		FlaggrServiceID:   "svc-chat",
		FlaggrEnvironment: "production",
		FlaggrAPIURL:      url,
	})
	if err != nil || client == nil {
		t.Fatalf("newChatModelFlagClient() = %v, %v; want a client", client, err)
	}
	s := newChatModelSelector(client, "gemini:gemini-2.5-flash", "production", routes, timing)
	clk := newFlagClock()
	s.now = clk.Now
	return s, clk
}

// flagSelector is flagSelectorWith with the turn wait set and the other bounds at
// their defaults.
func flagSelector(t *testing.T, url string, routes map[string]*ModelRouter, timeout time.Duration) (*chatModelSelector, *flagClock) {
	t.Helper()
	return flagSelectorWith(t, url, routes, flagTiming{Turn: timeout, TTL: 30 * time.Second})
}

// flaggedRoutes holds one router per id. Each is a forced-choice route whose
// fallback is an always-answering Gemini route.
func flaggedRoutes(ids ...string) map[string]*ModelRouter {
	routes := make(map[string]*ModelRouter, len(ids))
	for _, id := range ids {
		routes[id] = testFlaggedRouter(id)
	}
	return routes
}

// testFlaggedRouter is the router buildChatModelRoutes would make, with fakes.
func testFlaggedRouter(id string) *ModelRouter {
	primary := &routeProvider{name: strings.SplitN(id, ":", 2)[0], plans: always(okPlan())}
	fb := testRoute(routeFallback, &routeProvider{name: "gemini", plans: always(okPlan())})
	return newModelRouter(testRoute(routeFlag, primary), &fb, newTestToolExecutor(httpHandlerCounting(new(atomic.Int32))), 0)
}

// choiceOf runs one choose call with a turn's attributes.
func choiceOf(s *chatModelSelector, userID string) (string, string) {
	return s.choose(context.Background(), userID)
}

// waitFor polls cond until it holds, failing the test after two seconds.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestChatModelFlagUnconfiguredMakesNoRequests(t *testing.T) {
	fake := newFlaggrFake(t, answer("deepseek:deepseek-flash"))

	// Each half alone turns the flag off, and neither makes a client.
	for _, cfg := range []*Config{
		{FlaggrAPIKey: "fgr_test_key", FlaggrAPIURL: fake.srv.URL},
		{FlaggrServiceID: "svc-chat", FlaggrAPIURL: fake.srv.URL},
		{},
	} {
		client, err := newChatModelFlagClient(cfg)
		if err != nil || client != nil {
			t.Fatalf("newChatModelFlagClient(%+v) = %v, %v; want no client and no error", cfg, client, err)
		}
	}

	s := newChatModelSelector(nil, "gemini:gemini-2.5-flash", "production", nil, flagTiming{})
	route, outcome := choiceOf(s, "uid-owner")
	if route != "" || outcome != flagOutcomeUnconfigured {
		t.Fatalf("choose() = %q, %q; want the default and %s", route, outcome, flagOutcomeUnconfigured)
	}
	if n := fake.calls.Load(); n != 0 {
		t.Fatalf("Flaggr received %d requests while unconfigured, want 0", n)
	}
}

func TestChatModelFlagHappyPathUsesTheFlaggedRoute(t *testing.T) {
	fake := newFlaggrFake(t, answer("deepseek:deepseek-flash"))
	s, _ := flagSelector(t, fake.srv.URL, flaggedRoutes("deepseek:deepseek-flash"), time.Second)

	route, outcome := s.choose(context.Background(), "uid-owner")
	if route != "deepseek:deepseek-flash" || outcome != flagOutcomeFlag {
		t.Fatalf("choose() = %q, %q; want the flagged route and %s", route, outcome, flagOutcomeFlag)
	}
	if s.routeFor(route) == nil {
		t.Fatal("routeFor() = nil for the flagged route")
	}

	body := fake.lastBody(t)
	if body["flagKey"] != "chat-model" || body["serviceId"] != "svc-chat" || body["environment"] != "production" {
		t.Fatalf("request = %v; want the chat-model flag for service svc-chat in production", body)
	}
	if got := fake.auth[0]; got != "Bearer fgr_test_key" {
		t.Fatalf("Authorization = %q, want the project token", got)
	}
	ctxFields, _ := body["context"].(map[string]any)
	if ctxFields["targetingKey"] != "uid-owner" {
		t.Fatalf("targetingKey = %v, want the user id", ctxFields["targetingKey"])
	}
	if ctxFields["environment"] != "production" {
		t.Fatalf("context = %v, want the service environment", ctxFields)
	}
}

func TestChatModelFlagAnswerIsCachedWithinTheTTL(t *testing.T) {
	fake := newFlaggrFake(t, answer("deepseek:deepseek-flash"))
	s, clk := flagSelector(t, fake.srv.URL, flaggedRoutes("deepseek:deepseek-flash"), time.Second)

	if _, outcome := choiceOf(s, "uid-owner"); outcome != flagOutcomeFlag {
		t.Fatalf("first outcome = %q, want %s", outcome, flagOutcomeFlag)
	}
	clk.Advance(29 * time.Second)
	route, outcome := choiceOf(s, "uid-owner")
	if outcome != flagOutcomeCache || route != "deepseek:deepseek-flash" {
		t.Fatalf("second choose() = %q, %q; want the cached route", route, outcome)
	}
	if n := fake.calls.Load(); n != 1 {
		t.Fatalf("Flaggr received %d requests, want 1: a turn inside the TTL is a cache hit", n)
	}
}

func TestChatModelFlagStaleValueReturnsAtOnceAndRefreshesInTheBackground(t *testing.T) {
	arrived := make(chan struct{}, 1)
	release := make(chan struct{})
	releaseOnce := sync.OnceFunc(func() { close(release) })
	fake := newFlaggrFake(t, func(w http.ResponseWriter, r *http.Request, call int32) {
		if call == 1 {
			answer("deepseek:deepseek-flash")(w, r, call)
			return
		}
		arrived <- struct{}{}
		select {
		case <-release:
		case <-r.Context().Done():
		}
		answer("openrouter:openai/gpt-5-mini")(w, r, call)
	})
	t.Cleanup(releaseOnce)
	s, clk := flagSelector(t, fake.srv.URL, flaggedRoutes("deepseek:deepseek-flash", "openrouter:openai/gpt-5-mini"), time.Second)

	choiceOf(s, "uid-owner")
	clk.Advance(31 * time.Second)

	start := time.Now()
	route, outcome := choiceOf(s, "uid-owner")
	elapsed := time.Since(start)
	if outcome != flagOutcomeStale || route != "deepseek:deepseek-flash" {
		t.Fatalf("stale choose() = %q, %q; want the stale route and %s", route, outcome, flagOutcomeStale)
	}
	if elapsed > 100*time.Millisecond {
		t.Fatalf("stale choose() took %s; a stale turn must not wait for Flaggr", elapsed)
	}

	select {
	case <-arrived:
	case <-time.After(2 * time.Second):
		t.Fatal("no background refresh reached Flaggr")
	}
	releaseOnce()
	waitFor(t, "the refresh to finish", s.flightsIdle)

	route, outcome = choiceOf(s, "uid-owner")
	if outcome != flagOutcomeCache || route != "openrouter:openai/gpt-5-mini" {
		t.Fatalf("after refresh choose() = %q, %q; want the refreshed route from the cache", route, outcome)
	}
	if n := fake.calls.Load(); n != 2 {
		t.Fatalf("Flaggr received %d requests, want 2: the first turn and one refresh", n)
	}
}

func TestChatModelFlagConcurrentStaleTurnsRefreshOnce(t *testing.T) {
	arrived := make(chan struct{}, 1)
	release := make(chan struct{})
	releaseOnce := sync.OnceFunc(func() { close(release) })
	fake := newFlaggrFake(t, func(w http.ResponseWriter, r *http.Request, call int32) {
		if call == 1 {
			answer("deepseek:deepseek-flash")(w, r, call)
			return
		}
		select {
		case arrived <- struct{}{}:
		default:
		}
		select {
		case <-release:
		case <-r.Context().Done():
		}
		answer("deepseek:deepseek-flash")(w, r, call)
	})
	t.Cleanup(releaseOnce)
	s, clk := flagSelector(t, fake.srv.URL, flaggedRoutes("deepseek:deepseek-flash"), time.Second)

	choiceOf(s, "uid-owner")
	clk.Advance(31 * time.Second)

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, outcome := choiceOf(s, "uid-owner"); outcome != flagOutcomeStale {
				t.Errorf("concurrent stale choose() outcome = %q, want %s", outcome, flagOutcomeStale)
			}
		}()
	}
	wg.Wait()
	<-arrived
	releaseOnce()
	waitFor(t, "the refresh to finish", s.flightsIdle)

	if n := fake.calls.Load(); n != 2 {
		t.Fatalf("Flaggr received %d requests, want 2: one refresh for twenty concurrent stale turns", n)
	}
}

func TestChatModelFlagConcurrentFirstTurnsShareOneLookup(t *testing.T) {
	release := make(chan struct{})
	releaseOnce := sync.OnceFunc(func() { close(release) })
	fake := newFlaggrFake(t, func(w http.ResponseWriter, r *http.Request, call int32) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
		answer("deepseek:deepseek-flash")(w, r, call)
	})
	t.Cleanup(releaseOnce)
	s, _ := flagSelector(t, fake.srv.URL, flaggedRoutes("deepseek:deepseek-flash"), 200*time.Millisecond)

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			choiceOf(s, "uid-owner")
		}()
	}
	wg.Wait()
	if n := fake.calls.Load(); n != 1 {
		t.Fatalf("Flaggr received %d requests for twenty concurrent first turns, want 1", n)
	}
}

func TestChatModelFlagSlowFlaggrFailsOpenWithinTheTimeout(t *testing.T) {
	fake := newFlaggrFake(t, func(w http.ResponseWriter, r *http.Request, call int32) {
		select {
		case <-time.After(2 * time.Second):
		case <-r.Context().Done():
			return
		}
		answer("deepseek:deepseek-flash")(w, r, call)
	})
	s, _ := flagSelector(t, fake.srv.URL, flaggedRoutes("deepseek:deepseek-flash"), 200*time.Millisecond)

	start := time.Now()
	route, outcome := choiceOf(s, "uid-owner")
	elapsed := time.Since(start)
	if route != "" || outcome != flagOutcomeTimeout {
		t.Fatalf("choose() = %q, %q; want the default and %s", route, outcome, flagOutcomeTimeout)
	}
	// The target is about 250ms. The bound is generous so the test cannot flake.
	if elapsed > 600*time.Millisecond {
		t.Fatalf("choose() took %s against a 200ms timeout", elapsed)
	}
}

func TestChatModelFlagFailuresReturnTheDefault(t *testing.T) {
	cases := map[string]func(w http.ResponseWriter, r *http.Request, call int32){
		"500": func(w http.ResponseWriter, _ *http.Request, _ int32) { w.WriteHeader(http.StatusInternalServerError) },
		"401": func(w http.ResponseWriter, _ *http.Request, _ int32) { w.WriteHeader(http.StatusUnauthorized) },
		"429": func(w http.ResponseWriter, _ *http.Request, _ int32) { w.WriteHeader(http.StatusTooManyRequests) },
		"malformed JSON": func(w http.ResponseWriter, _ *http.Request, _ int32) {
			_, _ = w.Write([]byte(`{"value": "deepseek:deepseek-flash"`))
		},
	}
	for name, handle := range cases {
		t.Run(name, func(t *testing.T) {
			fake := newFlaggrFake(t, handle)
			s, _ := flagSelector(t, fake.srv.URL, flaggedRoutes("deepseek:deepseek-flash"), time.Second)
			route, outcome := choiceOf(s, "uid-owner")
			if route != "" || outcome != flagOutcomeError {
				t.Fatalf("choose() = %q, %q; want the default and %s", route, outcome, flagOutcomeError)
			}
		})
	}
}

func TestChatModelFlagNotFoundOrDisabledReturnsTheDefault(t *testing.T) {
	cases := map[string]map[string]any{
		"not found": {"value": "", "reason": "NOT_FOUND", "errorCode": "NOT_FOUND"},
		"disabled":  {"value": "", "reason": "DISABLED"},
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			fake := newFlaggrFake(t, func(w http.ResponseWriter, _ *http.Request, _ int32) {
				writeFlagAnswer(w, body)
			})
			s, _ := flagSelector(t, fake.srv.URL, flaggedRoutes("deepseek:deepseek-flash"), time.Second)
			route, outcome := choiceOf(s, "uid-owner")
			if route != "" || outcome != flagOutcomeNotFound {
				t.Fatalf("choose() = %q, %q; want the default and %s", route, outcome, flagOutcomeNotFound)
			}
		})
	}
}

func TestChatModelFlagUnusableValuesReturnTheDefault(t *testing.T) {
	cases := map[string]any{
		"wrong type":        float64(42),
		"unknown route":     "gemini:no-such-model",
		"not in the router": "openrouter:qwen/qwen3.8-flash", // catalogued but not activatable
	}
	for name, value := range cases {
		t.Run(name, func(t *testing.T) {
			fake := newFlaggrFake(t, answer(value))
			s, _ := flagSelector(t, fake.srv.URL, flaggedRoutes("deepseek:deepseek-flash"), time.Second)
			route, outcome := choiceOf(s, "uid-owner")
			if route != "" || outcome != flagOutcomeUnknownRoute {
				t.Fatalf("choose() = %q, %q; want the default and %s", route, outcome, flagOutcomeUnknownRoute)
			}
		})
	}
}

func TestChatModelFlagDefaultValuesAreTheDefault(t *testing.T) {
	for _, value := range []string{"", "default", "gemini:gemini-2.5-flash"} {
		fake := newFlaggrFake(t, answer(value))
		s, _ := flagSelector(t, fake.srv.URL, flaggedRoutes("deepseek:deepseek-flash"), time.Second)
		route, outcome := choiceOf(s, "uid-owner")
		if route != "" || outcome != flagOutcomeFlag {
			t.Fatalf("value %q: choose() = %q, %q; want the default and %s", value, route, outcome, flagOutcomeFlag)
		}
	}
}

func TestChatModelFlagBreakerOpensAfterThreeFailuresAndCloses(t *testing.T) {
	var broken atomic.Bool
	broken.Store(true)
	fake := newFlaggrFake(t, func(w http.ResponseWriter, r *http.Request, call int32) {
		if broken.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		answer("deepseek:deepseek-flash")(w, r, call)
	})
	s, clk := flagSelector(t, fake.srv.URL, flaggedRoutes("deepseek:deepseek-flash"), time.Second)

	var logs bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(prev) })

	for i := 0; i < 3; i++ {
		if _, outcome := choiceOf(s, "uid-owner"); outcome != flagOutcomeError {
			t.Fatalf("failure %d: outcome = %q, want %s", i+1, outcome, flagOutcomeError)
		}
	}
	if n := fake.calls.Load(); n != 3 {
		t.Fatalf("Flaggr received %d requests before the breaker, want 3", n)
	}

	// Inside the cooldown no request goes out, and the turn runs on the default.
	clk.Advance(59 * time.Second)
	if route, outcome := choiceOf(s, "uid-owner"); route != "" || outcome != flagOutcomeBreaker {
		t.Fatalf("choose() during the cooldown = %q, %q; want the default and %s", route, outcome, flagOutcomeBreaker)
	}
	if n := fake.calls.Load(); n != 3 {
		t.Fatalf("Flaggr received %d requests during the cooldown, want 3", n)
	}

	// After the cooldown Flaggr is called again, and its answer is used.
	broken.Store(false)
	clk.Advance(2 * time.Second)
	if route, outcome := choiceOf(s, "uid-owner"); route != "deepseek:deepseek-flash" || outcome != flagOutcomeFlag {
		t.Fatalf("choose() after the cooldown = %q, %q; want the flagged route", route, outcome)
	}
	if n := fake.calls.Load(); n != 4 {
		t.Fatalf("Flaggr received %d requests, want 4 after the cooldown", n)
	}
	if opened := strings.Count(logs.String(), "circuit open"); opened != 1 {
		t.Fatalf("the breaker opened %d times in the log, want 1", opened)
	}
	if closed := strings.Count(logs.String(), "circuit closed"); closed != 1 {
		t.Fatalf("the breaker closed %d times in the log, want 1", closed)
	}
}

// panickingEvaluator panics on every evaluation.
type panickingEvaluator struct{}

func (panickingEvaluator) Resolve(context.Context, string, interface{}, ...flaggr.EvalContext) (*flaggr.EvaluationDetail, error) {
	panic("evaluator bug")
}

func TestChatModelFlagPanicInTheEvaluatorReturnsTheDefault(t *testing.T) {
	s := newChatModelSelector(panickingEvaluator{}, "gemini:gemini-2.5-flash", "production", nil, flagTiming{Turn: time.Second, TTL: time.Second})

	route, outcome := choiceOf(s, "uid-owner")
	if route != "" || outcome != flagOutcomePanic {
		t.Fatalf("choose() = %q, %q; want the default and %s", route, outcome, flagOutcomePanic)
	}
	// The selector is still usable after the panic, and the lock is not held.
	if _, outcome := choiceOf(s, "uid-other"); outcome != flagOutcomePanic {
		t.Fatalf("second choose() outcome = %q, want %s", outcome, flagOutcomePanic)
	}
}

// fixedFlag is a flag evaluator that always answers with one value.
func fixedFlag(value string) flagEvaluator {
	return resolveFunc(func(context.Context, string, interface{}, ...flaggr.EvalContext) (*flaggr.EvaluationDetail, error) {
		return &flaggr.EvaluationDetail{Value: value, Reason: "TARGETING_MATCH"}, nil
	})
}

// resolveFunc adapts a function to flagEvaluator for tests.
type resolveFunc func(ctx context.Context, key string, def interface{}, evalCtx ...flaggr.EvalContext) (*flaggr.EvaluationDetail, error)

func (f resolveFunc) Resolve(ctx context.Context, key string, def interface{}, evalCtx ...flaggr.EvalContext) (*flaggr.EvaluationDetail, error) {
	return f(ctx, key, def, evalCtx...)
}

func TestChatModelFlagLogsEachFailureKindOncePerMinute(t *testing.T) {
	fails := resolveFunc(func(context.Context, string, interface{}, ...flaggr.EvalContext) (*flaggr.EvaluationDetail, error) {
		return nil, errors.New("upstream down")
	})
	s := newChatModelSelector(fails, "gemini:gemini-2.5-flash", "production", nil, flagTiming{Turn: time.Second, TTL: time.Second})
	clk := newFlagClock()
	s.now = clk.Now

	var logs bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(prev) })

	for i := 0; i < 2; i++ {
		choiceOf(s, "uid-owner")
	}
	if n := strings.Count(logs.String(), "default_error"); n != 1 {
		t.Fatalf("default_error logged %d times within a minute, want 1: %s", n, logs.String())
	}
	clk.Advance(time.Minute)
	choiceOf(s, "uid-owner")
	if n := strings.Count(logs.String(), "default_error"); n != 2 {
		t.Fatalf("default_error logged %d times after a minute, want 2", n)
	}
}

func TestChatModelFlagCacheIsBoundedByLeastRecentUse(t *testing.T) {
	c := newFlagRouteCache(2)
	far := time.Now().Add(time.Hour)
	c.put(flagCacheEntry{user: "a", route: "r", expires: far})
	c.put(flagCacheEntry{user: "b", route: "r", expires: far})
	c.get("a") // a is now the most recently used
	c.put(flagCacheEntry{user: "c", route: "r", expires: far})

	if _, ok := c.get("b"); ok {
		t.Fatal("b survived, want the least recently used entry evicted")
	}
	if _, ok := c.get("a"); !ok {
		t.Fatal("a was evicted, want it kept because it was used")
	}
	if c.order.Len() != 2 || len(c.items) != 2 {
		t.Fatalf("cache holds %d entries, want 2", c.order.Len())
	}
}

func TestChatModelFlagWaiterIsBoundedEvenIfTheEvaluatorIgnoresItsContext(t *testing.T) {
	release := make(chan struct{})
	releaseOnce := sync.OnceFunc(func() { close(release) })
	t.Cleanup(releaseOnce)
	stuck := resolveFunc(func(context.Context, string, interface{}, ...flaggr.EvalContext) (*flaggr.EvaluationDetail, error) {
		<-release
		return &flaggr.EvaluationDetail{Value: "deepseek:deepseek-flash"}, nil
	})
	s := newChatModelSelector(stuck, "gemini:gemini-2.5-flash", "production", flaggedRoutes("deepseek:deepseek-flash"), flagTiming{Turn: 200 * time.Millisecond, TTL: time.Second})

	type result struct {
		route, outcome string
		elapsed        time.Duration
	}
	done := make(chan result, 1)
	go func() {
		start := time.Now()
		route, outcome := choiceOf(s, "uid-owner")
		done <- result{route, outcome, time.Since(start)}
	}()
	select {
	case got := <-done:
		if got.route != "" || got.outcome != flagOutcomeTimeout {
			t.Fatalf("choose() = %q, %q; want the default and %s", got.route, got.outcome, flagOutcomeTimeout)
		}
		if got.elapsed > 600*time.Millisecond {
			t.Fatalf("choose() took %s against a 200ms timeout", got.elapsed)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("choose() did not return: the turn waited on an evaluator that ignored its context")
	}
}

// Stale answers are capped at MaxStale, and a failed refresh never leaves a route
// in place. A flag change is seen once the cached answer is too old to serve.

func TestChatModelFlagFallsBackToDefaultWhileFlaggrIsDownForHours(t *testing.T) {
	fake := newFlaggrFake(t, func(w http.ResponseWriter, r *http.Request, call int32) {
		if call == 1 {
			answer("deepseek:deepseek-flash")(w, r, call)
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable) // Flaggr is down from here on
	})
	s, clk := flagSelector(t, fake.srv.URL, flaggedRoutes("deepseek:deepseek-flash"), time.Second)

	if route, _ := choiceOf(s, "uid-owner"); route != "deepseek:deepseek-flash" {
		t.Fatalf("first turn route = %q, want the flagged route", route)
	}
	var route, outcome string
	for i := 0; i < 12; i++ { // two hours of Flaggr being down, one turn every 10 minutes
		clk.Advance(10 * time.Minute)
		route, outcome = choiceOf(s, "uid-owner")
		waitFor(t, "the refresh to finish", s.flightsIdle)
	}
	if route != "" {
		t.Fatalf("after 2h of Flaggr down: choose() = %q, %q; want the default model", route, outcome)
	}
}

func TestChatModelFlagStaleRouteStopsBeingServedAtMaxStale(t *testing.T) {
	release := make(chan struct{})
	releaseOnce := sync.OnceFunc(func() { close(release) })
	t.Cleanup(releaseOnce)
	fake := newFlaggrFake(t, func(w http.ResponseWriter, r *http.Request, call int32) {
		if call == 1 {
			answer("deepseek:deepseek-flash")(w, r, call)
			return
		}
		// A refresh that hangs, so the cached route is only ever served stale.
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	s, clk := flagSelectorWith(t, fake.srv.URL, flaggedRoutes("deepseek:deepseek-flash"), flagTiming{
		Turn: 200 * time.Millisecond, Lookup: 10 * time.Second, TTL: 30 * time.Second, MaxStale: 5 * time.Minute,
	})

	choiceOf(s, "uid-owner")
	clk.Advance(31 * time.Second) // past the TTL, inside max stale
	if route, outcome := choiceOf(s, "uid-owner"); route != "deepseek:deepseek-flash" || outcome != flagOutcomeStale {
		t.Fatalf("31s on: choose() = %q, %q; want the stale route", route, outcome)
	}
	clk.Advance(4 * time.Minute) // 4m31s on: still inside max stale
	if route, outcome := choiceOf(s, "uid-owner"); route != "deepseek:deepseek-flash" || outcome != flagOutcomeStale {
		t.Fatalf("4m31s on: choose() = %q, %q; want the stale route", route, outcome)
	}
	clk.Advance(time.Minute) // 5m31s on: past max stale, so the turn waits for Flaggr
	if route, outcome := choiceOf(s, "uid-owner"); route != "" || outcome != flagOutcomeTimeout {
		t.Fatalf("5m31s on: choose() = %q, %q; want the default and %s, not a stale route", route, outcome, flagOutcomeTimeout)
	}
}

func TestChatModelFlagFailedRefreshGivesTheDefaultOnTheNextTurn(t *testing.T) {
	fake := newFlaggrFake(t, func(w http.ResponseWriter, r *http.Request, call int32) {
		if call == 1 {
			answer("deepseek:deepseek-flash")(w, r, call)
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	s, clk := flagSelector(t, fake.srv.URL, flaggedRoutes("deepseek:deepseek-flash"), time.Second)

	choiceOf(s, "uid-owner")
	clk.Advance(31 * time.Second)
	if route, outcome := choiceOf(s, "uid-owner"); route != "deepseek:deepseek-flash" || outcome != flagOutcomeStale {
		t.Fatalf("stale turn = %q, %q; want the stale route while its refresh runs", route, outcome)
	}
	waitFor(t, "the failed refresh", s.flightsIdle)

	if route, outcome := choiceOf(s, "uid-owner"); route != "" || outcome != flagOutcomeError {
		t.Fatalf("turn after a failed refresh = %q, %q; want the default and %s", route, outcome, flagOutcomeError)
	}
}

func TestChatModelFlagChangeIsSeenAfterAGapLongerThanMaxStale(t *testing.T) {
	fake := newFlaggrFake(t, func(w http.ResponseWriter, r *http.Request, call int32) {
		if call == 1 {
			answer("deepseek:deepseek-flash")(w, r, call)
			return
		}
		answer("default")(w, r, call) // the operator has switched this user off
	})
	s, clk := flagSelector(t, fake.srv.URL, flaggedRoutes("deepseek:deepseek-flash"), time.Second)

	choiceOf(s, "uid-owner")
	clk.Advance(6 * time.Hour)
	if route, outcome := choiceOf(s, "uid-owner"); route != "" || outcome != flagOutcomeFlag {
		t.Fatalf("6h after the flag changed: choose() = %q, %q; want the new value (default)", route, outcome)
	}
}

// The evaluation carries only constant targeting: the user id and the environment.
// A per-turn value is not sent, so no rule on one can split the cache.

func TestChatModelFlagEvaluationCarriesOnlyConstantTargeting(t *testing.T) {
	fake := newFlaggrFake(t, answer(""))
	s, _ := flagSelector(t, fake.srv.URL, nil, time.Second)

	choiceOf(s, "uid-owner")

	ctxFields, _ := fake.lastBody(t)["context"].(map[string]any)
	keys := make([]string, 0, len(ctxFields))
	for k := range ctxFields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "environment,targetingKey" {
		t.Fatalf("context keys = %v, want only environment and targetingKey", keys)
	}
}

// A lookup that outlives the turn is still cached. The turn stops waiting at its own
// bound, and the lookup runs on its own, longer bound.

func TestChatModelFlagSlowButWorkingLookupIsCachedForTheNextTurn(t *testing.T) {
	fake := newFlaggrFake(t, func(w http.ResponseWriter, r *http.Request, call int32) {
		select {
		case <-time.After(400 * time.Millisecond):
		case <-r.Context().Done():
			return
		}
		answer("deepseek:deepseek-flash")(w, r, call)
	})
	s, _ := flagSelectorWith(t, fake.srv.URL, flaggedRoutes("deepseek:deepseek-flash"), flagTiming{
		Turn: 200 * time.Millisecond, Lookup: time.Second, TTL: 30 * time.Second,
	})

	start := time.Now()
	route, outcome := choiceOf(s, "uid-owner")
	elapsed := time.Since(start)
	if route != "" || outcome != flagOutcomeTimeout {
		t.Fatalf("turn 1 = %q, %q; want the default and %s", route, outcome, flagOutcomeTimeout)
	}
	// The target is about 200ms. The bound is generous so the test cannot flake.
	if elapsed > 600*time.Millisecond {
		t.Fatalf("turn 1 took %s against a 200ms turn wait", elapsed)
	}

	waitFor(t, "the slow lookup to finish", s.flightsIdle)
	route, outcome = choiceOf(s, "uid-owner")
	if route != "deepseek:deepseek-flash" || outcome != flagOutcomeCache {
		t.Fatalf("turn 2 = %q, %q; want the flagged route from the cache", route, outcome)
	}
}

func TestChatModelFlagLookupRunsUnderItsOwnDeadline(t *testing.T) {
	var deadlineLeft time.Duration
	var hasDeadline bool
	stuck := resolveFunc(func(ctx context.Context, _ string, _ interface{}, _ ...flaggr.EvalContext) (*flaggr.EvaluationDetail, error) {
		var deadline time.Time
		deadline, hasDeadline = ctx.Deadline()
		if hasDeadline {
			deadlineLeft = time.Until(deadline)
		}
		select {
		case <-ctx.Done():
		case <-time.After(3 * time.Second): // a guard, so a removed bound fails the test rather than hanging it
		}
		return &flaggr.EvaluationDetail{Value: ""}, nil
	})
	s := newChatModelSelector(stuck, "gemini:gemini-2.5-flash", "production", nil, flagTiming{
		Turn: 50 * time.Millisecond, Lookup: 300 * time.Millisecond, TTL: time.Second,
	})

	choiceOf(s, "uid-owner")
	waitFor(t, "the lookup to end at its own bound", s.flightsIdle)
	if !hasDeadline {
		t.Fatal("the lookup ran with no deadline, want its own lookup bound")
	}
	if deadlineLeft > 300*time.Millisecond || deadlineLeft < 0 {
		t.Fatalf("the lookup deadline was %s away, want at most the 300ms lookup bound", deadlineLeft)
	}
}

// A panic inside the selector's cache read must not leave the mutex held. The
// selector recovers the panic, and it keeps serving turns afterwards.

func TestChatModelFlagPanicInTheSelectorIsRecoveredAndTheSelectorStaysUsable(t *testing.T) {
	fake := newFlaggrFake(t, answer("deepseek:deepseek-flash"))
	s, _ := flagSelector(t, fake.srv.URL, flaggedRoutes("deepseek:deepseek-flash"), time.Second)
	s.cache = nil // the next read dereferences a nil cache

	// Each call runs in its own goroutine, so a deadlock fails the test rather than hanging it.
	call := func() (string, string, bool) {
		type answer struct{ route, outcome string }
		done := make(chan answer, 1)
		go func() {
			r, o := choiceOf(s, "uid-owner")
			done <- answer{r, o}
		}()
		select {
		case a := <-done:
			return a.route, a.outcome, true
		case <-time.After(2 * time.Second):
			return "", "", false
		}
	}

	route, outcome, returned := call()
	if !returned {
		t.Fatal("choose() did not return after a panic: the selector's mutex was left held")
	}
	if route != "" || outcome != flagOutcomePanic {
		t.Fatalf("choose() after a panic = %q, %q; want the default and %s", route, outcome, flagOutcomePanic)
	}

	s.cache = newFlagRouteCache(chatModelFlagCacheSize)
	route, outcome, returned = call()
	if !returned {
		t.Fatal("choose() did not return on the call after a panic: the selector's mutex was left held")
	}
	if route != "" || outcome != flagOutcomeFlag {
		t.Fatalf("choose() after the panic = %q, %q; want the flagged route's default", route, outcome)
	}
}
