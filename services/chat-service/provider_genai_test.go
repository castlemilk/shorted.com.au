package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"google.golang.org/genai"
)

// The golden wire test pins what chat sends to Gemini through the genai SDK. A
// fake endpoint records every request body and replays a scripted reply for each
// call, so the request bytes are compared against committed files. It drives the
// public ChatStream entry point, and the P1 adapter's tests run here too, with
// the same scripts.
//
// Scripted turn: the user asks a question. The first reply calls two data tools
// in one response, and the first call carries a thought signature. Each tool
// answers with its own query, so a reversed response order changes the bytes.
// Usage arrives on two chunks of each call. The second reply answers in text,
// and the second request must replay the first reply verbatim, signature
// included.
//
// The goldens are the canonical JSON that genai marshals, re-indented so a diff
// reads. To regenerate them after an intended wire change, run
//
//	CHAT_GOLDEN_UPDATE=1 GOWORK=off go test ./chat-service/ -run TestGeminiWireGolden
//
// and review the diff before committing it.

const wireModel = "gemini-test"

// wireMaxOutputTokens is the prod value (GEMINI_MAX_OUTPUT_TOKENS default).
const wireMaxOutputTokens = 1024

// wireTestKey is a placeholder. The endpoint never checks it, and it is not a
// secret, so it is not registered for redaction.
const wireTestKey = "wire-test-key"

// wireSignature is a base64 thought signature, as the API sends it in JSON.
const wireSignature = "c2lnLTE="

// wireToolResult is what the fake Shorts API returns for a search. It names the
// query, so two calls in one reply get different results.
func wireToolResult(query string) string {
	b, _ := json.Marshal(map[string]any{"stocks": []map[string]string{{"productCode": query}}})
	return string(b)
}

// wireReplies are the two scripted model replies, as JSON response messages.
var wireReplies = [][]string{
	{
		`{"candidates":[{"content":{"role":"model","parts":[` +
			`{"functionCall":{"name":"search_stocks","args":{"query":"BHP"}},"thoughtSignature":"` + wireSignature + `"}` +
			`]},"index":0}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":1,"totalTokenCount":8}}`,
		`{"candidates":[{"content":{"role":"model","parts":[` +
			`{"functionCall":{"name":"search_stocks","args":{"query":"CBA"}}}` +
			`]},"index":0}],"usageMetadata":{"promptTokenCount":120,"candidatesTokenCount":12,"totalTokenCount":132}}`,
	},
	{
		`{"candidates":[{"content":{"role":"model","parts":[{"text":"BHP is shorted "}]},"index":0}],` +
			`"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":1,"totalTokenCount":5}}`,
		`{"candidates":[{"content":{"role":"model","parts":[{"text":"at 4.2%."}]},"index":0}],` +
			`"usageMetadata":{"promptTokenCount":260,"cachedContentTokenCount":100,"candidatesTokenCount":9,"thoughtsTokenCount":3,"totalTokenCount":272}}`,
	},
}

// wireRecorder is the fake Gemini endpoint and the fake Shorts API. It keeps
// what each request looked like, so a test can assert on it.
type wireRecorder struct {
	geminiPaths []string
	geminiBody  [][]byte
	toolPaths   []string
	toolQueries []string
}

// newWireGemini serves the scripted replies in order as SSE, and records each
// request. A call past the script is an error, so an extra model call fails the
// test.
func newWireGemini(t *testing.T, rec *wireRecorder, replies [][]string) *httptest.Server {
	t.Helper()
	next := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
			return
		}
		rec.geminiPaths = append(rec.geminiPaths, r.URL.Path+"?"+r.URL.RawQuery)
		rec.geminiBody = append(rec.geminiBody, body)
		if next >= len(replies) {
			t.Errorf("unexpected model call %d: the script has %d replies", next+1, len(replies))
			http.Error(w, "no scripted reply left", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, payload := range replies[next] {
			_, _ = fmt.Fprintf(w, "data: %s\n\n", payload)
		}
		next++
	}))
	t.Cleanup(srv.Close)
	return srv
}

// newWireToolAPI answers each search with a result that names its query.
func newWireToolAPI(t *testing.T, rec *wireRecorder) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req struct {
			Query string `json:"query"`
		}
		_ = json.Unmarshal(body, &req)
		rec.toolPaths = append(rec.toolPaths, r.URL.Path)
		rec.toolQueries = append(rec.toolQueries, req.Query)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, wireToolResult(req.Query))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// newWireProvider builds the Gemini provider against a fake endpoint.
