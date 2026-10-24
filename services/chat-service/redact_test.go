package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/url"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
)

// testKey is the configured Gemini key in these tests. leakedURL is the shape of
// the request URL the SDK writes into its error text, with the key in its query.
const (
	testKey   = "TESTKEY123"
	leakedURL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?%24alt=json%3Benum-encoding%3Dint&key=TESTKEY123&alt=sse"
)

// assertNoKey fails if text carries the configured key in any form. A test that
// asserts only the absence of the key would pass against an empty string, so
// callers also assert the redaction marker is present where the key was.
func assertNoKey(t *testing.T, label, text string) {
	t.Helper()
	for _, form := range []string{testKey, url.QueryEscape(testKey)} {
		if strings.Contains(text, form) {
			t.Fatalf("%s carries the key %q: %q", label, form, text)
		}
	}
}

// captureRawLog runs fn and returns the text the standard logger wrote. Unlike
// captureLogLines it does not require JSON, so it covers plain log lines too.
func captureRawLog(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	oldOutput := log.Writer()
	oldFlags := log.Flags()
	oldPrefix := log.Prefix()
	log.SetOutput(&buf)
	log.SetFlags(0)
	log.SetPrefix("")
	defer func() {
		log.SetOutput(oldOutput)
		log.SetFlags(oldFlags)
		log.SetPrefix(oldPrefix)
	}()
	fn()
	return buf.String()
}

func TestRedactSecretsRemovesTheConfiguredKeyAndTheQueryParameter(t *testing.T) {
	registerSecrets(testKey)
	in := `Post "` + leakedURL + `": dial tcp 127.0.0.1:1: connection refused; body echoed TESTKEY123`

	out := redactSecrets(in)

	assertNoKey(t, "redacted text", out)
	if !strings.Contains(out, "&key=[REDACTED]&alt=sse") {
		t.Fatalf("query value not replaced in place: %q", out)
	}
}

func TestRedactSecretsStripsAKeyParameterEvenWhenTheValueIsUnregistered(t *testing.T) {
	// No registration here, so only the URL pattern can remove the value.
	out := redactSecrets("https://example.test/v1?alt=sse&key=UNREGISTERED999&x=1")

	if strings.Contains(out, "UNREGISTERED999") {
		t.Fatalf("key= value survived: %q", out)
	}
	if !strings.Contains(out, "&key=[REDACTED]&x=1") {
		t.Fatalf("parameters around the key were disturbed: %q", out)
	}
}

func TestRedactSecretsHandlesAKeyParameterInsideAJSONLogLine(t *testing.T) {
	// encoding/json writes an ampersand as an escape sequence, so the pattern must
	// match that form too. Structured log lines are JSON. The value here is never
	// registered, so only the URL pattern can remove it.
	const value = "UNREGISTERED777"
	rawURL := "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=" + value + "&alt=sse"
	line, err := json.Marshal(map[string]any{"error": rawURL})
	if err != nil {
		t.Fatal(err)
	}
	escaped := `\u0026key=`
	if !strings.Contains(string(line), escaped) {
		t.Fatalf("test precondition: encoder did not escape the ampersand: %s", line)
	}

	out := redactSecrets(string(line))

	if strings.Contains(out, value) {
		t.Fatalf("escaped key= value survived: %s", out)
	}
	if !strings.Contains(out, escaped+"[REDACTED]") {
		t.Fatalf("escaped query value not replaced in place: %s", out)
	}
}

func TestRedactSecretsLeavesUnrelatedTextAlone(t *testing.T) {
	in := "keyword=stock&monkey=banana and stock key metrics for ZIP"
	if out := redactSecrets(in); out != in {
		t.Fatalf("redactSecrets(%q) = %q, want it unchanged", in, out)
	}
}

func TestRegisteredSecretIsRedactedInItsURLEncodedForm(t *testing.T) {
	const value = "a+b key/x"
	registerSecrets(value)

	encoded := url.QueryEscape(value)
	out := redactSecrets("callback?state=" + encoded)

	if strings.Contains(out, encoded) {
		t.Fatalf("encoded secret survived: %q", out)
	}
}

