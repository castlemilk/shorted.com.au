package main

import (
	"bytes"
	"context"
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
// in one response, and the second reply answers in text.
//
// To regenerate the goldens after an intended change to the wire format, run
//
//	CHAT_GOLDEN_UPDATE=1 GOWORK=off go test ./chat-service/ -run TestGeminiWireGolden
//
// and review the diff before committing it.

const wireModel = "gemini-test"

// wireTestKey is a placeholder. The endpoint never checks it, and it is not a
// secret, so it is not registered for redaction.
const wireTestKey = "wire-test-key"

// wireToolAPIBody is what the fake Shorts API returns for every tool call. The
// search tools pass their body through unchanged, so the tool result the model
// reads is exactly this text.
const wireToolAPIBody = `{"stocks":[{"productCode":"BHP","name":"BHP Group"}]}`

// wireReplies are the two scripted model replies, as JSON response messages. The
// first is a response with two function calls, and it carries usage. The second
// is text split over two chunks, and it reports usage on the last one.
var wireReplies = [][]string{
	{
		`{"candidates":[{"content":{"role":"model","parts":[` +
			`{"functionCall":{"name":"search_stocks","args":{"query":"BHP"}}},` +
			`{"functionCall":{"name":"search_stocks","args":{"query":"CBA"}}}` +
			`]},"index":0}],"usageMetadata":{"promptTokenCount":120,"candidatesTokenCount":12,"totalTokenCount":132}}`,
	},
	{
		`{"candidates":[{"content":{"role":"model","parts":[{"text":"BHP is shorted "}]},"index":0}]}`,
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
}

// newWireGemini serves the scripted replies in order and records each request.
func newWireGemini(t *testing.T, rec *wireRecorder) *httptest.Server {
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
		if next >= len(wireReplies) {
			t.Errorf("unexpected model call %d: the script has %d replies", next+1, len(wireReplies))
			http.Error(w, "no scripted reply left", http.StatusInternalServerError)
			return
		}
		// The SDK reads a reply as one JSON array of response messages.
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, "["+strings.Join(wireReplies[next], ",")+"]")
		next++
	}))
	t.Cleanup(srv.Close)
	return srv
}

// newWireToolAPI serves the same fixed body for every Shorts API call.
func newWireToolAPI(t *testing.T, rec *wireRecorder) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.toolPaths = append(rec.toolPaths, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, wireToolAPIBody)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// newWireTestClient builds the chat client against the fake Gemini endpoint.
func newWireTestClient(t *testing.T, geminiURL, toolAPIURL string) *LLMClient {
	t.Helper()
	gemini, err := genai.NewClient(context.Background(),
		option.WithAPIKey(wireTestKey),
		option.WithEndpoint(geminiURL),
	)
	if err != nil {
		t.Fatalf("genai.NewClient() error = %v", err)
	}
	t.Cleanup(func() { _ = gemini.Close() })
	return llmClientOverGemini(gemini, wireModel, NewToolExecutor(toolAPIURL))
}

// llmClientOverGemini is the chat client over an existing Gemini SDK client. The
// tests use it to point a real provider at a fake endpoint.
func llmClientOverGemini(gemini *genai.Client, model string, tools *ToolExecutor) *LLMClient {
	return newLLMClient(&geminiProvider{client: gemini}, model, 0, tools)
}

// compareGolden checks got against testdata/gemini_wire/<name>, byte for byte.
func compareGolden(t *testing.T, name string, got []byte) {
	t.Helper()
	path := filepath.Join("testdata", "gemini_wire", name)
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

func TestGeminiWireGolden(t *testing.T) {
	rec := &wireRecorder{}
	gemini := newWireGemini(t, rec)
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
	if len(rec.toolPaths) != 2 {
		t.Fatalf("tool API calls = %d, want 2 (one per function call)", len(rec.toolPaths))
	}

	compareGolden(t, "turn1_request.json", rec.geminiBody[0])
	compareGolden(t, "turn2_request.json", rec.geminiBody[1])

	if want := []string{"BHP is shorted ", "at 4.2%."}; !slices.Equal(chunks, want) {
		t.Fatalf("streamed chunks = %q, want %q", chunks, want)
	}
	if len(resp.ToolCalls) != 2 {
		t.Fatalf("tool calls = %d, want 2", len(resp.ToolCalls))
	}
	for i, query := range []string{"BHP", "CBA"} {
		tc := resp.ToolCalls[i]
		if tc.Name != "search_stocks" || tc.Args["query"] != query || tc.Result != wireToolAPIBody {
			t.Fatalf("tool call %d = %+v, want search_stocks(%s) with the fixed result", i, tc, query)
		}
	}
	// Usage sums the usable chunk of each model call. The first call reports no
	// cache, and the second reports 100 cached prompt tokens.
	if got, want := resp.Usage, (TokenUsage{PromptTokens: 380, CachedPromptTokens: 100, CandidateTokens: 21, TotalTokens: 401}); got != want {
		t.Fatalf("usage = %+v, want %+v", got, want)
	}
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
