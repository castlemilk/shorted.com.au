package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
)

// The engine is tested with a scripted provider. Each Send records its input and
// tool choice, then returns the next scripted reply. The tools run against a
// fake Shorts API that counts the calls it receives.

// fakeReply is one scripted model call.
type fakeReply struct {
	texts []string // streamed as deltas, in order
	calls []ToolCall
	usage TokenUsage
	err   error // a *ProviderError, or nil
}

// fakeSend is one Send the engine made.
type fakeSend struct {
	in     SendInput
	choice ToolChoice
}

type fakeSession struct {
	replies []fakeReply
	sends   []fakeSend
}

func (s *fakeSession) Send(_ context.Context, in SendInput, choice ToolChoice, emit func(ModelEvent)) (ModelReply, error) {
	s.sends = append(s.sends, fakeSend{in: in, choice: choice})
	if len(s.sends) > len(s.replies) {
		return ModelReply{}, &ProviderError{Provider: "fake", Err: errors.New("script exhausted")}
	}
	r := s.replies[len(s.sends)-1]
	reply := ModelReply{ToolCalls: r.calls, Usage: r.usage}
	for _, text := range r.texts {
		emit(ModelEvent{Kind: EventTextDelta, Text: text})
		reply.Text += text
	}
	return reply, r.err
}

type fakeProvider struct{ session *fakeSession }

func (p *fakeProvider) Name() string { return "fake" }

func (p *fakeProvider) NewSession(SessionConfig) (ModelSession, error) { return p.session, nil }

func (p *fakeProvider) Close() error { return nil }

