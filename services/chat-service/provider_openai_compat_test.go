package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

const oaTestKey = "sk-test-SECRET-KEY-123"

// oaRecorder keeps the body of every request a fake provider received.
type oaRecorder struct {
	mu     sync.Mutex
	bodies [][]byte
}

// body decodes request i.
func (r *oaRecorder) body(t *testing.T, i int) map[string]any {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	if i >= len(r.bodies) {
		t.Fatalf("request %d was not made (%d made)", i, len(r.bodies))
	}
	var m map[string]any
	if err := json.Unmarshal(r.bodies[i], &m); err != nil {
		t.Fatalf("request %d is not JSON: %v", i, err)
	}
	return m
}

// rawBody returns request i's bytes, for checks that look at the whole body.
func (r *oaRecorder) rawBody(i int) []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.bodies[i]
}

// scriptedReply is one canned response. file names a fixture under testdata/sse.
type scriptedReply struct {
	status int
	file   string
	raw    string
}

// oaServer answers each request with the next scripted reply, repeating the last.
func oaServer(t *testing.T, replies ...scriptedReply) (*httptest.Server, *oaRecorder) {
	t.Helper()
	rec := &oaRecorder{}
	var n int
	var nMu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		rec.mu.Lock()
		rec.bodies = append(rec.bodies, body)
		rec.mu.Unlock()

		nMu.Lock()
		i := n
		n++
		nMu.Unlock()
		if i >= len(replies) {
			i = len(replies) - 1
		}
		reply := replies[i]
		status := reply.status
		if status == 0 {
			status = http.StatusOK
		}
		payload := reply.raw
		if reply.file != "" {
			payload = readOAFixture(t, reply.file)
		}
		if status == http.StatusOK && reply.file != "" && strings.HasSuffix(reply.file, ".sse") {
			w.Header().Set("Content-Type", "text/event-stream")
		} else {
			w.Header().Set("Content-Type", "application/json")
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, payload)
	}))
	t.Cleanup(srv.Close)
	return srv, rec
}

func readOAFixture(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "sse", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return string(data)
}

// newOAProvider builds a catalog provider against a fake endpoint.
func newOAProvider(t *testing.T, name, baseURL string) *openAICompatProvider {
	t.Helper()
	spec, ok := lookupProvider(name)
	if !ok {
		t.Fatalf("provider %q is not in the catalog", name)
	}
	p, err := newOpenAICompatProvider(spec, baseURL, oaTestKey, nil)
	if err != nil {
		t.Fatalf("newOpenAICompatProvider() error = %v", err)
	}
	return p
}

// oaConfig is a turn with a system prompt, two history messages and the real tools.
func oaConfig(model string) SessionConfig {
	return SessionConfig{
		Model:           model,
		System:          "sys",
		History:         []Message{{Role: "user", Content: "earlier question"}, {Role: "assistant", Content: "earlier answer"}, {Role: "tool", Content: "dropped"}, {Role: "user", Content: ""}},
		Tools:           chatToolDefinitions(),
		MaxOutputTokens: 512,
		EndUser:         endUserID("uid-123"),
	}
}

// sendOnce starts a session and makes its first call.
func sendOnce(t *testing.T, p *openAICompatProvider, cfg SessionConfig, choice ToolChoice) (ModelReply, []string, error) {
	t.Helper()
	session, err := p.NewSession(cfg)
	if err != nil {
		t.Fatalf("NewSession() error = %v", err)
	}
	var deltas []string
	reply, err := session.Send(context.Background(), SendInput{UserText: "question"}, choice, func(ev ModelEvent) {
		deltas = append(deltas, ev.Text)
	})
	return reply, deltas, err
}

// messagesOf returns the messages of request i.
func messagesOf(t *testing.T, rec *oaRecorder, i int) []map[string]any {
	t.Helper()
	raw, ok := rec.body(t, i)["messages"].([]any)
	if !ok {
		t.Fatalf("request %d has no messages array", i)
	}
	out := make([]map[string]any, 0, len(raw))
	for _, m := range raw {
		out = append(out, m.(map[string]any))
	}
	return out
}

// --- request body -----------------------------------------------------------

