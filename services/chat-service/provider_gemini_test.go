package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/google/generative-ai-go/genai"
	"google.golang.org/api/option"
)

// The golden wire test pins what chat sends to Gemini. A fake endpoint records
// every request body and replays a scripted reply for each call, so the bytes the
// SDK writes are compared against committed files. It drives the public
// ChatStream entry point, which is the same on either side of the provider
// refactor, so the golden files must not change when the engine moves.
//
// Scripted turn: the user asks a question, the first reply calls two data tools
// in one response, and the second reply answers in text. Each tool answers with
// its own query, so a reversed function-response order changes the bytes.
//
// The SDK's protojson output carries random insignificant whitespace, so goldens
// are compared after json.Compact on both sides. Key order and values still count.
//
// To regenerate the goldens after an intended change to the wire format, run
//
//	CHAT_GOLDEN_UPDATE=1 GOWORK=off go test ./chat-service/ -run TestGeminiWireGolden
//
// and review the diff before committing it.

const wireModel = "gemini-test"

// wireMaxOutputTokens is the prod value (GEMINI_MAX_OUTPUT_TOKENS default). The
// golden carries it, so dropping SetMaxOutputTokens changes the wire.
const wireMaxOutputTokens = 1024

// wireTestKey is a placeholder. The endpoint never checks it, and it is not a
// secret, so it is not registered for redaction.
const wireTestKey = "wire-test-key"

// wireToolResult is what the fake Shorts API returns for a search. It names the
// query, so two calls in one reply get different results.
func wireToolResult(query string) string {
	b, _ := json.Marshal(map[string]any{"stocks": []map[string]string{{"productCode": query}}})
	return string(b)
}

// wireReplies are the two scripted model replies, as JSON response messages.
// Usage arrives on more than one chunk of each call. The SDK keeps the last
// usable chunk, so a sum instead would give a different total.
var wireReplies = [][]string{
	{
		`{"candidates":[{"content":{"role":"model","parts":[` +
			`{"functionCall":{"name":"search_stocks","args":{"query":"BHP"}}}` +
			`]},"index":0}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":1,"totalTokenCount":8}}`,
		`{"candidates":[{"content":{"role":"model","parts":[` +
			`{"functionCall":{"name":"search_stocks","args":{"query":"CBA"}}}` +
			`]},"index":0}],"usageMetadata":{"promptTokenCount":120,"candidatesTokenCount":12,"totalTokenCount":132}}`,
	},
	{
		`{"candidates":[{"content":{"role":"model","parts":[{"text":"BHP is shorted "}]},"index":0}],` +
			`"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":1,"totalTokenCount":5}}`,
		`{"candidates":[{"content":{"role":"model","parts":[{"text":"at 4.2%."}]},"index":0}],` +
			`"usageMetadata":{"promptTokenCount":260,"cachedContentTokenCount":100,"candidatesTokenCount":9,"totalTokenCount":269}}`,
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

// newWireGemini serves the scripted replies in order and records each request.
// A call past the script is an error, so an extra model call fails the test.
func newWireGemini(t *testing.T, rec *wireRecorder, replies [][]string) *httptest.Server {
	t.Helper()
	next := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
			return
		}
		rec.geminiPaths = append(rec.geminiPaths, r.URL.Path)
		rec.geminiBody = append(rec.geminiBody, body)
		if next >= len(replies) {
			t.Errorf("unexpected model call %d: the script has %d replies", next+1, len(replies))
			http.Error(w, "no scripted reply left", http.StatusInternalServerError)
			return
		}
		// The SDK reads a reply as one JSON array of response messages.
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, "["+strings.Join(replies[next], ",")+"]")
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
	gemini, err := genai.NewClient(context.Background(),
		option.WithAPIKey(wireTestKey),
		option.WithEndpoint(geminiURL),
	)
	if err != nil {
		t.Fatalf("genai.NewClient() error = %v", err)
	}
	t.Cleanup(func() { _ = gemini.Close() })
	return &geminiProvider{client: gemini}
}

// newWireTestClient builds the chat client against the fake Gemini endpoint, with
// the prod max output tokens.
func newWireTestClient(t *testing.T, geminiURL, toolAPIURL string) *LLMClient {
	t.Helper()
	return newLLMClient(newWireProvider(t, geminiURL), wireModel, wireMaxOutputTokens, NewToolExecutor(toolAPIURL))
}

// llmClientOverGemini is the chat client over an existing Gemini SDK client. The
// tests use it to point a real provider at a fake endpoint.
func llmClientOverGemini(gemini *genai.Client, model string, tools *ToolExecutor) *LLMClient {
	return newLLMClient(&geminiProvider{client: gemini}, model, 0, tools)
}

// compactJSON removes the insignificant whitespace the SDK adds, so two bodies
// compare by content and key order.
func compactJSON(t *testing.T, body []byte) []byte {
	t.Helper()
	var out bytes.Buffer
	if err := json.Compact(&out, body); err != nil {
		t.Fatalf("body is not JSON: %v\n%s", err, body)
	}
	return out.Bytes()
}

