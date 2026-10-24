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
)

// The golden wire test pins what chat sends to Gemini through the genai SDK. A
// fake endpoint records every request body and replays a scripted reply for each
// call, so the request bytes are compared against committed files. It drives the
// public ChatStream entry point.
//
// Scripted turn: the user asks a question. The first reply calls two data tools
// in one response, and the first call carries a thought signature. The second
// reply answers in text, split over two chunks. The second request must replay
// the first reply verbatim, signature included.
//
// The goldens are the canonical JSON that genai marshals, re-indented so a diff
// reads. To regenerate them after an intended wire change, run
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

// wireSignature is a base64 thought signature, as the API sends it in JSON.
const wireSignature = "c2lnLTE="

// wireReplies are the two scripted model replies, as JSON response messages.
var wireReplies = [][]string{
	{
		`{"candidates":[{"content":{"role":"model","parts":[` +
			`{"functionCall":{"name":"search_stocks","args":{"query":"BHP"}},"thoughtSignature":"` + wireSignature + `"},` +
			`{"functionCall":{"name":"search_stocks","args":{"query":"CBA"}}}` +
			`]},"index":0}],"usageMetadata":{"promptTokenCount":120,"candidatesTokenCount":12,"totalTokenCount":132}}`,
	},
	{
		`{"candidates":[{"content":{"role":"model","parts":[{"text":"BHP is shorted "}]},"index":0}]}`,
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
}

// newWireGemini serves the scripted replies in order as SSE, and records each
// request. genai reads the stream as "data:" events.
func newWireGemini(t *testing.T, rec *wireRecorder) *httptest.Server {
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
		if next >= len(wireReplies) {
			t.Errorf("unexpected model call %d: the script has %d replies", next+1, len(wireReplies))
			http.Error(w, "no scripted reply left", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, payload := range wireReplies[next] {
			_, _ = fmt.Fprintf(w, "data: %s\n\n", payload)
		}
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
	provider, err := newGeminiProviderAt(context.Background(), wireTestKey, geminiURL)
	if err != nil {
		t.Fatalf("newGeminiProviderAt() error = %v", err)
	}
	return newLLMClient(provider, wireModel, 0, NewToolExecutor(toolAPIURL))
}

// canonicalJSON re-indents a request body so a golden diff is readable. Go
// marshals map keys in order, so the indented form is deterministic.
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
		if want := "/v1beta/models/" + wireModel + ":streamGenerateContent?alt=sse"; p != want {
			t.Fatalf("model call %d = %q, want %q", i+1, p, want)
		}
	}
	if len(rec.toolPaths) != 2 {
		t.Fatalf("tool API calls = %d, want 2 (one per function call)", len(rec.toolPaths))
	}

	compareGolden(t, "turn1_request.json", canonicalJSON(t, rec.geminiBody[0]))
	compareGolden(t, "turn2_request.json", canonicalJSON(t, rec.geminiBody[1]))

	if want := []string{"BHP is shorted ", "at 4.2%."}; !slices.Equal(chunks, want) {
		t.Fatalf("streamed chunks = %q, want %q", chunks, want)
	}
	if len(resp.ToolCalls) != 2 {
		t.Fatalf("recorded tool calls = %d, want the two executed data calls", len(resp.ToolCalls))
	}
	for i, query := range []string{"BHP", "CBA"} {
		tc := resp.ToolCalls[i]
		if tc.Name != "search_stocks" || tc.Args["query"] != query || tc.Result != wireToolAPIBody {
			t.Fatalf("tool call %d = %+v, want search_stocks(%s) with the fixed result", i, tc, query)
		}
	}
	// Usage sums the last usable chunk of each model call.
	if got, want := resp.Usage, (TokenUsage{PromptTokens: 380, CachedPromptTokens: 100, CandidateTokens: 21, ReasoningTokens: 3, TotalTokens: 404}); got != want {
		t.Fatalf("usage = %+v, want %+v", got, want)
	}
}

// The second request must carry the model's first reply back verbatim: the
// function calls and the signature on the first of them.
func TestGeminiReplaysThoughtSignatureInTheSecondRequest(t *testing.T) {
	rec := &wireRecorder{}
	gemini := newWireGemini(t, rec)
	toolAPI := newWireToolAPI(t, rec)
	client := newWireTestClient(t, gemini.URL, toolAPI.URL)

	if _, err := client.ChatStream(context.Background(), "system", nil, "question", func(string) {}); err != nil {
		t.Fatalf("ChatStream() error = %v", err)
	}

	var second struct {
		Contents []struct {
			Role  string           `json:"role"`
			Parts []map[string]any `json:"parts"`
		} `json:"contents"`
	}
	if err := json.Unmarshal(rec.geminiBody[1], &second); err != nil {
		t.Fatalf("second request: %v", err)
	}
	var modelParts []map[string]any
	for _, c := range second.Contents {
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

// The tool choice reaches the wire as the mode the model must follow: nothing
// for Auto, ANY for Required and NONE for None. The ANY and NONE modes are what
// a forced first call and a text-only final round depend on.
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

// captureSendBody sends one text-only reply through a session with the given
// choice, and returns the request body that went out.
func captureSendBody(t *testing.T, choice ToolChoice) []byte {
	t.Helper()
	var body []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"index":0}]}`+"\n\n")
	}))
	t.Cleanup(srv.Close)

	provider, err := newGeminiProviderAt(context.Background(), wireTestKey, srv.URL)
	if err != nil {
		t.Fatalf("newGeminiProviderAt() error = %v", err)
	}
	session, err := provider.NewSession(SessionConfig{Model: wireModel, System: "s", Tools: chatToolDefinitions()})
	if err != nil {
		t.Fatalf("NewSession() error = %v", err)
	}
	if _, err := session.Send(context.Background(), SendInput{UserText: "hi"}, choice, func(ModelEvent) {}); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	return body
}

// A thought part is the model's reasoning. It never reaches the person, and only
// the answer text is streamed.
func TestGeminiNeverEmitsThoughtText(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"private reasoning","thought":true},{"text":"Answer."}]},"index":0}]}`+"\n\n")
	}))
	t.Cleanup(srv.Close)

	provider, err := newGeminiProviderAt(context.Background(), wireTestKey, srv.URL)
	if err != nil {
		t.Fatalf("newGeminiProviderAt() error = %v", err)
	}
	session, err := provider.NewSession(SessionConfig{Model: wireModel, System: "s", Tools: chatToolDefinitions()})
	if err != nil {
		t.Fatalf("NewSession() error = %v", err)
	}
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