func TestOpenAICompatFirstCallSendsRequiredAndStreamOptions(t *testing.T) {
	srv, rec := oaServer(t, scriptedReply{file: "text_only.sse"})
	p := newOAProvider(t, "deepseek", srv.URL)

	if _, _, err := sendOnce(t, p, oaConfig("deepseek-flash"), ToolChoiceRequired); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	body := rec.body(t, 0)
	if body["tool_choice"] != "required" {
		t.Fatalf("tool_choice = %v, want required on the first call", body["tool_choice"])
	}
	if body["stream"] != true {
		t.Fatalf("stream = %v, want true", body["stream"])
	}
	opts, _ := body["stream_options"].(map[string]any)
	if opts["include_usage"] != true {
		t.Fatalf("stream_options = %v, want include_usage", body["stream_options"])
	}
	if body["max_tokens"] != float64(512) {
		t.Fatalf("max_tokens = %v, want 512", body["max_tokens"])
	}
	if _, set := body["temperature"]; set {
		t.Fatal("temperature was sent with no temperature set")
	}
	msgs := messagesOf(t, rec, 0)
	wantRoles := []string{"system", "user", "assistant", "user"}
	if len(msgs) != len(wantRoles) {
		t.Fatalf("messages = %d, want %d (system, two history messages, the turn): %v", len(msgs), len(wantRoles), msgs)
	}
	for i, role := range wantRoles {
		if msgs[i]["role"] != role {
			t.Fatalf("message %d role = %v, want %s", i, msgs[i]["role"], role)
		}
	}
	if msgs[0]["content"] != "sys" || msgs[3]["content"] != "question" {
		t.Fatalf("system or turn text is wrong: %v", msgs)
	}
}

func TestOpenAICompatBudgetSpentSendsNone(t *testing.T) {
	srv, rec := oaServer(t, scriptedReply{file: "text_only.sse"})
	p := newOAProvider(t, "deepseek", srv.URL)
	if _, _, err := sendOnce(t, p, oaConfig("deepseek-flash"), ToolChoiceNone); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if got := rec.body(t, 0)["tool_choice"]; got != "none" {
		t.Fatalf("tool_choice = %v, want none once the budget is spent", got)
	}
}

func TestOpenAICompatChoiceValuesOnTheWire(t *testing.T) {
	cases := map[ToolChoice]string{ToolChoiceAuto: "auto", ToolChoiceRequired: "required", ToolChoiceNone: "none"}
	for choice, want := range cases {
		srv, rec := oaServer(t, scriptedReply{file: "text_only.sse"})
		p := newOAProvider(t, "openrouter", srv.URL)
		if _, _, err := sendOnce(t, p, oaConfig("openai/gpt-5-mini"), choice); err != nil {
			t.Fatalf("Send() error = %v", err)
		}
		if got := rec.body(t, 0)["tool_choice"]; got != want {
			t.Fatalf("choice %d sent %v, want %s", choice, got, want)
		}
	}
}

func TestDeepSeekAlwaysDisablesThinking(t *testing.T) {
	for _, choice := range []ToolChoice{ToolChoiceRequired, ToolChoiceAuto, ToolChoiceNone} {
		srv, rec := oaServer(t, scriptedReply{file: "text_only.sse"})
		p := newOAProvider(t, "deepseek", srv.URL)
		if _, _, err := sendOnce(t, p, oaConfig("deepseek-flash"), choice); err != nil {
			t.Fatalf("Send() error = %v", err)
		}
		thinking, _ := rec.body(t, 0)["thinking"].(map[string]any)
		if thinking["type"] != "disabled" {
			t.Fatalf("choice %d: thinking = %v, want type disabled on every call", choice, rec.body(t, 0)["thinking"])
		}
	}
}

func TestOtherProvidersDoNotSendDeepSeekThinking(t *testing.T) {
	srv, rec := oaServer(t, scriptedReply{file: "text_only.sse"})
	p := newOAProvider(t, "openrouter", srv.URL)
	if _, _, err := sendOnce(t, p, oaConfig("openai/gpt-5-mini"), ToolChoiceRequired); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if _, set := rec.body(t, 0)["thinking"]; set {
		t.Fatal("thinking was sent to a provider that has no thinking switch")
	}
}

var pseudonymousUser = regexp.MustCompile(`^u_[0-9a-f]{24}$`)

func TestDeepSeekUserIDIsPseudonymousAndNeverTheRawUID(t *testing.T) {
	srv, rec := oaServer(t, scriptedReply{file: "text_only.sse"})
	p := newOAProvider(t, "deepseek", srv.URL)
	if _, _, err := sendOnce(t, p, oaConfig("deepseek-flash"), ToolChoiceRequired); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	body := rec.body(t, 0)
	userID, _ := body["user_id"].(string)
	if !pseudonymousUser.MatchString(userID) {
		t.Fatalf("user_id = %q, want u_ and 24 hex digits", userID)
	}
	if strings.Contains(string(rec.rawBody(0)), "uid-123") {
		t.Fatal("the raw uid reached the request body")
	}
	if _, set := body["user"]; set {
		t.Fatal("DeepSeek received the OpenRouter user field")
	}
}

func TestEndUserIDIsStableAndDependsOnlyOnTheUID(t *testing.T) {
	first, again := endUserID("uid-123"), endUserID("uid-123")
	if first != again {
		t.Fatal("endUserID is not stable")
	}
	if endUserID("uid-123") == endUserID("uid-456") {
		t.Fatal("two users share an end-user id")
	}
	if !pseudonymousUser.MatchString(endUserID("uid-123")) {
		t.Fatalf("endUserID = %q does not match the pseudonymous form", endUserID("uid-123"))
	}
}

