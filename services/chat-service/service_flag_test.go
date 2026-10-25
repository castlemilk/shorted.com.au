package main

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	flaggr "github.com/flaggr-dev/flaggr-go"

	chatv1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/chat/v1"
)

// runFlaggedTurn plays one turn through the handler's runTurn, and returns what
// the person saw along with the ledger completion the turn left.
func runFlaggedTurn(t *testing.T, h *ChatServiceHandler, msg *chatv1.SendMessageRequest) (*LLMResponse, flagPick, sendCompletion, []string) {
	t.Helper()
	var completion sendCompletion
	var got []string
	resp, pick, err := h.runTurn(context.Background(), "uid-owner",
		TurnInput{System: "system", UserText: msg.Message},
		func(s string) { got = append(got, s) }, &completion)
	if err != nil {
		t.Fatalf("runTurn() error = %v, want the turn answered", err)
	}
	return resp, pick, completion, got
}

func TestSelectedRouteAnswersTheTurnAndIsTheLedgerModel(t *testing.T) {
	defaultProvider := &routeProvider{name: "gemini", plans: always(okPlan())}
	defaultRouter, _ := routerFor(defaultProvider, nil, 0)
	flagged := testFlaggedRouter("deepseek:deepseek-flash")
	selector := newChatModelSelector(fixedFlag("deepseek:deepseek-flash"), "gemini:gemini-2.5-flash", "production",
		map[string]*ModelRouter{"deepseek:deepseek-flash": flagged}, flagTiming{Turn: time.Second, TTL: time.Second})
	h := NewChatServiceHandler(nil, defaultRouter, nil)
	h.SetModelSelector(selector)

	resp, pick, completion, got := runFlaggedTurn(t, h, &chatv1.SendMessageRequest{Message: "question"})

	if resp.Provider != "deepseek" || resp.Route != routeFlag {
		t.Fatalf("answered by provider %q route %q, want the flagged route", resp.Provider, resp.Route)
	}
	if defaultProvider.sessions() != 0 {
		t.Fatalf("the default model was called %d times, want 0", defaultProvider.sessions())
	}
	if pick.Route != "deepseek:deepseek-flash" || pick.Source != flagOutcomeFlag {
		t.Fatalf("pick = %+v, want the flagged route from the flag", pick)
	}
	if completion.Model != "m-deepseek" {
		t.Fatalf("ledger model = %q, want the flagged model that answered", completion.Model)
	}
	if len(got) == 0 {
		t.Fatal("the person saw no text from the flagged route")
	}
}

