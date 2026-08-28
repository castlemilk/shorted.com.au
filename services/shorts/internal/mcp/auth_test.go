package mcp

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func sdkNewTestClient() *sdk.Client {
	return sdk.NewClient(&sdk.Implementation{Name: "auth-test-client", Version: "0.0.1"}, nil)
}

func sdkStreamableTransport(endpoint string) *sdk.StreamableClientTransport {
	return &sdk.StreamableClientTransport{Endpoint: endpoint}
}

// fakeValidator stands in for *shorts.TokenService. The real one cannot be
// used here: shorts imports this package, so the dependency only runs one way.
type fakeValidator struct {
	claims *VerifiedClaims
	err    error
}

func (f fakeValidator) ValidateBearerToken(string) (*VerifiedClaims, error) {
	return f.claims, f.err
}

func TestResourceURIMatchesThePublishedEndpoint(t *testing.T) {
	if got := ResourceURI(DefaultAPIBaseURL); got != PublicEndpoint {
		t.Fatalf("ResourceURI(%q) = %q, want the published catalog endpoint %q",
			DefaultAPIBaseURL, got, PublicEndpoint)
	}
	if got := ResourceURI("http://localhost:9091/"); got != "http://localhost:9091/mcp" {
		t.Fatalf("trailing slash not normalised: got %q", got)
	}
}

func TestTokenVerifierAcceptsATokenCarryingTheResourceAudience(t *testing.T) {
	resource := ResourceURI(DefaultAPIBaseURL)
	exp := time.Now().Add(time.Hour)
	verifier := NewTokenVerifier(fakeValidator{claims: &VerifiedClaims{
		UserID:    "user-1",
		Audience:  []string{DefaultAPIBaseURL, resource},
		ExpiresAt: exp,
		Scopes:    []string{"shorts:read"},
	}}, resource)

	info, err := verifier(context.Background(), "tok", httptest.NewRequest(http.MethodPost, "/mcp", nil))
	if err != nil {
		t.Fatalf("verifier returned error: %v", err)
	}
	if info.UserID != "user-1" {
		t.Errorf("UserID = %q, want user-1", info.UserID)
	}
	if !info.Expiration.Equal(exp) {
		t.Errorf("Expiration = %v, want %v", info.Expiration, exp)
	}
	if len(info.Scopes) != 1 || info.Scopes[0] != "shorts:read" {
		t.Errorf("Scopes = %v, want [shorts:read]", info.Scopes)
	}
}

// The compatibility seam, MCP side. Every token minted before audiences
// existed carries no `aud`; on this surface that must be a rejection, or the
// RFC 8707 check is decorative.
func TestTokenVerifierRejectsATokenWithNoAudience(t *testing.T) {
	resource := ResourceURI(DefaultAPIBaseURL)
	verifier := NewTokenVerifier(fakeValidator{claims: &VerifiedClaims{
		UserID:    "legacy-user",
		ExpiresAt: time.Now().Add(time.Hour),
	}}, resource)

	_, err := verifier(context.Background(), "tok", httptest.NewRequest(http.MethodPost, "/mcp", nil))
	if !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("err = %v, want ErrInvalidToken for an audience-less token", err)
	}
}

func TestTokenVerifierRejectsATokenForADifferentResource(t *testing.T) {
	resource := ResourceURI(DefaultAPIBaseURL)
	verifier := NewTokenVerifier(fakeValidator{claims: &VerifiedClaims{
		UserID:    "user-1",
		Audience:  []string{DefaultAPIBaseURL, "https://example.com/mcp"},
		ExpiresAt: time.Now().Add(time.Hour),
	}}, resource)

	_, err := verifier(context.Background(), "tok", httptest.NewRequest(http.MethodPost, "/mcp", nil))
	if !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("err = %v, want ErrInvalidToken for a foreign audience", err)
	}
}