func TestOpenRouterSendsRoutingPreferencesAndTheUserField(t *testing.T) {
	srv, rec := oaServer(t, scriptedReply{file: "text_only.sse"})
	p := newOAProvider(t, "openrouter", srv.URL)
	cfg := oaConfig("deepseek/deepseek-v4-flash")
	cfg.Params = ModelParams{OpenRouterOnly: []string{"deepinfra", "azure"}}
	if _, _, err := sendOnce(t, p, cfg, ToolChoiceRequired); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	body := rec.body(t, 0)
	prefs, _ := body["provider"].(map[string]any)
	if prefs["require_parameters"] != true {
		t.Fatalf("provider = %v, want require_parameters true", body["provider"])
	}
	only, _ := prefs["only"].([]any)
	if len(only) != 2 || only[0] != "deepinfra" || only[1] != "azure" {
		t.Fatalf("provider.only = %v, want [deepinfra azure]", prefs["only"])
	}
	if prefs["data_collection"] != "deny" {
		t.Fatalf("provider.data_collection = %v, want deny", prefs["data_collection"])
	}
	if body["user"] != endUserID("uid-123") {
		t.Fatalf("user = %v, want the pseudonymous id", body["user"])
	}
	if _, set := body["user_id"]; set {
		t.Fatal("OpenRouter received the DeepSeek user_id field")
	}
}

func TestNoToolIsSentAsStrict(t *testing.T) {
	srv, rec := oaServer(t, scriptedReply{file: "text_only.sse"})
	p := newOAProvider(t, "deepseek", srv.URL)
	if _, _, err := sendOnce(t, p, oaConfig("deepseek-flash"), ToolChoiceRequired); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if strings.Contains(string(rec.rawBody(0)), `"strict"`) {
		t.Fatal(`a "strict" field reached the request body`)
	}
}

func TestToolWithoutParametersGetsAnEmptyObjectSchema(t *testing.T) {
	srv, rec := oaServer(t, scriptedReply{file: "text_only.sse"})
	p := newOAProvider(t, "deepseek", srv.URL)
	cfg := oaConfig("deepseek-flash")
	cfg.Tools = []ToolDefinition{{Name: "no_args", Description: "takes nothing"}}
	if _, _, err := sendOnce(t, p, cfg, ToolChoiceRequired); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	tools, _ := rec.body(t, 0)["tools"].([]any)
	fn := tools[0].(map[string]any)["function"].(map[string]any)
	params, _ := json.Marshal(fn["parameters"])
	if string(params) != `{"properties":{},"type":"object"}` {
		t.Fatalf("parameters = %s, want an object with no properties", params)
	}
	if tools[0].(map[string]any)["type"] != "function" {
		t.Fatalf("tool type = %v, want function", tools[0].(map[string]any)["type"])
	}
}

func TestTemperatureIsSentOnlyWhenSet(t *testing.T) {
	srv, rec := oaServer(t, scriptedReply{file: "text_only.sse"}, scriptedReply{file: "text_only.sse"})
	p := newOAProvider(t, "deepseek", srv.URL)
	if _, _, err := sendOnce(t, p, oaConfig("deepseek-flash"), ToolChoiceRequired); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	cfg := oaConfig("deepseek-flash")
	temp := 0.2
	cfg.Params.Temperature = &temp
	if _, _, err := sendOnce(t, p, cfg, ToolChoiceRequired); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if rec.body(t, 1)["temperature"] != 0.2 {
		t.Fatalf("temperature = %v, want 0.2 when it is set", rec.body(t, 1)["temperature"])
	}
}