// The flagged route is the one the registry builds for DeepSeek, pointed at a fake
// DeepSeek endpoint that refuses the turn with a 400. Only the Gemini fallback is
// swapped for a fake that answers, so the test shows the real route falls back.
func TestRegistryBuiltFlaggedRouteFallsBackToGeminiBeforeAnyText(t *testing.T) {
	refuse := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"refused"}}`))
	}))
	t.Cleanup(refuse.Close)

	cfg := registryConfig("development", keysFor("gemini", "deepseek"))
	routes := buildChatModelRoutesAt(context.Background(), cfg, testToolExecutor(), "gemini:gemini-2.5-flash",
		map[string]string{"deepseek": refuse.URL})
	flagged := routes["deepseek:deepseek-flash"]
	if flagged == nil {
		t.Fatal("the registry built no deepseek:deepseek-flash route")
	}
	geminiFallback := &routeProvider{name: "gemini", plans: always(okPlan())}
	flagged.fallback.route.Provider = geminiFallback

	defaultRouter, _ := routerFor(&routeProvider{name: "gemini", plans: always(okPlan())}, nil, 0)
	h := NewChatServiceHandler(nil, defaultRouter, nil)
	h.SetModelSelector(newChatModelSelector(fixedFlag("deepseek:deepseek-flash"), "gemini:gemini-2.5-flash", "development", routes, flagTiming{}))

	resp, pick, completion, got := runFlaggedTurn(t, h, &chatv1.SendMessageRequest{Message: "question"})

	if pick.Route != "deepseek:deepseek-flash" {
		t.Fatalf("pick.Route = %q, want the flagged route the flag chose", pick.Route)
	}
	if resp.Route != routeFallback || resp.Provider != "gemini" {
		t.Fatalf("answered by route %q provider %q, want the Gemini fallback", resp.Route, resp.Provider)
	}
	if geminiFallback.sessions() != 1 {
		t.Fatalf("the Gemini fallback ran %d times, want 1", geminiFallback.sessions())
	}
	if completion.Model != "gemini-2.5-flash" {
		t.Fatalf("ledger model = %q, want the fallback model that answered", completion.Model)
	}
	if len(got) == 0 || got[0] != "ok" {
		t.Fatalf("text = %v, want the fallback's answer", got)
	}
}

func TestWithoutTheFlagTheDefaultAnswers(t *testing.T) {
	defaultProvider := &routeProvider{name: "gemini", plans: always(okPlan())}
	defaultRouter, _ := routerFor(defaultProvider, nil, 0)
	h := NewChatServiceHandler(nil, defaultRouter, nil)

	resp, pick, completion, _ := runFlaggedTurn(t, h, &chatv1.SendMessageRequest{Message: "question"})

	if pick.Source != flagOutcomeUnconfigured || pick.Route != "" {
		t.Fatalf("pick = %+v, want the default with %s", pick, flagOutcomeUnconfigured)
	}
	if defaultProvider.sessions() != 1 || resp.Route != routeEnvDefault {
		t.Fatalf("default sessions = %d, route = %q; want one call on the env default", defaultProvider.sessions(), resp.Route)
	}
	if completion.Model != "m-gemini" {
		t.Fatalf("ledger model = %q, want the default model", completion.Model)
	}
}

func TestFlaggedTurnRoutesDefaultWhenTheFlagIsDown(t *testing.T) {
	defaultProvider := &routeProvider{name: "gemini", plans: always(okPlan())}
	defaultRouter, _ := routerFor(defaultProvider, nil, 0)
	down := resolveFunc(func(context.Context, string, interface{}, ...flaggr.EvalContext) (*flaggr.EvaluationDetail, error) {
		return nil, context.DeadlineExceeded
	})
	selector := newChatModelSelector(down, "gemini:gemini-2.5-flash", "production", nil, flagTiming{Turn: time.Second, TTL: time.Second})
	h := NewChatServiceHandler(nil, defaultRouter, nil)
	h.SetModelSelector(selector)

	resp, pick, _, _ := runFlaggedTurn(t, h, &chatv1.SendMessageRequest{Message: "question"})

	if pick.Route != "" || pick.Source != flagOutcomeTimeout {
		t.Fatalf("pick = %+v, want the default with %s", pick, flagOutcomeTimeout)
	}
	if defaultProvider.sessions() != 1 || resp.Route != routeEnvDefault {
		t.Fatalf("default sessions = %d, route = %q; want the default to answer", defaultProvider.sessions(), resp.Route)
	}
}

func TestFailedFlaggedTurnIsLoggedWithTheRouteTheFlagPicked(t *testing.T) {
	defaultProvider := &routeProvider{name: "gemini", plans: always(okPlan())}
	defaultRouter, _ := routerFor(defaultProvider, nil, 0)
	// The flagged route and its Gemini fallback both refuse the turn before any text.
	flaggedPrimary := &routeProvider{name: "deepseek", plans: always([]fakeReply{{err: failedCall(false, false, 400)}})}
	failingFallback := testRoute(routeFallback, &routeProvider{name: "gemini", plans: always([]fakeReply{{err: failedCall(false, false, 400)}})})
	flagged := newModelRouter(testRoute(routeFlag, flaggedPrimary), &failingFallback, testToolExecutor(), 0)
	selector := newChatModelSelector(fixedFlag("deepseek:deepseek-flash"), "gemini:gemini-2.5-flash", "production",
		map[string]*ModelRouter{"deepseek:deepseek-flash": flagged}, flagTiming{Turn: time.Second, TTL: time.Second})
	h := NewChatServiceHandler(nil, defaultRouter, nil)
	h.SetModelSelector(selector)

	var logs bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(prev) })

	var completion sendCompletion
	_, _, err := h.runTurn(context.Background(), "uid-owner",
		TurnInput{System: "system", UserText: "q"}, func(string) {}, &completion)
	if err == nil {
		t.Fatal("runTurn() error = nil, want both routes to refuse")
	}
	if completion.Model != "m-deepseek" {
		t.Fatalf("ledger model = %q, want the flagged model the turn tried", completion.Model)
	}
	if !strings.Contains(logs.String(), "chat turn failed: model=m-deepseek route=deepseek:deepseek-flash route_source=flag") {
		t.Fatalf("failed turn log = %q, want the route the flag picked and its source", logs.String())
	}
}
