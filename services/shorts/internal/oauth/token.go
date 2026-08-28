package oauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	"github.com/google/uuid"
)

// AccessTokenTTL is one hour.
//
// The access token is a stateless JWT: nothing revokes it, so its lifetime IS
// the window a leaked token stays useful. One hour is the MCP-ecosystem norm
// and is short enough that revocation-by-expiry is a real control, while the
// refresh token below keeps a long-lived session from re-prompting the human.
const AccessTokenTTL = time.Hour

// RefreshTokenTTL bounds how long an unattended client can keep renewing
// without the user ever seeing a consent screen again. Thirty days matches the
// existing API-token lifetime, so a compromise here is not worse than a
// compromise of the credential this product already issues.
const RefreshTokenTTL = 30 * 24 * time.Hour

// refreshEntropyBytes — 256 bits. A refresh token is a bearer credential for a
// month; it must be unguessable, not merely unique.
const refreshEntropyBytes = 32

// PKCE verifier bounds, RFC 7636 §4.1.
const (
	minVerifierLen = 43
	maxVerifierLen = 128
)

// RefreshToken is a row of oauth_refresh_tokens. The raw token is not a field:
// only its hash is ever persisted, exactly as for an authorization code.
type RefreshToken struct {
	TokenHash string
	// FamilyID groups every token descended from ONE authorization grant.
	// Reuse detection revokes by family, not by token — see the handler.
	FamilyID  string
	ClientID  string
	UserID    string
	Resource  string
	Scope     string
	ExpiresAt time.Time
	RotatedAt time.Time
	RevokedAt time.Time
}

// TokenStore is the durable state the token endpoint needs, on top of the
// grant's Store.
//
// Every method that matters here is written so the CHECK and the MUTATION are
// one statement. A read-then-write would let two concurrent presentations of
// the same code — or the same refresh token — both pass the check before either
// wrote, which is precisely the race single-use is supposed to lose.
type TokenStore interface {
	Store

	// ConsumeAuthorizationCode marks a code consumed and returns it, ATOMICALLY.
	// It returns (nil, nil) when the code does not exist or was already
	// consumed: exactly one concurrent caller can ever get a row back.
	ConsumeAuthorizationCode(ctx context.Context, codeHash string) (*AuthorizationCode, error)

	// CreateRefreshToken writes a token hash. Used for the first token of a
	// family; successors are written by RotateRefreshToken so that rotation is
	// one transaction.
	CreateRefreshToken(ctx context.Context, token RefreshToken) error

	// GetRefreshToken reads a token row WITHOUT changing it. Unknown token:
	// (nil, nil). Rotated and revoked rows ARE returned, with RotatedAt /
	// RevokedAt set, because telling a dead token from an unknown one is the
	// whole point of reading it.
	//
	// This is the non-destructive half of the refresh grant: it lets an ordinary
	// client bug (a widened scope, the wrong resource) be refused without
	// spending the token, so that killing the family stays reserved for evidence
	// of compromise. It decides nothing on its own — RotateRefreshToken is still
	// the atomic single-use gate.
	GetRefreshToken(ctx context.Context, tokenHash string) (*RefreshToken, error)

	// RotateRefreshToken marks the presented token rotated and inserts the
	// successor in one transaction, returning the PARENT row.
	//
	// It returns (nil, nil) when the presented token does not exist, was
	// already rotated, or was revoked. The caller must treat that as a possible
	// REUSE and revoke the family — this method deliberately does not decide
	// that, so the policy lives in one readable place.
	RotateRefreshToken(ctx context.Context, presentedHash, successorHash string, successorExpiresAt time.Time) (*RefreshToken, error)

	// RevokeRefreshTokenFamily revokes every token sharing a family with the
	// presented one, and returns how many it killed. Unknown token: (0, nil).
	RevokeRefreshTokenFamily(ctx context.Context, presentedHash string) (int, error)
}