func TestToolCallIDsAndResultsReplayInOrder(t *testing.T) {
	srv, rec := oaServer(t, scriptedReply{file: "parallel_tool_calls.sse"}, scriptedReply{file: "text_only.sse"})
	p := newOAProvider(t, "deepseek", srv.URL)
	session, err := p.NewSession(oaConfig("deepseek-flash"))
	if err != nil {
		t.Fatalf("NewSession() error = %v", err)
	}
	reply, err := session.Send(context.Background(), SendInput{UserText: "question"}, ToolChoiceRequired, func(ModelEvent) {})
	if err != nil {
		t.Fatalf("first Send() error = %v", err)
	}
	if len(reply.ToolCalls) != 2 || reply.ToolCalls[0].ID != "call_1" || reply.ToolCalls[1].ID != "call_2" {
		t.Fatalf("tool calls = %+v, want call_1 then call_2", reply.ToolCalls)
	}
	results := []ToolResult{{CallID: "call_1", Name: "query_short_positions", JSON: `{"a":1}`}, {CallID: "call_2", Name: "get_stock_details", JSON: `{"b":2}`}}
	if _, err := session.Send(context.Background(), SendInput{ToolResults: results}, ToolChoiceAuto, func(ModelEvent) {}); err != nil {
		t.Fatalf("second Send() error = %v", err)
	}

	msgs := messagesOf(t, rec, 1)
	n := len(msgs)
	if n < 6 {
		t.Fatalf("second request has %d messages, want the transcript", n)
	}
	asst := msgs[n-3]
	if asst["role"] != "assistant" {
		t.Fatalf("message before the results is %v, want the assistant's calls", asst["role"])
	}
	if _, set := asst["content"]; set {
		t.Fatalf("assistant message carries content %v although it only called tools", asst["content"])
	}
	calls, _ := asst["tool_calls"].([]any)
	if len(calls) != 2 || calls[0].(map[string]any)["id"] != "call_1" || calls[1].(map[string]any)["id"] != "call_2" {
		t.Fatalf("assistant tool_calls = %v, want call_1 then call_2", asst["tool_calls"])
	}
	if calls[0].(map[string]any)["function"].(map[string]any)["arguments"] != `{"productCode": "BHP"}` {
		t.Fatalf("the transcript did not replay the raw argument text: %v", calls[0])
	}
	if msgs[n-2]["role"] != "tool" || msgs[n-2]["tool_call_id"] != "call_1" || msgs[n-2]["content"] != `{"a":1}` {
		t.Fatalf("first tool message = %v, want call_1's result", msgs[n-2])
	}
	if msgs[n-1]["role"] != "tool" || msgs[n-1]["tool_call_id"] != "call_2" || msgs[n-1]["content"] != `{"b":2}` {
		t.Fatalf("second tool message = %v, want call_2's result", msgs[n-1])
	}
	if got := rec.body(t, 1)["tool_choice"]; got != "auto" {
		t.Fatalf("second call tool_choice = %v, want auto", got)
	}
}

func TestEmptyHistoryMessagesAreNotSent(t *testing.T) {
	srv, rec := oaServer(t, scriptedReply{file: "text_only.sse"})
	p := newOAProvider(t, "deepseek", srv.URL)
	if _, _, err := sendOnce(t, p, oaConfig("deepseek-flash"), ToolChoiceRequired); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	for _, m := range messagesOf(t, rec, 0) {
		if m["role"] == "tool" || m["content"] == "" {
			t.Fatalf("message %v should not have been sent", m)
		}
	}
}

// --- SSE parsing ------------------------------------------------------------

func TestOpenAICompatTextOnlyStreamsEachDelta(t *testing.T) {
	srv, _ := oaServer(t, scriptedReply{file: "text_only.sse"})
	reply, deltas, err := sendOnce(t, newOAProvider(t, "deepseek", srv.URL), oaConfig("deepseek-flash"), ToolChoiceRequired)
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if reply.Text != "Hello, world." || strings.Join(deltas, "") != "Hello, world." {
		t.Fatalf("text = %q, deltas = %q", reply.Text, deltas)
	}
	if len(deltas) != 3 {
		t.Fatalf("deltas = %q, want three", deltas)
	}
	if reply.Finish != FinishStop || len(reply.ToolCalls) != 0 {
		t.Fatalf("reply = %+v, want stop with no calls", reply)
	}
}

func TestOpenAICompatAssemblesSplitArguments(t *testing.T) {
	srv, _ := oaServer(t, scriptedReply{file: "tool_call_split_args.sse"})
	reply, _, err := sendOnce(t, newOAProvider(t, "deepseek", srv.URL), oaConfig("deepseek-flash"), ToolChoiceRequired)
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if len(reply.ToolCalls) != 1 {
		t.Fatalf("tool calls = %+v, want one", reply.ToolCalls)
	}
	call := reply.ToolCalls[0]
	if call.ID != "call_a" || call.Name != "search_stocks" || call.ArgsError != "" {
		t.Fatalf("call = %+v, want call_a search_stocks with no args error", call)
	}
	if call.Args["query"] != "BHP" {
		t.Fatalf("args = %v, want query BHP", call.Args)
	}
	if reply.Finish != FinishToolCalls {
		t.Fatalf("finish = %q, want tool_calls", reply.Finish)
	}
}

func TestOpenAICompatParallelCallsStayInIndexOrder(t *testing.T) {
	srv, _ := oaServer(t, scriptedReply{file: "parallel_tool_calls.sse"})
	reply, _, err := sendOnce(t, newOAProvider(t, "deepseek", srv.URL), oaConfig("deepseek-flash"), ToolChoiceRequired)
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if len(reply.ToolCalls) != 2 {
		t.Fatalf("tool calls = %+v, want two", reply.ToolCalls)
	}
	if reply.ToolCalls[0].Name != "query_short_positions" || reply.ToolCalls[0].Args["productCode"] != "BHP" {
		t.Fatalf("first call = %+v", reply.ToolCalls[0])
	}
	if reply.ToolCalls[1].Name != "get_stock_details" || reply.ToolCalls[1].Args["productCode"] != "CBA" {
		t.Fatalf("second call = %+v", reply.ToolCalls[1])
	}
}

