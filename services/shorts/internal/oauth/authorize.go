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
	// Consent redeems the human's approval. It is a SEPARATE dependency from
	// Store rather than a method on it because a client store has no business
	// promising anything about consent — and because a nil one has to be a
	// visible 503, not a silently skipped check. See ServeHTTP step 1.
	//
	// It is a ConsentRedeemer, not a ConsentStore: the grant spends approvals
	// and must not be able to create them.
	Consent ConsentRedeemer
	// Now is injectable for tests. Defaults to time.Now.
	Now func() time.Time
}

type grantRequest struct {
	// ConsentTicket is REQUIRED. It is the proof that a human approved this
	// exact client, redirect URI and PKCE challenge.
	ConsentTicket string `json:"consent_ticket"`
	// IDToken is OPTIONAL, and defence in depth only. When present it must
	// verify AND name the same subject the ticket recorded.
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
	consent       ConsentRedeemer
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
// WHAT AUTHENTICATES A CALL HERE: a CONSENT TICKET, and nothing else.
//
// It used to be a Firebase ID token alone. That proves someone holds a
// credential; it does not prove a human approved anything, and once
// /oauth/register shipped, the gap was exploitable end to end — an attacker
// with a stolen ID token registers their own client and redirect URI, POSTs
// here, redeems the code, and walks away with an indefinitely-rotating refresh
// token that nobody ever agreed to.
//
// A ticket cannot be obtained with a stolen identity alone: minting one
// requires the internal service secret, which lives only on the consent
// screen's server, and the screen mints one only after a signed-in human
// approves a page naming the client, its redirect URI and its scopes.
//
// The ticket is spent FIRST, before any other validation, so a replay costs the
// attacker the ticket. Every binding it carries is then re-checked against this
// request, so an approval of one client cannot be spent on another. An ID
// token, if the caller passes one, is a cross-check on the subject only.
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
		consent:       cfg.Consent,
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
	if h.store == nil || h.consent == nil {
		// A deployment without a database, or wired without a consent store,
		// cannot issue codes. Say so plainly rather than panicking — and note
		// which way a missing consent store fails: refusing everything, never
		// issuing a code nobody approved.
		writeOAuthError(w, http.StatusServiceUnavailable, "temporarily_unavailable",
			"the authorization server is not configured to issue codes")
		return
	}

	var req grantRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "body must be JSON")
		return
	}

	// 1. CONSENT FIRST. Everything below binds a code to a user, and the only
	//    thing that names that user is a ticket a human's approval created. So
	//    the ticket is spent before anything else is even looked at: a request
	//    without one buys nothing, no matter what else it carries.
	//
	//    Spending it here also means a replay costs the attacker the ticket.
	if strings.TrimSpace(req.ConsentTicket) == "" {
		writeOAuthError(w, http.StatusUnauthorized, "access_denied",
			"consent_ticket is required — an authorization code is only issued after a human approves")
		return
	}
	ticket, err := h.consent.ConsumeConsentTicket(r.Context(), HashConsentTicket(req.ConsentTicket))
	if err != nil {
		log.Errorf("oauth grant: consuming consent ticket: %v", err)
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not verify consent")
		return
	}
	if ticket == nil {
		// Unknown or already spent. One approval, one code.
		writeOAuthError(w, http.StatusUnauthorized, "access_denied",
			"the consent ticket is not valid")
		return
	}
	if !ticket.ExpiresAt.After(h.now()) {
		writeOAuthError(w, http.StatusUnauthorized, "access_denied",
			"the consent ticket has expired — approve again")
		return
	}
	identity := Identity{UserID: ticket.UserID}

	// 1b. The ID token is OPTIONAL here and is a cross-check, not the
	//     authority: the consent screen may pass one, and if it does, it must
	//     name the same human the ticket recorded. A mismatch means the
	//     approval and the credential came from two different people, which is
	//     never a legitimate flow.
	if strings.TrimSpace(req.IDToken) != "" {
		if h.identity == nil {
			writeOAuthError(w, http.StatusServiceUnavailable, "temporarily_unavailable",
				"the authorization server cannot verify ID tokens")
			return
		}
		verified, err := h.identity.VerifyIDToken(r.Context(), req.IDToken)
		if err != nil {
			// The reason (expired, wrong project, malformed) stays in the log.
			// The response says only that the token was not accepted.
			log.Warnf("oauth grant: ID token rejected: %v", err)
			writeOAuthError(w, http.StatusUnauthorized, "invalid_token", "the ID token was not accepted")
			return
		}
		if verified.UserID != ticket.UserID {
			log.Warnf("oauth grant: ID token subject does not match the consent ticket")
			writeOAuthError(w, http.StatusUnauthorized, "invalid_token",
				"the ID token does not match the approving user")
			return
		}
		identity = verified
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

	// 6b. THE APPROVAL MUST BE FOR THIS REQUEST.
	//
	//     Everything above validated the request against the CLIENT's
	//     registration. This validates it against what the human was actually
	//     shown. Without it, a ticket approved for "Claude Desktop, callback
	//     127.0.0.1:51763, shorts:read" could be spent on any other registered
	//     client, any other registered callback, or a wider scope — the screen
	//     would be honest and the grant would still be wrong.
	//
	//     The code_challenge is bound too, which is what stops an attacker who
	//     can observe a ticket from substituting their own PKCE verifier and
	//     redeeming the resulting code themselves.
	if mismatch := ticketMismatch(ticket, client.ClientID, req.RedirectURI, req.CodeChallenge, resource, scope); mismatch != "" {
		log.Warnf("oauth grant: consent ticket does not match the request: %s differs", mismatch)
		writeOAuthError(w, http.StatusUnauthorized, "access_denied",
			"the consent ticket was issued for a different authorization request")
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
	return normaliseScope(h.scopes, requested, registered)
}

// normaliseScope is the free function behind it, shared with the consent
// endpoints so the scope the human is SHOWN is computed by the same code as the
// scope that is GRANTED. Two implementations of this would be two chances for
// the screen to describe a narrower grant than the one it authorises.
func normaliseScope(vocabulary map[string]bool, requested, registered string) (string, bool) {
	allowed := vocabulary
	if regFields := strings.Fields(registered); len(regFields) > 0 {
		allowed = make(map[string]bool, len(regFields))
		for _, s := range regFields {
			// A registered scope outside the published vocabulary grants
			// nothing: the intersection is what the client may ask for.
			if vocabulary[s] {
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

// ticketMismatch reports the FIRST binding on which the approval and the
// request disagree, or "" when every one matches.
//
// It returns the field name for the log and never for the response: telling a
// caller which binding failed turns this into an oracle for probing what a
// ticket was approved for.
//
// Scope is compared as a SET, not a string, because the granted scope is
// rebuilt from a map on both paths and its order is only as stable as the
// published vocabulary. A set comparison cannot be defeated by reordering and
// cannot fail spuriously because of it — but it still refuses a request that
// adds or drops a scope the human saw.
func ticketMismatch(ticket *ConsentTicket, clientID, redirectURI, codeChallenge, resource, scope string) string {
	switch {
	case ticket.ClientID != clientID:
		return "client_id"
	case ticket.RedirectURI != redirectURI:
		return "redirect_uri"
	case ticket.CodeChallenge != codeChallenge:
		return "code_challenge"
	case ticket.Resource != resource:
		return "resource"
	case !sameScopeSet(ticket.Scope, scope):
		return "scope"
	}
	return ""
}

func sameScopeSet(a, b string) bool {
	fa, fb := strings.Fields(a), strings.Fields(b)
	if len(fa) != len(fb) {
		return false
	}
	seen := make(map[string]int, len(fa))
	for _, s := range fa {
		seen[s]++
	}
	for _, s := range fb {
		seen[s]--
		if seen[s] < 0 {
			return false
		}
	}
	return true
}

// matchRedirectURI compares by exact string equality against every registered
// URI, with ONE exception: the port of a loopback address (RFC 8252 §7.3).
//
// Exact matching is the rule because anything looser is an open redirect.
// Normalising would defeat the point: "https://app.example/cb" and
// "https://APP.EXAMPLE/cb" resolve to the same host but a client that
// registered the first never asked to receive codes at the second, and a
// case-insensitive comparison is a step towards accepting
// "https://app.example/cb.attacker.com".
//
// THE LOOPBACK EXCEPTION, and why it is not a weakening.
//
// A native client (Claude Desktop, an IDE, a CLI) receives its callback on an
// ephemeral port it opens at the moment the flow starts: it registers
// "http://127.0.0.1:51763/callback" today and listens on 49200 tomorrow,
// because binding a FIXED port is what would be insecure — another local
// process could squat it. RFC 8252 §7.3 therefore requires an authorization
// server to allow any port for a loopback redirect. Without this, the single
// most common MCP client shape fails on its second connection, and it fails
// with "redirect_uri does not match", which reads like our bug in someone
// else's logs.
//
// It grants nothing: the host is still compared exactly, so only 127.0.0.1,
// ::1 or localhost qualify, and every one of those is the user's OWN machine.
// The path, scheme, query and fragment are still exact. An attacker who could
// use this would have to already be running code on the victim's computer, at
// which point the redirect URI is not what is protecting them.
func matchRedirectURI(registered []string, presented string) bool {
	for _, r := range registered {
		if r == presented {
			return true
		}
	}
	// Parsed only if the exact pass failed, so the common path does no work
	// and a malformed presented URI cannot reach the parser via the fast path.
	presentedURL, err := url.Parse(presented)
	if err != nil || !isLoopbackRedirect(presentedURL) {
		return false
	}
	for _, r := range registered {
		registeredURL, err := url.Parse(r)
		if err != nil || !isLoopbackRedirect(registeredURL) {
			continue
		}
		if sameExceptPort(registeredURL, presentedURL) {
			return true
		}
	}
	return false
}

// isLoopbackRedirect reports whether a URI is the "native app on this machine"
// shape RFC 8252 §7.3 is about.
//
// http only, and only over a loopback host. https is excluded because an https
// loopback URI has no port-agility problem to solve, and every non-loopback
// host must keep its port compared exactly — "https://app.example:8443/cb" and
// "https://app.example:9999/cb" can be two entirely different services.
func isLoopbackRedirect(u *url.URL) bool {
	if u == nil || u.Scheme != "http" {
		return false
	}
	switch u.Hostname() {
	case "127.0.0.1", "::1", "localhost":
		return true
	}
	return false
}

// sameExceptPort compares two loopback URIs on everything but the port.
//
// Hostname is compared exactly rather than by "is loopback", so a client that
// registered 127.0.0.1 cannot call back on localhost. They resolve to the same
// machine, but honouring a host the client never registered is the kind of
// latitude that stops being obviously safe the moment someone changes what
// "loopback" means.
func sameExceptPort(registered, presented *url.URL) bool {
	return registered.Hostname() == presented.Hostname() &&
		registered.Path == presented.Path &&
		registered.RawQuery == presented.RawQuery &&
		registered.Fragment == presented.Fragment &&
		registered.User.String() == presented.User.String()
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