// AccessTokenRequest is what the token endpoint asks the minter for.
//
// It exists so that this package does not have to name the shorts package's
// Claims type (shorts imports oauth, so the dependency runs one way only) —
// the same shape of seam as IdentityVerifier and mcp.ClaimsValidator.
// There is deliberately NO Email field. There was one, it was never set by
// issue(), and it reached TokenService.mint as an always-empty claim — a field
// that is structurally guaranteed to be empty is worse than no field, because
// the next caller reads it as "the email is available here" and ships something
// that silently depends on "". Populating it is not available either: an email
// is only in hand at the grant, and neither oauth_authorization_codes nor
// oauth_refresh_tokens carries a column for it, so an OAuth access token cannot
// truthfully assert one. Removing it says that.
type AccessTokenRequest struct {
	UserID string
	// Tier is resolved from api_subscriptions at mint time. It is a HINT: the
	// Connect interceptor re-resolves tier on every request and never trusts
	// the token's copy, because a token outlives a cancelled subscription.
	Tier string
	// Scope is the space-delimited granted scope set (RFC 6749 §3.3).
	Scope string
	// Audience is the RFC 8707 resource binding — the ONLY audience the token
	// carries. See the note in the authorization_code path about why the API
	// origin is deliberately absent from it.
	Audience []string
	TTL      time.Duration
}

// TokenMinter signs an access token. Implemented by *shorts.TokenService.
type TokenMinter interface {
	MintAccessToken(req AccessTokenRequest) (string, error)
}

// TierResolver returns a user's subscription tier. Same signature as the
// Connect interceptor's SubscriptionLookup, so one implementation serves both.
type TierResolver func(userID string) (tier string, err error)

// TokenConfig configures the token endpoint.
type TokenConfig struct {
	Endpoints   Endpoints
	Store       TokenStore
	Minter      TokenMinter
	ResolveTier TierResolver
	Now         func() time.Time
}

type tokenHandler struct {
	issuer      string
	store       TokenStore
	minter      TokenMinter
	resolveTier TierResolver
	now         func() time.Time
	resources   []string
	scopes      map[string]bool
}

// NewTokenHandler builds the POST /oauth/token handler.
//
// WHAT AUTHENTICATES A CALL HERE. Nothing, and that is correct: every client of
// this AS is PUBLIC (an MCP desktop or browser client cannot keep a secret, so
// token_endpoint_auth_methods_supported is ["none"]). What stands in for client
// authentication is PKCE on the code grant, and possession of an unrotated,
// unrevoked, family-live token on the refresh grant. The client_id in the body
// is therefore a CLAIM to be checked against the stored grant, never a
// credential.
func NewTokenHandler(cfg TokenConfig) http.Handler {
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	issuer := cfg.Endpoints.issuer()
	scopes := make(map[string]bool, len(mcp.Scopes))
	for _, s := range mcp.Scopes {
		scopes[s] = true
	}
	return &tokenHandler{
		issuer:      issuer,
		store:       cfg.Store,
		minter:      cfg.Minter,
		resolveTier: cfg.ResolveTier,
		now:         now,
		resources:   []string{mcp.ResourceURI(issuer)},
		scopes:      scopes,
	}
}

func (h *tokenHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// RFC 6749 §5.1: token responses are never cached, anywhere, by anything.
	// Set before any branch so an error response carries it too.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")

	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeOAuthError(w, http.StatusMethodNotAllowed, "invalid_request", "POST required")
		return
	}
	if h.store == nil || h.minter == nil {
		writeOAuthError(w, http.StatusServiceUnavailable, "temporarily_unavailable",
			"the authorization server is not configured to issue tokens")
		return
	}
	// Form-encoded, per RFC 6749 §4.1.3. Bounded, because the body is
	// unauthenticated input.
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := r.ParseForm(); err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "body must be form-encoded")
		return
	}

	switch r.PostFormValue("grant_type") {
	case "authorization_code":
		h.authorizationCode(w, r)
	case "refresh_token":
		h.refresh(w, r)
	case "":
		writeOAuthError(w, http.StatusBadRequest, "invalid_request", "grant_type is required")
	default:
		writeOAuthError(w, http.StatusBadRequest, "unsupported_grant_type",
			"only authorization_code and refresh_token are supported")
	}
}