func TestTokenVerifierRejectsAnUnparseableToken(t *testing.T) {
	verifier := NewTokenVerifier(fakeValidator{err: errors.New("signature is invalid")}, ResourceURI(DefaultAPIBaseURL))

	_, err := verifier(context.Background(), "tok", httptest.NewRequest(http.MethodPost, "/mcp", nil))
	if !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("err = %v, want ErrInvalidToken", err)
	}
	if !strings.Contains(err.Error(), "signature is invalid") {
		t.Errorf("underlying reason lost: %v", err)
	}
}

// --- the optional-bearer wrapper -------------------------------------------

func probeHandler(seen *auth.TokenInfo, called *bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*called = true
		if info := auth.TokenInfoFromContext(r.Context()); info != nil {
			*seen = *info
		}
		w.WriteHeader(http.StatusOK)
	})
}

func middlewareUnderTest(v ClaimsValidator) func(http.Handler) http.Handler {
	base := DefaultAPIBaseURL
	return OptionalBearerToken(
		NewTokenVerifier(v, ResourceURI(base)),
		BearerTokenOptions(base),
	)
}

// Anonymous access is the adoption path — Phase 2 shipped 24 tools with no
// auth and this task must not take that away.
func TestOptionalBearerLetsAnAnonymousRequestThrough(t *testing.T) {
	var called bool
	var seen auth.TokenInfo
	h := middlewareUnderTest(fakeValidator{err: errors.New("should not be called")})(probeHandler(&seen, &called))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/mcp", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 for an anonymous request", rec.Code)
	}
	if !called {
		t.Fatal("downstream handler was not reached")
	}
	if seen.UserID != "" {
		t.Errorf("anonymous request carried TokenInfo %+v", seen)
	}
}

func TestOptionalBearerAttachesIdentityForAValidToken(t *testing.T) {
	var called bool
	var seen auth.TokenInfo
	h := middlewareUnderTest(fakeValidator{claims: &VerifiedClaims{
		UserID:    "user-42",
		Audience:  []string{ResourceURI(DefaultAPIBaseURL)},
		ExpiresAt: time.Now().Add(time.Hour),
		Scopes:    []string{"shorts:read"},
	}})(probeHandler(&seen, &called))

	req := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	req.Header.Set("Authorization", "Bearer good-token")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body %q", rec.Code, rec.Body.String())
	}
	if seen.UserID != "user-42" {
		t.Fatalf("TokenInfo.UserID = %q, want user-42", seen.UserID)
	}
}

func TestOptionalBearerRejectsAWrongAudienceTokenWithAChallenge(t *testing.T) {
	var called bool
	var seen auth.TokenInfo
	h := middlewareUnderTest(fakeValidator{claims: &VerifiedClaims{
		UserID:    "user-42",
		ExpiresAt: time.Now().Add(time.Hour),
	}})(probeHandler(&seen, &called))

	req := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	req.Header.Set("Authorization", "Bearer audience-less")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if called {
		t.Fatal("downstream handler ran despite a rejected token")
	}
	challenge := rec.Header().Get("WWW-Authenticate")
	t.Logf("WWW-Authenticate: %s", challenge)
	want := ProtectedResourceMetadataURL(DefaultAPIBaseURL)
	if !strings.Contains(challenge, want) {
		t.Fatalf("WWW-Authenticate = %q, want it to name %q", challenge, want)
	}
}

func TestOptionalBearerRejectsAnExpiredToken(t *testing.T) {
	var called bool
	var seen auth.TokenInfo
	h := middlewareUnderTest(fakeValidator{claims: &VerifiedClaims{
		UserID:    "user-42",
		Audience:  []string{ResourceURI(DefaultAPIBaseURL)},
		ExpiresAt: time.Now().Add(-time.Hour),
	}})(probeHandler(&seen, &called))

	req := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	req.Header.Set("Authorization", "Bearer stale")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 for an expired token", rec.Code)
	}
	if called {
		t.Fatal("downstream handler ran despite an expired token")
	}
}