func newWireProvider(t *testing.T, geminiURL string) *geminiProvider {
	t.Helper()
	provider, err := newGeminiProviderAt(context.Background(), wireTestKey, geminiURL)
	if err != nil {
		t.Fatalf("newGeminiProviderAt() error = %v", err)
	}
	return provider
}

// newWireTestClient builds the chat client against the fake Gemini endpoint, with
// the prod max output tokens.
func newWireTestClient(t *testing.T, geminiURL, toolAPIURL string) *LLMClient {
	t.Helper()
	return newLLMClient(newWireProvider(t, geminiURL), wireModel, wireMaxOutputTokens, NewToolExecutor(toolAPIURL))
}

// mustWireSession starts a turn against the fake endpoint with the tool set.
func mustWireSession(t *testing.T, geminiURL string) ModelSession {
	t.Helper()
	session, err := newWireProvider(t, geminiURL).NewSession(SessionConfig{Model: wireModel, System: "s", Tools: chatToolDefinitions()})
	if err != nil {
		t.Fatalf("NewSession() error = %v", err)
	}
	return session
}

// canonicalJSON re-indents a request body so a golden diff is readable. genai
// marshals structs in a fixed order, so the indented form is deterministic.
func canonicalJSON(t *testing.T, body []byte) []byte {
	t.Helper()
	var out bytes.Buffer
	if err := json.Indent(&out, body, "", "  "); err != nil {
		t.Fatalf("request body is not JSON: %v", err)
	}
	return append(out.Bytes(), '\n')
}

// compareGolden checks got against testdata/genai_wire/<name>, byte for byte.
func compareGolden(t *testing.T, name string, got []byte) {
	t.Helper()
	path := filepath.Join("testdata", "genai_wire", name)
	if os.Getenv("CHAT_GOLDEN_UPDATE") == "1" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("create golden dir: %v", err)
		}
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatalf("write golden %s: %v", path, err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden %s: %v (run with CHAT_GOLDEN_UPDATE=1 to create it)", path, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("request body differs from %s\n--- want\n%s\n--- got\n%s", path, want, got)
	}
}

// wireRequest is the part of a request body these tests read.
type wireRequest struct {
	Contents []struct {
		Role  string           `json:"role"`
		Parts []map[string]any `json:"parts"`
	} `json:"contents"`
	GenerationConfig struct {
		MaxOutputTokens int `json:"maxOutputTokens"`
	} `json:"generationConfig"`
}

func parseWireRequest(t *testing.T, body []byte) wireRequest {
	t.Helper()
	var req wireRequest
	if err := json.Unmarshal(body, &req); err != nil {
		t.Fatalf("request body: %v", err)
	}
	return req
}

// lastContentParts returns the parts of the last content in a request.
func lastContentParts(t *testing.T, req wireRequest) []map[string]any {
	t.Helper()
	if len(req.Contents) == 0 {
		t.Fatal("request has no contents")
	}
	return req.Contents[len(req.Contents)-1].Parts
}

// functionResponseAt returns the response object of the i-th part, which must be
// a function response.
func functionResponseAt(t *testing.T, parts []map[string]any, i int) map[string]any {
	t.Helper()
	if i >= len(parts) {
		t.Fatalf("part %d missing: the content has %d parts", i, len(parts))
	}
	fr, ok := parts[i]["functionResponse"].(map[string]any)
	if !ok {
		t.Fatalf("part %d is not a function response: %v", i, parts[i])
	}
	resp, _ := fr["response"].(map[string]any)
	return resp
}

