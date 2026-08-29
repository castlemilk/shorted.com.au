package shorts

import (
	"fmt"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/mcp"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/oauth"
	"github.com/golang-jwt/jwt/v5"
)

type Claims struct {
	jwt.RegisteredClaims
	UserID        string   `json:"user_id"`
	Email         string   `json:"email"`
	Roles         []string `json:"roles"`
	Tier          string   `json:"tier,omitempty"`            // Subscription tier: free, pro, enterprise
	IsBrowserAuth bool     `json:"is_browser_auth,omitempty"` // True if authenticated via Firebase (browser)
	// Scope is the OAuth 2.0 granted scope set, space-delimited per RFC 6749
	// §3.3. Empty on every token this service mints today — the tokens minted
	// through MintTokenWithTier are whole-API credentials, not scoped grants.
	// The OAuth token endpoint (Phase 3, Task 4) is what will populate it.
	Scope string `json:"scope,omitempty"`
}

// GetUserID implements ratelimit.UserClaims interface
func (c *Claims) GetUserID() string {
	return c.UserID
}

// GetTier implements ratelimit.UserClaims interface
func (c *Claims) GetTier() string {
	return c.Tier
}

// GetIsBrowserAuth returns true if this is browser-based auth (Firebase)
func (c *Claims) GetIsBrowserAuth() bool {
	return c.IsBrowserAuth
}

type TokenService struct {
	secret []byte
	// audience is stamped into every token this service mints. See
	// TokenAudience for what goes in it and why it is configured rather than
	// hardcoded.
	audience []string
}

// TokenAudience is the audience list for tokens minted by an API deployment
// whose public origin is apiBaseURL.
//
// Two entries, for two surfaces: the API origin itself (the Connect API) and
// the RFC 8707 resource identifier of the MCP server. Both are derived from
// the configured origin so that a dev-minted token is not spendable against
// prod — which is the whole value of binding an audience in the first place.
func TokenAudience(apiBaseURL string) []string {
	base := strings.TrimSuffix(apiBaseURL, "/")
	return []string{base, mcp.ResourceURI(base)}
}

// NewTokenService builds the JWT minter/validator.
//
// audience may be omitted, in which case minted tokens carry no `aud` and are
// therefore Connect-API-only — indistinguishable from a token minted before
// audiences existed. That is the right degradation for a misconfigured
// environment: the API keeps working and only the MCP surface refuses.
func NewTokenService(secret string, audience ...string) *TokenService {
	return &TokenService{
		secret:   []byte(secret),
		audience: audience,
	}
}

// MintToken creates a new JWT for a user with specific roles.
func (s *TokenService) MintToken(userID, email string, roles []string, duration time.Duration) (string, error) {
	return s.MintTokenWithTier(userID, email, roles, "free", duration)
}

// MintTokenWithTier creates a new JWT for a user with specific roles and subscription tier.
//
// It is a thin wrapper over mint: the whole-API credential is just the case
// where the audience is this service's default and no OAuth scope was granted.
// One minting path means one place the signing method, issuer and audience are
// decided.
func (s *TokenService) MintTokenWithTier(userID, email string, roles []string, tier string, duration time.Duration) (string, error) {
	return s.mint(mintRequest{
		UserID:   userID,
		Email:    email,
		Roles:    roles,
		Tier:     tier,
		Audience: s.audience,
		TTL:      duration,
	})
}

// mintRequest is the full set of things that vary between minted tokens.
type mintRequest struct {
	UserID   string
	Email    string
	Roles    []string
	Tier     string
	Scope    string
	Audience []string
	TTL      time.Duration
}

func (s *TokenService) mint(req mintRequest) (string, error) {
	now := time.Now()
	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(req.TTL)),
			IssuedAt:  jwt.NewNumericDate(now),
			Issuer:    "shorted-api",
			// RFC 8707 resource binding. Absent before this existed, which is
			// exactly why the MCP verifier treats an absent audience as a
			// refusal and the Connect API does not check it at all — see
			// mcp.NewTokenVerifier for the full seam.
			Audience: jwt.ClaimStrings(req.Audience),
		},
		UserID: req.UserID,
		Email:  req.Email,
		Roles:  req.Roles,
		Tier:   req.Tier,
		Scope:  req.Scope,
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.secret)
}

// MintAccessToken implements oauth.TokenMinter — the OAuth token endpoint's
// half of the seam that keeps the oauth package from needing to name Claims.
//
// Two things distinguish an OAuth access token from the whole-API token above,
// and both are load-bearing:
//
//   - It carries a SCOPE, so a resource server can see what was granted.
//   - Its audience is whatever the grant bound, which for an MCP grant is the
//     /mcp resource ALONE. It is deliberately not spendable on the Connect API;
//     ValidateConnectToken below is the half that enforces that.
//
// Roles are empty on purpose: a role is an operator grant, not something a
// consent screen can confer, so an OAuth token can never satisfy a
// required_role check.
//
// Email is empty for the same kind of reason. The grant knows the user's email,
// but nothing durable between the grant and here carries it, so the claim would
// be an always-empty string dressed up as a fact. oauth.AccessTokenRequest has
// no Email field at all, which is the honest version of that.
func (s *TokenService) MintAccessToken(req oauth.AccessTokenRequest) (string, error) {
	ttl := req.TTL
	if ttl <= 0 {
		ttl = oauth.AccessTokenTTL
	}
	return s.mint(mintRequest{
		UserID:   req.UserID,
		Tier:     req.Tier,
		Scope:    req.Scope,
		Audience: req.Audience,
		TTL:      ttl,
	})
}