// The clock-skew allowance is a real behavioural choice, not a default: this
// server sits behind Cloudflare and Cloud Run and mints its own tokens
// elsewhere in the fleet.
func TestOptionalBearerToleratesClockSkewWithinTheAllowance(t *testing.T) {
	var called bool
	var seen auth.TokenInfo
	h := middlewareUnderTest(fakeValidator{claims: &VerifiedClaims{
		UserID:    "user-42",
		Audience:  []string{ResourceURI(DefaultAPIBaseURL)},
		ExpiresAt: time.Now().Add(-ClockSkew / 2),
	}})(probeHandler(&seen, &called))

	req := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	req.Header.Set("Authorization", "Bearer barely-stale")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 within the %s skew allowance", rec.Code, ClockSkew)
	}
}

// Wrapping /mcp must not disturb the transport. Stateless is load-bearing —
// without it the SDK silently omits 2026-07-28 from server/discover and every
// client downgrades to the legacy initialize path — and a middleware that (for
// instance) buffered or rewrote the response would break exactly that, quietly.
func TestWrappedHandlerStillNegotiatesTheLatestProtocolAnonymously(t *testing.T) {
	wrapped := middlewareUnderTest(fakeValidator{err: errors.New("no token expected")})(Handler(nil))
	srv := httptest.NewServer(wrapped)
	t.Cleanup(srv.Close)

	client := sdkNewTestClient()
	session, err := client.Connect(context.Background(), sdkStreamableTransport(srv.URL), nil)
	if err != nil {
		t.Fatalf("anonymous client connect through the bearer wrapper: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })

	if got := session.InitializeResult().ProtocolVersion; got != latestProtocolVersion {
		t.Fatalf("negotiated protocol = %q, want %q (is the streamable handler still Stateless?)",
			got, latestProtocolVersion)
	}
}

// --- protected resource metadata -------------------------------------------

func TestProtectedResourceMetadata(t *testing.T) {
	md := ProtectedResourceMetadata(DefaultAPIBaseURL)

	if md.Resource != PublicEndpoint {
		t.Errorf("Resource = %q, want %q", md.Resource, PublicEndpoint)
	}
	if len(md.AuthorizationServers) != 1 || md.AuthorizationServers[0] != DefaultAPIBaseURL {
		t.Errorf("AuthorizationServers = %v, want [%s]", md.AuthorizationServers, DefaultAPIBaseURL)
	}
	if len(md.BearerMethodsSupported) != 1 || md.BearerMethodsSupported[0] != "header" {
		t.Errorf("BearerMethodsSupported = %v, want [header]", md.BearerMethodsSupported)
	}
	for _, scope := range Scopes {
		if !contains(md.ScopesSupported, scope) {
			t.Errorf("ScopesSupported missing %q", scope)
		}
	}
	// A resource server advertises what it REQUIRES. offline_access is a
	// property of the authorization server's token lifetime, not of this
	// resource, and advertising it here invites clients to demand refresh
	// tokens they do not need.
	if contains(md.ScopesSupported, "offline_access") {
		t.Error("ScopesSupported advertises offline_access; a resource server SHOULD NOT")
	}
}

func TestProtectedResourceMetadataHandlerServesTheDocument(t *testing.T) {
	h := ProtectedResourceMetadataHandler(DefaultAPIBaseURL)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, ProtectedResourceMetadataPath, nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"resource":"`+PublicEndpoint+`"`) &&
		!strings.Contains(body, `"resource": "`+PublicEndpoint+`"`) {
		t.Fatalf("body does not carry the resource identifier: %s", body)
	}
}

func TestProtectedResourceMetadataURL(t *testing.T) {
	want := DefaultAPIBaseURL + ProtectedResourceMetadataPath
	if got := ProtectedResourceMetadataURL(DefaultAPIBaseURL); got != want {
		t.Fatalf("ProtectedResourceMetadataURL = %q, want %q", got, want)
	}
}
