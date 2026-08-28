// Package oauth is the OAuth 2.1 AUTHORIZATION SERVER side of this API.
//
// The API is deliberately both the resource server (internal/mcp) and the
// authorization server. Three reasons, each checkable:
//
//  1. Go already verifies Firebase ID tokens (middleware_connect.go), so the
//     "the AS must live where the identity is" argument for putting it in
//     Next.js does not hold — the browser can hand Go the same assertion.
//  2. Access tokens are HS256, signed with a symmetric secret. An AS on Vercel
//     would put that secret on two platforms and make every rotation a
//     two-platform change. Here there is no shared secret at all.
//  3. The resource server must validate exactly what the AS mints. Same
//     process, same key: no JWKS fetch, and no cross-platform clock skew.
//
// Next.js contributes only the human-facing consent screen — the one part that
// genuinely needs a browser session and a person. It POSTs to /oauth/authorize/grant.
package oauth

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	"github.com/modelcontextprotocol/go-sdk/oauthex"
)

// DefaultAPIBaseURL is the authorization server's own origin — the issuer.
// It mirrors mcp.DefaultAPIBaseURL so that the AS and the resource server
// cannot disagree about which deployment they are.
const DefaultAPIBaseURL = mcp.DefaultAPIBaseURL

// DefaultConsentURL is the Next.js consent screen. It lives on the WEB origin,
// not this one: the authorization endpoint is where a human is sent, and the
// human's session cookie belongs to shorted.com.au.
const DefaultConsentURL = "https://shorted.com.au/oauth/authorize"

// Paths served by this package. They are relative to the API origin and are
// what the metadata document advertises.
const (
	// AuthorizationServerMetadataPath is the RFC 8414 discovery document.
	AuthorizationServerMetadataPath = "/.well-known/oauth-authorization-server"
	// GrantPath is called by the consent screen after a human approves. It is
	// NOT the authorization endpoint — no browser is redirected here.
	GrantPath = "/oauth/authorize/grant"
	// TokenPath and RegisterPath are advertised here and implemented by later
	// tasks. Advertising a path this package does not serve would be a lie in
	// the discovery document, so these constants are the single definition both
	// the document and the future mounts use.
	TokenPath    = "/oauth/token"
	RegisterPath = "/oauth/register"
)

// Endpoints is the deployment-specific configuration of the AS.
//
// Both fields are origins/URLs rather than constants because a dev or preview
// deployment must advertise ITSELF. Hardcoding prod would send a dev client to
// prod's token endpoint carrying a dev-issued code, which fails in the least
// legible way possible.
type Endpoints struct {
	// APIBaseURL is this deployment's public origin — the issuer, and the
	// origin the token and registration endpoints hang off. Defaults to
	// DefaultAPIBaseURL.
	APIBaseURL string
	// ConsentURL is the absolute URL of the Next.js consent screen. Defaults
	// to DefaultConsentURL.
	ConsentURL string
}

func (e Endpoints) issuer() string {
	if e.APIBaseURL == "" {
		return DefaultAPIBaseURL
	}
	return strings.TrimSuffix(e.APIBaseURL, "/")
}

func (e Endpoints) consent() string {
	if e.ConsentURL == "" {
		return DefaultConsentURL
	}
	return e.ConsentURL
}

// Metadata builds the RFC 8414 authorization-server metadata document.
//
// oauthex.AuthServerMeta is the SDK's own type for this document, so the field
// names and JSON tags are not hand-rolled here.
func Metadata(e Endpoints) *oauthex.AuthServerMeta {
	issuer := e.issuer()
	return &oauthex.AuthServerMeta{
		Issuer: issuer,
		// The human goes to the WEB app; that page calls back into this API.
		AuthorizationEndpoint:  e.consent(),
		TokenEndpoint:          issuer + TokenPath,
		RegistrationEndpoint:   issuer + RegisterPath,
		ScopesSupported:        append([]string(nil), mcp.Scopes...),
		ResponseTypesSupported: []string{"code"},
		GrantTypesSupported:    []string{"authorization_code", "refresh_token"},
		// S256 ONLY. "plain" is a PKCE downgrade: the verifier travels in the
		// clear and stops protecting anything.
		CodeChallengeMethodsSupported: []string{"S256"},
		// RFC 9207. The grant returns iss on the redirect so a client holding
		// several authorization servers cannot be tricked into sending a code
		// minted here to a different one (the mix-up attack).
		AuthorizationResponseIssParameterSupported: true,
		// Public clients only: an MCP desktop client cannot keep a secret, so
		// it proves itself with PKCE.
		TokenEndpointAuthMethodsSupported: []string{"none"},
		ServiceDocumentation:              mcp.DocumentationURL,
	}
}

// MetadataHandler serves the document at AuthorizationServerMetadataPath.
//
// It is hand-served rather than marshalled straight from the struct for one
// reason: RFC 8414 marks `jwks_uri` REQUIRED and the SDK's tag therefore has no
// `omitempty`, so a plain Marshal emits `"jwks_uri": ""`. This AS signs HS256
// with a symmetric secret — there is no public key set to publish — and an
// empty string is worse than an absent key, because a conformant client will
// try to fetch it and fail discovery. So the empty value is dropped.
func MetadataHandler(e Endpoints) http.Handler {
	body, err := marshalMetadata(Metadata(e))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Browser-based MCP clients fetch this cross-origin during discovery.
		// It is a public, non-credentialed document.
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, OPTIONS")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if err != nil {
			http.Error(w, "metadata unavailable", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		_, _ = w.Write(body)
	})
}

func marshalMetadata(md *oauthex.AuthServerMeta) ([]byte, error) {
	raw, err := json.Marshal(md)
	if err != nil {
		return nil, err
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	if v, ok := doc["jwks_uri"]; ok {
		if s, isString := v.(string); isString && s == "" {
			delete(doc, "jwks_uri")
		}
	}
	return json.Marshal(doc)
}
