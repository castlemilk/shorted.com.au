package oauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
)

// ConsentTicketTTL is how long a human's approval stays spendable.
//
// Two minutes. The consent screen redeems it on the very next request, so this
// only has to cover a slow round trip and a slow browser — and a ticket is a
// bearer proof of consent, so every second past that is only useful to someone
// who intercepted it.
const ConsentTicketTTL = 2 * time.Minute

// consentTicketEntropyBytes matches the authorization code: 256 bits, because a
// guessable ticket is a forged approval.
const consentTicketEntropyBytes = 32

// Paths served by the consent-screen support endpoints. Both are INTERNAL:
// they are called by the Next.js consent screen's server side, never by a
// browser, and they are gated on the internal service secret.
const (
	// ConsentDescribePath answers "what should the human be shown?" for an
	// authorization request. Read-only.
	ConsentDescribePath = "/oauth/consent/describe"
	// ConsentTicketPath mints the proof that the human approved. Called only
	// after an explicit approve action.
	ConsentTicketPath = "/oauth/consent/ticket"
)

// ConsentTicket is a single-use, server-side record that a human approved one
// specific authorization request.
//
// Every field except the timestamps is a BINDING that /oauth/authorize/grant
// re-checks against its own request, so an approval of one client cannot be
// spent on another. The raw ticket is not a field: only its hash is persisted.
type ConsentTicket struct {
	TicketHash    string
	UserID        string
	ClientID      string
	RedirectURI   string
	CodeChallenge string
	Resource      string
	Scope         string
	ExpiresAt     time.Time
	// ConsumedAt is always zero on creation; the grant consumes with a
	// conditional UPDATE so a replay loses the race.
	ConsumedAt time.Time
}

// ConsentRedeemer is the half of the consent store the GRANT depends on.
//
// It is split out because the grant must be able to SPEND an approval and must
// not be able to CREATE one — an authorization endpoint that can mint its own
// proof of consent proves nothing.
type ConsentRedeemer interface {
	// ConsumeConsentTicket redeems a ticket in one statement, returning
	// (nil, nil) when it is unknown or already spent — the caller answers both
	// the same way.
	ConsumeConsentTicket(ctx context.Context, ticketHash string) (*ConsentTicket, error)
}

// ConsentStore is the durable state consent tickets need.
type ConsentStore interface {
	ConsentRedeemer
	CreateConsentTicket(ctx context.Context, ticket ConsentTicket) error
}

// consentClientStore is the read the consent endpoints need from the client
// store. It is deliberately GetClient (the resolving one) so that a CIMD
// client_id renders the metadata document's own name and redirect URIs — the
// human must be shown what will actually be honoured.
type consentClientStore interface {
	GetClient(ctx context.Context, clientID string) (*Client, error)
}

// ScopeDescription is one line of the consent screen: what a scope lets the
// client see, in words a human can act on.
//
// It lives here, next to the vocabulary it describes, because the screen is not
// allowed to invent them. A consent screen that paraphrases scopes locally
// drifts from what the server actually grants, and the human then approves
// something other than what happens.
type ScopeDescription struct {
	Scope       string `json:"scope"`
	Description string `json:"description"`
}

var scopeDescriptions = map[string]string{
	"shorts:read":   "Read ASX short-selling positions, stock details and market data",
	"housing:read":  "Read Australian house prices, suburb statistics and price drops",
	"economy:read":  "Read Australian economic series and state economic data",
	"politics:read": "Read federal politicians' declared registers of interests",
}

// DescribeScopes turns a space-delimited grant into ordered, human-readable
// lines. Unknown scopes are dropped rather than rendered raw — the vocabulary
// is closed, and anything outside it was already refused upstream.
func DescribeScopes(scope string) []ScopeDescription {
	granted := make(map[string]bool)
	for _, s := range strings.Fields(scope) {
		granted[s] = true
	}
	out := make([]ScopeDescription, 0, len(granted))
	for _, s := range mcp.Scopes { // published order, not map order
		if granted[s] {
			out = append(out, ScopeDescription{Scope: s, Description: scopeDescriptions[s]})
		}
	}
	return out
}

// ConsentConfig configures both consent endpoints.
type ConsentConfig struct {
	Endpoints Endpoints
	Store     consentClientStore
	Tickets   ConsentStore
	// Authorize gates the endpoint. It is the internal-service-secret check —
	// injected rather than read from the environment here so the package stays
	// testable and so the one implementation of that policy stays in one place.
	// A nil Authorize denies everything: a mis-wired gate must fail closed.
	Authorize func(*http.Request) bool
	// Now is injectable for tests. Defaults to time.Now.
	Now func() time.Time
}

// consentRequest is the shape of both endpoints' bodies. Describe ignores
// UserID; the ticket mint requires it.
//
// The identity is a USER ID, not an ID token, because the caller is the consent
// screen's server side: it has already established the session that names this
// user, and it proves it is the consent screen with the internal secret. See
// NewConsentTicketHandler for why that is stronger than an ID token here.
type consentRequest struct {
	UserID        string `json:"user_id"`
	ClientID      string `json:"client_id"`
	RedirectURI   string `json:"redirect_uri"`
	CodeChallenge string `json:"code_challenge"`
	// CodeChallengeMethod must be S256 when present. Absent means S256 too —
	// see validate() for why the plain default is never honoured.
	CodeChallengeMethod string `json:"code_challenge_method"`
	Resource            string `json:"resource"`
	Scope               string `json:"scope"`
}

