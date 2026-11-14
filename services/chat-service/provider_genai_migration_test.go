package main

import (
	"context"
	"encoding/json"
	"fmt"
	"google.golang.org/genai"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// This transport exercises the real SDK without opening a network connection.
type migrationCapture struct {
	bodies  []map[string]any
	paths   []string
	replies []string
}

func (m *migrationCapture) RoundTrip(r *http.Request) (*http.Response, error) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	var body map[string]any
	if err = json.Unmarshal(raw, &body); err != nil {
		return nil, err
	}
	m.bodies = append(m.bodies, body)
	m.paths = append(m.paths, r.URL.Path)
	n := len(m.bodies) - 1
	if n >= len(m.replies) {
		return nil, fmt.Errorf("unexpected model request %d", n+1)
	}
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader("data: " + m.replies[n] + "\n\n")), Request: r}, nil
}

const migrationDone = `{"candidates":[{"content":{"role":"model","parts":[{"text":"Done"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":20,"thoughtsTokenCount":3,"totalTokenCount":123}}`

func newMigrationSession(t *testing.T, model string, replies ...string) (ModelSession, *migrationCapture) {
	t.Helper()
	tr := &migrationCapture{replies: replies}
	client, err := genai.NewClient(context.Background(), &genai.ClientConfig{APIKey: "offline-test-key", Backend: genai.BackendGeminiAPI, HTTPClient: &http.Client{Transport: tr}})
	if err != nil {
		t.Fatal(err)
	}
	provider := &geminiProvider{client: client, timeouts: defaultStreamTimeouts()}
	temperature := 0.7
	session, err := provider.NewSession(SessionConfig{Model: model, System: "Use supplied tools.", MaxOutputTokens: 700, History: []Message{{Role: "assistant", Content: "Prior answer"}}, Tools: []ToolDefinition{{Name: "lookup", Description: "Look up a value"}}, Params: ModelParams{Temperature: &temperature}})
	if err != nil {
		t.Fatal(err)
	}
	return session, tr
}
func sendMigration(t *testing.T, s ModelSession, in SendInput) ModelReply {
	t.Helper()
	r, err := s.Send(context.Background(), in, ToolChoiceAuto, func(ModelEvent) {})
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func TestGemini35RequestConfigWire(t *testing.T) {
	for _, model := range []string{"gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3.5-flash-lite", "models/gemini-3.5-flash-lite"} {
		t.Run(model, func(t *testing.T) {
			s, tr := newMigrationSession(t, model, migrationDone)
			reply := sendMigration(t, s, SendInput{UserText: "Question"})
			cfg := tr.bodies[0]["generationConfig"].(map[string]any)
			target := strings.TrimPrefix(model, "models/") == "gemini-3.5-flash-lite"
			if target {
				if !reflect.DeepEqual(cfg["thinkingConfig"], map[string]any{"thinkingLevel": "MEDIUM"}) {
					t.Fatalf("thinkingConfig=%#v", cfg)
				}
				for _, key := range []string{"temperature", "topP", "topK", "candidateCount"} {
					if _, ok := cfg[key]; ok {
						t.Fatalf("unexpected %s: %#v", key, cfg)
					}
				}
			} else if cfg["candidateCount"] != float64(1) || cfg["temperature"] == nil || cfg["thinkingConfig"] != nil {
				t.Fatalf("legacy config changed: %#v", cfg)
			}
			if !strings.Contains(tr.paths[0], "/models/"+strings.TrimPrefix(model, "models/")+":") {
				t.Fatalf("model path=%s", tr.paths[0])
			}
			if cfg["maxOutputTokens"] != float64(700) {
				t.Fatal("lost token limit")
			}
			contents := tr.bodies[0]["contents"].([]any)
			if contents[len(contents)-1].(map[string]any)["role"] != "user" {
				t.Fatal("model prefill")
			}
			if tr.bodies[0]["tools"] == nil || tr.bodies[0]["systemInstruction"] == nil {
				t.Fatal("lost tools/system")
			}
			if reply.Usage.ReasoningTokens != 3 || reply.Usage.TotalTokens != 123 {
				t.Fatalf("usage=%#v", reply.Usage)
			}
		})
	}
}
func TestGemini35ProviderIDAndSignatureReplay(t *testing.T) {
	first := `{"candidates":[{"content":{"role":"model","parts":[{"text":"private reasoning","thought":true,"thoughtSignature":"c2lnLWE="},{"functionCall":{"id":"provider-a","name":"lookup","args":{"key":"a"}},"thoughtSignature":"c2lnLWI="},{"functionCall":{"id":"provider-b","name":"lookup","args":{"key":"b"}}},{"thoughtSignature":"c2lnLWM="}]}}]}`
	s, tr := newMigrationSession(t, "gemini-3.5-flash-lite", first, migrationDone)
	r := sendMigration(t, s, SendInput{UserText: "Question"})
	if r.Text != "" || len(r.ToolCalls) != 2 {
		t.Fatalf("reply=%#v", r)
	}
	results := []ToolResult{}
	for _, call := range r.ToolCalls {
		results = append(results, ToolResult{CallID: call.ID, Name: call.Name, JSON: `{"value":1}`})
	}
	sendMigration(t, s, SendInput{ToolResults: results})
	contents := tr.bodies[1]["contents"].([]any)
	var original map[string]any
	if err := json.Unmarshal([]byte(first), &original); err != nil {
		t.Fatal(err)
	}
	want := original["candidates"].([]any)[0].(map[string]any)["content"].(map[string]any)["parts"]
	got := contents[len(contents)-2].(map[string]any)["parts"]
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parts changed: got %#v want %#v", got, want)
	}
	responses := contents[len(contents)-1].(map[string]any)["parts"].([]any)
	for i, id := range []string{"provider-a", "provider-b"} {
		fr := responses[i].(map[string]any)["functionResponse"].(map[string]any)
		if fr["id"] != id || fr["name"] != "lookup" {
			t.Fatalf("response=%#v", fr)
		}
	}
}
func TestGemini35SyntheticIDCollisions(t *testing.T) {
	for _, reverse := range []bool{false, true} {
		t.Run(fmt.Sprint(reverse), func(t *testing.T) {
			parts := []string{`{"functionCall":{"name":"lookup","args":{"key":"synthetic"}}}`, `{"functionCall":{"id":"call_1","name":"lookup","args":{"key":"real"}}}`}
			if reverse {
				parts[0], parts[1] = parts[1], parts[0]
			}
			first := `{"candidates":[{"content":{"role":"model","parts":[` + strings.Join(parts, ",") + `]}}]}`
			s, tr := newMigrationSession(t, "gemini-3.5-flash-lite", first, migrationDone)
			r := sendMigration(t, s, SendInput{UserText: "Question"})
			if len(r.ToolCalls) != 2 || r.ToolCalls[0].ID == r.ToolCalls[1].ID {
				t.Fatalf("ID collision: %#v", r.ToolCalls)
			}
			results := []ToolResult{}
			for _, c := range r.ToolCalls {
				results = append(results, ToolResult{CallID: c.ID, Name: c.Name, JSON: `{"value":1}`})
			}
			sendMigration(t, s, SendInput{ToolResults: results})
			contents := tr.bodies[1]["contents"].([]any)
			responses := contents[len(contents)-1].(map[string]any)["parts"].([]any)
			for i, c := range r.ToolCalls {
				fr := responses[i].(map[string]any)["functionResponse"].(map[string]any)
				if c.Args["key"] == "synthetic" {
					if _, ok := fr["id"]; ok {
						t.Fatalf("synthetic ID echoed: %#v", fr)
					}
				} else if fr["id"] != "call_1" {
					t.Fatalf("lost provider ID: %#v", fr)
				}
			}
		})
	}
}
func TestGemini35AllMissingIDsStayInternal(t *testing.T) {
	first := `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"lookup","args":{}}},{"functionCall":{"name":"lookup","args":{}}}]}}]}`
	s, tr := newMigrationSession(t, "gemini-3.5-flash-lite", first, migrationDone)
	r := sendMigration(t, s, SendInput{UserText: "Question"})
	if len(r.ToolCalls) != 2 || r.ToolCalls[0].ID == r.ToolCalls[1].ID {
		t.Fatalf("IDs=%#v", r.ToolCalls)
	}
	results := []ToolResult{}
	for _, c := range r.ToolCalls {
		results = append(results, ToolResult{CallID: c.ID, Name: c.Name, JSON: `{"value":1}`})
	}
	sendMigration(t, s, SendInput{ToolResults: results})
	contents := tr.bodies[1]["contents"].([]any)
	responses := contents[len(contents)-1].(map[string]any)["parts"].([]any)
	for _, part := range responses {
		if _, ok := part.(map[string]any)["functionResponse"].(map[string]any)["id"]; ok {
			t.Fatal("synthetic ID echoed")
		}
	}
}
