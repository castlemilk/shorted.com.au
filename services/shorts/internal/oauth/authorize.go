package oauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
)

// CodeTTL is how long an authorization code lives.
//
// Sixty seconds, because a code is redeemed by a machine within a round trip of
// being issued. Every second beyond that is only useful to someone who
// intercepted it — from a browser history entry, a referrer header, a proxy
// log. OAuth 2.1 §4.1.2 recommends a maximum of ten minutes; this is the
// tightest value that still tolerates a slow client.
const CodeTTL = 60 * time.Second

// codeEntropyBytes is the size of the random authorization code. 32 bytes is
// 256 bits — the code is a bearer credential for the length of its TTL and must
// be unguessable, not merely unique.
const codeEntropyBytes = 32

// Identity is who the consent screen says is approving. It is established by
// verifying a Firebase ID token, never by trusting a user_id in the body.
type Identity struct {
	UserID string
	Email  string
}

// IdentityVerifier verifies a Firebase ID token and returns its subject.
//
// The interface is here, next to its consumer, and implemented in the shorts
// package over the SAME firebase path the Connect auth interceptor uses
// (initFirebase → app.Auth → VerifyIDToken). A second Firebase integration
// would be a second place for the audience/project checks to drift.
type IdentityVerifier interface {
	VerifyIDToken(ctx context.Context, idToken string) (Identity, error)
}

// Client is a registered OAuth client.
type Client struct {
	ClientID   string
	ClientName string
	// RedirectURIs is compared by EXACT STRING EQUALITY. See matchRedirectURI.
	RedirectURIs []string
	GrantTypes   []string
	Scope        string
}

// AuthorizationCode is the row written by a successful grant. The raw code is
// not a field: only its hash is ever persisted.
type AuthorizationCode struct {
	CodeHash            string
	ClientID            string
	UserID              string
	RedirectURI         string
	CodeChallenge       string
	CodeChallengeMethod string
	Resource            string
	Scope               string
	ExpiresAt           time.Time
	// ConsumedAt is always zero here. Redemption is Task 4's, and it consumes
	// with a conditional UPDATE so a replay loses the race.
	ConsumedAt time.Time
}

// Store is the durable state the grant needs.
type Store interface {
	// GetClient returns (nil, nil) when the client is not registered — an
	// unknown client is a normal outcome, not an error.
	GetClient(ctx context.Context, clientID string) (*Client, error)
	CreateAuthorizationCode(ctx context.Context, code AuthorizationCode) error
}

// GrantConfig configures the grant handler.
type GrantConfig struct {
	Endpoints Endpoints
	Identity  IdentityVerifier
	Store     Store
	// Now is injectable for tests. Defaults to time.Now.
	Now func() time.Time
}

type grantRequest struct {
	IDToken             string `json:"id_token"`
	ClientID            string `json:"client_id"`
	RedirectURI         string `json:"redirect_uri"`
	CodeChallenge       string `json:"code_challenge"`
	CodeChallengeMethod string `json:"code_challenge_method"`
	Resource            string `json:"resource"`
	Scope               string `json:"scope"`
	State               string `json:"state"`
}

type grantHandler struct {
	issuer string
	// consentOrigin is the single browser origin allowed to call this endpoint
	// cross-origin. See the CORS block in ServeHTTP.
	consentOrigin string
	identity      IdentityVerifier
	store         Store
	now           func() time.Time
	resources     []string
	scopes        map[string]bool
}

