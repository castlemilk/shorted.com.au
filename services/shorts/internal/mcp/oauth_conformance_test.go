package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	sdkauth "github.com/modelcontextprotocol/go-sdk/auth"

	"github.com/castlemilk/shorted.com.au/services/pkg/ratelimit"
)

// The OAuth 2.1 surface as a REAL client meets it, driven over a real socket
// through the same middleware stack serve.go mounts.
//
// Everything here is an end-to-end property that a unit test of any single
// layer would miss, because every one of them depends on the ORDER the
// middleware is composed in:
//
//   - anonymous still works (the adoption path);
//   - a valid, audience-bound token is accepted and identifies the caller;
//   - a wrong-audience token is refused with a challenge naming the metadata
//     document, rather than being silently downgraded to anonymous;
//   - an exhausted quota produces the documented payload.
//
// The whole stack is used deliberately. Phase 2's lesson was that the SDK
// silently negotiates DOWN when the handler is misconfigured and an in-memory
// transport cannot detect it — protocol-adjacent behaviour has to be driven
// through a socket.

// stubClaims is the validator the bearer middleware calls. It stands in for
// TokenService so this package does not have to import the one that imports it.
type stubClaims struct {
	claims *VerifiedClaims
	err    error
}

func (s stubClaims) ValidateBearerToken(string) (*VerifiedClaims, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.claims, nil
}

// fixedLimiter allows a set number of checks and then rejects with a monthly
// exhaustion, which is the rejection a real caller is most likely to see.
type fixedLimiter struct {
	allow int
	seen  int
}

func (l *fixedLimiter) Check(_ context.Context, _, tier string, isBrowser bool) (*ratelimit.Result, error) {
	l.seen++
	if l.seen > l.allow {
		return &ratelimit.Result{
			Allowed:        false,
			ExceededKind:   ratelimit.LimitKindMonthly,
			Tier:           tier,
			IsBrowser:      isBrowser,
			MonthlyLimit:   500,
			MonthlyUsed:    500,
			MonthlyResetAt: time.Now().Add(72 * time.Hour),
			RetryAfter:     72 * time.Hour,
		}, nil
	}
	return &ratelimit.Result{Allowed: true, Tier: tier, IsBrowser: isBrowser}, nil
}

func (l *fixedLimiter) Close() error { return nil }

const conformanceOrigin = "https://api.example.test"

// mcpStack composes the handler EXACTLY as serve.go does: rate limiting inside
// the bearer middleware, so the identity function can see a verified token.
// A test that composed them the other way round would pass while production
// metered every authenticated caller as anonymous.
func mcpStack(t *testing.T, validator ClaimsValidator, limiter ratelimit.RateLimiter, resolveTier TierResolver) *httptest.Server {
	t.Helper()
	cfg := ratelimit.Config{Enabled: limiter != nil, UpgradeURL: "https://shorted.com.au/pricing"}
	rateLimited := ratelimit.NewHTTPMiddleware(
		limiter, cfg, RateLimitIdentity(resolveTier),
		ratelimit.WithCost(RateLimitCost),
		ratelimit.WithRejection(RateLimitRejection(ProtectedResourceMetadataURL(conformanceOrigin))),
	)
	handler := OptionalBearerToken(
		NewTokenVerifier(validator, ResourceURI(conformanceOrigin)),
		BearerTokenOptions(conformanceOrigin),
	)(rateLimited(Handler(realisticSource())))

	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv
}

func oauthToolCall(t *testing.T, srv *httptest.Server, token string) *http.Response {
	t.Helper()
	body := `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"list_top_shorts","arguments":{"limit":1}}}`
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/mcp", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func validClaims() *VerifiedClaims {
	return &VerifiedClaims{
		UserID:    "uid-1",
		Scopes:    []string{"shorts:read"},
		Audience:  []string{ResourceURI(conformanceOrigin)},
		ExpiresAt: time.Now().Add(time.Hour),
	}
}

// THE adoption property. OAuth raises limits; it is not a gate on first
// contact. If this ever fails, every client that has not been through a browser
// stops working at once.
func TestAnonymousMCPStillWorksWithTheWholeOAuthStackMounted(t *testing.T) {
	srv := mcpStack(t, stubClaims{claims: validClaims()}, &fixedLimiter{allow: 100}, nil)

	resp := oauthToolCall(t, srv, "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 — anonymous access is the adoption path", resp.StatusCode)
	}
}