// ClockLeeway is the tolerance applied to a token's expiry.
//
// It lives here, on the parse, because that is the only place it can take
// effect: golang-jwt validates `exp` during ParseWithClaims with zero leeway by
// default, and rejects the token before any downstream middleware gets to apply
// its own tolerance. The MCP bearer middleware sets a matching ClockSkew, but
// that value could never fire on a real token while this parse was strict — a
// token 30 seconds past expiry was refused even though both layers claimed to
// allow 60.
//
// Sixty seconds is the conventional NTP allowance. Tokens are minted by a
// different instance of this same binary on a different host, and reach us
// through Cloudflare and Cloud Run, so sub-second drift between issuer and
// verifier is ordinary. The tolerance only ever applies AFTER a token's stated
// expiry — it can never make an invalid token valid, only briefly extend one
// that already was.
const ClockLeeway = 60 * time.Second

// ValidateToken parses and validates a JWT.
func (s *TokenService) ValidateToken(tokenString string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return s.secret, nil
	}, jwt.WithLeeway(ClockLeeway))

	if err != nil {
		return nil, err
	}

	if claims, ok := token.Claims.(*Claims); ok && token.Valid {
		return claims, nil
	}

	return nil, fmt.Errorf("invalid token")
}

// ValidateConnectToken validates a bearer token for the CONNECT API surface,
// enforcing the audience rule that ValidateToken deliberately does not.
//
// WHY THIS EXISTS. The OAuth token endpoint mints tokens whose audience is the
// /mcp resource alone, granted by a consent screen that says "read-only access
// to the MCP server". Without an audience check on this side, such a token is
// also a valid Connect API credential — and `BillingService.MintToken` is
// PRIVATE with no required_role, i.e. reachable by ANY authenticated user. So a
// one-hour, read-only, scope-limited MCP grant could be exchanged for a 30-day
// whole-API token. That is a privilege escalation the consent screen never
// described, and this method is what closes it.
//
// The compatibility seam is unchanged and runs the other way from the MCP one:
//
//   - absent aud  -> ACCEPTED. Every token minted before audiences existed
//     carries none, and they are whole-API credentials.
//   - aud present, includes the API origin -> ACCEPTED (MintTokenWithTier).
//   - aud present, omits the API origin    -> REFUSED (an OAuth/MCP token).
//
// A deployment configured with no audience at all cannot make the distinction,
// so it accepts — the same degradation NewTokenService documents.
func (s *TokenService) ValidateConnectToken(tokenString string) (*Claims, error) {
	claims, err := s.ValidateToken(tokenString)
	if err != nil {
		return nil, err
	}
	if len(s.audience) == 0 {
		return claims, nil
	}
	audience, err := claims.GetAudience()
	if err != nil {
		return nil, fmt.Errorf("reading audience: %w", err)
	}
	if len(audience) == 0 {
		return claims, nil
	}
	// audience[0] is the API origin — see TokenAudience.
	for _, a := range audience {
		if a == s.audience[0] {
			return claims, nil
		}
	}
	return nil, fmt.Errorf("token audience %v does not include the Connect API (%s)", []string(audience), s.audience[0])
}

// ValidateBearerToken adapts ValidateToken to mcp.ClaimsValidator.
//
// The adapter exists because of the import direction: the mcp package cannot
// name *Claims (this package imports mcp, for DataSource), so the resource
// server declares the narrow shape it needs and this method projects onto it.
// Satisfaction is asserted at compile time in tokens_test.go.
//
// Note what it does NOT do: it performs no audience check. Audience is
// resource-specific and belongs to the resource server that knows its own
// identifier — mcp.NewTokenVerifier does it. Doing it here would either bind
// this method to one resource or duplicate the seam.
func (s *TokenService) ValidateBearerToken(tokenString string) (*mcp.VerifiedClaims, error) {
	claims, err := s.ValidateToken(tokenString)
	if err != nil {
		return nil, err
	}

	audience, err := claims.GetAudience()
	if err != nil {
		return nil, fmt.Errorf("reading audience: %w", err)
	}

	var expiresAt time.Time
	if exp, err := claims.GetExpirationTime(); err == nil && exp != nil {
		expiresAt = exp.Time
	}

	return &mcp.VerifiedClaims{
		UserID:    claims.UserID,
		Audience:  []string(audience),
		ExpiresAt: expiresAt,
		// strings.Fields, not Split(" "), so a doubled or tab separator does
		// not produce an empty scope that silently never matches.
		Scopes: strings.Fields(claims.Scope),
	}, nil
}
