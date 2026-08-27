package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

const latestProtocolVersion = "2026-07-28"

// connectInMemory wires a client and server together over the SDK's own
// in-memory transport, so these tests exercise real protocol framing and real
// version negotiation rather than our idea of them.
func connectInMemory(t *testing.T) *sdk.ClientSession {
	t.Helper()
	ctx := context.Background()

	server := NewServer(nil)
	client := sdk.NewClient(&sdk.Implementation{Name: "test-client", Version: "0.0.1"}, nil)

	clientTransport, serverTransport := sdk.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatalf("server connect: %v", err)
	}
	t.Cleanup(func() { _ = serverSession.Close() })

	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })

	return session
}

func TestServerDiscoverReportsIdentityAndVersion(t *testing.T) {
	session := connectInMemory(t)

	got := session.InitializeResult()
	if got == nil {
		t.Fatal("no initialize result — the handshake produced nothing")
	}
	if got.ServerInfo == nil {
		t.Fatal("no server info — a client cannot identify us")
	}
	if got.ServerInfo.Name != ServerName {
		t.Errorf("server name = %q, want %q", got.ServerInfo.Name, ServerName)
	}
	if got.ServerInfo.Version != ServerVersion {
		t.Errorf("server version = %q, want %q", got.ServerInfo.Version, ServerVersion)
	}
	// The SDK client prefers server/discover, which only succeeds on
	// 2026-07-28 or later; anything older means we fell back to the legacy
	// initialize path.
	if want := latestProtocolVersion; got.ProtocolVersion != want {
		t.Errorf("negotiated protocol version = %q, want %q", got.ProtocolVersion, want)
	}
}

// A server with no data source registers no tools. This is what makes the
// Task 1 slice honest: the protocol works before any tool exists.
func TestServerWithoutDataSourceHasNoTools(t *testing.T) {
	session := connectInMemory(t)

	res, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("tools/list: %v", err)
	}
	if len(res.Tools) != 0 {
		t.Errorf("got %d tools, want 0", len(res.Tools))
	}
}

// The in-memory transport is not the transport we actually serve. The SDK
// only advertises protocol 2026-07-28 over streamable HTTP when the transport
// is STATELESS — a stateful handler quietly omits it from server/discover and
// every client silently downgrades to the legacy initialize path. That is a
// transport-level property no in-memory test can see, so this exercises the
// real handler over a real socket.
func TestHTTPHandlerServesLatestProtocolVersion(t *testing.T) {
	ctx := context.Background()

	srv := httptest.NewServer(Handler(nil))
	t.Cleanup(srv.Close)

	client := sdk.NewClient(&sdk.Implementation{Name: "test-client", Version: "0.0.1"}, nil)
	session, err := client.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: srv.URL}, nil)
	if err != nil {
		t.Fatalf("client connect over HTTP: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })

	got := session.InitializeResult()
	if got.ProtocolVersion != latestProtocolVersion {
		t.Errorf("negotiated protocol version over HTTP = %q, want %q "+
			"(is the streamable handler still Stateless?)", got.ProtocolVersion, latestProtocolVersion)
	}
	if got.ServerInfo == nil || got.ServerInfo.Name != ServerName {
		t.Errorf("server info over HTTP = %+v, want name %q", got.ServerInfo, ServerName)
	}
}

// Backwards compatibility: a client that only speaks the legacy initialize
// handshake must still connect. Going stateless to unlock 2026-07-28 must not
// strand clients pinned to an older version, so this drives the raw legacy
// wire format rather than the SDK client (which would negotiate up).
//
// Dropping any version listed here is a breaking change for clients pinned to
// it.
func TestHTTPHandlerSupportsLegacyProtocolVersions(t *testing.T) {
	srv := httptest.NewServer(Handler(nil))
	t.Cleanup(srv.Close)

	for _, version := range []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"} {
		t.Run(version, func(t *testing.T) {
			body, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"id":      1,
				"method":  "initialize",
				"params": map[string]any{
					"protocolVersion": version,
					"capabilities":    map[string]any{},
					"clientInfo":      map[string]any{"name": "legacy-client", "version": "0.0.1"},
				},
			})

			req, err := http.NewRequest(http.MethodPost, srv.URL, bytes.NewReader(body))
			if err != nil {
				t.Fatalf("new request: %v", err)
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Accept", "application/json, text/event-stream")

			resp, err := srv.Client().Do(req)
			if err != nil {
				t.Fatalf("initialize: %v", err)
			}
			defer resp.Body.Close()

			raw, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("initialize status = %d, body = %s", resp.StatusCode, raw)
			}
			if !strings.Contains(string(raw), `"protocolVersion":"`+version+`"`) {
				t.Errorf("initialize on %s did not echo that version back: %s", version, raw)
			}
			if !strings.Contains(string(raw), ServerName) {
				t.Errorf("initialize on %s did not identify the server: %s", version, raw)
			}
		})
	}
}
