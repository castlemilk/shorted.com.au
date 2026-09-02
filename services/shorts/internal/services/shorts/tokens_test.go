package shorts

import (
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	"github.com/golang-jwt/jwt/v5"
)

const testSecret = "test-secret-not-for-production"

func testAudience() []string {
	return TokenAudience(mcp.DefaultAPIBaseURL)
}

func TestMintedTokenCarriesTheAPIAndMCPAudiences(t *testing.T) {
	svc := NewTokenService(testSecret, testAudience()...)

	token, err := svc.MintTokenWithTier("user-1", "u@example.com", []string{"user"}, "free", time.Hour)
	if err != nil {
		t.Fatalf("MintTokenWithTier: %v", err)
	}

	claims, err := svc.ValidateToken(token)
	if err != nil {
		t.Fatalf("ValidateToken: %v", err)
	}
	aud, err := claims.GetAudience()
	if err != nil {
		t.Fatalf("GetAudience: %v", err)
	}
	for _, want := range []string{mcp.DefaultAPIBaseURL, mcp.ResourceURI(mcp.DefaultAPIBaseURL)} {
		found := false
		for _, got := range aud {
			if got == want {
				found = true
			}
		}
		if !found {
			t.Errorf("audience %v missing %q", []string(aud), want)
		}
	}
}

// --- the compatibility seam -------------------------------------------------
//
// Direction 1: a token minted before audiences existed carries no `aud` and
// must keep working on the Connect API. Every live API token is one of these;
// getting this wrong breaks all of them at once.

func mintLegacyTokenWithoutAudience(t *testing.T, secret string) string {
	t.Helper()
	now := time.Now()
	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour)),
			IssuedAt:  jwt.NewNumericDate(now),
			Issuer:    "shorted-api",
		},
		UserID: "legacy-user",
		Email:  "legacy@example.com",
		Roles:  []string{"user"},
		Tier:   "free",
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(secret))
	if err != nil {
		t.Fatalf("signing legacy token: %v", err)
	}
	return signed
}

func TestConnectAPIStillAcceptsAPreAudienceToken(t *testing.T) {
	svc := NewTokenService(testSecret, testAudience()...)
	legacy := mintLegacyTokenWithoutAudience(t, testSecret)

	claims, err := svc.ValidateToken(legacy)
	if err != nil {
		t.Fatalf("ValidateToken rejected a pre-audience token: %v — every live API token is one of these", err)
	}
	if claims.UserID != "legacy-user" {
		t.Fatalf("UserID = %q, want legacy-user", claims.UserID)
	}
	aud, _ := claims.GetAudience()
	if len(aud) != 0 {
		t.Fatalf("fixture is wrong: legacy token should carry no audience, got %v", []string(aud))
	}
}

// Direction 2: the SAME token is never valid for /mcp. ValidateBearerToken is
// what the MCP verifier calls, and it surfaces the audience so the verifier can
// refuse. (The refusal itself is asserted in the mcp package.)
func TestMCPPathSeesNoAudienceOnAPreAudienceToken(t *testing.T) {
	svc := NewTokenService(testSecret, testAudience()...)
	legacy := mintLegacyTokenWithoutAudience(t, testSecret)

	verified, err := svc.ValidateBearerToken(legacy)
	if err != nil {
		t.Fatalf("ValidateBearerToken: %v", err)
	}
	if len(verified.Audience) != 0 {
		t.Fatalf("Audience = %v, want empty so the MCP verifier rejects it", verified.Audience)
	}

	fresh, err := svc.MintTokenWithTier("user-1", "u@example.com", nil, "free", time.Hour)
	if err != nil {
		t.Fatalf("MintTokenWithTier: %v", err)
	}
	verified, err = svc.ValidateBearerToken(fresh)
	if err != nil {
		t.Fatalf("ValidateBearerToken: %v", err)
	}
	resource := mcp.ResourceURI(mcp.DefaultAPIBaseURL)
	found := false
	for _, a := range verified.Audience {
		if a == resource {
			found = true
		}
	}
	if !found {
		t.Fatalf("Audience = %v, want it to contain %q", verified.Audience, resource)
	}
}