func TestOpenAICompatIgnoresKeepAliveComments(t *testing.T) {
	srv, _ := oaServer(t, scriptedReply{file: "keepalive_comments.sse"})
	reply, deltas, err := sendOnce(t, newOAProvider(t, "deepseek", srv.URL), oaConfig("deepseek-flash"), ToolChoiceRequired)
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if reply.Text != "Hello there" {
		t.Fatalf("text = %q, want the comments left out", reply.Text)
	}
	if len(deltas) != 2 || strings.Contains(strings.Join(deltas, ""), "keep-alive") {
		t.Fatalf("deltas = %q, want two text deltas and no comment text", deltas)
	}
}

func TestOpenAICompatReadsUsageFromTheFinalChunk(t *testing.T) {
	srv, _ := oaServer(t, scriptedReply{file: "usage_last_chunk.sse"})
	reply, _, err := sendOnce(t, newOAProvider(t, "deepseek", srv.URL), oaConfig("deepseek-flash"), ToolChoiceRequired)
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	u := reply.Usage
	if u.PromptTokens != 1200 || u.CachedPromptTokens != 1000 || u.TotalTokens != 1280 {
		t.Fatalf("usage = %+v, want prompt 1200, cached 1000, total 1280", u)
	}
	if u.CandidateTokens != 50 || u.ReasoningTokens != 30 {
		t.Fatalf("usage = %+v, want 50 visible output and 30 reasoning (completion 80)", u)
	}
	if u.ReportedCostUSD == nil || *u.ReportedCostUSD != 0.000321 {
		t.Fatalf("reported cost = %v, want 0.000321", u.ReportedCostUSD)
	}
}

func TestOpenAICompatCachedTokensTakeTheLargerField(t *testing.T) {
	usage := oaUsage{
		PromptTokens:         1200,
		PromptCacheHitTokens: 1000,
		PromptTokensDetails:  &oaCache{CachedTokens: 1100},
	}
	if got := usage.tokenUsage().CachedPromptTokens; got != 1100 {
		t.Fatalf("cached = %d, want the larger field, 1100", got)
	}
}

func TestOpenAICompatInvalidArgumentsSetArgsError(t *testing.T) {
	srv, _ := oaServer(t, scriptedReply{file: "invalid_args.sse"})
	reply, _, err := sendOnce(t, newOAProvider(t, "deepseek", srv.URL), oaConfig("deepseek-flash"), ToolChoiceRequired)
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if len(reply.ToolCalls) != 1 {
		t.Fatalf("tool calls = %+v, want the call kept", reply.ToolCalls)
	}
	call := reply.ToolCalls[0]
	if call.ArgsError == "" || call.Args != nil || call.Name != "search_stocks" {
		t.Fatalf("call = %+v, want ArgsError set, Args nil and the name kept", call)
	}
}

func TestOpenAICompatFinishLengthKeepsTheText(t *testing.T) {
	srv, _ := oaServer(t, scriptedReply{file: "finish_length.sse"})
	reply, _, err := sendOnce(t, newOAProvider(t, "deepseek", srv.URL), oaConfig("deepseek-flash"), ToolChoiceRequired)
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if reply.Finish != FinishLength || reply.Text != "The answer is cut" {
		t.Fatalf("reply = finish %q text %q, want length and the partial text", reply.Finish, reply.Text)
	}
}

func TestOpenAICompatReasoningIsKeptButNeverEmitted(t *testing.T) {
	srv, rec := oaServer(t, scriptedReply{file: "reasoning_content.sse"}, scriptedReply{file: "text_only.sse"})
	p := newOAProvider(t, "deepseek", srv.URL)
	session, err := p.NewSession(oaConfig("deepseek-flash"))
	if err != nil {
		t.Fatalf("NewSession() error = %v", err)
	}
	var deltas []string
	reply, err := session.Send(context.Background(), SendInput{UserText: "question"}, ToolChoiceRequired, func(ev ModelEvent) {
		deltas = append(deltas, ev.Text)
	})
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if strings.Join(deltas, "") != "BHP is 4.2%." || strings.Contains(strings.Join(deltas, ""), "think") {
		t.Fatalf("emitted %q, want only the answer", deltas)
	}
	if reply.Text != "BHP is 4.2%." {
		t.Fatalf("reply text = %q", reply.Text)
	}
	if _, err := session.Send(context.Background(), SendInput{}, ToolChoiceAuto, func(ModelEvent) {}); err != nil {
		t.Fatalf("second Send() error = %v", err)
	}
	msgs := messagesOf(t, rec, 1)
	last := msgs[len(msgs)-1]
	if last["reasoning_content"] != "Let me think about BHP. More thought." {
		t.Fatalf("assistant reasoning was not replayed in the transcript: %v", last)
	}
}

