package main

import (
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
	for i := 0; i < maxToolCallsPerRound; i++ {
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
	for round := 0; round < maxToolRounds; round++ {
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