// The whole point of naming an interface in the mcp package: *TokenService
// must satisfy it, checked at compile time.
var _ mcp.ClaimsValidator = (*TokenService)(nil)

func TestValidateBearerTokenMapsIdentityScopesAndExpiry(t *testing.T) {
	svc := NewTokenService(testSecret, testAudience()...)
	now := time.Now()
	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour)),
			IssuedAt:  jwt.NewNumericDate(now),
			Issuer:    "shorted-api",
			Audience:  jwt.ClaimStrings(testAudience()),
		},
		UserID: "user-7",
		Scope:  "shorts:read housing:read",
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testSecret))
	if err != nil {
		t.Fatalf("signing: %v", err)
	}

	verified, err := svc.ValidateBearerToken(signed)
	if err != nil {
		t.Fatalf("ValidateBearerToken: %v", err)
	}
	if verified.UserID != "user-7" {
		t.Errorf("UserID = %q, want user-7", verified.UserID)
	}
	if len(verified.Scopes) != 2 || verified.Scopes[0] != "shorts:read" || verified.Scopes[1] != "housing:read" {
		t.Errorf("Scopes = %v, want [shorts:read housing:read]", verified.Scopes)
	}
	if verified.ExpiresAt.IsZero() {
		t.Error("ExpiresAt is zero; the bearer middleware rejects tokens with no expiration")
	}
}

func TestValidateBearerTokenRejectsAForgedSignature(t *testing.T) {
	minted, err := NewTokenService("other-secret", testAudience()...).
		MintTokenWithTier("user-1", "u@example.com", nil, "free", time.Hour)
	if err != nil {
		t.Fatalf("MintTokenWithTier: %v", err)
	}

	if _, err := NewTokenService(testSecret, testAudience()...).ValidateBearerToken(minted); err == nil {
		t.Fatal("ValidateBearerToken accepted a token signed with a different secret")
	}
}

// A TokenService with no configured audience must still mint usable tokens —
// otherwise a misconfigured environment silently produces tokens nothing
// accepts.
func TestTokenServiceWithoutConfiguredAudienceStillMints(t *testing.T) {
	svc := NewTokenService(testSecret)
	token, err := svc.MintToken("user-1", "u@example.com", nil, time.Hour)
	if err != nil {
		t.Fatalf("MintToken: %v", err)
	}
	if _, err := svc.ValidateToken(token); err != nil {
		t.Fatalf("ValidateToken: %v", err)
	}
}

// The MCP bearer middleware advertises a 60s ClockSkew, but that value could
// never fire while ValidateToken parsed with golang-jwt's default zero leeway:
// the parse rejected the token first. The middleware's own skew test passed
// regardless, because its fake validator bypasses the JWT layer entirely — a
// tolerance documented as load-bearing that could not actually tolerate
// anything.
//
// This exercises the deployed path: a REAL signed token, a REAL parse.
func TestValidateTokenToleratesClockDriftWithinTheLeeway(t *testing.T) {
	svc := NewTokenService("test-secret")

	justExpired, err := svc.MintTokenWithTier("uid-1", "a@b.com", []string{"api-user"}, "free",
		-ClockLeeway/2)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}

	if _, err := svc.ValidateToken(justExpired); err != nil {
		t.Errorf("a token %v past expiry should be tolerated by the %v leeway, got: %v",
			ClockLeeway/2, ClockLeeway, err)
	}
}

func TestValidateTokenStillRejectsGenuinelyExpiredTokens(t *testing.T) {
	svc := NewTokenService("test-secret")

	longExpired, err := svc.MintTokenWithTier("uid-1", "a@b.com", []string{"api-user"}, "free",
		-2*ClockLeeway)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}

	if _, err := svc.ValidateToken(longExpired); err == nil {
		t.Error("a token well past expiry must still be rejected; leeway is a tolerance, not an extension")
	}
}

// --- ValidateIdentityToken -------------------------------------------------
//
// The identity path exists so that a caller holding a valid OAuth/MCP token is
// METERED as themselves on public methods, rather than as an anonymous IP at
// 30/min. These tests pin both halves of that: it must accept a credential this
// deployment minted, and it must not become a second way to spend one.