// --- errors -----------------------------------------------------------------

func TestOpenAICompatHTTPStatusesClassifyRetryability(t *testing.T) {
	cases := []struct {
		name      string
		file      string
		status    int
		retryable bool
		message   string
	}{
		{"429 is retryable", "http_429_json.json", http.StatusTooManyRequests, true, "Rate limit reached for requests"},
		{"402 is not retryable", "http_402_json.json", http.StatusPaymentRequired, false, "Insufficient Balance"},
		{"400 is not retryable", "http_400_json.json", http.StatusBadRequest, false, "Invalid tool_choice value"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv, _ := oaServer(t, scriptedReply{status: c.status, file: c.file})
			_, _, err := sendOnce(t, newOAProvider(t, "deepseek", srv.URL), oaConfig("deepseek-flash"), ToolChoiceRequired)
			var pe *ProviderError
			if !errors.As(err, &pe) {
				t.Fatalf("error = %v, want a *ProviderError", err)
			}
			if pe.Reached || pe.Retryable != c.retryable || pe.Status != c.status {
				t.Fatalf("ProviderError = {Reached:%v Retryable:%v Status:%d}, want not reached, retryable=%v, status %d",
					pe.Reached, pe.Retryable, pe.Status, c.retryable, c.status)
			}
			if !strings.Contains(err.Error(), c.message) {
				t.Fatalf("error %q does not carry error.message %q", err, c.message)
			}
		})
	}
}

func TestOpenAICompatServerErrorIsRetryable(t *testing.T) {
	srv, _ := oaServer(t, scriptedReply{status: http.StatusInternalServerError, raw: "<html>not json</html>"})
	_, _, err := sendOnce(t, newOAProvider(t, "deepseek", srv.URL), oaConfig("deepseek-flash"), ToolChoiceRequired)
	var pe *ProviderError
	if !errors.As(err, &pe) || !pe.Retryable || pe.Reached {
		t.Fatalf("error = %v, want a retryable failure before any chunk", err)
	}
	if !strings.Contains(err.Error(), "Internal Server Error") {
		t.Fatalf("error %q should fall back to the status text when the body is not JSON", err)
	}
}

func TestOpenAICompatMidStreamDisconnectIsNotRetryableAfterAChunk(t *testing.T) {
	srv, _ := oaServer(t, scriptedReply{file: "mid_stream_disconnect.sse"})
	reply, deltas, err := sendOnce(t, newOAProvider(t, "deepseek", srv.URL), oaConfig("deepseek-flash"), ToolChoiceRequired)
	var pe *ProviderError
	if !errors.As(err, &pe) {
		t.Fatalf("error = %v, want a *ProviderError", err)
	}
	if !pe.Reached || pe.Retryable {
		t.Fatalf("ProviderError = {Reached:%v Retryable:%v}, want reached and not retryable", pe.Reached, pe.Retryable)
	}
	if strings.Join(deltas, "") != "The short position is 4.2" {
		t.Fatalf("partial text = %q, want what arrived before the cut", deltas)
	}
	_ = reply
}

func TestOpenAICompatInsufficientResourcesWithoutTextIsRetryable(t *testing.T) {
	srv, _ := oaServer(t, scriptedReply{file: "insufficient_resource.sse"})
	_, _, err := sendOnce(t, newOAProvider(t, "deepseek", srv.URL), oaConfig("deepseek-flash"), ToolChoiceRequired)
	var pe *ProviderError
	if !errors.As(err, &pe) || !pe.Retryable {
		t.Fatalf("error = %v, want a retryable failure", err)
	}
}

func TestOpenAICompatTransportFailureBeforeAnyChunkIsRetryable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close()
	_, _, err := sendOnce(t, newOAProvider(t, "deepseek", url), oaConfig("deepseek-flash"), ToolChoiceRequired)
	var pe *ProviderError
	if !errors.As(err, &pe) || !pe.Retryable || pe.Reached {
		t.Fatalf("error = %v, want a retryable failure before any chunk", err)
	}
}

func TestOpenAICompatNeverLeaksTheKeyInAnError(t *testing.T) {
	// The provider echoes the bearer header back in its error text. The key must
	// not survive into the error the service keeps.
	srv, _ := oaServer(t, scriptedReply{status: http.StatusUnauthorized,
		raw: `{"error":{"message":"invalid token Bearer ` + oaTestKey + `"}}`})
	_, _, err := sendOnce(t, newOAProvider(t, "deepseek", srv.URL), oaConfig("deepseek-flash"), ToolChoiceRequired)
	if err == nil {
		t.Fatal("Send() error = nil, want the 401")
	}
	if strings.Contains(err.Error(), oaTestKey) {
		t.Fatalf("the API key reached an error: %q", err)
	}
	if !strings.Contains(err.Error(), redactedMarker) {
		t.Fatalf("error %q should show the redaction marker where the key was", err)
	}
}

