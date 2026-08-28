package shorts

import (
	"context"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/oauth"
)

// The token endpoint hands the minter an oauth.AccessTokenRequest; this is the
// compile-time statement that TokenService is that minter.
var _ oauth.TokenMinter = (*TokenService)(nil)

func mcpResource() string { return mcp.ResourceURI(mcp.DefaultAPIBaseURL) }

func containsStr(haystack []string, needle string) bool {
	for _, v := range haystack {
		if v == needle {
			return true
		}
	}
	return false
}

// The output of Task 4 must be accepted by the verifier Task 1 built —
// otherwise the AS and the resource server disagree about what a valid token
// is, and the whole flow dead-ends at the first tool call.
func TestOAuthAccessTokenIsAcceptedByTheMCPVerifier(t *testing.T) {
	svc := NewTokenService(testSecret, testAudience()...)

	token, err := svc.MintAccessToken(oauth.AccessTokenRequest{
		UserID:   "uid-1",
		Tier:     "pro",
		Scope:    "shorts:read housing:read",
		Audience: []string{mcpResource()},
		TTL:      oauth.AccessTokenTTL,
	})
	if err != nil {
		t.Fatalf("MintAccessToken: %v", err)
	}

	verify := mcp.NewTokenVerifier(svc, mcpResource())
	info, err := verify(context.Background(), token, &http.Request{})
	if err != nil {
		t.Fatalf("the MCP verifier rejected a token this AS minted for it: %v", err)
	}
	if info.UserID != "uid-1" {
		t.Errorf("UserID = %q", info.UserID)
	}
	if strings.Join(info.Scopes, " ") != "shorts:read housing:read" {
		t.Errorf("Scopes = %v, want the granted scope set", info.Scopes)
	}
	if info.Expiration.IsZero() {
		t.Error("no expiry: the SDK's bearer middleware rejects a zero expiration outright")
	}
	if ttl := time.Until(info.Expiration); ttl > oauth.AccessTokenTTL+time.Minute || ttl < oauth.AccessTokenTTL-time.Minute {
		t.Errorf("TTL = %s, want ~%s", ttl, oauth.AccessTokenTTL)
	}
}