func mcpAudienceOnly() jwt.ClaimStrings {
	return jwt.ClaimStrings{mcp.ResourceURI(mcp.DefaultAPIBaseURL)}
}

func signedWithAudience(t *testing.T, aud jwt.ClaimStrings, userID string) string {
	t.Helper()
	now := time.Now()
	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour)),
			IssuedAt:  jwt.NewNumericDate(now),
			Issuer:    "shorted-api",
			Audience:  aud,
		},
		UserID: userID,
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testSecret))
	if err != nil {
		t.Fatalf("signing: %v", err)
	}
	return signed
}

func TestValidateIdentityTokenAcceptsAnMCPAudienceToken(t *testing.T) {
	svc := NewTokenService(testSecret, testAudience()...)
	tok := signedWithAudience(t, mcpAudienceOnly(), "user-mcp")

	claims, err := svc.ValidateIdentityToken(tok)
	if err != nil {
		t.Fatalf("ValidateIdentityToken rejected an MCP token: %v", err)
	}
	if claims.UserID != "user-mcp" {
		t.Errorf("UserID = %q, want user-mcp", claims.UserID)
	}
	// The point of the whole exercise: this identity is what lets the rate
	// limiter key the caller as user:<uid> at their tier instead of ip:<addr>.
	if claims.UserID == "" {
		t.Error("no user id: the caller would still be metered as anonymous")
	}
}

func TestValidateIdentityTokenAcceptsWholeAPIAndLegacyTokens(t *testing.T) {
	svc := NewTokenService(testSecret, testAudience()...)

	both := signedWithAudience(t, jwt.ClaimStrings(testAudience()), "user-api")
	if _, err := svc.ValidateIdentityToken(both); err != nil {
		t.Errorf("rejected a whole-API token: %v", err)
	}

	// Audience-less tokens predate audiences entirely; the seam that keeps them
	// working on ValidateConnectToken must hold here too.
	legacy := signedWithAudience(t, nil, "user-legacy")
	if _, err := svc.ValidateIdentityToken(legacy); err != nil {
		t.Errorf("rejected an audience-less legacy token: %v", err)
	}
}

func TestValidateIdentityTokenRejectsAnotherDeploymentsToken(t *testing.T) {
	// Identity is weaker than authority, but it is still deployment-bound: a
	// dev-minted token naming a dev origin is not a prod user.
	svc := NewTokenService(testSecret, testAudience()...)
	foreign := signedWithAudience(t, jwt.ClaimStrings{"https://dev.example.com", "https://dev.example.com/mcp"}, "user-dev")

	if _, err := svc.ValidateIdentityToken(foreign); err == nil {
		t.Fatal("accepted a token whose audience names no surface of this deployment")
	}
}

func TestValidateIdentityTokenRejectsAForgedSignature(t *testing.T) {
	svc := NewTokenService(testSecret, testAudience()...)
	forged, err := jwt.NewWithClaims(jwt.SigningMethodHS256, Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
			Audience:  mcpAudienceOnly(),
		},
		UserID: "attacker",
	}).SignedString([]byte("not-the-secret"))
	if err != nil {
		t.Fatalf("signing: %v", err)
	}
	if _, err := svc.ValidateIdentityToken(forged); err == nil {
		t.Fatal("accepted a token signed with a different secret")
	}
}

// THE REGRESSION GUARD. Identity must not have reopened the escalation that
// ValidateConnectToken exists to close: an MCP grant is still not a Connect
// credential, so it still cannot reach MintToken and become a 30-day whole-API
// token. If this test ever fails, the consent screen is lying to users.
func TestValidateConnectTokenStillRefusesAnMCPAudienceToken(t *testing.T) {
	svc := NewTokenService(testSecret, testAudience()...)
	tok := signedWithAudience(t, mcpAudienceOnly(), "user-mcp")

	if _, err := svc.ValidateIdentityToken(tok); err != nil {
		t.Fatalf("precondition: identity should accept this token: %v", err)
	}
	if _, err := svc.ValidateConnectToken(tok); err == nil {
		t.Fatal("ValidateConnectToken accepted an MCP-audience token — privilege escalation reopened")
	}
}