// compareGolden checks got against testdata/gemini_wire/<name>, after compacting
// both sides. Updates are written indented, so a golden diff reads.
func compareGolden(t *testing.T, name string, got []byte) {
	t.Helper()
	path := filepath.Join("testdata", "gemini_wire", name)
	if os.Getenv("CHAT_GOLDEN_UPDATE") == "1" {
		var pretty bytes.Buffer
		if err := json.Indent(&pretty, got, "", "  "); err != nil {
			t.Fatalf("indent golden: %v", err)
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("create golden dir: %v", err)
		}
		if err := os.WriteFile(path, append(pretty.Bytes(), '\n'), 0o644); err != nil {
			t.Fatalf("write golden %s: %v", path, err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden %s: %v (run with CHAT_GOLDEN_UPDATE=1 to create it)", path, err)
	}
	if !bytes.Equal(compactJSON(t, got), compactJSON(t, want)) {
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

// functionResponseAt returns the response object of the i-th function response
// in a content's parts.
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
		if want := "/v1beta/models/" + wireModel + ":streamGenerateContent"; p != want {
			t.Fatalf("model call %d path = %q, want %q", i+1, p, want)
		}
	}
	if !slices.Equal(rec.toolQueries, []string{"BHP", "CBA"}) {
		t.Fatalf("tool queries = %q, want one call per function call, in order", rec.toolQueries)
	}

	compareGolden(t, "turn1_request.json", rec.geminiBody[0])
	compareGolden(t, "turn2_request.json", rec.geminiBody[1])

	// The second request answers the calls in the order the model made them.
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
		t.Fatalf("tool calls = %d, want 2", len(resp.ToolCalls))
	}
	for i, query := range []string{"BHP", "CBA"} {
		tc := resp.ToolCalls[i]
		if tc.Name != "search_stocks" || tc.Args["query"] != query || tc.Result != wireToolResult(query) {
			t.Fatalf("tool call %d = %+v, want search_stocks(%s) with its own result", i, tc, query)
		}
	}
	// Usage is the last usable chunk of each model call, summed over calls. A
	// sum over chunks would give 127 prompt tokens for the first call, not 120.
	if got, want := resp.Usage, (TokenUsage{PromptTokens: 380, CachedPromptTokens: 100, CandidateTokens: 21, TotalTokens: 401}); got != want {
		t.Fatalf("usage = %+v, want %+v", got, want)
	}
}

// Max output tokens reach the wire. Dropping SetMaxOutputTokens fails here.
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

// Text in a chunk that also carries a function call is not streamed. P1's rule:
// the chunk's text is dropped, and only the answer streams.
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

// An empty stored message is not sent. The API rejects an empty text part, so
// one blank assistant reply would break every later turn of the conversation.
func TestGeminiHistorySkipsEmptyMessages(t *testing.T) {
	replies := [][]string{{`{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"index":0}]}`}}
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

// A failure before any chunk is not reached: the request was refused, and it is
// not billed. A failure after a chunk arrived is reached.
func TestGeminiReachedFollowsWhetherAChunkArrived(t *testing.T) {
	t.Run("refused before any chunk", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.ReadAll(r.Body)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":{"code":400,"message":"bad request","status":"INVALID_ARGUMENT"}}`)
		}))
		t.Cleanup(srv.Close)
		session := mustWireSession(t, srv.URL)
		_, err := session.Send(context.Background(), SendInput{UserText: "hi"}, ToolChoiceAuto, func(ModelEvent) {})
		var pe *ProviderError
		if !errors.As(err, &pe) || pe.Reached {
			t.Fatalf("error = %v, want a ProviderError with Reached=false", err)
		}
	})

	t.Run("failed after a chunk", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.ReadAll(r.Body)
			w.Header().Set("Content-Type", "application/json")
			// One complete message, then a truncated one.
			_, _ = io.WriteString(w, `[{"candidates":[{"content":{"role":"model","parts":[{"text":"partial"}]},"index":0}]},{"candidates":[`)
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
	})
}

func mustWireSession(t *testing.T, geminiURL string) ModelSession {
	t.Helper()
	session, err := newWireProvider(t, geminiURL).NewSession(SessionConfig{Model: wireModel, System: "s", Tools: chatToolDefinitions()})
	if err != nil {
		t.Fatalf("NewSession() error = %v", err)
	}
	return session
}

// The Gemini mapping: a choice becomes the SDK's function calling mode. Auto must
// be nil, because that is the request the model received before the engine
// existed, and an explicit AUTO would change the wire.
func TestGeminiToolConfigMapsEachChoice(t *testing.T) {
	if got := geminiToolConfig(ToolChoiceAuto); got != nil {
		t.Fatalf("geminiToolConfig(Auto) = %+v, want nil", got)
	}
	tests := map[ToolChoice]genai.FunctionCallingMode{
		ToolChoiceRequired: genai.FunctionCallingAny,
		ToolChoiceNone:     genai.FunctionCallingNone,
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