func TestGeminiWireGolden(t *testing.T) {
	rec := &wireRecorder{}
	gemini := newWireGemini(t, rec, wireReplies)
	toolAPI := newWireToolAPI(t, rec)
	client := newWireTestClient(t, gemini.URL, toolAPI.URL)

	var chunks []string
	resp, err := client.ChatStream(context.Background(),
		"system prompt for the wire test",
		[]Message{{Role: "user", Content: "earlier question"}, {Role: "assistant", Content: "earlier answer"}},
		"Who is shorting BHP?",
		func(text string) { chunks = append(chunks, text) },
	)
	if err != nil {
		t.Fatalf("ChatStream() error = %v", err)
	}

	if len(rec.geminiBody) != 2 {
		t.Fatalf("model calls = %d, want 2 (one tool round, then the answer)", len(rec.geminiBody))
	}
	for i, p := range rec.geminiPaths {
		if want := "/v1beta/models/" + wireModel + ":streamGenerateContent?alt=sse"; p != want {
			t.Fatalf("model call %d = %q, want %q", i+1, p, want)
		}
	}
	if !slices.Equal(rec.toolQueries, []string{"BHP", "CBA"}) {
		t.Fatalf("tool queries = %q, want one call per function call, in order", rec.toolQueries)
	}

	compareGolden(t, "turn1_request.json", canonicalJSON(t, rec.geminiBody[0]))
	compareGolden(t, "turn2_request.json", canonicalJSON(t, rec.geminiBody[1]))

	parts := lastContentParts(t, parseWireRequest(t, rec.geminiBody[1]))
	for i, query := range []string{"BHP", "CBA"} {
		got := functionResponseAt(t, parts, i)
		if code := got["stocks"].([]any)[0].(map[string]any)["productCode"]; code != query {
			t.Fatalf("function response %d names %v, want %s: the responses are out of order", i, code, query)
		}
	}

	if want := []string{"BHP is shorted ", "at 4.2%."}; !slices.Equal(chunks, want) {
		t.Fatalf("streamed chunks = %q, want %q", chunks, want)
	}
	if len(resp.ToolCalls) != 2 {
		t.Fatalf("recorded tool calls = %d, want the two executed data calls", len(resp.ToolCalls))
	}
	for i, query := range []string{"BHP", "CBA"} {
		tc := resp.ToolCalls[i]
		if tc.Name != "search_stocks" || tc.Args["query"] != query || tc.Result != wireToolResult(query) {
			t.Fatalf("tool call %d = %+v, want search_stocks(%s) with its own result", i, tc, query)
		}
	}
	// Usage is the last usable chunk of each model call, summed over calls. A
	// sum over chunks would give 127 prompt tokens for the first call, not 120.
	want := TokenUsage{PromptTokens: 380, CachedPromptTokens: 100, CandidateTokens: 21, ReasoningTokens: 3, TotalTokens: 404}
	if resp.Usage != want {
		t.Fatalf("usage = %+v, want %+v", resp.Usage, want)
	}
}

// Max output tokens reach the wire. Dropping the setting fails here.
func TestGeminiSendsMaxOutputTokens(t *testing.T) {
	rec := &wireRecorder{}
	gemini := newWireGemini(t, rec, wireReplies)
	toolAPI := newWireToolAPI(t, rec)
	client := newWireTestClient(t, gemini.URL, toolAPI.URL)
	if _, err := client.ChatStream(context.Background(), "s", nil, "q", func(string) {}); err != nil {
		t.Fatalf("ChatStream() error = %v", err)
	}
	for i, body := range rec.geminiBody {
		if got := parseWireRequest(t, body).GenerationConfig.MaxOutputTokens; got != wireMaxOutputTokens {
			t.Fatalf("model call %d maxOutputTokens = %d, want %d", i+1, got, wireMaxOutputTokens)
		}
	}
}

// Over-cap calls are answered with the notice on the wire, in their own slots,
// and the calls inside the cap carry real results.
func TestGeminiNoticeReachesTheRequest(t *testing.T) {
	calls := ""
	for i, q := range []string{"A", "B", "C", "D", "E", "F"} {
		if i > 0 {
			calls += ","
		}
		calls += `{"functionCall":{"name":"search_stocks","args":{"query":"` + q + `"}}}`
	}
	replies := [][]string{
		{`{"candidates":[{"content":{"role":"model","parts":[` + calls + `]},"index":0}]}`},
		{`{"candidates":[{"content":{"role":"model","parts":[{"text":"done"}]},"index":0}]}`},
	}
	rec := &wireRecorder{}
	gemini := newWireGemini(t, rec, replies)
	toolAPI := newWireToolAPI(t, rec)
	client := newWireTestClient(t, gemini.URL, toolAPI.URL)
	if _, err := client.ChatStream(context.Background(), "s", nil, "q", func(string) {}); err != nil {
		t.Fatalf("ChatStream() error = %v", err)
	}

	parts := lastContentParts(t, parseWireRequest(t, rec.geminiBody[1]))
	if len(parts) != 6 {
		t.Fatalf("function responses = %d, want one per call (6)", len(parts))
	}
	for i := range maxToolCallsPerRound {
		if _, refused := functionResponseAt(t, parts, i)["error"]; refused {
			t.Fatalf("response %d is a refusal, want the tool result: %v", i, parts[i])
		}
	}
	for i := maxToolCallsPerRound; i < 6; i++ {
		msg, _ := functionResponseAt(t, parts, i)["error"].(string)
		if !strings.Contains(msg, "Only 4 tool calls run per reply") {
			t.Fatalf("response %d = %v, want the over-cap notice", i, parts[i])
		}
	}
}