type consentHandler struct {
	// mint distinguishes the two endpoints. Everything before the mint is
	// identical, and that is the point: the human is shown exactly the request
	// the ticket will be bound to.
	mint      bool
	issuer    string
	store     consentClientStore
	tickets   ConsentStore
	authorize func(*http.Request) bool
	now       func() time.Time
	resources []string
	scopes    map[string]bool
}

// NewConsentDescribeHandler builds the read-only POST /oauth/consent/describe
// handler: it validates an authorization request and returns what the consent
// screen must render. It writes nothing.
func NewConsentDescribeHandler(cfg ConsentConfig) http.Handler {
	return newConsentHandler(cfg, false)
}

// NewConsentTicketHandler builds POST /oauth/consent/ticket.
//
// WHY THIS ENDPOINT EXISTS AT ALL. /oauth/authorize/grant used to be
// authenticated by a Firebase ID token alone. That proves someone holds a
// credential; it does not prove a human saw a screen. Once dynamic client
// registration shipped, the gap became exploitable end to end: an attacker
// holding a stolen ID token registers their own client with their own redirect
// URI, POSTs the grant, redeems the code, and converts a ~1h credential into an
// indefinitely-rotating refresh token — with nobody ever approving anything.
//
// A ticket closes that because it cannot be minted with a stolen identity
// alone. Minting requires the INTERNAL_SERVICE_SECRET, which lives only on the
// consent screen's server, and the consent screen mints one only after a
// signed-in human clicks Approve on a page naming the client, its redirect URI
// and its scopes.
//
// So the identity here is a user id asserted by a caller that proved it is the
// consent screen, rather than an ID token verified in this process. That is
// deliberately not a downgrade: an ID token is a bearer credential an attacker
// can steal and replay from anywhere, whereas this path additionally requires a
// server-held secret. The grant still accepts an ID token as OPTIONAL defence in
// depth, and when one is present its subject must equal the ticket's.
func NewConsentTicketHandler(cfg ConsentConfig) http.Handler {
	return newConsentHandler(cfg, true)
}

func newConsentHandler(cfg ConsentConfig, mint bool) http.Handler {
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	issuer := cfg.Endpoints.issuer()
	scopes := make(map[string]bool, len(mcp.Scopes))
	for _, s := range mcp.Scopes {
		scopes[s] = true
	}
	return &consentHandler{
		mint:      mint,
		issuer:    issuer,
		store:     cfg.Store,
		tickets:   cfg.Tickets,
		authorize: cfg.Authorize,
		now:       now,
		resources: []string{mcp.ResourceURI(issuer)},
		scopes:    scopes,
	}
}

func (h *consentHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// No CORS headers, on purpose. These endpoints are server-to-server; a
	// browser must never be able to reach them, and the absence of an
	// Access-Control-Allow-Origin header is what enforces that for a
	// cross-origin caller.
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeOAuthError(w, http.StatusMethodNotAllowed, "invalid_request", "POST required")
		return
	}
	// FAIL CLOSED. A nil gate is a wiring mistake, and the safe reading of a
	// wiring mistake on the endpoint that mints proof-of-consent is "no".
	if h.authorize == nil || !h.authorize(r) {
		writeOAuthError(w, http.StatusForbidden, "access_denied",
			"this endpoint is callable only by the consent screen")
		return
	}
	if h.store == nil || (h.mint && h.tickets == nil) {
		writeOAuthError(w, http.StatusServiceUnavailable, "temporarily_unavailable",
			"the authorization server is not configured to issue consent tickets")
		return
	}

	var req consentRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "body must be JSON")
		return
	}

	client, resource, scope, ok := h.validate(w, r, req)
	if !ok {
		return
	}

	if !h.mint {
		writeConsentJSON(w, map[string]any{
			"client_id":    client.ClientID,
			"client_name":  client.ClientName,
			"redirect_uri": req.RedirectURI,
			"resource":     resource,
			"scope":        scope,
			"scopes":       DescribeScopes(scope),
		})
		return
	}

	// The mint path additionally needs to know WHO approved. There is no
	// fallback: a ticket with no subject would authorise a code for nobody, and
	// the grant would have nothing to bind the user to.
	if strings.TrimSpace(req.UserID) == "" {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request",
			"user_id is required — a ticket records who approved")
		return
	}

	ticket, err := newConsentTicket()
	if err != nil {
		log.Errorf("oauth consent: generating ticket: %v", err)
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not issue a consent ticket")
		return
	}
	record := ConsentTicket{
		TicketHash:    HashConsentTicket(ticket),
		UserID:        req.UserID,
		ClientID:      client.ClientID,
		RedirectURI:   req.RedirectURI,
		CodeChallenge: req.CodeChallenge,
		Resource:      resource,
		Scope:         scope,
		ExpiresAt:     h.now().Add(ConsentTicketTTL),
	}
	if err := h.tickets.CreateConsentTicket(r.Context(), record); err != nil {
		log.Errorf("oauth consent: storing ticket: %v", err)
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not issue a consent ticket")
		return
	}

	writeConsentJSON(w, map[string]any{
		"consent_ticket": ticket,
		"expires_in":     int(ConsentTicketTTL.Seconds()),
		"scope":          scope,
	})
}