// fakeClient wires the scripted session to the engine, with a tool API that counts
// the data calls it receives.
func fakeClient(t *testing.T, replies ...fakeReply) (*LLMClient, *fakeSession, *atomic.Int32) {
	t.Helper()
	var executed atomic.Int32
	tools := newTestToolExecutor(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		executed.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"stocks":[]}`))
	}))
	session := &fakeSession{replies: replies}
	return newLLMClient(&fakeProvider{session: session}, "fake-model", 0, tools), session, &executed
}

// searchCall is a data call with valid arguments.
func searchCall(id, query string) ToolCall {
	return ToolCall{ID: id, Name: "search_stocks", Args: map[string]any{"query": query}}
}

func noopChunk(string) {}

// resultError decodes the error message of a notice result.
func resultError(t *testing.T, result string) string {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(result), &m); err != nil {
		t.Fatalf("result %q is not JSON: %v", result, err)
	}
	msg, _ := m["error"].(string)
	return msg
}

func TestEngineChoosesRequiredThenAutoThenNoneWhenBudgetIsSpent(t *testing.T) {
	// Six replies each ask for one data call. Rounds 0 to 4 run them, and round 5
	// has no budget, so its call is refused. The last reply is text.
	var replies []fakeReply
	for i := range maxToolRounds + 1 {
		replies = append(replies, fakeReply{calls: []ToolCall{searchCall("c"+string(rune('0'+i)), "BHP")}})
	}
	replies = append(replies, fakeReply{texts: []string{"done"}})
	client, session, executed := fakeClient(t, replies...)

	resp, err := client.ChatStream(context.Background(), "system", nil, "question", noopChunk)
	if err != nil {
		t.Fatalf("ChatStream() error = %v", err)
	}

	var choices []ToolChoice
	for _, s := range session.sends {
		choices = append(choices, s.choice)
	}
	want := []ToolChoice{
		ToolChoiceRequired,
		ToolChoiceAuto, ToolChoiceAuto, ToolChoiceAuto, ToolChoiceAuto, ToolChoiceAuto,
		ToolChoiceNone,
	}
	if !slices.Equal(choices, want) {
		t.Fatalf("choices = %v, want %v", choices, want)
	}

	last := session.sends[len(session.sends)-1].in.ToolResults
	if len(last) != 1 || !strings.Contains(resultError(t, last[0].JSON), "tool budget for this reply is spent") {
		t.Fatalf("last round results = %+v, want one no-budget notice", last)
	}
	if got := executed.Load(); got != maxToolRounds {
		t.Fatalf("tool API calls = %d, want %d: one per round with budget", got, maxToolRounds)
	}
	if len(resp.ToolCalls) != maxToolRounds {
		t.Fatalf("recorded tool calls = %d, want %d", len(resp.ToolCalls), maxToolRounds)
	}
}

func TestEngineRunsAtMostTheCapPerRoundAndNoticesTheRest(t *testing.T) {
	var calls []ToolCall
	for i := range 6 {
		calls = append(calls, searchCall(string(rune('a'+i)), "BHP"))
	}
	client, session, executed := fakeClient(t,
		fakeReply{calls: calls},
		fakeReply{texts: []string{"answer"}},
	)

	resp, err := client.ChatStream(context.Background(), "system", nil, "question", noopChunk)
	if err != nil {
		t.Fatalf("ChatStream() error = %v", err)
	}
	if got := executed.Load(); got != maxToolCallsPerRound {
		t.Fatalf("tool API calls = %d, want %d", got, maxToolCallsPerRound)
	}
	if len(resp.ToolCalls) != maxToolCallsPerRound {
		t.Fatalf("recorded tool calls = %d, want %d", len(resp.ToolCalls), maxToolCallsPerRound)
	}

	results := session.sends[1].in.ToolResults
	if len(results) != 6 {
		t.Fatalf("results = %d, want one per requested call (6)", len(results))
	}
	for i := range maxToolCallsPerRound {
		if strings.Contains(results[i].JSON, `"error"`) {
			t.Fatalf("result %d = %s, want the executed tool result", i, results[i].JSON)
		}
	}
	for i := maxToolCallsPerRound; i < 6; i++ {
		if !strings.Contains(resultError(t, results[i].JSON), "Only 4 tool calls run per reply") {
			t.Fatalf("result %d = %s, want the over-cap notice", i, results[i].JSON)
		}
	}
}

func TestEngineAnswerWithoutDataIsNotRecordedAndTakesNoSlot(t *testing.T) {
	// answer_without_data runs at once and takes no cap slot, so the fifth data
	// call is the one refused.
	calls := []ToolCall{
		{ID: "a", Name: answerWithoutDataTool, Args: map[string]any{}},
		searchCall("b", "BHP"),
		searchCall("c", "CBA"),
		{ID: "d", Name: answerWithoutDataTool, Args: map[string]any{}},
		searchCall("e", "WBC"),
		searchCall("f", "NAB"),
		searchCall("g", "ANZ"),
	}
	client, session, executed := fakeClient(t,
		fakeReply{calls: calls},
		fakeReply{texts: []string{"answer"}},
	)

	resp, err := client.ChatStream(context.Background(), "system", nil, "question", noopChunk)
	if err != nil {
		t.Fatalf("ChatStream() error = %v", err)
	}
	if got := executed.Load(); got != maxToolCallsPerRound {
		t.Fatalf("tool API calls = %d, want %d: answer_without_data makes no request", got, maxToolCallsPerRound)
	}
	for _, tc := range resp.ToolCalls {
		if tc.Name == answerWithoutDataTool {
			t.Fatalf("recorded tool calls include answer_without_data: %+v", resp.ToolCalls)
		}
	}
	results := session.sends[1].in.ToolResults
	if results[0].JSON != answerWithoutDataResult || results[3].JSON != answerWithoutDataResult {
		t.Fatalf("answer_without_data results = %q, %q, want the fixed result", results[0].JSON, results[3].JSON)
	}
	if !strings.Contains(resultError(t, results[6].JSON), "Only 4 tool calls run per reply") {
		t.Fatalf("fifth data call result = %s, want the over-cap notice", results[6].JSON)
	}
}

func TestEngineRoundFiveAnswersEveryCallThenStops(t *testing.T) {
	var replies []fakeReply
	for range maxToolRounds {
		replies = append(replies, fakeReply{calls: []ToolCall{searchCall("x", "BHP")}})
	}
	// The reply to round 4 asks for three more calls, and round 5 runs none of
	// them. The model then asks again in its answer to the notices. The turn must
	// stop there and not send another request: the script has no reply left, so
	// a further send fails the turn.
	replies = append(replies,
		fakeReply{calls: []ToolCall{searchCall("y", "BHP"), searchCall("z", "CBA"), searchCall("w", "WBC")}},
		fakeReply{calls: []ToolCall{searchCall("v", "NAB")}},
	)
	client, session, executed := fakeClient(t, replies...)

	resp, err := client.ChatStream(context.Background(), "system", nil, "question", noopChunk)
	if err != nil {
		t.Fatalf("ChatStream() error = %v: the turn must stop after round 5, not ask again", err)
	}
	if len(session.sends) != maxToolRounds+2 {
		t.Fatalf("model calls = %d, want %d: first call, five rounds, then the notice round", len(session.sends), maxToolRounds+2)
	}
	if got := executed.Load(); got != maxToolRounds {
		t.Fatalf("tool API calls = %d, want %d: round 5 runs nothing", got, maxToolRounds)
	}
	if len(resp.ToolCalls) != maxToolRounds {
		t.Fatalf("recorded tool calls = %d, want %d", len(resp.ToolCalls), maxToolRounds)
	}
	last := session.sends[len(session.sends)-1]
	if last.choice != ToolChoiceNone {
		t.Fatalf("final call choice = %v, want None", last.choice)
	}
	if len(last.in.ToolResults) != 3 {
		t.Fatalf("final results = %d, want 3: every call gets an answer", len(last.in.ToolResults))
	}
	for _, r := range last.in.ToolResults {
		if !strings.Contains(resultError(t, r.JSON), "tool budget for this reply is spent") {
			t.Fatalf("result %+v, want the no-budget notice", r)
		}
	}
}

func TestEngineModelReachedFollowsTheFirstCallOnly(t *testing.T) {
	refused := &ProviderError{Provider: "fake", Reached: false, Err: errors.New("refused before any response")}
	reached := &ProviderError{Provider: "fake", Reached: true, Err: errors.New("failed mid-stream")}

	t.Run("first call refused before any response is not reached", func(t *testing.T) {
		client, _, _ := fakeClient(t, fakeReply{err: refused})
		_, err := client.ChatStream(context.Background(), "system", nil, "question", noopChunk)
		if err == nil || modelAnswered(err) {
			t.Fatalf("error = %v, want a failure the model did not answer", err)
		}
	})

	t.Run("first call failing after a response is reached", func(t *testing.T) {
		client, _, _ := fakeClient(t, fakeReply{err: reached})
		_, err := client.ChatStream(context.Background(), "system", nil, "question", noopChunk)
		if !modelAnswered(err) {
			t.Fatalf("error = %v, want the model reached", err)
		}
	})

	t.Run("a tool round failure is always reached", func(t *testing.T) {
		client, _, _ := fakeClient(t,
			fakeReply{calls: []ToolCall{searchCall("c", "BHP")}},
			fakeReply{err: refused},
		)
		_, err := client.ChatStream(context.Background(), "system", nil, "question", noopChunk)
		if !modelAnswered(err) {
			t.Fatalf("error = %v, want the model reached: tool rounds run after an answer", err)
		}
	})
}

func TestEngineStreamsTextInOrderAcrossCalls(t *testing.T) {
	client, _, _ := fakeClient(t,
		fakeReply{texts: []string{"Let me ", "check."}, calls: []ToolCall{searchCall("c", "BHP")}},
		fakeReply{texts: []string{"BHP ", "is 4%."}},
	)
	var got []string
	if _, err := client.ChatStream(context.Background(), "system", nil, "question", func(s string) { got = append(got, s) }); err != nil {
		t.Fatalf("ChatStream() error = %v", err)
	}
	if want := []string{"Let me ", "check.", "BHP ", "is 4%."}; !slices.Equal(got, want) {
		t.Fatalf("chunks = %q, want %q", got, want)
	}
}

func TestEngineSumsUsageOverEveryModelCall(t *testing.T) {
	client, _, _ := fakeClient(t,
		fakeReply{calls: []ToolCall{searchCall("c", "BHP")}, usage: TokenUsage{PromptTokens: 100, CandidateTokens: 10}},
		fakeReply{texts: []string{"ok"}, usage: TokenUsage{PromptTokens: 200, CachedPromptTokens: 50, CandidateTokens: 20, TotalTokens: 220}},
	)
	resp, err := client.ChatStream(context.Background(), "system", nil, "question", noopChunk)
	if err != nil {
		t.Fatalf("ChatStream() error = %v", err)
	}
	want := TokenUsage{PromptTokens: 300, CachedPromptTokens: 50, CandidateTokens: 30, TotalTokens: 220}
	if resp.Usage != want {
		t.Fatalf("usage = %+v, want %+v", resp.Usage, want)
	}
}

func TestEngineRecordsOnlyDataCallsAsToolRuns(t *testing.T) {
	var logged bytes.Buffer
	oldOutput := log.Writer()
	log.SetOutput(&logged)
	defer log.SetOutput(oldOutput)

	client, _, _ := fakeClient(t,
		fakeReply{calls: []ToolCall{{ID: "a", Name: answerWithoutDataTool, Args: map[string]any{}}}},
		fakeReply{texts: []string{"ok"}},
	)
	resp, err := client.ChatStream(context.Background(), "system", nil, "question", noopChunk)
	if err != nil {
		t.Fatalf("ChatStream() error = %v", err)
	}
	if len(resp.ToolCalls) != 0 || strings.Contains(logged.String(), "chat_tool_call") {
		t.Fatalf("tool calls = %+v, log = %q: answer_without_data is neither shown nor counted", resp.ToolCalls, logged.String())
	}
}

// The planning tests below are the pure decisions the engine makes.

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

func TestToolCallNoticeIsAFunctionErrorTheModelCanRead(t *testing.T) {
	for _, d := range []toolCallDecision{toolCallOverCap, toolCallNoBudget} {
		notice := toolCallNotice(d)
		message, ok := notice["error"].(string)
		if !ok || message == "" {
			t.Fatalf("toolCallNotice(%v) = %v, want a non-empty error message", d, notice)
		}
	}
}

func TestChoiceForCallSelectsTheChoiceForEachModelCall(t *testing.T) {
	tests := []struct {
		name      string
		firstCall bool
		budget    bool
		want      ToolChoice
	}{
		{name: "first call with budget must choose a tool", firstCall: true, budget: true, want: ToolChoiceRequired},
		{name: "first call without budget still must choose a tool", firstCall: true, budget: false, want: ToolChoiceRequired},
		{name: "later call with budget is auto", firstCall: false, budget: true, want: ToolChoiceAuto},
		{name: "later call without budget answers in text", firstCall: false, budget: false, want: ToolChoiceNone},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := choiceForCall(test.firstCall, test.budget); got != test.want {
				t.Fatalf("choiceForCall(%v, %v) = %v, want %v", test.firstCall, test.budget, got, test.want)
			}
		})
	}
}

func TestPlanRoundCallsKeepsAnswerWithoutDataOutOfTheCap(t *testing.T) {
	// Five data calls, two of them answer_without_data. The local calls take no
	// cap slot, so only the fifth data call is refused.
	calls := toolCalls(
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
	got := planRoundCalls(toolCalls(answerWithoutDataTool, "get_news"), false)

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

// toolCalls builds the calls one model response asked for, by tool name.
func toolCalls(names ...string) []ToolCall {
	calls := make([]ToolCall, 0, len(names))
	for _, name := range names {
		calls = append(calls, ToolCall{Name: name})
	}
	return calls
}

// Engine: a first-call violation is billed, and the nudged retry then fails before
// the model. The turn must count as reached (it billed a call). Guards withBilled's
// ModelReached flip, which no router test reaches.
func TestEngineViolationThenPreModelFailureCountsAsReached(t *testing.T) {
	p := &routeProvider{name: "primary", plans: func(n int) []fakeReply {
		if n == 1 {
			return []fakeReply{{texts: []string{"no tool"}, usage: TokenUsage{PromptTokens: 5, CandidateTokens: 2}}}
		}
		return []fakeReply{{err: failedCall(false, true, 503)}}
	}}
	r, _ := routerFor(p, nil, 0)
	_, shown, err := runTurn(r)
	if err == nil {
		t.Fatal("RunTurn() succeeded")
	}
	if !modelAnswered(err) {
		t.Fatal("a turn whose first call was billed reports failed_before_model")
	}
	if p.sessions() != 2 {
		t.Fatalf("sessions = %d, want 2 (first call, nudged retry) and no same-provider re-run", p.sessions())
	}
	if shown != "" {
		t.Fatalf("shown = %q, want nothing", shown)
	}
	var pe *ProviderError
	if !errors.As(err, &pe) {
		t.Fatalf("error lost its ProviderError: %v", err)
	}
}