// Text in a chunk that also carries a function call is not streamed.
func TestGeminiTextBesideAFunctionCallIsNotStreamed(t *testing.T) {
	replies := [][]string{
		{`{"candidates":[{"content":{"role":"model","parts":[` +
			`{"text":"Let me check."},` +
			`{"functionCall":{"name":"search_stocks","args":{"query":"BHP"}}}` +
			`]},"index":0}]}`},
		{`{"candidates":[{"content":{"role":"model","parts":[{"text":"answer"}]},"index":0}]}`},
	}
	rec := &wireRecorder{}
	gemini := newWireGemini(t, rec, replies)
	toolAPI := newWireToolAPI(t, rec)
	client := newWireTestClient(t, gemini.URL, toolAPI.URL)

	var chunks []string
	if _, err := client.ChatStream(context.Background(), "s", nil, "q", func(s string) { chunks = append(chunks, s) }); err != nil {
		t.Fatalf("ChatStream() error = %v", err)
	}
	if !slices.Equal(chunks, []string{"answer"}) {
		t.Fatalf("streamed chunks = %q, want only the answer: text beside a call is not streamed", chunks)
	}
}

// AutomaticContinuation stays off: a stream that carries a continuation token
// is not resumed with a second request.
func TestGeminiMakesNoContinuationRequest(t *testing.T) {
	replies := [][]string{
		{`{"candidates":[{"content":{"role":"model","parts":[{"text":"part one"}]},"index":0,"continuationToken":"dG9rZW4="}]}`},
	}
	rec := &wireRecorder{}
	gemini := newWireGemini(t, rec, replies)
	session := mustWireSession(t, gemini.URL)
	if _, err := session.Send(context.Background(), SendInput{UserText: "hi"}, ToolChoiceAuto, func(ModelEvent) {}); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if len(rec.geminiBody) != 1 {
		t.Fatalf("requests = %d, want 1: the stream must not be resumed", len(rec.geminiBody))
	}
}

// The second request must carry the model's first reply back verbatim: the
// function calls, and the signature on the first of them.
func TestGeminiReplaysThoughtSignatureInTheSecondRequest(t *testing.T) {
	rec := &wireRecorder{}
	gemini := newWireGemini(t, rec, wireReplies)
	toolAPI := newWireToolAPI(t, rec)
	client := newWireTestClient(t, gemini.URL, toolAPI.URL)

	if _, err := client.ChatStream(context.Background(), "system", nil, "question", func(string) {}); err != nil {
		t.Fatalf("ChatStream() error = %v", err)
	}

	req := parseWireRequest(t, rec.geminiBody[1])
	var modelParts []map[string]any
	for _, c := range req.Contents {
		if c.Role == "model" {
			modelParts = c.Parts
		}
	}
	if len(modelParts) != 2 {
		t.Fatalf("replayed model parts = %d, want the two function calls", len(modelParts))
	}
	if modelParts[0]["thoughtSignature"] != wireSignature {
		t.Fatalf("first replayed call = %v, want thoughtSignature %q", modelParts[0], wireSignature)
	}
	if _, ok := modelParts[1]["thoughtSignature"]; ok {
		t.Fatalf("second replayed call carries a signature it never had: %v", modelParts[1])
	}
}

// A signature-only part (empty text, no call) is kept in the replayed transcript.
// Gemini 3 sends these, and the signature must go back on the next call.
func TestGeminiKeepsASignatureOnlyPartInTheTranscript(t *testing.T) {
	replies := [][]string{
		{
			`{"candidates":[{"content":{"role":"model","parts":[{"thoughtSignature":"c2ln"}]},"index":0}]}`,
			`{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"search_stocks","args":{"query":"BHP"}}}]},"index":0}]}`,
		},
		{`{"candidates":[{"content":{"role":"model","parts":[{"text":"done"}]},"index":0}]}`},
	}
	rec := &wireRecorder{}
	gemini := newWireGemini(t, rec, replies)
	toolAPI := newWireToolAPI(t, rec)
	client := newWireTestClient(t, gemini.URL, toolAPI.URL)
	if _, err := client.ChatStream(context.Background(), "s", nil, "q", func(string) {}); err != nil {
		t.Fatalf("ChatStream() error = %v", err)
	}

	req := parseWireRequest(t, rec.geminiBody[1])
	var modelParts []map[string]any
	for _, c := range req.Contents {
		if c.Role == "model" {
			modelParts = c.Parts
		}
	}
	if len(modelParts) != 2 {
		t.Fatalf("replayed model parts = %d, want the signature part and the call", len(modelParts))
	}
	if modelParts[0]["thoughtSignature"] != "c2ln" || len(modelParts[0]) != 1 {
		t.Fatalf("first replayed part = %v, want exactly the signature", modelParts[0])
	}
}