// authorizationCode implements RFC 6749 §4.1.3 with mandatory PKCE.
//
// THE ORDER OF OPERATIONS IS THE SECURITY PROPERTY. The code is CONSUMED
// FIRST — before the client_id, redirect_uri, PKCE verifier or resource are
// checked — and every later refusal leaves it consumed. That is deliberate:
//
//   - The race that matters is two presentations of the same code. Consuming
//     with a conditional UPDATE makes exactly one of them see a row, whatever
//     they present alongside it. Validating first and consuming after leaves a
//     window in which both pass.
//   - A caller who holds a stolen code but not the verifier gets ONE attempt,
//     and burns the code doing it. The legitimate client's redemption then
//     fails, which is a loud, detectable symptom of interception rather than a
//     silent one. OAuth 2.1 §4.1.3.3 requires exactly this: a code presented
//     with a bad verifier is spent.
func (h *tokenHandler) authorizationCode(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	code := r.PostFormValue("code")
	clientID := r.PostFormValue("client_id")
	redirectURI := r.PostFormValue("redirect_uri")
	verifier := r.PostFormValue("code_verifier")

	if code == "" || clientID == "" || redirectURI == "" {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request",
			"code, client_id and redirect_uri are required")
		return
	}
	// Shape-check the verifier before spending the code. This is not the PKCE
	// check — it rejects input that could not be a verifier at all (RFC 7636
	// §4.1), so a malformed request does not burn a legitimate user's code.
	if !validVerifier(verifier) {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request",
			"code_verifier must be 43-128 unreserved characters")
		return
	}

	record, err := h.store.ConsumeAuthorizationCode(ctx, HashCode(code))
	if err != nil {
		// FAIL CLOSED. A storage failure is not "no such code" and must never
		// be allowed to look like a successful single-use consumption.
		log.Errorf("oauth token: consuming code: %v", err)
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not redeem the code")
		return
	}
	if record == nil {
		// Unknown, or already consumed — a replay. One answer for both: telling
		// them apart would confirm to an attacker that a code was real.
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant",
			"the authorization code is invalid, expired or already used")
		return
	}

	if !h.now().Before(record.ExpiresAt) {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "the authorization code has expired")
		return
	}
	if record.ClientID != clientID {
		log.Warnf("oauth token: code for client %q presented by client %q", record.ClientID, clientID)
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant",
			"the authorization code was not issued to this client")
		return
	}
	// Exact string equality, for the same reason the grant used it: any
	// normalisation is a step towards accepting a redirect the client never
	// registered.
	if record.RedirectURI != redirectURI {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "redirect_uri does not match the authorization request")
		return
	}
	// PKCE. Constant-time, because a byte-at-a-time comparison of a value an
	// attacker can retry leaks the challenge one byte per attempt.
	if record.CodeChallengeMethod != "S256" {
		// Unreachable through the grant handler and the DB CHECK, so if it ever
		// fires something bypassed both.
		log.Errorf("oauth token: stored code has challenge method %q", record.CodeChallengeMethod)
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "unsupported code challenge method")
		return
	}
	if subtle.ConstantTimeCompare([]byte(challengeFor(verifier)), []byte(record.CodeChallenge)) != 1 {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "code_verifier does not match the code_challenge")
		return
	}

	// RFC 8707. The resource is optional on this request, but if present it
	// must be the one the grant bound — a token whose audience differs from the
	// audience the human consented to is a confused deputy.
	if requested := r.PostFormValue("resource"); requested != "" && requested != record.Resource {
		writeOAuthError(w, http.StatusBadRequest, "invalid_target",
			"resource does not match the resource this code was issued for")
		return
	}
	if !containsString(h.resources, record.Resource) {
		// The stored resource is no longer one this deployment serves.
		log.Warnf("oauth token: code bound to unknown resource %q", record.Resource)
		writeOAuthError(w, http.StatusBadRequest, "invalid_target", "unknown resource")
		return
	}

	h.issue(w, r, record.UserID, record.ClientID, record.Resource, record.Scope, "")
}

