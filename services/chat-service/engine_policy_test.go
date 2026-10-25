package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// sessionsProvider hands out one scripted session per NewSession, and records
// the config of each. The first call of a turn and its retry are two sessions.
type sessionsProvider struct {
	sessions []*fakeSession
	cfgs     []SessionConfig
}

func (p *sessionsProvider) Name() string { return "fake" }

func (p *sessionsProvider) NewSession(cfg SessionConfig) (ModelSession, error) {
	p.cfgs = append(p.cfgs, cfg)
	if len(p.cfgs) > len(p.sessions) {
		return nil, errors.New("no scripted session left")
	}
	return p.sessions[len(p.cfgs)-1], nil
}

func (p *sessionsProvider) Close() error { return nil }

// runPolicyTurn runs one turn through the engine, with a counting tool API.
func runPolicyTurn(t *testing.T, provider ChatProvider, forced bool, pricing Pricing, onChunk func(string)) (*LLMResponse, *atomic.Int32, error) {
	t.Helper()
	var executed atomic.Int32
	tools := newTestToolExecutor(httpHandlerCounting(&executed))
	engine := &TurnEngine{tools: tools}
	resp, err := engine.run(context.Background(), turnSpec{
		provider: provider,
		cfg: SessionConfig{
			Model:           "fake-model",
			System:          "system",
			Tools:           chatToolDefinitions(),
			MaxOutputTokens: 256,
		},
		userText:        "question",
		forcedFirstCall: forced,
		meta:            turnMeta{Provider: "fake", Model: "fake-model", Pricing: pricing, Start: time.Now()},
	}, onChunk)
	return resp, &executed, err
}

func collect(out *[]string) func(string) {
	return func(s string) { *out = append(*out, s) }
}

func TestEngineForcedFirstCallRequiresAToolAndNudgesOnlyTheRetry(t *testing.T) {
	first := &fakeSession{replies: []fakeReply{{texts: []string{"I will just answer."}}}}
	retry := &fakeSession{replies: []fakeReply{{calls: []ToolCall{searchCall("c1", "BHP")}}, {texts: []string{"BHP is 4%."}}}}
	provider := &sessionsProvider{sessions: []*fakeSession{first, retry}}

	var emitted []string
	resp, _, err := runPolicyTurn(t, provider, true, Pricing{}, collect(&emitted))
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if resp.FirstCallViolation {
		t.Fatal("FirstCallViolation = true, but the retry chose a tool")
	}
	if strings.Contains(provider.cfgs[0].System, firstCallNudge) {
		t.Fatal("the first call carried the nudge, which only the verify policy and the retry add")
	}
	if !strings.Contains(provider.cfgs[1].System, firstCallNudge) {
		t.Fatalf("the retry's system prompt lacks the nudge: %q", provider.cfgs[1].System)
	}
	if first.sends[0].choice != ToolChoiceRequired || retry.sends[0].choice != ToolChoiceRequired {
		t.Fatalf("forced first calls chose %v and %v, want required on both", first.sends[0].choice, retry.sends[0].choice)
	}
	if strings.Join(emitted, "") != "BHP is 4%." {
		t.Fatalf("emitted %q: the text of the first, violating call must not reach the person", emitted)
	}
}

func TestEngineVerifyPolicyFirstCallIsAutoWithTheNudgeFromTheStart(t *testing.T) {
	session := &fakeSession{replies: []fakeReply{
		{calls: []ToolCall{searchCall("c1", "BHP")}},
		{texts: []string{"done"}},
	}}
	provider := &sessionsProvider{sessions: []*fakeSession{session}}

	resp, _, err := runPolicyTurn(t, provider, false, Pricing{}, func(string) {})
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if !strings.Contains(provider.cfgs[0].System, firstCallNudge) {
		t.Fatalf("the verify policy's first call lacks the nudge: %q", provider.cfgs[0].System)
	}
	if session.sends[0].choice != ToolChoiceAuto {
		t.Fatalf("verify first call chose %v, want auto", session.sends[0].choice)
	}
	if resp.FirstCallViolation {
		t.Fatal("a first call that chose a tool was marked as a violation")
	}
}

func TestEngineFirstCallViolationTwiceFlushesTheRetryText(t *testing.T) {
	first := &fakeSession{replies: []fakeReply{{texts: []string{"first try"}}}}
	retry := &fakeSession{replies: []fakeReply{{texts: []string{"second try"}}}}
	provider := &sessionsProvider{sessions: []*fakeSession{first, retry}}

	var emitted []string
	resp, executed, err := runPolicyTurn(t, provider, true, Pricing{}, collect(&emitted))
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if !resp.FirstCallViolation {
		t.Fatal("FirstCallViolation = false after two text-only first calls")
	}
	if strings.Join(emitted, "|") != "second try" {
		t.Fatalf("emitted %q, want only the retry's text", emitted)
	}
	if executed.Load() != 0 {
		t.Fatalf("a violating turn ran %d tools", executed.Load())
	}
	if len(provider.cfgs) != 2 {
		t.Fatalf("sessions opened = %d, want the first call and one retry", len(provider.cfgs))
	}
}

