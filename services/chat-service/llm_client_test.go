package main

import (
	"bytes"
	"context"
	"log"
	"strings"
	"testing"

	"github.com/google/generative-ai-go/genai"
)

// The streaming loop itself needs a live Gemini client, which genai does not
// let a test replace. Its decisions are pure functions, and those are what
// these tests pin: how many calls run, what each refused call is answered with,
// and when the model is forced to answer in text.

func TestPlanToolCallsRunsAtMostTheCapPerRound(t *testing.T) {
	decisions := planToolCalls(6, true)

	if len(decisions) != 6 {
		t.Fatalf("decisions = %d, want one per requested call (6)", len(decisions))
	}
	for i := range maxToolCallsPerRound {
		if decisions[i] != toolCallExecute {
			t.Fatalf("call %d = %v, want execute", i, decisions[i])
		}
	}
	for i := maxToolCallsPerRound; i < 6; i++ {
		if decisions[i] != toolCallOverCap {
			t.Fatalf("call %d = %v, want over-cap refusal", i, decisions[i])
		}
	}
}

func TestPlanToolCallsAnswersEveryCallWhenTheRoundHasNoBudget(t *testing.T) {
	decisions := planToolCalls(3, false)

	if len(decisions) != 3 {
		t.Fatalf("decisions = %d, want 3: every call still needs a response", len(decisions))
	}
	for i, d := range decisions {
		if d != toolCallNoBudget {
			t.Fatalf("call %d = %v, want no-budget refusal", i, d)
		}
	}
}

func TestPlanToolCallsForNoCallsIsEmpty(t *testing.T) {
	if got := planToolCalls(0, true); len(got) != 0 {
		t.Fatalf("planToolCalls(0) = %v, want empty", got)
	}
}

func TestRoundHasBudgetAllowsExactlyTheToolRounds(t *testing.T) {
	for round := range maxToolRounds {
		if !roundHasBudget(round) {
			t.Fatalf("roundHasBudget(%d) = false, want true", round)
		}
	}
	if roundHasBudget(maxToolRounds) {
		t.Fatalf("roundHasBudget(%d) = true, want false: that round is the text-only answer", maxToolRounds)
	}
}

func TestToolConfigFinalRoundDisablesFunctionCalling(t *testing.T) {
	if got := toolConfigFor(true); got != nil {
		t.Fatalf("toolConfigFor(true) = %+v, want nil so the model keeps its tools", got)
	}

	got := toolConfigFor(false)
	if got == nil || got.FunctionCallingConfig == nil {
		t.Fatalf("toolConfigFor(false) = %+v, want a function calling config", got)
	}
	if got.FunctionCallingConfig.Mode != genai.FunctionCallingNone {
		t.Fatalf("mode = %v, want FunctionCallingNone so the model answers in text", got.FunctionCallingConfig.Mode)
	}
}

func TestToolCallNoticeIsAFunctionErrorTheModelCanRead(t *testing.T) {
	for _, d := range []toolCallDecision{toolCallOverCap, toolCallNoBudget} {
		notice := toolCallNotice(d)
		message, ok := notice["error"].(string)
		if !ok || message == "" {
			t.Fatalf("toolCallNotice(%v) = %v, want a non-empty error message", d, notice)
		}
	}
}

func TestToolConfigForCallSelectsTheModeForEachModelCall(t *testing.T) {
	tests := []struct {
		name      string
		firstCall bool
		budget    bool
		// wantMode is the mode the config must carry. wantNil means no config at
		// all, which is AUTO, the model's default.
		wantMode genai.FunctionCallingMode
		wantNil  bool
	}{
		{name: "first call with budget must choose a tool", firstCall: true, budget: true, wantMode: genai.FunctionCallingAny},
		{name: "first call without budget still must choose a tool", firstCall: true, budget: false, wantMode: genai.FunctionCallingAny},
		{name: "later call with budget is auto", firstCall: false, budget: true, wantNil: true},
		{name: "later call without budget answers in text", firstCall: false, budget: false, wantMode: genai.FunctionCallingNone},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := toolConfigForCall(test.firstCall, test.budget)
			if test.wantNil {
				if got != nil {
					t.Fatalf("toolConfigForCall(%v, %v) = %+v, want nil (AUTO)", test.firstCall, test.budget, got)
				}
				return
			}
			if got == nil || got.FunctionCallingConfig == nil {
				t.Fatalf("toolConfigForCall(%v, %v) = %+v, want a function calling config", test.firstCall, test.budget, got)
			}
			if got.FunctionCallingConfig.Mode != test.wantMode {
				t.Fatalf("mode = %v, want %v", got.FunctionCallingConfig.Mode, test.wantMode)
			}
		})
	}
}

// fakeCalls builds the calls one model response asked for, by tool name.
func fakeCalls(names ...string) []*genai.FunctionCall {
	calls := make([]*genai.FunctionCall, 0, len(names))
	for _, name := range names {
		calls = append(calls, &genai.FunctionCall{Name: name})
	}
	return calls
}

func TestPlanRoundCallsKeepsAnswerWithoutDataOutOfTheCap(t *testing.T) {
	// Five data calls, two of them answer_without_data. The local calls take no
	// cap slot, so only the fifth data call is refused.
	calls := fakeCalls(
		answerWithoutDataTool,
		"get_top_shorts",
		"get_stock_details",
		"search_stocks",
		"get_news",
		answerWithoutDataTool,
		"get_director_trades",
	)
	got := planRoundCalls(calls, true)

	want := []toolCallDecision{
		toolCallExecute, toolCallExecute, toolCallExecute, toolCallExecute, toolCallExecute,
		toolCallExecute, toolCallOverCap,
	}
	if len(got) != len(want) {
		t.Fatalf("decisions = %d, want %d: one per requested call", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("call %d (%s) = %v, want %v", i, calls[i].Name, got[i], want[i])
		}
	}
}

func TestPlanRoundCallsRunsAnswerWithoutDataWhenTheRoundHasNoBudget(t *testing.T) {
	got := planRoundCalls(fakeCalls(answerWithoutDataTool, "get_news"), false)

	if got[0] != toolCallExecute {
		t.Fatalf("answer_without_data = %v, want execute: it needs no budget", got[0])
	}
	if got[1] != toolCallNoBudget {
		t.Fatalf("get_news = %v, want no-budget refusal", got[1])
	}
}

func TestRecordToolRunKeepsAnswerWithoutDataOutOfCallsAndMetrics(t *testing.T) {
	var logged bytes.Buffer
	oldOutput := log.Writer()
	log.SetOutput(&logged)
	defer log.SetOutput(oldOutput)

	ctx := context.Background()
	calls := recordToolRun(ctx, nil, answerWithoutDataTool, map[string]any{}, answerWithoutDataResult, "success")
	if len(calls) != 0 {
		t.Fatalf("tool calls = %+v, want none: answer_without_data is not shown to the person", calls)
	}
	if logged.Len() != 0 {
		t.Fatalf("log = %q, want no tool-call metric for answer_without_data", logged.String())
	}

	calls = recordToolRun(ctx, calls, "get_stock_details", map[string]any{"stock_code": "X"}, `{"name":"X"}`, "success")
	if len(calls) != 1 || calls[0].Name != "get_stock_details" || calls[0].Result != `{"name":"X"}` {
		t.Fatalf("tool calls = %+v, want the one data call", calls)
	}
	if !strings.Contains(logged.String(), `"event_type":"chat_tool_call"`) {
		t.Fatalf("log = %q, want a chat_tool_call metric for the data call", logged.String())
	}
}