// appendStreamedPart joins adjacent plain text, drops empty text, and keeps every
// other part on its own: thoughts, calls, and text that carries a signature.
func TestAppendStreamedPartMergesOnlyPlainText(t *testing.T) {
	var parts []*genai.Part
	add := func(p *genai.Part) { parts = appendStreamedPart(parts, p) }
	add(&genai.Part{Text: "a"})
	add(&genai.Part{Text: "b"})
	add(&genai.Part{Text: ""})
	add(&genai.Part{Text: "thinking", Thought: true})
	add(&genai.Part{Text: "c", ThoughtSignature: []byte("sig")})
	add(&genai.Part{Text: "d"})
	add(&genai.Part{FunctionCall: &genai.FunctionCall{Name: "f"}})
	add(&genai.Part{Text: "e"})

	want := []string{"ab", "thinking", "c", "d", "", "e"}
	if len(parts) != 6 {
		t.Fatalf("parts = %d, want 6", len(parts))
	}
	for i, text := range want[:4] {
		if parts[i].Text != text {
			t.Fatalf("part %d text = %q, want %q", i, parts[i].Text, text)
		}
	}
	if parts[0].Thought || !parts[1].Thought || string(parts[2].ThoughtSignature) != "sig" {
		t.Fatalf("thought or signature flags were lost: %+v", parts[:3])
	}
	if parts[4].FunctionCall == nil || parts[4].FunctionCall.Name != "f" {
		t.Fatalf("part 4 = %+v, want the function call", parts[4])
	}
	if parts[5].Text != "e" {
		t.Fatalf("part 5 text = %q, want %q", parts[5].Text, "e")
	}
}

// Tool choice reaches the wire as the mode the model must follow: nothing for
// Auto, ANY for Required and NONE for None.
func TestGeminiToolChoiceReachesTheWire(t *testing.T) {
	tests := []struct {
		name   string
		choice ToolChoice
		want   string // the mode, or "" for no tool config at all
	}{
		{name: "auto carries no tool config", choice: ToolChoiceAuto, want: ""},
		{name: "required is ANY", choice: ToolChoiceRequired, want: "ANY"},
		{name: "none is NONE", choice: ToolChoiceNone, want: "NONE"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			body := captureSendBody(t, test.choice)
			var req struct {
				ToolConfig *struct {
					FunctionCallingConfig struct {
						Mode string `json:"mode"`
					} `json:"functionCallingConfig"`
				} `json:"toolConfig"`
			}
			if err := json.Unmarshal(body, &req); err != nil {
				t.Fatalf("request: %v", err)
			}
			switch {
			case test.want == "" && req.ToolConfig != nil:
				t.Fatalf("toolConfig = %+v, want none", req.ToolConfig)
			case test.want != "" && (req.ToolConfig == nil || req.ToolConfig.FunctionCallingConfig.Mode != test.want):
				t.Fatalf("toolConfig = %+v, want mode %s", req.ToolConfig, test.want)
			}
		})
	}
}

// captureSendBody sends one text-only reply with the given choice, and returns
// the request body that went out.
func captureSendBody(t *testing.T, choice ToolChoice) []byte {
	t.Helper()
	rec := &wireRecorder{}
	gemini := newWireGemini(t, rec, [][]string{{`{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"index":0}]}`}})
	session := mustWireSession(t, gemini.URL)
	if _, err := session.Send(context.Background(), SendInput{UserText: "hi"}, choice, func(ModelEvent) {}); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	return rec.geminiBody[0]
}

// A thought part is the model's reasoning. It never reaches the person, and only
// the answer text is streamed.
func TestGeminiNeverEmitsThoughtText(t *testing.T) {
	replies := [][]string{{`{"candidates":[{"content":{"role":"model","parts":[{"text":"private reasoning","thought":true},{"text":"Answer."}]},"index":0}]}`}}
	rec := &wireRecorder{}
	gemini := newWireGemini(t, rec, replies)
	session := mustWireSession(t, gemini.URL)

	var emitted []string
	reply, err := session.Send(context.Background(), SendInput{UserText: "hi"}, ToolChoiceAuto, func(ev ModelEvent) {
		emitted = append(emitted, ev.Text)
	})
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if strings.Contains(strings.Join(emitted, ""), "private reasoning") || strings.Contains(reply.Text, "private reasoning") {
		t.Fatalf("thought text reached the person: emitted=%q reply=%q", emitted, reply.Text)
	}
	if reply.Text != "Answer." {
		t.Fatalf("reply text = %q, want the answer only", reply.Text)
	}
}