func TestAValidAudienceBoundTokenIsAcceptedAndIdentifiesTheCaller(t *testing.T) {
	limiter := &fixedLimiter{allow: 100}
	var seenTier string
	srv := mcpStack(t, stubClaims{claims: validClaims()}, limiter, func(userID string) (string, error) {
		if userID != "uid-1" {
			t.Errorf("tier resolved for %q, want the token's subject", userID)
		}
		seenTier = "premium"
		return "premium", nil
	})

	resp := oauthToolCall(t, srv, "a-valid-token")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	// The tier lookup running at all is the proof that the rate limiter saw a
	// VERIFIED identity — which only happens if it is composed inside the
	// bearer middleware.
	if seenTier != "premium" {
		t.Fatal("the token was accepted but the caller was metered as anonymous")
	}
}

// The audience check is the whole value of RFC 8707 here: a token minted for
// the Connect API, for a different deployment, or by a confused-deputy
// authorization server must not be spendable on this resource.
func TestAWrongAudienceTokenIsChallengedRatherThanDowngraded(t *testing.T) {
	claims := validClaims()
	claims.Audience = []string{"https://api.somewhere-else.test/mcp"}
	srv := mcpStack(t, stubClaims{claims: claims}, &fixedLimiter{allow: 100}, nil)

	resp := oauthToolCall(t, srv, "a-token-for-another-resource")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 — a wrong-audience token must not be served", resp.StatusCode)
	}

	// And the challenge has to point at the metadata document, or a client has
	// no way to discover where to get a token that WOULD work.
	challenge := resp.Header.Get("WWW-Authenticate")
	if !strings.HasPrefix(strings.ToLower(challenge), "bearer") {
		t.Fatalf("WWW-Authenticate = %q", challenge)
	}
	if !strings.Contains(challenge, ProtectedResourceMetadataURL(conformanceOrigin)) {
		t.Errorf("challenge does not name the metadata document: %q", challenge)
	}
}

// A token that is present but unverifiable must NOT quietly become anonymous.
// A client holding an expired credential would then get anonymous limits and no
// signal that it needs to re-authorise.
func TestAnUnverifiableTokenIsRefusedRatherThanIgnored(t *testing.T) {
	srv := mcpStack(t, stubClaims{err: errors.New("signature mismatch")}, &fixedLimiter{allow: 100}, nil)

	resp := oauthToolCall(t, srv, "a-forged-token")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
}