// refresh implements RFC 6749 §6 with mandatory rotation and reuse detection.
//
// ROTATION IS NOT AN OPTIMISATION. A non-rotating refresh token that leaks is
// useful for its whole lifetime and leaves no trace. With rotation, the thief
// and the victim end up presenting the same token, and that collision is the
// only signal a server ever gets that a token was stolen. Acting on it — by
// revoking the FAMILY, not the token — is what turns "useful forever" into
// "useful once, then everyone is logged out and has to re-consent".
//
// The cost is real and accepted: a client that legitimately retries a rotation
// (a dropped response, two threads refreshing at once) also kills its family
// and has to re-authorise. RFC 9700 §4.14.2 makes that trade the recommended
// one, because the alternative is being unable to distinguish theft at all.
//
// WHAT IS VALIDATED BEFORE THE TOKEN IS SPENT, AND WHY THAT IS NOT A WEAKENING.
// The order used to be rotate-then-validate, which meant a successor already
// existed by the time a scope or resource mismatch was noticed, and the only
// safe answer left was to kill the family. But a widened scope and a mistyped
// resource are ORDINARY CLIENT BUGS. Answering them with the same response as
// theft does not make the system safer; it makes the theft signal worthless, in
// exactly the way a freshness alarm that fires on the designed steady state
// stops meaning anything.
//
// So the parent is READ first, non-destructively, and client, expiry, scope and
// resource are checked against that read. A failed pre-check leaves the token
// LIVE and nothing rotated — the same argument this file already makes for
// running validVerifier before the code consume. Safety is unchanged because
// the pre-check is not the gate: RotateRefreshToken is still the atomic
// single-use conditional update, and it is still the thing that decides whether
// this presentation gets to spend the token. Anything the read says can be
// stale by the time the rotate runs; nothing is trusted that the rotate does
// not re-establish.
func (h *tokenHandler) refresh(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	presented := r.PostFormValue("refresh_token")
	clientID := r.PostFormValue("client_id")
	if presented == "" || clientID == "" {
		writeOAuthError(w, http.StatusBadRequest, "invalid_request",
			"refresh_token and client_id are required")
		return
	}
	presentedHash := HashCode(presented)

	parent, err := h.store.GetRefreshToken(ctx, presentedHash)
	if err != nil {
		// FAIL CLOSED, for the same reason the code path does: a storage failure
		// is not "no such token".
		log.Errorf("oauth token: reading refresh token: %v", err)
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not read the token")
		return
	}
	if parent == nil {
		// An unknown token has no family to revoke and no user to log out. One
		// answer for unknown and dead, so the response cannot be used to tell a
		// real token from an invented one.
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant",
			"the refresh token is invalid, expired or has already been used")
		return
	}
	// REUSE, checked before anything else. A token that has already been rotated
	// or revoked is being held by two parties, and that judgement must not be
	// pre-empted by a scope or resource complaint about the same request — a
	// thief who also mistypes a scope is still a thief.
	if !parent.RotatedAt.IsZero() || !parent.RevokedAt.IsZero() {
		h.revokeFamily(ctx, presentedHash, "reuse of a rotated or revoked refresh token")
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant",
			"the refresh token is invalid, expired or has already been used")
		return
	}
	// A token presented by a client it was not issued to is theft, not a typo:
	// the presenter got it from somewhere other than the exchange that minted it.
	if parent.ClientID != clientID {
		log.Warnf("oauth token: refresh token for client %q presented by client %q", parent.ClientID, clientID)
		h.revokeFamily(ctx, presentedHash, "cross-client refresh token presentation")
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant",
			"the refresh token was not issued to this client")
		return
	}
	// Expiry is a clock, not a compromise. The token is already useless; killing
	// its family as well would log a user out for the crime of being slow.
	if !h.now().Before(parent.ExpiresAt) {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "the refresh token has expired")
		return
	}

	// A refresh may NARROW the grant (RFC 6749 §6) and may never widen it.
	//
	// TrimSpace, because `scope=%20%20` is a whitespace-only field: strings.Fields
	// of it is empty, narrowScope refuses an empty set, and a client that sent a
	// blank scope parameter used to have its entire family revoked for it.
	// An empty field set is "no narrowing requested", which is what an absent
	// parameter means.
	scope := parent.Scope
	if requested := strings.TrimSpace(r.PostFormValue("scope")); requested != "" {
		narrowed, ok := narrowScope(parent.Scope, requested)
		if !ok {
			writeOAuthError(w, http.StatusBadRequest, "invalid_scope",
				"the requested scope exceeds the scope of the original grant")
			return
		}
		scope = narrowed
	}
	if requested := r.PostFormValue("resource"); requested != "" && requested != parent.Resource {
		writeOAuthError(w, http.StatusBadRequest, "invalid_target",
			"resource does not match the resource this token was issued for")
		return
	}

	// The client must still be REGISTERED for this grant. grant_types was
	// enforced at /authorize and nowhere else, so a client registered for
	// authorization_code alone could refresh indefinitely. Reading the client
	// through ResolvingStore also touches last_used_at, which the unused-client
	// sweep depends on and which the refresh path never used to write — a client
	// that only ever refreshes looked untouched to the sweeper.
	//
	// LAST of the checks on purpose. For a Client ID Metadata Document client_id
	// this is not a database read but an outbound HTTPS fetch (cached for
	// DefaultCIMDSuccessTTL), so it is the only check here that can be slow or
	// can fail for reasons that have nothing to do with the caller. Everything
	// cheap and local is already decided by this point, so an unreachable
	// metadata document costs latency only on requests that were going to
	// succeed.
	client, err := h.store.GetClient(ctx, clientID)
	if err != nil {
		log.Errorf("oauth token: client lookup failed: %v", err)
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "client lookup failed")
		return
	}
	if client == nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_client", "unknown client_id")
		return
	}
	// The length guard is for rows that predate grant-type normalisation. Nothing
	// can write an empty set now, but an empty set must not read as "deny
	// everything" for a client that has been refreshing happily for weeks.
	if len(client.GrantTypes) > 0 && !containsString(client.GrantTypes, "refresh_token") {
		writeOAuthError(w, http.StatusBadRequest, "unauthorized_client",
			"this client is not registered for the refresh_token grant")
		return
	}

	// Everything checks out, so now spend it. This is the gate, and it is the
	// only statement here whose outcome is authoritative.
	successor, err := newRefreshToken()
	if err != nil {
		log.Errorf("oauth token: generating refresh token: %v", err)
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not issue a token")
		return
	}
	rotated, err := h.store.RotateRefreshToken(ctx, presentedHash, HashCode(successor), h.now().Add(RefreshTokenTTL))
	if err != nil {
		log.Errorf("oauth token: rotating refresh token: %v", err)
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not rotate the token")
		return
	}
	if rotated == nil {
		// We did not win the conditional update, even though the read a moment
		// ago said the token was live. Something rotated or revoked it in
		// between — which means two parties presented it. This is the reuse
		// detection that actually matters, because it is the only one that is
		// atomic.
		h.revokeFamily(ctx, presentedHash, "reuse of a rotated or revoked refresh token")
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant",
			"the refresh token is invalid, expired or has already been used")
		return
	}

	h.issue(w, r, rotated.UserID, rotated.ClientID, rotated.Resource, scope, successor)
}