// Stored history with an empty message sends no empty part: the API rejects one.
func TestGeminiHistorySkipsEmptyMessages(t *testing.T) {
	// A text-only first reply is a first-call violation, so the engine retries once
	// on a fresh session. The script answers both calls; the test reads the first.
	text := []string{`{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"index":0}]}`}
	replies := [][]string{text, text}
	rec := &wireRecorder{}
	gemini := newWireGemini(t, rec, replies)
	toolAPI := newWireToolAPI(t, rec)
	client := newWireTestClient(t, gemini.URL, toolAPI.URL)

	history := []Message{
		{Role: "user", Content: "first"},
		{Role: "assistant", Content: ""},
		{Role: "user", Content: "second"},
	}
	if _, err := client.ChatStream(context.Background(), "s", history, "now", func(string) {}); err != nil {
		t.Fatalf("ChatStream() error = %v", err)
	}
	req := parseWireRequest(t, rec.geminiBody[0])
	var texts []string
	for _, c := range req.Contents {
		for _, part := range c.Parts {
			text, ok := part["text"].(string)
			if !ok || text == "" {
				t.Fatalf("content %+v carries an empty part, which the API rejects", c)
			}
			texts = append(texts, text)
		}
	}
	if want := []string{"first", "second", "now"}; !slices.Equal(texts, want) {
		t.Fatalf("texts sent = %q, want %q", texts, want)
	}
}

// A blocked reply is an error, and the Reached flag follows the chunks before the
// block: a block on the first chunk never reached the model.
func TestGeminiBlockedRepliesAreErrors(t *testing.T) {
	tests := []struct {
		name        string
		replies     []string
		wantReached bool
		wantEmitted []string
		wantText    string
	}{
		{
			name:        "blocked prompt on the first chunk",
			replies:     []string{`{"promptFeedback":{"blockReason":"SAFETY"}}`},
			wantReached: false,
		},
		{
			name: "SAFETY finish after text keeps the partial text",
			replies: []string{
				`{"candidates":[{"content":{"role":"model","parts":[{"text":"partial"}]},"index":0}]}`,
				`{"candidates":[{"content":{"role":"model","parts":[{"text":"not shown"}]},"index":0,"finishReason":"SAFETY"}]}`,
			},
			wantReached: true,
			wantEmitted: []string{"partial"},
			wantText:    "partial",
		},
		{
			name: "RECITATION finish on the first chunk",
			replies: []string{
				`{"candidates":[{"content":{"role":"model","parts":[{"text":"quoted"}]},"index":0,"finishReason":"RECITATION"}]}`,
			},
			wantReached: false,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			rec := &wireRecorder{}
			gemini := newWireGemini(t, rec, [][]string{test.replies})
			session := mustWireSession(t, gemini.URL)

			var emitted []string
			reply, err := session.Send(context.Background(), SendInput{UserText: "hi"}, ToolChoiceAuto, func(ev ModelEvent) {
				emitted = append(emitted, ev.Text)
			})
			var pe *ProviderError
			if !errors.As(err, &pe) {
				t.Fatalf("error = %v, want a ProviderError", err)
			}
			if pe.Reached != test.wantReached {
				t.Fatalf("Reached = %v, want %v", pe.Reached, test.wantReached)
			}
			if pe.Retryable {
				t.Fatal("a refused reply is not retryable")
			}
			if !slices.Equal(emitted, test.wantEmitted) || reply.Text != test.wantText {
				t.Fatalf("emitted = %q, reply = %q, want %q and %q", emitted, reply.Text, test.wantEmitted, test.wantText)
			}
		})
	}
}

// A cancelled context is never retryable, even though it fails before any chunk.
func TestGeminiCancelIsNotRetryable(t *testing.T) {
	rec := &wireRecorder{}
	gemini := newWireGemini(t, rec, [][]string{{`{"candidates":[{"content":{"role":"model","parts":[{"text":"x"}]},"index":0}]}`}})
	session := mustWireSession(t, gemini.URL)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := session.Send(ctx, SendInput{UserText: "hi"}, ToolChoiceAuto, func(ModelEvent) {})
	var pe *ProviderError
	if !errors.As(err, &pe) {
		t.Fatalf("error = %v, want a ProviderError", err)
	}
	if pe.Retryable {
		t.Fatalf("a cancelled call is marked retryable: %+v", pe)
	}
}