// --- timeouts ---------------------------------------------------------------

func TestOpenAICompatKeepAliveCommentsDoNotStopTheFirstByteBound(t *testing.T) {
	// A queued request that only sends keep-alive comments must time out: a
	// comment is not an answer. The test bounds its own context, so a regression
	// fails in seconds with a message instead of running into the go test timeout.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		for {
			select {
			case <-r.Context().Done():
				return
			case <-time.After(10 * time.Millisecond):
			}
			_, _ = io.WriteString(w, ": keep-alive\n\n")
			if flusher != nil {
				flusher.Flush()
			}
		}
	}))
	defer srv.Close()

	p := newOAProvider(t, "deepseek", srv.URL)
	p.timeouts = streamTimeouts{FirstByte: 150 * time.Millisecond, Idle: time.Second}
	session, err := p.NewSession(oaConfig("deepseek-flash"))
	if err != nil {
		t.Fatalf("NewSession() error = %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	_, err = session.Send(ctx, SendInput{UserText: "question"}, ToolChoiceRequired, func(ModelEvent) {})
	if ctx.Err() != nil {
		t.Fatalf("the first-byte bound did not fire within 5s: keep-alive comments kept the queued call open")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatalf("the first-byte bound took %s to fire", time.Since(start))
	}
	var pe *ProviderError
	if !errors.As(err, &pe) || pe.Retryable || pe.Reached {
		t.Fatalf("error = %v, want a timeout before any chunk that is not retried on the same provider", err)
	}
	if !strings.Contains(err.Error(), "did not answer in time") {
		t.Fatalf("error %q does not name the timeout", err)
	}
}

func TestOpenAICompatIdleBoundAfterAChunkIsNotRetryable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "data: "+`{"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}`+"\n\n")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		<-r.Context().Done()
	}))
	defer srv.Close()

	p := newOAProvider(t, "deepseek", srv.URL)
	p.timeouts = streamTimeouts{FirstByte: time.Second, Idle: 150 * time.Millisecond}
	_, deltas, err := sendOnce(t, p, oaConfig("deepseek-flash"), ToolChoiceRequired)
	var pe *ProviderError
	if !errors.As(err, &pe) || pe.Retryable || !pe.Reached {
		t.Fatalf("error = %v, want reached and not retryable after a chunk", err)
	}
	if strings.Join(deltas, "") != "Hi" {
		t.Fatalf("deltas = %q, want the chunk that arrived", deltas)
	}
}

// A chunk that carries a tool call streams no text, as the Gemini adapter does. The
// preamble in it is not shown, and the call is still kept.
func TestOpenAICompatPreambleInAToolCallChunkIsNotShown(t *testing.T) {
	srv, _ := oaServer(t, scriptedReply{file: "preamble_same_chunk.sse"})
	reply, deltas, err := sendOnce(t, newOAProvider(t, "deepseek", srv.URL), oaConfig("deepseek-flash"), ToolChoiceAuto)
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if len(deltas) != 0 || reply.Text != "" {
		t.Fatalf("deltas = %q, text = %q: want no user-visible text for a round that calls a tool", deltas, reply.Text)
	}
	if len(reply.ToolCalls) != 1 || reply.ToolCalls[0].Name != "search_stocks" {
		t.Fatalf("tool calls = %+v, want the search call", reply.ToolCalls)
	}
}

// A refused reply is an error, as a Gemini SAFETY block is: it is not an answer and
// it is not retried. It reached the model, so the call is billed.
func TestOpenAICompatContentFilterIsARefusalNotAnAnswer(t *testing.T) {
	srv, _ := oaServer(t, scriptedReply{file: "finish_content_filter.sse"})
	_, _, err := sendOnce(t, newOAProvider(t, "deepseek", srv.URL), oaConfig("deepseek-flash"), ToolChoiceRequired)
	var pe *ProviderError
	if !errors.As(err, &pe) || pe.Retryable || !pe.Reached {
		t.Fatalf("error = %v, want a non-retryable, reached ProviderError for a filtered reply", err)
	}
	if !strings.Contains(err.Error(), "filtered") {
		t.Fatalf("error %q does not say the reply was filtered", err)
	}
}

// A finish of "error" is a failed reply, with or without an error object. It is
// returned as an error, never as a completed answer.
func TestOpenAICompatFinishErrorIsAFailure(t *testing.T) {
	for _, file := range []string{"finish_error.sse", "finish_error_object.sse"} {
		t.Run(file, func(t *testing.T) {
			srv, _ := oaServer(t, scriptedReply{file: file})
			reply, _, err := sendOnce(t, newOAProvider(t, "deepseek", srv.URL), oaConfig("deepseek-flash"), ToolChoiceRequired)
			var pe *ProviderError
			if !errors.As(err, &pe) {
				t.Fatalf("error = %v, want a ProviderError", err)
			}
			if reply.Finish == FinishStop {
				t.Fatalf("reply finish %q: a failed reply must not read as an answer", reply.Finish)
			}
		})
	}
}