// TestGeminiErrorNeverCarriesTheKey runs the real SDK against a port that refuses
// connections. The error that leaves the package, and the line it is logged as,
// must carry no trace of the key. The URL redaction itself is covered by the
// tests above, since a key in a query string is what that rule removes.
func TestGeminiErrorNeverCarriesTheKey(t *testing.T) {
	registerSecrets(testKey)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	provider, err := newGeminiProviderAt(ctx, testKey, "http://127.0.0.1:1")
	if err != nil {
		t.Fatalf("newGeminiProviderAt() error = %v", err)
	}
	lc := newLLMClient(provider, "gemini-test", 0, nil)
	_, err = lc.ChatStream(ctx, "system", nil, "hello", func(string) {})
	if err == nil {
		t.Fatal("ChatStream() error = nil, want the refused connection")
	}

	assertNoKey(t, "ChatStream error", err.Error())
	// genai sends the key in a header, so the error no longer carries a URL with
	// the key in it. The test still needs the error to name the endpoint, or it
	// proves nothing.
	if !strings.Contains(err.Error(), "127.0.0.1:1") {
		t.Fatalf("the error named no endpoint, so this test proves nothing: %q", err)
	}

	logged := captureRawLog(t, func() { logRedacted("LLM error: %v", err) })
	assertNoKey(t, "logged LLM error", logged)
}

func TestModelFailureToTheClientNamesNoProvider(t *testing.T) {
	// The error as the provider produced it, with the key in its URL.
	raw := errors.New(`Post "` + leakedURL + `": 500 internal`)

	var clientErr error
	logged := captureRawLog(t, func() { clientErr = modelFailure(raw) })

	if connect.CodeOf(clientErr) != connect.CodeInternal {
		t.Fatalf("code = %v, want internal", connect.CodeOf(clientErr))
	}
	var connectErr *connect.Error
	if !errors.As(clientErr, &connectErr) {
		t.Fatalf("error is %T, want *connect.Error", clientErr)
	}
	if connectErr.Message() != modelFailureMessage {
		t.Fatalf("client message = %q, want the generic text", connectErr.Message())
	}
	for _, leak := range []string{"generativelanguage", "key=", testKey} {
		if strings.Contains(connectErr.Message(), leak) {
			t.Fatalf("client message carries %q: %q", leak, connectErr.Message())
		}
	}

	// The detail is still logged, and it is the redacted form.
	if !strings.Contains(logged, "LLM error:") {
		t.Fatalf("the detail was not logged: %q", logged)
	}
	assertNoKey(t, "logged model failure", logged)
	if !strings.Contains(logged, redactedMarker) {
		t.Fatalf("logged detail has no redaction marker: %q", logged)
	}
}

func TestInternalFailureToTheClientNamesNoDetail(t *testing.T) {
	raw := errors.New("pq: could not connect with credential TESTKEY123 at host db")

	var clientErr error
	logged := captureRawLog(t, func() { clientErr = internalFailure("get conversation", raw) })

	var connectErr *connect.Error
	if !errors.As(clientErr, &connectErr) || connectErr.Message() != internalFailureMessage {
		t.Fatalf("client error = %v, want the generic internal message", clientErr)
	}
	assertNoKey(t, "client message", connectErr.Message())
	assertNoKey(t, "logged internal failure", logged)
	if !strings.Contains(logged, "chat get conversation failed") {
		t.Fatalf("the operation was not logged: %q", logged)
	}
}

func TestStructuredLogLineIsScrubbed(t *testing.T) {
	// logLimitFailure writes its error through mustMarshalLogEvent. The line it
	// writes must come out without the key.
	logged := captureRawLog(t, func() {
		logLimitFailure("admit", errors.New(`provider said `+leakedURL))
	})

	assertNoKey(t, "structured log line", logged)
	var event map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(logged)), &event); err != nil {
		t.Fatalf("scrubbed line is no longer JSON: %v: %q", err, logged)
	}
	if event["type"] != "chat_limit_error" {
		t.Fatalf("event = %v, want the limit failure", event)
	}
}

func TestRedactingWriterScrubsEveryLine(t *testing.T) {
	// A call that never went through a redacting helper must still be scrubbed,
	// because the process's own writer does it.
	registerSecrets(testKey)
	var buf bytes.Buffer
	unredacted := log.New(redactingWriter{dst: &buf}, "", 0)

	unredacted.Printf("http server error: %s", leakedURL)

	assertNoKey(t, "process log output", buf.String())
	if !strings.Contains(buf.String(), "key=[REDACTED]") {
		t.Fatalf("writer passed the query value through: %q", buf.String())
	}
}
