package mcp

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	sdkauth "github.com/modelcontextprotocol/go-sdk/auth"

	"github.com/castlemilk/shorted.com.au/services/pkg/ratelimit"
)

func jsonRPCRequest(body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
	r.RemoteAddr = "203.0.113.9:41234"
	return r
}

// ------------------------------------------------------------------ counting

func TestOnlyToolCallsCost(t *testing.T) {
	cases := []struct {
		name string
		body string
		want int
	}{
		{"a tool call", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{}}`, 1},
		// Session preamble is free. A client that has not yet made a request
		// anyone asked for must not be able to exhaust a quota by connecting.
		{"initialize", `{"jsonrpc":"2.0","id":1,"method":"initialize"}`, 0},
		{"tools/list", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, 0},
		{"resources/list", `{"jsonrpc":"2.0","id":1,"method":"resources/list"}`, 0},
		{"prompts/list", `{"jsonrpc":"2.0","id":1,"method":"prompts/list"}`, 0},
		{"server/discover", `{"jsonrpc":"2.0","id":1,"method":"server/discover"}`, 0},
		// A batch is charged per call, or batching is the way around the limit.
		{
			"a batch of three tool calls",
			`[{"method":"tools/call"},{"method":"tools/call"},{"method":"tools/call"}]`,
			3,
		},
		{
			"a batch mixing preamble and calls",
			`[{"method":"tools/list"},{"method":"tools/call"},{"method":"initialize"}]`,
			1,
		},
		// A malformed body is never served, so charging for it would let a
		// broken client burn its own quota on nothing.
		{"malformed JSON", `{not json`, 0},
		{"empty body", ``, 0},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := RateLimitCost(jsonRPCRequest(tc.body)); got != tc.want {
				t.Errorf("cost = %d, want %d", got, tc.want)
			}
		})
	}
}

// The cost function has to read the body to count it. If it did not put the
// bytes back, every request would reach the handler empty — the failure would
// be total and would look like a protocol bug.
func TestCountingRestoresTheBody(t *testing.T) {
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_stock"}}`
	r := jsonRPCRequest(body)

	if got := RateLimitCost(r); got != 1 {
		t.Fatalf("cost = %d", got)
	}
	read, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(read) != body {
		t.Fatalf("body after counting = %q", string(read))
	}
}

// An oversized body must not be the cheap path: it is charged the ceiling
// rather than parsed, and rather than being free.
func TestAnOversizedBodyIsChargedTheCeiling(t *testing.T) {
	huge := `{"method":"tools/call","params":{"pad":"` + strings.Repeat("a", MaxRequestBytes) + `"}}`
	if got := RateLimitCost(jsonRPCRequest(huge)); got != MaxBatchCost {
		t.Errorf("cost = %d, want %d", got, MaxBatchCost)
	}
}

func TestAnEnormousBatchIsCapped(t *testing.T) {
	entries := make([]string, MaxBatchCost+20)
	for i := range entries {
		entries[i] = `{"method":"tools/call"}`
	}
	body := "[" + strings.Join(entries, ",") + "]"
	if got := RateLimitCost(jsonRPCRequest(body)); got != MaxBatchCost {
		t.Errorf("cost = %d, want the cap %d", got, MaxBatchCost)
	}
}

func TestAGETCostsNothing(t *testing.T) {
	// The streamable transport opens a GET for the server-to-client stream.
	// Charging it would bill a client for holding a connection open.
	r := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	if got := RateLimitCost(r); got != 0 {
		t.Errorf("cost = %d, want 0", got)
	}
}

// ------------------------------------------------------------------ identity

func TestAnonymousMCPIsMeteredByIPNotRefused(t *testing.T) {
	identify := RateLimitIdentity(nil)
	caller := identify(jsonRPCRequest(`{"method":"tools/call"}`))

	if caller.Identifier != "mcp-anon:203.0.113.9" {
		t.Errorf("identifier = %q", caller.Identifier)
	}
	if caller.Tier != "anonymous" {
		t.Errorf("tier = %q", caller.Tier)
	}
}

// identifyWithToken drives the REAL bearer middleware rather than injecting a
// TokenInfo into the context directly. The SDK exports no setter, and that is
// convenient: a test that faked the context would pass even if the identity
// function were wired OUTSIDE the middleware, where every caller looks
// anonymous — which is exactly the mistake this ordering exists to avoid.
func identifyWithToken(t *testing.T, r *http.Request, info *sdkauth.TokenInfo, resolve TierResolver) ratelimit.Caller {
	t.Helper()
	var caller ratelimit.Caller
	identify := RateLimitIdentity(resolve)
	handler := sdkauth.RequireBearerToken(
		func(context.Context, string, *http.Request) (*sdkauth.TokenInfo, error) {
			return info, nil
		},
		&sdkauth.RequireBearerTokenOptions{},
	)(http.HandlerFunc(func(_ http.ResponseWriter, req *http.Request) {
		caller = identify(req)
	}))

	r.Header.Set("Authorization", "Bearer any-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, r)
	if rec.Code != http.StatusOK && caller.Identifier == "" {
		t.Fatalf("the bearer middleware rejected the request: %d %s", rec.Code, rec.Body.String())
	}
	return caller
}

func TestAnOAuthCallerIsIdentifiedByTheirVerifiedSubject(t *testing.T) {
	identify := func(userID string) (string, error) {
		if userID != "uid-1" {
			t.Errorf("tier resolved for %q", userID)
		}
		return "premium", nil
	}

	caller := identifyWithToken(t, jsonRPCRequest(`{"method":"tools/call"}`),
		&sdkauth.TokenInfo{UserID: "uid-1", Expiration: time.Now().Add(time.Hour)},
		identify)
	if caller.Identifier != "oauth:uid-1" {
		t.Errorf("identifier = %q", caller.Identifier)
	}
	if caller.Tier != "premium" {
		t.Errorf("tier = %q, want the RESOLVED tier", caller.Tier)
	}
}

// The token is stamped with the tier that was current an hour ago. A lapsed
// subscription inside that window must not keep buying a premium ceiling, so
// the tier is looked up and never read off the token.
func TestTierComesFromTheLookupNotTheToken(t *testing.T) {
	caller := identifyWithToken(t, jsonRPCRequest(`{"method":"tools/call"}`),
		&sdkauth.TokenInfo{UserID: "uid-1", Expiration: time.Now().Add(time.Hour)},
		func(string) (string, error) { return "free", nil })

	if caller.Tier != "free" {
		t.Errorf("tier = %q, want free", caller.Tier)
	}
}

func TestAFailedTierLookupDegradesToFree(t *testing.T) {
	caller := identifyWithToken(t, jsonRPCRequest(`{"method":"tools/call"}`),
		&sdkauth.TokenInfo{UserID: "uid-1", Expiration: time.Now().Add(time.Hour)},
		func(string) (string, error) { return "", http.ErrServerClosed })

	if caller.Tier != "free" {
		t.Errorf("tier = %q, want free", caller.Tier)
	}
	// It must still be metered as that user, not collapsed into a shared IP
	// bucket where one caller's traffic limits another's.
	if caller.Identifier != "oauth:uid-1" {
		t.Errorf("identifier = %q", caller.Identifier)
	}
}

// A bearer token that got past the optional-verification path without a
// subject still must not share the anonymous IP bucket with everyone behind
// the same NAT — and the raw token must never become a rate-limit key.
func TestAnUnattributedBearerTokenIsKeyedByItsHash(t *testing.T) {
	identify := RateLimitIdentity(nil)
	r := jsonRPCRequest(`{"method":"tools/call"}`)
	r.Header.Set("Authorization", "Bearer secret-token-value")

	caller := identify(r)
	if !strings.HasPrefix(caller.Identifier, "token:") {
		t.Fatalf("identifier = %q", caller.Identifier)
	}
	if strings.Contains(caller.Identifier, "secret-token-value") {
		t.Fatal("the raw token became a rate-limit key")
	}
	if len(caller.Identifier) != len("token:")+32 {
		t.Errorf("identifier = %q, want a 32-char hash", caller.Identifier)
	}
}

// ----------------------------------------------------------------- rejection

func TestTheRejectionIsAJSONRPCErrorAnAgentCanRelay(t *testing.T) {
	result := &ratelimit.Result{
		Allowed:      false,
		ExceededKind: ratelimit.LimitKindMonthly,
		Tier:         "free",
		MonthlyLimit: 1000,
		MonthlyUsed:  1000,
		RetryAfter:   3600 * time.Second,
	}
	detail := ratelimit.RateLimitDetail{
		Kind:              ratelimit.LimitKindMonthly,
		Limit:             1000,
		Used:              1000,
		Tier:              "free",
		Access:            "api",
		UpgradeURL:        "https://shorted.com.au/pricing",
		Message:           "monthly quota exceeded",
		RetryAfterSeconds: 3600,
	}

	r := jsonRPCRequest(`{"jsonrpc":"2.0","id":42,"method":"tools/call"}`)
	rec := httptest.NewRecorder()
	RateLimitRejection(rec, r, result, detail)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d", rec.Code)
	}

	var body struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Error   struct {
			Code    int                       `json:"code"`
			Message string                    `json:"message"`
			Data    ratelimit.RateLimitDetail `json:"data"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("the rejection is not JSON-RPC: %v (%s)", err, rec.Body.String())
	}
	if body.JSONRPC != "2.0" {
		t.Errorf("jsonrpc = %q", body.JSONRPC)
	}
	// Echoing the id is how a client matches the error to the call it made.
	if string(body.ID) != "42" {
		t.Errorf("id = %s, want the request's", body.ID)
	}
	if body.Error.Message == "" {
		t.Error("no message for the agent to relay")
	}
	// The payload is the shared contract, not an MCP-shaped restatement of it.
	if body.Error.Data.UpgradeURL != "https://shorted.com.au/pricing" ||
		body.Error.Data.Kind != ratelimit.LimitKindMonthly ||
		body.Error.Data.Access != "api" {
		t.Errorf("detail did not survive: %+v", body.Error.Data)
	}
	// And the headers still carry it, for anything watching the transport.
	if rec.Header().Get("X-RateLimit-Detail") == "" {
		t.Error("no X-RateLimit-Detail header")
	}
	if rec.Header().Get("Retry-After") != "3600" {
		t.Errorf("Retry-After = %q", rec.Header().Get("Retry-After"))
	}
}

func TestARejectedBatchCarriesANullID(t *testing.T) {
	r := jsonRPCRequest(`[{"method":"tools/call"},{"method":"tools/call"}]`)
	rec := httptest.NewRecorder()
	RateLimitRejection(rec, r, &ratelimit.Result{Tier: "anonymous"}, ratelimit.RateLimitDetail{Message: "x"})

	var body struct {
		ID json.RawMessage `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if string(body.ID) != "null" {
		t.Errorf("id = %s, want null — a batch rejection is not attributable", body.ID)
	}
}
