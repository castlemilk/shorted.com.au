package mcp

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"testing"
	"time"
)

// A subscriptions/listen POST (SEP-2575) has no synchronous result: the server
// acknowledges the subscription and then holds the SSE stream open, pushing
// notifications as they occur. Left alone it stays open until Cloud Run's 300s
// request timeout kills it — which Cloudflare records as a 524, and which held
// a request slot for five minutes each time. The handler must end it first,
// and end it as a COMPLETED response.
//
// Two details this test depends on, both learned the hard way:
//   - it drives a REAL socket, because the hang lives in the streamable HTTP
//     transport and an in-memory transport cannot see it;
//   - it uses a data source, because a server with no tools honours no
//     subscriptions and completes the listen immediately. Against Handler(nil)
//     this test passes without the fix.
func TestHeldOpenStreamEndsBeforeThePlatformTimeout(t *testing.T) {
	const lifetime = 300 * time.Millisecond

	srv := httptest.NewServer(HandlerWithLifetime(&fakeDataSource{}, lifetime))
	t.Cleanup(srv.Close)

	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "subscriptions/listen",
		"params": map[string]any{
			"notifications": map[string]any{"toolsListChanged": true},
			"_meta": map[string]any{
				"io.modelcontextprotocol/protocolVersion":    latestProtocolVersion,
				"io.modelcontextprotocol/clientCapabilities": map[string]any{},
				"io.modelcontextprotocol/clientInfo":         map[string]any{"name": "test-client", "version": "0.0.1"},
			},
		},
	})
	req, err := http.NewRequest(http.MethodPost, srv.URL, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", latestProtocolVersion)
	req.Header.Set("Mcp-Method", "subscriptions/listen")

	start := time.Now()
	// A client timeout well above the ceiling: if the stream is unbounded this
	// fails as a transport error rather than hanging the suite.
	resp, err := (&http.Client{Timeout: 20 * lifetime}).Do(req)
	if err != nil {
		t.Fatalf("subscriptions/listen did not complete within %s — the request context is not bounded: %v",
			20*lifetime, err)
	}
	defer func() { _ = resp.Body.Close() }()
	// Reading to EOF is the point: the stream must END, not merely respond.
	raw, err := io.ReadAll(resp.Body)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("reading the stream to completion: %v", err)
	}

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("held-open stream ended with status %d: %s — ending it ourselves, as a normal "+
			"response, is the whole point", resp.StatusCode, raw)
	}
	if !bytes.Contains(raw, []byte("notifications/subscriptions/acknowledged")) {
		t.Fatalf("the server never acknowledged the subscription, so this never held a stream open "+
			"and proves nothing: %s", raw)
	}
	if elapsed < lifetime {
		t.Fatalf("stream ended after %s, before the %s ceiling — it completed on its own, so this "+
			"test is not exercising the bound", elapsed, lifetime)
	}
	if elapsed > 10*lifetime {
		t.Fatalf("stream stayed open %s against a %s ceiling", elapsed, lifetime)
	}
}

// An ordinary call must not pay for the ceiling: it completes in milliseconds
// and never reaches the deadline.
func TestBoundedLifetimeDoesNotDelayOrdinaryCalls(t *testing.T) {
	srv := httptest.NewServer(HandlerWithLifetime(nil, 5*time.Second))
	t.Cleanup(srv.Close)

	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "initialize",
		"params": map[string]any{
			"protocolVersion": "2025-11-25",
			"capabilities":    map[string]any{},
			"clientInfo":      map[string]any{"name": "test-client", "version": "0.0.1"},
		},
	})
	req, _ := http.NewRequest(http.MethodPost, srv.URL, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")

	start := time.Now()
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("initialize: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("initialize status = %d, body = %s", resp.StatusCode, raw)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Errorf("initialize took %s — a request/response call must not wait out the stream ceiling", elapsed)
	}
}

// The ceiling is only meaningful relative to the platform timeout it sits
// under. That timeout lives in Terraform, so read it there rather than
// restating it: raising Cloud Run's timeout without revisiting this constant
// would silently leave the margin wrong.
func TestStreamLifetimeIsBelowCloudRunTimeout(t *testing.T) {
	const tf = "../../../../terraform/modules/shorts-api/main.tf"
	src, err := os.ReadFile(tf)
	if err != nil {
		t.Skipf("cannot read %s: %v", tf, err)
	}
	m := regexp.MustCompile(`(?m)^\s*timeout\s*=\s*"(\d+)s"`).FindSubmatch(src)
	if m == nil {
		t.Fatalf("no request timeout found in %s — has the Cloud Run service moved?", tf)
	}
	var secs time.Duration
	for _, c := range m[1] {
		secs = secs*10 + time.Duration(c-'0')
	}
	platform := secs * time.Second
	if StreamLifetime >= platform {
		t.Fatalf("StreamLifetime = %s but Cloud Run kills requests at %s — a stream would still be 504'd",
			StreamLifetime, platform)
	}
	if platform-StreamLifetime < 30*time.Second {
		t.Errorf("only %s of margin below the %s platform timeout — too tight to win the race",
			platform-StreamLifetime, platform)
	}
}
