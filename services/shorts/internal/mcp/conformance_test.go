package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Protocol conformance: what a REAL client sees, driven through the SDK's own
// client (and, where the SDK client would smooth something over, the raw wire).
//
// The per-tool tests elsewhere in this package drive handlers directly and
// assert projections. These assert the protocol contract around them: that
// server/discover advertises the versions we claim, that every domain returns
// STRUCTURED content and not just prose, that an unknown tool name fails
// legibly, and that a client speaking a version we do not have gets told which
// versions we do.

// The versions the SDK negotiates for us. Listed explicitly rather than read
// back from the server, because the point of the assertion is that dropping one
// is a breaking change a client notices before we do.
var conformanceSupportedVersions = []string{
	"2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05",
}

// newConformanceSession connects an in-process SDK client to a server backed by
// the same worst-case fixtures the payload budget test uses, so a structured
// result here is one with every field populated rather than a lucky empty one.
func newConformanceSession(t *testing.T) (*sdk.ClientSession, context.Context) {
	t.Helper()
	ctx := context.Background()

	server := NewServer(realisticSource())
	client := sdk.NewClient(&sdk.Implementation{Name: "conformance", Version: "0.0.1"}, nil)

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

	return session, ctx
}

// ---------------------------------------------------------------------------
// server/discover
// ---------------------------------------------------------------------------

// The SDK client reports only the version it NEGOTIATED, so it cannot see the
// list the server advertised — and that list is the whole point of
// server/discover for a client deciding whether it can talk to us at all. Hence
// the raw request.
func TestServerDiscoverAdvertisesEveryVersionWeSupport(t *testing.T) {
	// A data source is required for the capability assertion below: the SDK
	// omits the "tools" capability entirely when no tool is registered, so a
	// nil-source server would pass a weaker test than production runs.
	srv := httptest.NewServer(Handler(realisticSource()))
	t.Cleanup(srv.Close)

	// server/discover carries the server identity in _meta under
	// io.modelcontextprotocol/serverInfo, NOT as a top-level field — the
	// handshake-less protocol moved it there, and a client reading
	// result.serverInfo finds nothing.
	var result struct {
		SupportedVersions []string       `json:"supportedVersions"`
		Capabilities      map[string]any `json:"capabilities"`
		Meta              struct {
			ServerInfo *struct {
				Name    string `json:"name"`
				Title   string `json:"title"`
				Version string `json:"version"`
			} `json:"io.modelcontextprotocol/serverInfo"`
		} `json:"_meta"`
	}
	if err := rawCall(t, srv, "server/discover", nil, &result); err != nil {
		t.Fatalf("server/discover: %v", err)
	}

	for _, want := range conformanceSupportedVersions {
		if !contains(result.SupportedVersions, want) {
			t.Errorf("server/discover does not advertise %s (got %v) — dropping a version is a breaking change for clients pinned to it",
				want, result.SupportedVersions)
		}
	}
	if len(result.SupportedVersions) == 0 || result.SupportedVersions[0] != latestProtocolVersion {
		t.Errorf("server/discover supportedVersions = %v, want %s first — clients pick the head of this list",
			result.SupportedVersions, latestProtocolVersion)
	}

	info := result.Meta.ServerInfo
	if info == nil {
		t.Fatal("server/discover returned no serverInfo in _meta — a client cannot identify us before connecting")
	}
	if info.Name != ServerName {
		t.Errorf("serverInfo.name = %q, want %q", info.Name, ServerName)
	}
	if info.Title != ServerTitle {
		t.Errorf("serverInfo.title = %q, want %q", info.Title, ServerTitle)
	}
	if info.Version != ServerVersion {
		t.Errorf("serverInfo.version = %q, want %q", info.Version, ServerVersion)
	}

	// Capabilities drive what a client bothers to ask for. We serve tools,
	// resources and prompts on every server, data source or not.
	for _, capability := range []string{"tools", "resources", "prompts"} {
		if _, ok := result.Capabilities[capability]; !ok {
			t.Errorf("server/discover does not advertise the %q capability (got %v) — clients skip surfaces we do not declare",
				capability, result.Capabilities)
		}
	}
}

// ---------------------------------------------------------------------------
// tools/call — structured content, per domain
// ---------------------------------------------------------------------------