// A reply with no usage report is accepted, and its cost is flagged as unknown.
func TestOpenAICompatMissingUsageIsFlaggedNotZero(t *testing.T) {
	srv, _ := oaServer(t, scriptedReply{file: "missing_usage.sse"})
	reply, deltas, err := sendOnce(t, newOAProvider(t, "deepseek", srv.URL), oaConfig("deepseek-flash"), ToolChoiceRequired)
	if err != nil {
		t.Fatalf("Send() error = %v, want the reply accepted", err)
	}
	if strings.Join(deltas, "") != "Shorts are up." {
		t.Fatalf("deltas = %q, want the answer", deltas)
	}
	if !reply.UsageMissing {
		t.Fatal("UsageMissing = false, want true: a reply without usage has an unknown cost")
	}

	srv, _ = oaServer(t, scriptedReply{file: "usage_last_chunk.sse"})
	reply, _, err = sendOnce(t, newOAProvider(t, "deepseek", srv.URL), oaConfig("deepseek-flash"), ToolChoiceRequired)
	if err != nil || reply.UsageMissing {
		t.Fatalf("with usage: error %v, UsageMissing %v, want no error and no flag", err, reply.UsageMissing)
	}
}

// The request names the tools' final-round choice only where the catalog allows
// it. A model without a none choice gets no tools at all on that round.
func TestOpenAICompatNoneChoiceWithoutCatalogSupportOmitsTools(t *testing.T) {
	srv, rec := oaServer(t, scriptedReply{file: "text_only.sse"})
	if _, _, err := sendOnce(t, newOAProvider(t, "openrouter", srv.URL), oaConfig("deepseek/deepseek-v4-flash"), ToolChoiceNone); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	body := rec.body(t, 0)
	if _, ok := body["tools"]; ok {
		t.Fatal("tools were sent on the final round, want them omitted for a model without a none choice")
	}
	if _, ok := body["tool_choice"]; ok {
		t.Fatal("tool_choice was sent on the final round, want it omitted")
	}
}

// parallel_tool_calls is sent only for a model the catalog says supports it.
func TestOpenAICompatParallelToolCallsOnlyWhereTheCatalogSaysSo(t *testing.T) {
	srv, rec := oaServer(t, scriptedReply{file: "text_only.sse"}, scriptedReply{file: "text_only.sse"})
	if _, _, err := sendOnce(t, newOAProvider(t, "deepseek", srv.URL), oaConfig("deepseek-flash"), ToolChoiceRequired); err != nil {
		t.Fatalf("deepseek Send() error = %v", err)
	}
	if got, ok := rec.body(t, 0)["parallel_tool_calls"]; !ok || got != true {
		t.Fatalf("deepseek parallel_tool_calls = %v (present %v), want true", got, ok)
	}
	if _, _, err := sendOnce(t, newOAProvider(t, "openrouter", srv.URL), oaConfig("qwen/qwen3.8-flash"), ToolChoiceAuto); err != nil {
		t.Fatalf("qwen Send() error = %v", err)
	}
	if _, ok := rec.body(t, 1)["parallel_tool_calls"]; ok {
		t.Fatal("qwen was sent parallel_tool_calls, but the catalog does not say it supports them")
	}
}

// The key is trimmed in the Authorization header, as it is for redaction.
func TestOpenAICompatTrimsTheKeyInTheAuthorizationHeader(t *testing.T) {
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		_, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer srv.Close()

	spec, _ := lookupProvider("deepseek")
	p, err := newOpenAICompatProvider(spec, srv.URL, " "+oaTestKey+"\n", nil)
	if err != nil {
		t.Fatalf("newOpenAICompatProvider() error = %v", err)
	}
	_, _, _ = sendOnce(t, p, oaConfig("deepseek-flash"), ToolChoiceRequired)
	if auth != "Bearer "+oaTestKey {
		t.Fatalf("Authorization = %q, want the trimmed key", auth)
	}
}

// A content-filtered OpenAI-compatible reply still reports the usage it billed (the
// fixture bills 900/12), but the adapter returns the error with zero usage, so
// the engine adds a billed call with no tokens and no cost.
func TestOpenAICompatFilteredReplyKeepsItsBilledUsage(t *testing.T) {
	srv, _ := oaServer(t, scriptedReply{file: "finish_content_filter.sse"})
	reply, _, err := sendOnce(t, newOAProvider(t, "deepseek", srv.URL), oaConfig("deepseek-flash"), ToolChoiceRequired)
	if err == nil {
		t.Fatal("Send() succeeded, want the filtered reply refused")
	}
	if reply.Usage.PromptTokens != 900 || reply.Usage.CandidateTokens != 12 {
		t.Fatalf("usage on a filtered reply = %+v, want the billed 900/12 the stream reported", reply.Usage)
	}
}