// A token minted for a DIFFERENT deployment's MCP resource is not spendable
// here. That is the whole value of binding an audience.
func TestOAuthAccessTokenForAnotherDeploymentIsRejected(t *testing.T) {
	svc := NewTokenService(testSecret, testAudience()...)
	token, err := svc.MintAccessToken(oauth.AccessTokenRequest{
		UserID:   "uid-1",
		Audience: []string{"https://api.dev.example/mcp"},
		TTL:      time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := mcp.NewTokenVerifier(svc, mcpResource())(context.Background(), token, &http.Request{}); err == nil {
		t.Fatal("a token minted for another deployment's resource was accepted")
	}
}

// THE ESCALATION THIS TASK CLOSES.
//
// An MCP grant is one hour of read-only access to the MCP server, and that is
// what the consent screen says. The Connect API has PRIVATE methods with no
// required_role — BillingService.MintToken among them — which any authenticated
// caller may invoke, and it returns a 30-day whole-API token. So if an MCP
// access token authenticated the Connect API, a client could trade a narrow,
// short, revocable-by-expiry grant for a broad, long-lived credential the user
// never approved.
func TestMCPScopedTokenIsNotAConnectAPICredential(t *testing.T) {
	svc := NewTokenService(testSecret, testAudience()...)
	token, err := svc.MintAccessToken(oauth.AccessTokenRequest{
		UserID:   "uid-1",
		Scope:    "shorts:read",
		Audience: []string{mcpResource()},
		TTL:      time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}

	// It is a perfectly valid token — signature and expiry are fine — and the
	// MCP surface accepts it.
	if _, err := svc.ValidateToken(token); err != nil {
		t.Fatalf("the token is not even well-formed: %v", err)
	}
	if _, err := mcp.NewTokenVerifier(svc, mcpResource())(context.Background(), token, &http.Request{}); err != nil {
		t.Fatalf("the MCP surface should accept it: %v", err)
	}

	// The Connect surface must not.
	if _, err := svc.ValidateConnectToken(token); err == nil {
		t.Fatal("an MCP-scoped OAuth token authenticated the Connect API — it could then call BillingService.MintToken and walk away with a 30-day whole-API token")
	}
}

// The other three directions of the audience seam, so a future change cannot
// close the escalation by breaking every live API token instead.
func TestConnectAudienceSeam(t *testing.T) {
	svc := NewTokenService(testSecret, testAudience()...)

	// The outage-class direction: this is EXACTLY how production mints an API
	// token — service.go's MintToken RPC calls MintTokenWithTier with a 30-day
	// TTL. If this fails, every API key issued from today forward is dead on
	// arrival, so it is pinned against the real call shape rather than a
	// convenient one.
	t.Run("a token minted the way the MintToken RPC mints one is accepted", func(t *testing.T) {
		token, err := svc.MintTokenWithTier("uid", "u@example.test", []string{"api-user"}, "pro", 30*24*time.Hour)
		if err != nil {
			t.Fatal(err)
		}
		claims, err := svc.ValidateConnectToken(token)
		if err != nil {
			t.Fatalf("MintTokenWithTier's own token was refused by the Connect path: %v", err)
		}
		aud, _ := claims.GetAudience()
		if !containsStr(aud, mcp.DefaultAPIBaseURL) {
			t.Fatalf("audience = %v: the seam relies on MintTokenWithTier stamping the API origin", []string(aud))
		}
	})

	t.Run("a pre-audience token is accepted", func(t *testing.T) {
		legacy := mintLegacyTokenWithoutAudience(t, testSecret)
		if _, err := svc.ValidateConnectToken(legacy); err != nil {
			t.Fatalf("a live API token minted before audiences existed was refused: %v", err)
		}
	})

	t.Run("an unconfigured deployment cannot distinguish, so it accepts", func(t *testing.T) {
		plain := NewTokenService(testSecret)
		token, err := plain.MintAccessToken(oauth.AccessTokenRequest{
			UserID:   "uid",
			Audience: []string{mcpResource()},
			TTL:      time.Hour,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := plain.ValidateConnectToken(token); err != nil {
			t.Fatalf("a deployment with no configured audience must degrade to accepting: %v", err)
		}
	})
}

// The guard above only protects anything if the Connect auth path actually
// calls it. ValidateToken still exists and is still correct for its own callers
// (ValidateBearerToken builds on it), so nothing in the type system stops the
// interceptor from being changed back to the unchecked variant — and the change
// would be a one-word diff that no other test would notice.
//
// So this reads the source. It is a blunt instrument, chosen deliberately over
// standing up a Connect server with a store just to assert one branch.
func TestConnectInterceptorUsesTheAudienceCheckedValidator(t *testing.T) {
	src, err := os.ReadFile("middleware_connect.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	if !strings.Contains(body, "opts.TokenService.ValidateConnectToken(tokenString)") {
		t.Fatal("the Connect auth path no longer calls ValidateConnectToken — an OAuth token minted for /mcp would authenticate the Connect API")
	}
	if strings.Contains(body, "opts.TokenService.ValidateToken(") {
		t.Error("the Connect auth path calls ValidateToken, which performs no audience check")
	}
}

// An OAuth token carries no roles, so it can never satisfy a required_role
// check even on a surface that did accept it.
func TestOAuthAccessTokenCarriesNoRoles(t *testing.T) {
	svc := NewTokenService(testSecret, testAudience()...)
	token, err := svc.MintAccessToken(oauth.AccessTokenRequest{
		UserID:   "uid-1",
		Tier:     "enterprise",
		Audience: []string{mcpResource()},
		TTL:      time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	claims, err := svc.ValidateToken(token)
	if err != nil {
		t.Fatal(err)
	}
	if len(claims.Roles) != 0 {
		t.Errorf("Roles = %v, want none: a consent screen cannot confer an operator role", claims.Roles)
	}
	if hasRole(claims, "admin") {
		t.Error("an OAuth token satisfied an admin role check")
	}
}