// A failure before any chunk is not reached, and a failure after one is.
// Retryable marks transient provider errors only.
func TestGeminiProviderErrorClassification(t *testing.T) {
	tests := []struct {
		name          string
		status        int
		body          string
		wantReached   bool
		wantRetryable bool
		wantStatus    int
	}{
		{
			name:          "429 before any chunk is retryable",
			status:        http.StatusTooManyRequests,
			body:          `{"error":{"code":429,"message":"slow down","status":"RESOURCE_EXHAUSTED"}}`,
			wantRetryable: true,
			wantStatus:    http.StatusTooManyRequests,
		},
		{
			name:          "503 before any chunk is retryable",
			status:        http.StatusServiceUnavailable,
			body:          `{"error":{"code":503,"message":"busy","status":"UNAVAILABLE"}}`,
			wantRetryable: true,
			wantStatus:    http.StatusServiceUnavailable,
		},
		{
			name:       "400 is not retryable",
			status:     http.StatusBadRequest,
			body:       `{"error":{"code":400,"message":"bad request","status":"INVALID_ARGUMENT"}}`,
			wantStatus: http.StatusBadRequest,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.ReadAll(r.Body)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, test.body)
			}))
			t.Cleanup(srv.Close)
			session := mustWireSession(t, srv.URL)
			_, err := session.Send(context.Background(), SendInput{UserText: "hi"}, ToolChoiceAuto, func(ModelEvent) {})
			var pe *ProviderError
			if !errors.As(err, &pe) {
				t.Fatalf("error %T is not a *ProviderError: %v", err, err)
			}
			if pe.Provider != geminiProviderName {
				t.Fatalf("provider = %q, want %q", pe.Provider, geminiProviderName)
			}
			if pe.Reached != test.wantReached || pe.Retryable != test.wantRetryable {
				t.Fatalf("Reached=%v Retryable=%v, want Reached=%v Retryable=%v", pe.Reached, pe.Retryable, test.wantReached, test.wantRetryable)
			}
			if pe.Status != test.wantStatus {
				t.Fatalf("status = %d, want %d", pe.Status, test.wantStatus)
			}
			assertNoKey(t, "provider error", err.Error())
		})
	}
}

// A malformed chunk after a complete one was reached: the call was billed.
func TestGeminiFailureAfterAChunkIsReached(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"partial\"}]}}]}\n\ndata: {not json\n\n")
	}))
	t.Cleanup(srv.Close)
	session := mustWireSession(t, srv.URL)
	var emitted []string
	reply, err := session.Send(context.Background(), SendInput{UserText: "hi"}, ToolChoiceAuto, func(ev ModelEvent) {
		emitted = append(emitted, ev.Text)
	})
	var pe *ProviderError
	if !errors.As(err, &pe) || !pe.Reached {
		t.Fatalf("error = %v, want a ProviderError with Reached=true", err)
	}
	if !slices.Equal(emitted, []string{"partial"}) || reply.Text != "partial" {
		t.Fatalf("emitted = %q, reply = %q, want the partial text kept", emitted, reply.Text)
	}
}

// The Gemini mapping: a choice becomes the function calling mode.
func TestGeminiToolConfigMapsEachChoice(t *testing.T) {
	if got := geminiToolConfig(ToolChoiceAuto); got != nil {
		t.Fatalf("geminiToolConfig(Auto) = %+v, want nil", got)
	}
	tests := map[ToolChoice]genai.FunctionCallingConfigMode{
		ToolChoiceRequired: genai.FunctionCallingConfigModeAny,
		ToolChoiceNone:     genai.FunctionCallingConfigModeNone,
	}
	for choice, wantMode := range tests {
		got := geminiToolConfig(choice)
		if got == nil || got.FunctionCallingConfig == nil || got.FunctionCallingConfig.Mode != wantMode {
			t.Fatalf("geminiToolConfig(%v) = %+v, want mode %v", choice, got, wantMode)
		}
	}
}

// A tool with no parameters declares none, because an object schema with no
// properties is not a valid declaration.
func TestBuildGeminiToolsDeclaresNoParametersForAParameterlessTool(t *testing.T) {
	tools := buildGeminiTools([]ToolDefinition{
		{Name: "no_args", Description: "takes nothing"},
		{
			Name:        "one_arg",
			Description: "takes a query",
			Parameters:  map[string]ToolParameter{"query": {Type: "string", Description: "text"}},
			Required:    []string{"query"},
		},
	})
	decls := tools[0].FunctionDeclarations
	if len(decls) != 2 {
		t.Fatalf("declarations = %d, want 2", len(decls))
	}
	if decls[0].Parameters != nil {
		t.Fatalf("no_args parameters = %+v, want nil", decls[0].Parameters)
	}
	if decls[1].Parameters == nil || decls[1].Parameters.Type != genai.TypeObject || !slices.Equal(decls[1].Parameters.Required, []string{"query"}) {
		t.Fatalf("one_arg parameters = %+v, want an object requiring query", decls[1].Parameters)
	}
}

