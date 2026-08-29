package mcp

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/oauthex"
)

// OAuth 2.1 resource-server side of the MCP server.
//
// Authentication is OPTIONAL here and that is deliberate: Phase 2 shipped 24
// tools usable with no credentials, and that is what makes the server
// adoptable. What this file adds is the ability to RECOGNISE a token when one
// is presented, and the RFC 9728 document that tells a client where to get
// one. It does not make auth mandatory — see OptionalBearerToken.

// DefaultAPIBaseURL is the public origin of this API. It is the fallback for
// the configurable base URL, and the value every published constant in this
// package is derived from — see the assertion in ResourceURI's test that it
// reproduces PublicEndpoint.
const DefaultAPIBaseURL = "https://api.shorted.com.au"

// ProtectedResourceMetadataPath is where the RFC 9728 document is served.
//
// The path is resource-scoped (`/mcp` suffix) rather than bare, per RFC 9728
// §3.1: the resource identifier has a path component, so the metadata for it
// lives under the well-known prefix with that path appended. A client that
// discovers this server via the WWW-Authenticate challenge is sent straight
// here.
const ProtectedResourceMetadataPath = "/.well-known/oauth-protected-resource/mcp"

// BareProtectedResourceMetadataPath is the un-suffixed path, served as an ALIAS
// of the one above.
//
// RFC 9728 says the resource-scoped path is the correct one, and the
// WWW-Authenticate challenge points there. But some clients probe the bare path
// FIRST — before reading a challenge, sometimes before making a request at all
// — and a 404 there is indistinguishable from "this server does not do OAuth".
// The document is identical and entirely public, so aliasing costs nothing and
// removes a failure mode we would otherwise only ever hear about as "your
// server does not support authentication".
const BareProtectedResourceMetadataPath = "/.well-known/oauth-protected-resource"

// ClockSkew is the tolerance applied when deciding whether a token has
// expired.
//
// It is not a default and not decoration. Requests reach this process through
// Cloudflare and then Cloud Run, and the token was minted by a different
// instance of this binary on a different host. A strict comparison (the SDK's
// zero value) rejects a token that is perfectly valid by the issuer's clock
// whenever the two hosts differ by a fraction of a second, which surfaces as a
// rare, unreproducible 401 in the middle of an agent's turn.
//
// 60s is the conventional NTP-drift allowance (the same figure Google's and
// AWS's SDKs use). Against the 1h access-token TTL that Phase 3 mints it
// extends the effective lifetime by 1.7% — cheap next to intermittent
// mid-conversation failures, and it only ever applies AFTER a token's stated
// expiry, never to a token that was never valid.
const ClockSkew = 60 * time.Second

// Scopes is the scope vocabulary this resource server understands, published
// in the protected-resource metadata.
//
// offline_access is deliberately absent. Refresh-token issuance is a property
// of the authorization server's token lifetime, not a requirement of this
// resource; RFC 9728 §2 says a resource server advertises what it requires,
// and listing it here would push clients into asking for refresh tokens they
// have no need of.
var Scopes = []string{"shorts:read", "housing:read", "economy:read", "politics:read"}

// ResourceURI returns the RFC 8707 resource identifier for an API origin.
//
// Deriving it rather than hardcoding it is what lets dev, preview and prod
// each bind tokens to their own resource. A token minted for a dev origin is
// then not accepted by prod, which is the entire value of the audience check.
func ResourceURI(apiBaseURL string) string {
	return strings.TrimSuffix(apiBaseURL, "/") + "/mcp"
}

// ProtectedResourceMetadataURL is the absolute URL of the metadata document,
// as it appears in the WWW-Authenticate challenge.
func ProtectedResourceMetadataURL(apiBaseURL string) string {
	return strings.TrimSuffix(apiBaseURL, "/") + ProtectedResourceMetadataPath
}

// VerifiedClaims is the set of token facts this resource server needs.
//
// It is a deliberate re-statement of the fields of shorts.Claims rather than
// an import of it. The shorts package imports THIS package (for DataSource,
// asserted on *ShortsServer), so the dependency can only ever run one way.
// Naming the four fields the resource server actually uses keeps the direction
// honest and, like DataSource, makes the surface a compile-time statement
// rather than a convention.
type VerifiedClaims struct {
	// UserID is the subject the token was minted for.
	UserID string
	// Audience is the raw `aud` claim. EMPTY for every token minted before
	// this change — see NewTokenVerifier for what that means.
	Audience []string
	// ExpiresAt is the `exp` claim. The SDK's bearer middleware rejects a
	// zero value outright unless AllowMissingExpiration is set, and it is not.
	ExpiresAt time.Time
	// Scopes is the granted OAuth scope set, parsed from the space-delimited
	// `scope` claim.
	Scopes []string
}

// ClaimsValidator verifies a bearer token's signature and returns its claims.
//
// It is implemented by *shorts.TokenService, which asserts satisfaction in its
// own package. The interface lives here, next to its only consumer, for the
// same reason DataSource does: this package cannot name shorts.Claims without
// an import cycle, and a narrow interface is a better contract than a
// callback anyway.
type ClaimsValidator interface {
	ValidateBearerToken(token string) (*VerifiedClaims, error)
}