// originOf reduces a URL to its scheme://host form — what a browser puts in
// the Origin header. An unparseable URL yields "", which matches no Origin
// header and therefore allows nothing.
func originOf(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// NewGrantHandler builds the POST /oauth/authorize/grant handler.
//
// WHAT AUTHENTICATES A CALL HERE. Nothing but the Firebase ID token in the
// body, and that is the design: the caller is a browser on the consent screen,
// so a cookie would be forgeable cross-site and a shared secret would have to
// ship to the browser. An ID token is a bearer assertion of one identity,
// scoped to the Firebase project, and holding one already means being able to
// act as that user against the Connect API. So this endpoint grants no
// authority the presenter did not already have — what it adds is that the code
// it returns can only leave via a redirect URI the CLIENT registered.
func NewGrantHandler(cfg GrantConfig) http.Handler {
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	issuer := cfg.Endpoints.issuer()
	scopes := make(map[string]bool, len(mcp.Scopes))
	for _, s := range mcp.Scopes {
		scopes[s] = true
	}
	return &grantHandler{
		issuer:        issuer,
		consentOrigin: originOf(cfg.Endpoints.consent()),
		identity:      cfg.Identity,
		store:         cfg.Store,
		now:           now,
		// The ONE grantable resource: this deployment's MCP server. The Connect
		// API origin is deliberately absent — an OAuth grant here authorises the
		// MCP surface, and widening it to the whole API would need its own
		// consent copy and its own decision.
		resources: []string{mcp.ResourceURI(issuer)},
		scopes:    scopes,
	}
}

func (h *grantHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// CORS, because the consent screen is on the WEB origin and this endpoint
	// is on the API origin — without it the approve button fails a preflight
	// and the flow dead-ends with nothing in any log.
	//
	// The allowlist is ONE origin: the consent screen's own, derived from the
	// configured ConsentURL so dev and prod each allow themselves. Not `*`,
	// even though the metadata document uses it — that document is public and
	// read-only, whereas this endpoint MINTS a code. And no
	// Allow-Credentials: identity here is a Firebase ID token in the body, not
	// a cookie, so there is no ambient authority for a cross-site page to ride.
	origin := r.Header.Get("Origin")
	if origin != "" && origin == h.consentOrigin {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Max-Age", "600")
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeOAuthError(w, http.StatusMethodNotAllowed, "invalid_request", "POST required")
		return
	}
	if h.store == nil || h.identity == nil {
		// A deployment without a database or without Firebase cannot issue
		// codes. Say so plainly rather than panicking or minting nothing and
		// reporting success.
		writeOAuthError(w, http.StatusServiceUnavailable, "temporarily_unavailable",
			"the authorization server is not configured to issue codes")
		return
	}

	var req grantRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "body must be JSON")
		return
	}

	// 1. IDENTITY FIRST. Everything below binds a code to a user, so there is
	//    no point validating the request of a caller we cannot name.
	if strings.TrimSpace(req.IDToken) == "" {
		writeOAuthError(w, http.StatusUnauthorized, "invalid_token", "id_token is required")
		return
	}
	identity, err := h.identity.VerifyIDToken(r.Context(), req.IDToken)
	if err != nil {
		// The reason (expired, wrong project, malformed) stays in the log. The
		// response says only that the token was not accepted.
		log.Warnf("oauth grant: ID token rejected: %v", err)
		writeOAuthError(w, http.StatusUnauthorized, "invalid_token", "the ID token was not accepted")
		return
	}
	if strings.TrimSpace(identity.UserID) == "" {
		log.Warnf("oauth grant: ID token verified but carried no subject")
		writeOAuthError(w, http.StatusUnauthorized, "invalid_token", "the ID token carried no subject")
		return
	}

	// 2. CLIENT.
	if req.ClientID == "" {
		writeOAuthError(w, http.StatusBadRequest, "invalid_client", "client_id is required")
		return
	}
	client, err := h.store.GetClient(r.Context(), req.ClientID)
	if err != nil {
		log.Errorf("oauth grant: client lookup failed: %v", err)
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "client lookup failed")
		return
	}
	if client == nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_client", "unknown client_id")
		return
	}
	if len(client.GrantTypes) > 0 && !containsString(client.GrantTypes, "authorization_code") {
		writeOAuthError(w, http.StatusBadRequest, "unauthorized_client",
			"this client is not registered for the authorization_code grant")
		return
	}

	// 3. REDIRECT URI — exact string match, and the reason this endpoint is not
	//    an open redirect. Anything else (prefix, case-insensitive, "same host
	//    is fine") hands the code to an attacker-controlled origin.
	if req.RedirectURI == "" {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "redirect_uri is required")
		return
	}
	if !matchRedirectURI(client.RedirectURIs, req.RedirectURI) {
		log.Warnf("oauth grant: redirect_uri %q is not registered for client %q", req.RedirectURI, client.ClientID)
		writeOAuthError(w, http.StatusBadRequest, "invalid_request",
			"redirect_uri does not exactly match a registered redirect URI")
		return
	}

	// 4. PKCE. S256 or nothing.
	//
	//    The absent case is checked explicitly: RFC 7636 §4.3 says an omitted
	//    code_challenge_method DEFAULTS TO "plain", so accepting an empty value
	//    is a silent downgrade to a scheme where the verifier travels in the
	//    clear. The database has a CHECK constraint too, but relying on it would
	//    surface a downgrade attempt as a 500 instead of a legible refusal.
	if req.CodeChallenge == "" {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "code_challenge is required")
		return
	}
	if req.CodeChallengeMethod != "S256" {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request",
			"code_challenge_method must be S256")
		return
	}

	// 5. RESOURCE (RFC 8707). The code carries it, and Task 4 stamps it into the
	//    minted token's audience — so an unvalidated resource here becomes an
	//    unvalidated audience there.
	resource := req.Resource
	if resource == "" && len(h.resources) == 1 {
		// Defaulting is provably not a widening WHILE exactly one resource is
		// grantable: the default is the only value the allowlist would accept.
		// The length guard is what keeps that true if a second one is added.
		resource = h.resources[0]
	}
	if !containsString(h.resources, resource) {
		writeOAuthError(w, http.StatusBadRequest, "invalid_target",
			"resource is not a resource served by this authorization server")
		return
	}

	// 6. SCOPE. Unknown scopes are refused rather than dropped: silently
	//    narrowing a grant produces a client that believes it has access it
	//    does not, and fails later somewhere unrelated. A client that declared
	//    a scope set at registration is also held to it — a registration is a
	//    statement of what the client needs, and letting a request exceed it
	//    makes the declaration decorative.
	scope, ok := h.normaliseScope(req.Scope, client.Scope)
	if !ok {
		writeOAuthError(w, http.StatusBadRequest, "invalid_scope", "unsupported scope requested")
		return
	}

	// 7. MINT. The code exists in exactly two places: this response, and the
	//    client's redirect. Storage gets sha256(code).
	code, err := newAuthorizationCode()
	if err != nil {
		log.Errorf("oauth grant: generating code: %v", err)
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not issue a code")
		return
	}
	record := AuthorizationCode{
		CodeHash:            HashCode(code),
		ClientID:            client.ClientID,
		UserID:              identity.UserID,
		RedirectURI:         req.RedirectURI,
		CodeChallenge:       req.CodeChallenge,
		CodeChallengeMethod: "S256",
		Resource:            resource,
		Scope:               scope,
		ExpiresAt:           h.now().Add(CodeTTL),
	}
	if err := h.store.CreateAuthorizationCode(r.Context(), record); err != nil {
		log.Errorf("oauth grant: storing code: %v", err)
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not issue a code")
		return
	}

	redirectTo, err := buildRedirect(req.RedirectURI, code, req.State, h.issuer)
	if err != nil {
		log.Errorf("oauth grant: building redirect: %v", err)
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not build the redirect")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	_ = json.NewEncoder(w).Encode(map[string]string{"redirect_to": redirectTo})
}