// The documented 429. RateLimitDetail's field names are a contract the web app
// parses; an MCP client gets it as JSON-RPC error data AND on the headers.
func TestQuotaExhaustionProducesTheDocumentedPayload(t *testing.T) {
	srv := mcpStack(t, stubClaims{claims: validClaims()}, &fixedLimiter{allow: 0}, nil)

	// WITH a token: an authenticated caller at their ceiling gets the 429. An
	// anonymous one is challenged instead — next test.
	resp := oauthToolCall(t, srv, "a-valid-token")
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", resp.StatusCode)
	}

	var body struct {
		JSONRPC string `json:"jsonrpc"`
		ID      int    `json:"id"`
		Error   struct {
			Code    int                       `json:"code"`
			Message string                    `json:"message"`
			Data    ratelimit.RateLimitDetail `json:"data"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("the rejection is not JSON-RPC: %v", err)
	}
	if body.JSONRPC != "2.0" || body.ID != 7 {
		t.Errorf("a client cannot match this to its call: %+v", body)
	}

	detail := body.Error.Data
	if detail.Kind != ratelimit.LimitKindMonthly {
		t.Errorf("kind = %q", detail.Kind)
	}
	// "api", never "browser": paid BROWSER access is unlimited and paid API
	// access is not, so this field decides whether the upgrade copy is a
	// promise we can keep.
	if detail.Access != "api" {
		t.Errorf("access = %q, want api", detail.Access)
	}
	if detail.UpgradeURL == "" || detail.Message == "" || detail.ResetAt == 0 {
		t.Errorf("the payload is not actionable: %+v", detail)
	}
	// Mirrored on the headers so anything watching the transport — a proxy, a
	// curl, a non-JSON-RPC client — reads the same facts without a parser.
	if resp.Header.Get("X-RateLimit-Detail") == "" {
		t.Error("no X-RateLimit-Detail header")
	}
	if resp.Header.Get("Retry-After") == "" {
		t.Error("no Retry-After header")
	}
}

// Session preamble is free, so a client can connect and enumerate tools even
// with no quota left. Charging for the handshake would rate limit a client
// before it had made a single request anyone asked for.
func TestAClientWithNoQuotaCanStillConnectAndListTools(t *testing.T) {
	srv := mcpStack(t, stubClaims{claims: validClaims()}, &fixedLimiter{allow: 0}, nil)

	for _, method := range []string{"initialize", "tools/list"} {
		body := `{"jsonrpc":"2.0","id":1,"method":"` + method + `","params":{}}`
		req, err := http.NewRequest(http.MethodPost, srv.URL+"/mcp", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode == http.StatusTooManyRequests {
			t.Fatalf("%s was rate limited — session preamble must be free", method)
		}
	}
}

// The protected-resource document is what a client fetches after the
// challenge. It must name this deployment's resource and this deployment's
// authorization server, or a client authorises against the wrong origin and
// gets a token the audience check then refuses.
func TestTheProtectedResourceDocumentDescribesThisDeployment(t *testing.T) {
	metadata := ProtectedResourceMetadata(conformanceOrigin)

	if metadata.Resource != conformanceOrigin+"/mcp" {
		t.Errorf("resource = %q", metadata.Resource)
	}
	if len(metadata.AuthorizationServers) != 1 || metadata.AuthorizationServers[0] != conformanceOrigin {
		t.Errorf("authorization servers = %v", metadata.AuthorizationServers)
	}
	// offline_access is deliberately absent: a resource advertises what it
	// REQUIRES, and listing it would push clients into asking for refresh
	// tokens they have no need of.
	for _, scope := range metadata.ScopesSupported {
		if scope == "offline_access" {
			t.Error("offline_access is advertised as a resource requirement")
		}
	}
}

// Some clients probe the bare path before reading a challenge, and a 404 there
// is indistinguishable from "this server does not do OAuth".
func TestTheBareAndSuffixedMetadataPathsAreTheSameDocument(t *testing.T) {
	mux := http.NewServeMux()
	handler := ProtectedResourceMetadataHandler(conformanceOrigin)
	mux.Handle(ProtectedResourceMetadataPath, handler)
	mux.Handle(BareProtectedResourceMetadataPath, handler)

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	fetch := func(path string) string {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s: status = %d", path, resp.StatusCode)
		}
		var doc map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		encoded, _ := json.Marshal(doc)
		return string(encoded)
	}

	suffixed := fetch(ProtectedResourceMetadataPath)
	bare := fetch(BareProtectedResourceMetadataPath)
	if suffixed != bare {
		t.Errorf("the two paths serve different documents:\n%s\n%s", suffixed, bare)
	}
}

// A verified token must never share a bucket with the IP it happens to arrive
// from: two users behind one NAT would limit each other, and an authenticated
// caller would be metered as anonymous.
func TestAuthenticatedAndAnonymousCallersAreMeteredSeparately(t *testing.T) {
	identify := RateLimitIdentity(nil)

	anon := identify(func() *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"method":"tools/call"}`))
		r.RemoteAddr = "203.0.113.9:1234"
		return r
	}())

	var authed ratelimit.Caller
	handler := sdkauth.RequireBearerToken(
		func(context.Context, string, *http.Request) (*sdkauth.TokenInfo, error) {
			return &sdkauth.TokenInfo{UserID: "uid-1", Expiration: time.Now().Add(time.Hour)}, nil
		},
		&sdkauth.RequireBearerTokenOptions{},
	)(http.HandlerFunc(func(_ http.ResponseWriter, req *http.Request) {
		authed = identify(req)
	}))
	r := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"method":"tools/call"}`))
	r.RemoteAddr = "203.0.113.9:1234" // the SAME IP
	r.Header.Set("Authorization", "Bearer any")
	handler.ServeHTTP(httptest.NewRecorder(), r)

	if anon.Identifier == authed.Identifier {
		t.Fatalf("both callers share the bucket %q", anon.Identifier)
	}
}

// THE UNBLOCK, end to end through the real stack.
//
// OAuth here was live but dormant: a client connected, got its tools, stored no
// auth state and never started the flow, because nothing ever challenged it.
// Anonymous access is unchallenged deliberately — it is the adoption path — so
// the ceiling is the one honest place to say "authenticate for more", and this
// asserts that a client can actually act on it.
func TestAnAnonymousCallerAtTheCeilingIsSentToTheAuthorizationServer(t *testing.T) {
	srv := mcpStack(t, stubClaims{claims: validClaims()}, &fixedLimiter{allow: 0}, nil)

	resp := oauthToolCall(t, srv, "")

	// 401, not 429: MCP clients begin discovery on the status.
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 — a 429 leaves OAuth undiscoverable", resp.StatusCode)
	}
	challenge := resp.Header.Get("WWW-Authenticate")
	if !strings.Contains(challenge, ProtectedResourceMetadataURL(conformanceOrigin)) {
		t.Fatalf("challenge does not name the metadata document: %q", challenge)
	}

	// And the body still says WHY, so the agent can tell its user this was a
	// quota rather than a rejected credential.
	var body struct {
		Error struct {
			Data ratelimit.RateLimitDetail `json:"data"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("the challenge is not JSON-RPC: %v", err)
	}
	if body.Error.Data.Message == "" || body.Error.Data.UpgradeURL == "" {
		t.Errorf("the reason did not survive the challenge: %+v", body.Error.Data)
	}
}