// A 429 before any chunk is retryable and not reached. A 400 is neither. A failure
// after a chunk arrived was billed, so it is reached and not retryable.
func TestGeminiProviderErrorClassification(t *testing.T) {
	tests := []struct {
		name          string
		status        int
		body          string
		chunkFirst    bool
		wantReached   bool
		wantRetryable bool
		wantStatus    int
	}{
		{
			name:          "429 before any chunk is retryable",
			status:        http.StatusTooManyRequests,
			body:          `{"error":{"code":429,"message":"slow down","status":"RESOURCE_EXHAUSTED"}}`,
			wantReached:   false,
			wantRetryable: true,
			wantStatus:    http.StatusTooManyRequests,
		},
		{
			name:          "503 before any chunk is retryable",
			status:        http.StatusServiceUnavailable,
			body:          `{"error":{"code":503,"message":"busy","status":"UNAVAILABLE"}}`,
			wantReached:   false,
			wantRetryable: true,
			wantStatus:    http.StatusServiceUnavailable,
		},
		{
			name:          "400 is not retryable",
			status:        http.StatusBadRequest,
			body:          `{"error":{"code":400,"message":"bad request","status":"INVALID_ARGUMENT"}}`,
			wantReached:   false,
			wantRetryable: false,
			wantStatus:    http.StatusBadRequest,
		},
		{
			name:          "a malformed chunk after a response arrived was reached",
			status:        http.StatusOK,
			body:          "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"partial\"}]}}]}\n\ndata: {not json\n\n",
			chunkFirst:    true,
			wantReached:   true,
			wantRetryable: false,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.ReadAll(r.Body)
				if test.status != http.StatusOK {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(test.status)
					_, _ = io.WriteString(w, test.body)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, test.body)
			}))
			t.Cleanup(srv.Close)

			provider, err := newGeminiProviderAt(context.Background(), testKey, srv.URL)
			if err != nil {
				t.Fatalf("newGeminiProviderAt() error = %v", err)
			}
			session, err := provider.NewSession(SessionConfig{Model: wireModel, System: "s", Tools: chatToolDefinitions()})
			if err != nil {
				t.Fatalf("NewSession() error = %v", err)
			}
			_, err = session.Send(context.Background(), SendInput{UserText: "hi"}, ToolChoiceAuto, func(ModelEvent) {})
			if err == nil {
				t.Fatal("Send() error = nil, want a failure")
			}

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
			if test.wantStatus != 0 && pe.Status != test.wantStatus {
				t.Fatalf("status = %d, want %d", pe.Status, test.wantStatus)
			}
			assertNoKey(t, "provider error", err.Error())
		})
	}
}