// normaliseScope validates the requested scope set against the published
// vocabulary AND against the client's registered scope, returning the
// space-delimited grant.
//
// An empty request gets the client's registered scope, or the full read
// vocabulary when the client registered none — every scope in it is read-only
// against one resource, so the default is the whole of what this AS grants.
func (h *grantHandler) normaliseScope(requested, registered string) (string, bool) {
	allowed := h.scopes
	if regFields := strings.Fields(registered); len(regFields) > 0 {
		allowed = make(map[string]bool, len(regFields))
		for _, s := range regFields {
			// A registered scope outside the published vocabulary grants
			// nothing: the intersection is what the client may ask for.
			if h.scopes[s] {
				allowed[s] = true
			}
		}
	}

	fields := strings.Fields(requested)
	if len(fields) == 0 {
		granted := make([]string, 0, len(allowed))
		for _, s := range mcp.Scopes { // published order, not map order
			if allowed[s] {
				granted = append(granted, s)
			}
		}
		if len(granted) == 0 {
			return "", false
		}
		return strings.Join(granted, " "), true
	}
	for _, s := range fields {
		if !allowed[s] {
			return "", false
		}
	}
	return strings.Join(fields, " "), true
}

// matchRedirectURI compares by exact string equality against every registered
// URI. No parsing, no normalisation, no case folding — the registered value is
// the only acceptable value.
//
// Normalising would defeat the point: "https://app.example/cb" and
// "https://APP.EXAMPLE/cb" resolve to the same host but a client that
// registered the first never asked to receive codes at the second, and a
// case-insensitive comparison is a step towards accepting
// "https://app.example/cb.attacker.com".
func matchRedirectURI(registered []string, presented string) bool {
	for _, r := range registered {
		if r == presented {
			return true
		}
	}
	return false
}

// HashCode is the one-way function applied to an authorization code before it
// is stored. Exported because the token endpoint (Task 4) must look a code up
// by the same hash it was written under.
func HashCode(code string) string {
	sum := sha256.Sum256([]byte(code))
	return hex.EncodeToString(sum[:])
}

func newAuthorizationCode() (string, error) {
	buf := make([]byte, codeEntropyBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("reading entropy: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// buildRedirect appends the authorization response to the client's registered
// redirect URI, preserving any query it already carried (RFC 6749 §3.1.2).
func buildRedirect(redirectURI, code, state, issuer string) (string, error) {
	u, err := url.Parse(redirectURI)
	if err != nil {
		return "", fmt.Errorf("parsing redirect_uri: %w", err)
	}
	q := u.Query()
	q.Set("code", code)
	if state != "" {
		q.Set("state", state)
	}
	// RFC 9207. A client that talks to more than one authorization server needs
	// to know which one issued this code; without iss it can be induced to
	// redeem it at the wrong one (the mix-up attack).
	q.Set("iss", issuer)
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func containsString(haystack []string, needle string) bool {
	for _, v := range haystack {
		if v == needle {
			return true
		}
	}
	return false
}

// writeOAuthError emits the RFC 6749 §5.2 error shape.
//
// It is a JSON body, not a redirect, and that distinction is a security
// property: an error discovered BEFORE the client and redirect URI are both
// validated must never be delivered by redirecting somewhere the request asked
// for. The consent screen is the caller here, and it decides what the human
// sees.
func writeOAuthError(w http.ResponseWriter, status int, code, description string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"error":             code,
		"error_description": description,
	})
}