// validate applies the SAME checks the grant applies, so the request the human
// is shown is the request the grant will accept. Divergence between the two is
// how a consent screen ends up describing one thing and authorising another.
func (h *consentHandler) validate(w http.ResponseWriter, r *http.Request, req consentRequest) (*Client, string, string, bool) {
	if req.ClientID == "" {
		writeOAuthError(w, http.StatusBadRequest, "invalid_client", "client_id is required")
		return nil, "", "", false
	}
	client, err := h.store.GetClient(r.Context(), req.ClientID)
	if err != nil {
		log.Errorf("oauth consent: client lookup failed: %v", err)
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "client lookup failed")
		return nil, "", "", false
	}
	if client == nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_client", "unknown client_id")
		return nil, "", "", false
	}
	if len(client.GrantTypes) > 0 && !containsString(client.GrantTypes, "authorization_code") {
		writeOAuthError(w, http.StatusBadRequest, "unauthorized_client",
			"this client is not registered for the authorization_code grant")
		return nil, "", "", false
	}

	// Exact string match, for the same reason as the grant: anything looser is
	// an open redirect, and here it would additionally mean showing the human
	// one destination and honouring another.
	if req.RedirectURI == "" {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "redirect_uri is required")
		return nil, "", "", false
	}
	if !matchRedirectURI(client.RedirectURIs, req.RedirectURI) {
		log.Warnf("oauth consent: redirect_uri %q is not registered for client %q", req.RedirectURI, client.ClientID)
		writeOAuthError(w, http.StatusBadRequest, "invalid_request",
			"redirect_uri does not exactly match a registered redirect URI")
		return nil, "", "", false
	}

	if req.CodeChallenge == "" {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "code_challenge is required")
		return nil, "", "", false
	}
	// RFC 7636 §4.3 makes an omitted method mean "plain". Accepting the empty
	// string would therefore be a silent downgrade, so absence is refused
	// rather than defaulted.
	if req.CodeChallengeMethod != "S256" {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request",
			"code_challenge_method must be S256")
		return nil, "", "", false
	}

	resource := req.Resource
	if resource == "" && len(h.resources) == 1 {
		resource = h.resources[0]
	}
	if !containsString(h.resources, resource) {
		writeOAuthError(w, http.StatusBadRequest, "invalid_target",
			"resource is not a resource served by this authorization server")
		return nil, "", "", false
	}

	scope, ok := normaliseScope(h.scopes, req.Scope, client.Scope)
	if !ok {
		writeOAuthError(w, http.StatusBadRequest, "invalid_scope", "unsupported scope requested")
		return nil, "", "", false
	}
	return client, resource, scope, true
}

func writeConsentJSON(w http.ResponseWriter, body map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	_ = json.NewEncoder(w).Encode(body)
}

// HashConsentTicket is the one-way function applied before storage. Exported
// because the grant must look a ticket up by the hash it was written under.
func HashConsentTicket(ticket string) string {
	sum := sha256.Sum256([]byte(ticket))
	return hex.EncodeToString(sum[:])
}

func newConsentTicket() (string, error) {
	buf := make([]byte, consentTicketEntropyBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("reading entropy: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// InternalSecretAuthorizer returns the gate used by the consent endpoints.
//
// It mirrors adminAuthMiddleware's contract deliberately — same secret, same
// two header spellings, same production-fails-closed rule — because a second,
// subtly different internal-auth policy is how one of them ends up wrong.
// The environment is read through the injected funcs so this is testable
// without mutating process state.
func InternalSecretAuthorizer(secret, environment string) func(*http.Request) bool {
	isProd := environment == "production" || environment == "prod"
	return func(r *http.Request) bool {
		if secret == "" {
			// No secret configured. In production that is a misconfiguration and
			// the answer is no. Locally it is the normal state of a dev machine,
			// and refusing would make the consent flow untestable there.
			if isProd {
				log.Errorf("oauth consent: INTERNAL_SERVICE_SECRET not set in production; refusing to mint consent tickets")
				return false
			}
			return true
		}
		presented := ""
		if auth := r.Header.Get("Authorization"); len(auth) > 7 && strings.EqualFold(auth[:7], "Bearer ") {
			presented = auth[7:]
		}
		if presented == "" {
			presented = r.Header.Get("x-internal-secret")
		}
		// Constant time: this compares a secret, and a timing leak here is a
		// leak of the thing that gates minting proof of consent.
		return subtle.ConstantTimeCompare([]byte(presented), []byte(secret)) == 1
	}
}