// revokeFamily is best effort and never changes the response: a failure to
// revoke must not turn a refusal into a 500 that an attacker could use to tell
// "reused" from "unknown". It is logged loudly instead.
func (h *tokenHandler) revokeFamily(ctx context.Context, presentedHash, why string) {
	n, err := h.store.RevokeRefreshTokenFamily(ctx, presentedHash)
	if err != nil {
		log.Errorf("oauth token: FAMILY REVOCATION FAILED after %s: %v", why, err)
		return
	}
	if n > 0 {
		log.Warnf("oauth token: revoked %d refresh tokens after %s", n, why)
	}
}

// issue mints the access token and, when refreshToken is empty, a brand new
// refresh token family. Both grants converge here so the response shape and the
// audience rule have exactly one definition.
func (h *tokenHandler) issue(w http.ResponseWriter, r *http.Request, userID, clientID, resource, scope, refreshToken string) {
	ctx := r.Context()

	// Tier at mint time, from api_subscriptions. A failed lookup degrades to
	// "free" — the LEAST privilege — rather than failing the exchange, because
	// the interceptor re-resolves tier on every request anyway and the token's
	// copy is only a hint.
	tier := "free"
	if h.resolveTier != nil {
		if resolved, err := h.resolveTier(userID); err != nil {
			log.Warnf("oauth token: tier lookup for %s failed, defaulting to free: %v", userID, err)
		} else if resolved != "" {
			tier = resolved
		}
	}

	access, err := h.minter.MintAccessToken(AccessTokenRequest{
		UserID: userID,
		Tier:   tier,
		Scope:  scope,
		// THE AUDIENCE IS THE RESOURCE, AND NOTHING ELSE.
		//
		// Not the API origin. A user consenting on the MCP consent screen
		// approved read access to the MCP server for one hour — not a credential
		// for the Connect API, where BillingService.MintToken would hand the
		// holder a 30-day whole-API token. Narrowing the audience here is what
		// makes that escalation impossible; TokenService.ValidateConnectToken is
		// the matching half that refuses an MCP-only audience on the Connect
		// surface.
		Audience: []string{resource},
		TTL:      AccessTokenTTL,
	})
	if err != nil {
		log.Errorf("oauth token: minting access token: %v", err)
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not issue a token")
		return
	}

	if refreshToken == "" {
		// A fresh authorization grant starts a new family.
		refreshToken, err = newRefreshToken()
		if err != nil {
			log.Errorf("oauth token: generating refresh token: %v", err)
			writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not issue a token")
			return
		}
		if err := h.store.CreateRefreshToken(ctx, RefreshToken{
			TokenHash: HashCode(refreshToken),
			FamilyID:  uuid.NewString(),
			ClientID:  clientID,
			UserID:    userID,
			Resource:  resource,
			Scope:     scope,
			ExpiresAt: h.now().Add(RefreshTokenTTL),
		}); err != nil {
			log.Errorf("oauth token: storing refresh token: %v", err)
			writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not issue a token")
			return
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"access_token":  access,
		"token_type":    "Bearer",
		"expires_in":    int(AccessTokenTTL / time.Second),
		"refresh_token": refreshToken,
		"scope":         scope,
	})
}