func TestEngineFirstCallErrorIsNotRetriedAsAViolation(t *testing.T) {
	refused := &ProviderError{Provider: "fake", Reached: false, Err: errors.New("refused")}
	first := &fakeSession{replies: []fakeReply{{err: refused}}}
	provider := &sessionsProvider{sessions: []*fakeSession{first}}

	_, _, err := runPolicyTurn(t, provider, true, Pricing{}, func(string) {})
	if err == nil || modelAnswered(err) {
		t.Fatalf("error = %v, want the refusal before any model answer", err)
	}
	if len(provider.cfgs) != 1 {
		t.Fatalf("sessions opened = %d, want no retry after an error", len(provider.cfgs))
	}
}

func TestEngineBadArgumentsTakeASlotAndGetTheNotice(t *testing.T) {
	bad := ToolCall{ID: "bad", Name: "search_stocks", ArgsError: "not an object"}
	calls := []ToolCall{bad, searchCall("v1", "BHP"), searchCall("v2", "CBA"), searchCall("v3", "WBC"), searchCall("v4", "NAB")}
	session := &fakeSession{replies: []fakeReply{{calls: calls}, {texts: []string{"done"}}}}
	provider := &sessionsProvider{sessions: []*fakeSession{session}}

	_, executed, err := runPolicyTurn(t, provider, true, Pricing{}, func(string) {})
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if executed.Load() != 3 {
		t.Fatalf("executed %d data calls, want 3: the bad call takes slot one, the fifth is over the cap", executed.Load())
	}
	results := session.sends[1].in.ToolResults
	if len(results) != 5 {
		t.Fatalf("results = %d, want one answer per call", len(results))
	}
	if !strings.Contains(resultError(t, results[0].JSON), "not valid JSON") {
		t.Fatalf("bad call's result = %q, want the bad-arguments notice", results[0].JSON)
	}
	if !strings.Contains(resultError(t, results[4].JSON), "Only 4 tool calls") {
		t.Fatalf("fifth call's result = %q, want the over-cap notice", results[4].JSON)
	}
}

func TestEngineAnswerWithoutDataRunsEvenWithBadArguments(t *testing.T) {
	bad := ToolCall{ID: "a", Name: answerWithoutDataTool, ArgsError: "not an object"}
	session := &fakeSession{replies: []fakeReply{{calls: []ToolCall{bad}}, {texts: []string{"done"}}}}
	provider := &sessionsProvider{sessions: []*fakeSession{session}}

	_, executed, err := runPolicyTurn(t, provider, true, Pricing{}, func(string) {})
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if executed.Load() != 0 {
		t.Fatalf("answer_without_data reached the data API %d times", executed.Load())
	}
	if strings.Contains(session.sends[1].in.ToolResults[0].JSON, "not valid JSON") {
		t.Fatal("answer_without_data read its arguments, so its bad JSON should not matter")
	}
}

func TestEngineSumsEstimatedCostOverEveryCall(t *testing.T) {
	first := &fakeSession{replies: []fakeReply{
		{calls: []ToolCall{searchCall("c1", "BHP")}, usage: TokenUsage{PromptTokens: 100, CandidateTokens: 10}},
		{texts: []string{"ok"}, usage: TokenUsage{PromptTokens: 50, CandidateTokens: 5}},
	}}
	provider := &sessionsProvider{sessions: []*fakeSession{first}}
	// Micro-USD per token: 1 for input, 2 for output.
	resp, _, err := runPolicyTurn(t, provider, true, Pricing{Input: 1, Output: 2}, func(string) {})
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if resp.EstCostMicroUSD != (100+20)+(50+10) {
		t.Fatalf("EstCostMicroUSD = %d, want 180", resp.EstCostMicroUSD)
	}
}

func TestPlanRoundCallsBadArgumentsTakeASlot(t *testing.T) {
	bad := ToolCall{ID: "b", Name: "search_stocks", ArgsError: "x"}
	calls := []ToolCall{bad, searchCall("1", "A"), searchCall("2", "B"), searchCall("3", "C"), searchCall("4", "D")}
	got := planRoundCalls(calls, true)
	want := []toolCallDecision{toolCallBadArgs, toolCallExecute, toolCallExecute, toolCallExecute, toolCallOverCap}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("decisions = %v, want %v", got, want)
		}
	}
}

func TestToolCallNoticeForBadArgumentsIsAFunctionError(t *testing.T) {
	msg := resultError(t, mustJSON(t, toolCallNotice(toolCallBadArgs)))
	if !strings.Contains(msg, "valid JSON") {
		t.Fatalf("notice = %q, want the bad-arguments wording", msg)
	}
}

// httpHandlerCounting is a tool API that counts the data calls it receives.
func httpHandlerCounting(n *atomic.Int32) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"stocks":[]}`))
	})
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal %v: %v", v, err)
	}
	return string(b)
}