// NewTokenVerifier builds the auth.TokenVerifier the bearer middleware calls.
//
// Beyond signature and expiry, it enforces RFC 8707 resource binding: the
// token's `aud` must name THIS resource. That check is what stops a token
// minted for the Connect API — or for a different deployment, or by a
// confused-deputy authorization server — from being spent here.
//
// THE COMPATIBILITY SEAM. Every token minted before this change carries no
// `aud` at all. The rule, in both directions:
//
//   - absent aud, Connect API  -> VALID. shorts.ValidateToken performs no
//     audience check, so every live API token keeps working untouched.
//   - absent aud, /mcp         -> REJECTED, right here. An audience check that
//     treated "no audience" as "any audience" would be decorative.
//
// Getting this backwards breaks either every existing API token or the entire
// point of the check, so both directions are tested explicitly.
func NewTokenVerifier(validator ClaimsValidator, resourceURI string) auth.TokenVerifier {
	return func(_ context.Context, token string, _ *http.Request) (*auth.TokenInfo, error) {
		claims, err := validator.ValidateBearerToken(token)
		if err != nil {
			// Wrapped, not replaced: the middleware maps ErrInvalidToken to a
			// 401 with a challenge, and the reason stays legible in logs.
			return nil, fmt.Errorf("%w: %s", auth.ErrInvalidToken, err)
		}
		if claims == nil {
			return nil, fmt.Errorf("%w: no claims", auth.ErrInvalidToken)
		}
		if !contains(claims.Audience, resourceURI) {
			return nil, fmt.Errorf("%w: token audience does not include %s", auth.ErrInvalidToken, resourceURI)
		}
		return &auth.TokenInfo{
			UserID:     claims.UserID,
			Scopes:     claims.Scopes,
			Expiration: claims.ExpiresAt,
		}, nil
	}
}

// BearerTokenOptions are the middleware options for the /mcp surface.
//
// Scopes is intentionally EMPTY. The middleware requires every listed scope to
// be present, and no token in existence carries scopes yet; requiring one here
// would 403 the very callers this phase is meant to welcome. Per-tool
// authorisation is Task 9's problem, and tier is not a scope.
func BearerTokenOptions(apiBaseURL string) *auth.RequireBearerTokenOptions {
	return &auth.RequireBearerTokenOptions{
		ResourceMetadataURL: ProtectedResourceMetadataURL(apiBaseURL),
		ClockSkew:           ClockSkew,
	}
}

// OptionalBearerToken verifies a bearer token when one is presented and lets
// the request through untouched when one is not.
//
// auth.RequireBearerToken rejects a missing token outright, which would end
// anonymous access — the thing that makes this server adoptable. So the
// wrapper is thin and the branch is the whole design:
//
//   - no Authorization header -> straight through, no TokenInfo in context.
//     Handlers see exactly what they saw in Phase 2.
//   - header present          -> delegated to RequireBearerToken, so a bad
//     token gets the proper 401 and the RFC 9728 WWW-Authenticate challenge
//     rather than being silently downgraded to anonymous.
//
// That second branch matters: silently ignoring an unparseable token would
// leave a client with an expired credential quietly getting anonymous limits
// and no signal to re-authorise.
//
// A non-Bearer Authorization header (Basic, say) also goes down the delegated
// path and is rejected with the challenge, which is the correct answer to a
// client offering a scheme this resource does not accept.
func OptionalBearerToken(verifier auth.TokenVerifier, opts *auth.RequireBearerTokenOptions) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		required := auth.RequireBearerToken(verifier, opts)(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.TrimSpace(r.Header.Get("Authorization")) == "" {
				next.ServeHTTP(w, r)
				return
			}
			required.ServeHTTP(w, r)
		})
	}
}

// ProtectedResourceMetadata builds the RFC 9728 document for this resource.
func ProtectedResourceMetadata(apiBaseURL string) *oauthex.ProtectedResourceMetadata {
	base := strings.TrimSuffix(apiBaseURL, "/")
	return &oauthex.ProtectedResourceMetadata{
		Resource: ResourceURI(base),
		// This API is its own authorization server (Tasks 3-5). Same process,
		// same signing key, no JWKS fetch and no clock skew between two
		// platforms — which is also why JWKSURI is absent: the tokens are
		// HS256, symmetric, and there is no public key to publish.
		AuthorizationServers:   []string{base},
		ScopesSupported:        append([]string(nil), Scopes...),
		BearerMethodsSupported: []string{"header"},
		ResourceName:           ServerTitle,
		ResourceDocumentation:  DocumentationURL,
	}
}

// ProtectedResourceMetadataHandler serves the document at
// ProtectedResourceMetadataPath. The SDK supplies the handler, including the
// wildcard CORS the spec requires for browser-based client discovery.
func ProtectedResourceMetadataHandler(apiBaseURL string) http.Handler {
	return auth.ProtectedResourceMetadataHandler(ProtectedResourceMetadata(apiBaseURL))
}