// A tool that returns only prose is not machine-consumable: the whole reason
// every tool declares an output schema is that a client can parse the result
// instead of asking a model to. Asserting "no error" would pass on a result
// with a text blob and a nil structuredContent, which is exactly the
// regression worth catching.
//
// One representative tool per DOMAIN, and the domain list is derived from the
// registry rather than hardcoded, so adding a ninth domain fails here until it
// is covered.
func TestToolsCallReturnsStructuredContentForEveryDomain(t *testing.T) {
	session, ctx := newConformanceSession(t)

	representatives := map[string]struct {
		tool string
		args map[string]any
		// keys that must be present AND non-empty in the structured output —
		// the payload a client would actually read for that domain.
		wants []string
	}{
		"market":      {"list_top_shorts", map[string]any{}, []string{"period", "count", "stocks"}},
		"stock":       {"get_stock", map[string]any{"code": "BHP"}, []string{"code", "name"}},
		"discovery":   {"search_stocks", map[string]any{"query": "minerals"}, []string{"query", "count", "matches"}},
		"news":        {"get_stock_news", map[string]any{"code": "PLS"}, []string{"code", "returned", "articles"}},
		"reports":     {"list_reports", map[string]any{}, []string{"count", "reports"}},
		"housing":     {"get_housing_overview", map[string]any{}, []string{"count", "metrics", "source"}},
		"economy":     {"list_economic_series", map[string]any{}, []string{"count", "series"}},
		"politicians": {"search_politicians", map[string]any{}, []string{"count", "politicians"}},
	}

	// Every domain the registry knows about must have a representative here.
	for _, tool := range Registry() {
		if _, ok := representatives[tool.Domain]; !ok {
			t.Errorf("domain %q (e.g. tool %q) has no conformance representative — an uncovered domain can regress to prose-only silently",
				tool.Domain, tool.Name)
		}
	}

	// And every representative must name a tool that exists.
	registered := map[string]bool{}
	for _, tool := range Registry() {
		registered[tool.Name] = true
	}

	for domain, rep := range representatives {
		t.Run(domain, func(t *testing.T) {
			if !registered[rep.tool] {
				t.Fatalf("representative tool %q is not in the registry", rep.tool)
			}

			res, err := session.CallTool(ctx, &sdk.CallToolParams{Name: rep.tool, Arguments: rep.args})
			if err != nil {
				t.Fatalf("tools/call %s: %v", rep.tool, err)
			}
			if res.IsError {
				t.Fatalf("tools/call %s returned a tool error: %v", rep.tool, res.Content)
			}
			if res.StructuredContent == nil {
				t.Fatalf("tools/call %s returned no structuredContent — the tool declares an output schema, so a client expects to parse the result rather than the prose",
					rep.tool)
			}

			// The SDK hands structured content back as whatever the server
			// marshalled; round-trip it the way a non-Go client would.
			raw, err := json.Marshal(res.StructuredContent)
			if err != nil {
				t.Fatalf("%s: structured content does not marshal: %v", rep.tool, err)
			}
			var got map[string]any
			if err := json.Unmarshal(raw, &got); err != nil {
				t.Fatalf("%s: structured content is not a JSON object: %v (%s)", rep.tool, err, raw)
			}
			if len(got) == 0 {
				t.Fatalf("%s: structured content is an empty object", rep.tool)
			}

			for _, key := range rep.wants {
				value, ok := got[key]
				if !ok {
					t.Errorf("%s: structured content has no %q field (got keys %v)", rep.tool, key, keysOf(got))
					continue
				}
				if isEmptyValue(value) {
					t.Errorf("%s: structured content field %q is empty (%v) — the fixture populates it, so an empty value means the projection dropped it",
						rep.tool, key, value)
				}
			}

			// Structured or not, a tool result still carries prose for the
			// model: a client that ignores structured content must not get an
			// empty message.
			if len(res.Content) == 0 {
				t.Errorf("%s: no text content alongside the structured result", rep.tool)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// error paths
// ---------------------------------------------------------------------------

// An unknown tool name must fail loudly. The failure mode worth guarding
// against is not a panic (the SDK would recover it) but a SUCCESSFUL response
// with nothing in it, which a model reads as "there is no data" rather than
// "you called something that does not exist".
func TestUnknownToolNameErrorsCleanly(t *testing.T) {
	session, ctx := newConformanceSession(t)

	res, err := session.CallTool(ctx, &sdk.CallToolParams{
		Name:      "get_stock_price_prediction", // plausible, and deliberately not ours
		Arguments: map[string]any{"code": "BHP"},
	})

	// The SDK surfaces an unknown tool as a JSON-RPC error, not a tool result.
	// Either shape is acceptable to a client so long as it is unmistakably a
	// failure that names the tool; a nil error with a non-error result is not.
	switch {
	case err != nil:
		if !strings.Contains(err.Error(), "get_stock_price_prediction") {
			t.Errorf("unknown-tool error does not name the tool: %v", err)
		}
	case res == nil:
		t.Fatal("calling an unknown tool returned neither an error nor a result")
	case !res.IsError:
		t.Fatalf("calling an unknown tool succeeded: %+v — a silent empty result reads to a model as 'no data'", res)
	default:
		if len(res.Content) == 0 {
			t.Error("unknown-tool error result carries no message")
		}
	}

	// The real tools still work afterwards: an unknown name must not wedge the
	// session.
	if _, err := session.ListTools(ctx, nil); err != nil {
		t.Errorf("tools/list after an unknown tool call: %v", err)
	}
}

// A client newer than us must be told what we DO speak, not simply refused.
// SEP-2575 defines that as a JSON-RPC error with code -32022 carrying
// {supported, requested} — the SDK's UnsupportedProtocolVersionError. The SDK
// client negotiates down automatically, so it cannot produce this; the raw
// wire can.
func TestUnsupportedProtocolVersionListsWhatWeSupport(t *testing.T) {
	srv := httptest.NewServer(Handler(nil))
	t.Cleanup(srv.Close)

	// Newer than anything we know. String comparison is how the SDK decides
	// "new protocol", so this must sort ABOVE 2026-07-28 to be treated as a
	// version request at all rather than as a legacy client.
	const unsupported = "2099-01-01"

	rpcErr := rawCallExpectingError(t, srv, "tools/list", unsupported)
	if rpcErr == nil {
		t.Fatal("a request on an unsupported protocol version succeeded — a client would silently get results shaped for a protocol we do not speak")
	}
	if rpcErr.Code != sdk.CodeUnsupportedProtocolVersion {
		t.Errorf("error code = %d, want %d (UnsupportedProtocolVersion)", rpcErr.Code, sdk.CodeUnsupportedProtocolVersion)
	}

	var data sdk.UnsupportedProtocolVersionData
	if err := json.Unmarshal(rpcErr.Data, &data); err != nil {
		t.Fatalf("error data is not UnsupportedProtocolVersionData: %v (%s)", err, rpcErr.Data)
	}
	if data.Requested != unsupported {
		t.Errorf("error data requested = %q, want %q", data.Requested, unsupported)
	}
	for _, want := range conformanceSupportedVersions {
		if !contains(data.Supported, want) {
			t.Errorf("rejection does not offer %s as an alternative (offered %v) — a client cannot renegotiate against a list that omits what we serve",
				want, data.Supported)
		}
	}
}

// ---------------------------------------------------------------------------
// raw wire helpers
// ---------------------------------------------------------------------------

type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

func (e *rpcError) Error() string { return fmt.Sprintf("jsonrpc error %d: %s", e.Code, e.Message) }

// rawCall issues one 2026-07-28 request against the streamable handler and
// decodes the result into out. It hand-assembles what a real client does for
// us — the three mandatory _meta fields, the Mcp-Method header and the
// MCP-Protocol-Version header — because these tests exist to check exactly
// those.
func rawCall(t *testing.T, srv *httptest.Server, method string, params map[string]any, out any) error {
	t.Helper()
	result, rpcErr := rawRequest(t, srv, method, params, latestProtocolVersion)
	if rpcErr != nil {
		return rpcErr
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(result, out)
}

func rawCallExpectingError(t *testing.T, srv *httptest.Server, method, protocolVersion string) *rpcError {
	t.Helper()
	_, rpcErr := rawRequest(t, srv, method, nil, protocolVersion)
	return rpcErr
}

func rawRequest(t *testing.T, srv *httptest.Server, method string, params map[string]any, protocolVersion string) (json.RawMessage, *rpcError) {
	t.Helper()

	if params == nil {
		params = map[string]any{}
	}
	// The three _meta fields the handshake-less protocol requires on every
	// request. Omitting clientCapabilities is an InvalidParams error, not a
	// default — that is why a real client is the right thing to test with.
	params["_meta"] = map[string]any{
		sdk.MetaKeyProtocolVersion:    protocolVersion,
		sdk.MetaKeyClientInfo:         map[string]any{"name": "conformance-raw", "version": "0.0.1"},
		sdk.MetaKeyClientCapabilities: map[string]any{},
	}

	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  method,
		"params":  params,
	})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}

	req, err := http.NewRequest(http.MethodPost, srv.URL, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", protocolVersion)
	req.Header.Set("Mcp-Method", method)

	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("%s: read body: %v", method, err)
	}

	payload := raw
	// Responses on this protocol come back as SSE; a JSON body is also legal
	// and both appear depending on the request, so handle either.
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		payload = firstSSEData(t, raw)
	}

	var envelope struct {
		Result json.RawMessage `json:"result"`
		Error  *rpcError       `json:"error"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		t.Fatalf("%s: response is not JSON-RPC: %v (status %d, body %s)", method, err, resp.StatusCode, raw)
	}
	return envelope.Result, envelope.Error
}

func firstSSEData(t *testing.T, raw []byte) []byte {
	t.Helper()
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if data, ok := strings.CutPrefix(line, "data:"); ok {
			return []byte(strings.TrimSpace(data))
		}
	}
	t.Fatalf("no SSE data frame in response: %s", raw)
	return nil
}

// ---------------------------------------------------------------------------

func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// isEmptyValue reports whether a decoded JSON value is the zero-ish thing a
// dropped projection leaves behind.
func isEmptyValue(v any) bool {
	switch value := v.(type) {
	case nil:
		return true
	case string:
		return value == ""
	case float64:
		return value == 0
	case bool:
		return !value
	case []any:
		return len(value) == 0
	case map[string]any:
		return len(value) == 0
	default:
		return false
	}
}
