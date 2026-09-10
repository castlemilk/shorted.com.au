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

// The ceiling is only meaningful relative to the timeouts it sits under, and
// there are two of them.
//
// Cloudflare's proxy read timeout is what the CLIENT sees, and it is the
// binding one. It is not in this repo — it is a plan default — so it is stated
// here with its evidence: a probe against prod on 2026-09-10, after the 240s
// ceiling shipped, still came back
//
//	status=524 total=127.5s
//	"The origin web server did not return a complete response within the
//	 120-second Proxy Read Timeout window"
//
// Cloud Run's request timeout is what WE pay — a held request slot — and it
// does live in this repo, so read it rather than restate it. Raising it without
// revisiting this constant would silently leave the margin wrong.
const cloudflareProxyReadTimeout = 120 * time.Second

func TestStreamLifetimeClearsBothTimeouts(t *testing.T) {
	if StreamLifetime >= cloudflareProxyReadTimeout {
		t.Fatalf("StreamLifetime = %s but Cloudflare gives up on a silent stream at %s — "+
			"the client still gets a 524, which is the failure this constant exists to prevent",
			StreamLifetime, cloudflareProxyReadTimeout)
	}
	if margin := cloudflareProxyReadTimeout - StreamLifetime; margin < 15*time.Second {
		t.Errorf("only %s of margin below Cloudflare's %s read timeout — too tight to win the race",
			margin, cloudflareProxyReadTimeout)
	}

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
		t.Fatalf("StreamLifetime = %s but Cloud Run kills requests at %s — a stream would still hold "+
			"its slot until the platform ended it", StreamLifetime, platform)
	}
}