// A Gemini reply that streams steadily (a chunk every 60ms, each well inside the
// 500ms idle bound) for longer than the 300ms first-byte bound must complete. The
// stream takes about 720ms, so the first-byte bound would end it if it were not
// re-armed. The idle bound leaves 440ms of slack per gap, so a loaded runner does
// not cut the stream short. Without the touch that re-arms the idle bound, this
// reply is cut off at the first-byte bound.
func TestGeminiStreamKeepsTheIdleBoundNotTheFirstByteBound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		f, _ := w.(http.Flusher)
		for i := range 12 {
			finish := ""
			if i == 11 {
				finish = `,"finishReason":"STOP"`
			}
			_, _ = fmt.Fprintf(w, "data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"w%d \"}]},\"index\":0%s}]}\n\n", i, finish)
			if f != nil {
				f.Flush()
			}
			select {
			case <-r.Context().Done():
				return
			case <-time.After(60 * time.Millisecond):
			}
		}
	}))
	defer srv.Close()

	provider := newWireProvider(t, srv.URL)
	provider.timeouts = streamTimeouts{FirstByte: 300 * time.Millisecond, Idle: 500 * time.Millisecond}
	session, err := provider.NewSession(SessionConfig{Model: wireModel, System: "s", Tools: chatToolDefinitions()})
	if err != nil {
		t.Fatalf("NewSession() error = %v", err)
	}
	var got []string
	reply, err := session.Send(context.Background(), SendInput{UserText: "q"}, ToolChoiceAuto, func(ev ModelEvent) { got = append(got, ev.Text) })
	if err != nil {
		t.Fatalf("Send() error = %v after %q: a stream with a chunk every 60ms was cut off mid-reply", err, strings.Join(got, ""))
	}
	if !strings.HasSuffix(reply.Text, "w11 ") {
		t.Fatalf("reply = %q, want all 12 chunks", reply.Text)
	}
}

// The prod router path (not the test-only LLMClient) sends the same bytes the
// golden files pin.
func TestModelRouterGeminiWireMatchesGolden(t *testing.T) {
	setTerraformProdEnv(t)
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}
	rec := &wireRecorder{}
	gemini := newWireGemini(t, rec, wireReplies)
	toolAPI := newWireToolAPI(t, rec)
	r, err := NewModelRouter(context.Background(), cfg, NewToolExecutor(toolAPI.URL))
	if err != nil || r == nil {
		t.Fatalf("NewModelRouter() = %v, %v", r, err)
	}
	built := r.primary.route.Provider.(*geminiProvider)
	wire := newWireProvider(t, gemini.URL)
	wire.timeouts = built.timeouts
	r.primary.route.Provider = wire

	var chunks []string
	resp, err := r.RunTurn(context.Background(), "uid-wire", TurnInput{
		System:   "system prompt for the wire test",
		History:  []Message{{Role: "user", Content: "earlier question"}, {Role: "assistant", Content: "earlier answer"}},
		UserText: "Who is shorting BHP?",
	}, func(s string) { chunks = append(chunks, s) })
	if err != nil {
		t.Fatalf("RunTurn() error = %v", err)
	}
	if len(rec.geminiBody) != 2 {
		t.Fatalf("model calls = %d, want 2", len(rec.geminiBody))
	}
	for i, p := range rec.geminiPaths {
		if want := "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"; p != want {
			t.Fatalf("model call %d = %q, want %q", i+1, p, want)
		}
	}
	compareGolden(t, "turn1_request.json", canonicalJSON(t, rec.geminiBody[0]))
	compareGolden(t, "turn2_request.json", canonicalJSON(t, rec.geminiBody[1]))
	if want := []string{"BHP is shorted ", "at 4.2%."}; !slices.Equal(chunks, want) {
		t.Fatalf("chunks = %q, want %q", chunks, want)
	}
	if resp.Route != routeEnvDefault || resp.Model != "gemini-2.5-flash" || resp.Provider != "gemini" {
		t.Fatalf("answered by %s/%s route %s", resp.Provider, resp.Model, resp.Route)
	}
}