// challengeFor computes the RFC 7636 S256 challenge: BASE64URL-ENCODE(
// SHA256(ASCII(code_verifier))), unpadded.
func challengeFor(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// validVerifier enforces the RFC 7636 §4.1 grammar: 43-128 characters from the
// unreserved set. It exists so a malformed request is refused BEFORE the code
// is spent — a length check cannot leak anything a client did not already know.
func validVerifier(v string) bool {
	if len(v) < minVerifierLen || len(v) > maxVerifierLen {
		return false
	}
	for _, c := range v {
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9':
		case c == '-', c == '.', c == '_', c == '~':
		default:
			return false
		}
	}
	return true
}

// narrowScope returns the requested scope when it is a subset of the granted
// scope. Not a normalisation: an unknown or wider scope is refused, never
// silently dropped, because a client that believes it holds a scope it does not
// fails later somewhere unrelated.
func narrowScope(granted, requested string) (string, bool) {
	have := make(map[string]bool)
	for _, s := range strings.Fields(granted) {
		have[s] = true
	}
	fields := strings.Fields(requested)
	if len(fields) == 0 {
		return "", false
	}
	for _, s := range fields {
		if !have[s] {
			return "", false
		}
	}
	return strings.Join(fields, " "), true
}

func newRefreshToken() (string, error) {
	buf := make([]byte, refreshEntropyBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("reading entropy: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
