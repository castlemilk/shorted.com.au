package shorts

import (
	"context"
	"fmt"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	firebase "firebase.google.com/go"
	"github.com/castlemilk/shorted.com.au/services/gen/proto/go/options/v1"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
	"github.com/castlemilk/shorted.com.au/services/pkg/ratelimit"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
	"google.golang.org/api/idtoken"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
)

var (
	firebaseApp     *firebase.App
	firebaseAppOnce sync.Once
	firebaseAppErr  error
)

// initFirebase initializes Firebase lazily when auth is actually needed
func initFirebase() (*firebase.App, error) {
	firebaseAppOnce.Do(func() {
		ctx := context.Background()
		firebaseApp, firebaseAppErr = firebase.NewApp(ctx, nil)
		if firebaseAppErr != nil {
			log.Errorf("error initializing Firebase app: %v", firebaseAppErr)
		} else {
			log.Infof("Firebase app initialized successfully")
		}
	})
	return firebaseApp, firebaseAppErr
}

type contextKey string

const (
	userKey contextKey = "user"
)

// internalOnlyMethods are procedures that must be reachable ONLY via internal
// service-to-service authentication (a matching x-internal-secret), never by a
// generic end-user credential. Declaring a method PRIVATE in the proto is not
// sufficient: the interceptor treats PRIVATE with no required_role as "any
// authenticated user", so these Stripe webhook handlers — which trust the
// request body for identity + tier — would otherwise let any logged-in user
// self-grant a paid subscription or mutate another customer's record.
// Keyed by protobuf full method name.
// Each method is served by both the legacy monolithic service and its
// per-domain service (same ShortsServer handler) — derive both full names
// from one list so the two mounts can't drift.
var internalOnlyMethods = func() map[string]bool {
	m := make(map[string]bool)
	for _, svc := range []string{"ShortedStocksService", "BillingService"} {
		for _, method := range []string{"HandleStripeCheckoutCompleted", "HandleStripeSubscriptionUpdated"} {
			m["shorts.v1alpha1."+svc+"."+method] = true
		}
	}
	// The register review console. required_role="admin" in the proto is not
	// sufficient on its own: a user credential that carries the admin role could
	// otherwise call these directly. A decision here writes a curated_alias, which
	// the public gate then lets publish a live company link against a named
	// politician — so it is gated on the internal secret as well, and the only
	// caller that holds it is the web tier's own requireAdmin() actions.
	for _, method := range []string{
		"ListSecurityQueue", "SearchListings", "DecideSecurityCandidate",
		"UndoSecurityDecision", "GetCoverageStats",
	} {
		m["registerreview.v1.RegisterReviewService."+method] = true
	}
	return m
}()

// adminEmails is the one allowlist of accounts that may hold the "admin" role on
// the Connect API. Only the Firebase ID-token path reads it, and only for a token
// Firebase reports as email-verified (see rolesForFirebaseClaims). MintToken keeps
// no list of its own: it trusts the role the interceptor granted.
//
// e2e-test@shorted.com.au is deliberately absent. No automated test calls an admin
// RPC as that account: the web E2E suite reaches admin pages through the web tier,
// which asserts the role itself. An e2e account holding admin on the production API
// is the exposure this list should not carry.
var adminEmails = []string{
	"ben.ebsworth@gmail.com",
	"ben@shorted.com.au",
}

// The auth methods the interceptor records on Claims.AuthMethod.
const (
	// AuthMethodToken is a bespoke whole-API token minted by MintToken. The
	// identity-only path accepts the same tokens on public methods and records
	// this method too.
	AuthMethodToken = "token"
	// AuthMethodFirebase is a Firebase ID token presented by a browser.
	AuthMethodFirebase = "firebase"
	// AuthMethodInternal is the shared internal service secret, asserted by the web
	// tier, webhooks and other trusted services.
	AuthMethodInternal = "internal"

	// alertsJobUserAgentPrefix marks the alerts evaluator (`shorted alerts`). Its
	// entitlement lookups are the platform's own reads, made under the internal
	// secret, so they are exempt from the owner's per-user rate limit. An owner at
	// their quota must not stop their own alert email. The marker grants nothing on
	// its own: the internal secret must match before it is read.
	alertsJobUserAgentPrefix = "shorted-alerts/"
	// AuthMethodServiceAccount is a Google service-account identity token.
	AuthMethodServiceAccount = "service_account"
)

// adminTokenNotBefore is the earliest issue time at which a bespoke API token may
// carry the admin role.
//
// WHY A CUT-OVER AND NOT A REVOCATION. Before the verified-email fix, MintToken issued
// 30-day admin tokens to anyone holding an operator email, and MintToken renewed them.
// Those tokens cannot be revoked. They are stateless HS256 JWTs, and the signing secret
// is shared with every paying customer's token, so rotating it would log out every
// subscriber. Honouring the admin claim only on tokens issued after this instant
// withdraws admin from the old ones wherever they are presented. Everything else they
// carry (api-user, tier) keeps working. It is a var only because time.Time cannot be a
// constant, and tests move it.
var adminTokenNotBefore = time.Date(2026, 10, 24, 0, 0, 0, 0, time.UTC)

// bespokeTokenClaims marks claims as verified from a bespoke API token and withdraws
// the admin role when the token was issued before adminTokenNotBefore. Every path
// that accepts such a token calls it before the claims reach a handler.
func bespokeTokenClaims(claims *Claims) *Claims {
	claims.AuthMethod = AuthMethodToken
	if hasRoleInList(claims.Roles, "admin") && !issuedOnOrAfter(claims, adminTokenNotBefore) {
		log.Infof("Dropped admin role from API token for user %s: issued before the admin cut-over", claims.UserID)
		claims.Roles = withoutRole(claims.Roles, "admin")
	}
	return claims
}

// issuedOnOrAfter reports whether the token carries an issue time at or after t. A
// token with no iat counts as older than any cut-over, so it fails closed.
func issuedOnOrAfter(claims *Claims, t time.Time) bool {
	return claims.IssuedAt != nil && !claims.IssuedAt.Before(t)
}

// withoutRole returns roles with every occurrence of role removed.
func withoutRole(roles []string, role string) []string {
	out := make([]string, 0, len(roles))
	for _, r := range roles {
		if r != role {
			out = append(out, r)
		}
	}
	return out
}

// SubscriptionLookup is a function that looks up a user's subscription tier by user ID.
// Returns the tier (e.g., "free", "pro", "enterprise") or empty string if not found.
type SubscriptionLookup func(userID string) (tier string, err error)

// AuthInterceptorOptions configures the auth interceptor.
type AuthInterceptorOptions struct {
	TokenService       *TokenService
	SubscriptionLookup SubscriptionLookup
}

// AuthInterceptor implements authentication and authorization using Connect interceptors.
func NewAuthInterceptor(tokenService *TokenService) connect.UnaryInterceptorFunc {
	return NewAuthInterceptorWithOptions(AuthInterceptorOptions{
		TokenService: tokenService,
	})
}

// NewAuthInterceptorWithOptions creates an auth interceptor with additional options.
func NewAuthInterceptorWithOptions(opts AuthInterceptorOptions) connect.UnaryInterceptorFunc {
	// Helper to look up and set subscription tier
	lookupTier := func(claims *Claims) {
		if opts.SubscriptionLookup == nil || claims.UserID == "" {
			return
		}
		tier, err := opts.SubscriptionLookup(claims.UserID)
		if err != nil {
			log.Debugf("Failed to lookup subscription for user %s: %v", claims.UserID, err)
			return
		}
		claims.TierResolved = true
		if tier != "" {
			claims.Tier = tier
			log.Debugf("Set tier=%s for user %s", tier, claims.UserID)
		}
	}

	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			procedure := req.Spec().Procedure

			// Convert Connect procedure name (e.g. /shorts.v1alpha1.ShortedStocksService/GetTopShorts)
			// to Protobuf full name (e.g. shorts.v1alpha1.ShortedStocksService.GetTopShorts)
			name := strings.TrimPrefix(procedure, "/")
			name = strings.ReplaceAll(name, "/", ".")

			// Find the method descriptor
			methodDesc, err := protoregistry.GlobalFiles.FindDescriptorByName(protoreflect.FullName(name))
			if err != nil {
				log.Warnf("Could not find descriptor for procedure %s (as %s): %v", procedure, name, err)
				return next(ctx, req)
			}

			method, ok := methodDesc.(protoreflect.MethodDescriptor)
			if !ok {
				log.Warnf("Descriptor for %s is not a method descriptor", procedure)
				return next(ctx, req)
			}

			// Read custom visibility option
			visibility := optionsv1.Visibility_VISIBILITY_UNSPECIFIED
			if proto.HasExtension(method.Options(), optionsv1.E_Visibility) {
				ext := proto.GetExtension(method.Options(), optionsv1.E_Visibility)
				if v, ok := ext.(optionsv1.Visibility); ok {
					visibility = v
				}
			}

			// Read custom required_role option
			requiredRole := ""
			if proto.HasExtension(method.Options(), optionsv1.E_RequiredRole) {
				ext := proto.GetExtension(method.Options(), optionsv1.E_RequiredRole)
				if r, ok := ext.(string); ok {
					requiredRole = r
				}
			}

			// Only log procedure info at debug level
			log.Debugf("Procedure: %s, Visibility: %v, RequiredRole: %s", procedure, visibility, requiredRole)

			// 1. Check for internal service authentication first (from server actions/webhooks)
			// This allows service-to-service calls without user auth tokens
			// Use lowercase header names for compatibility with HTTP/2 and gRPC-web
			internalSecret := req.Header().Get("x-internal-secret")
			expectedSecret := os.Getenv("INTERNAL_SERVICE_SECRET")
			if expectedSecret == "" {
				// Check if we're in production - fail fast
				// Support both ENV and ENVIRONMENT (Terraform/Cloud Run uses ENVIRONMENT)
				env := os.Getenv("ENV")
				if env == "" {
					env = os.Getenv("ENVIRONMENT")
				}
				if env == "production" || env == "prod" {
					log.Errorf("INTERNAL_SERVICE_SECRET environment variable is required in production")
					return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("server misconfiguration"))
				}
				expectedSecret = "dev-internal-secret-unsafe-do-not-use-in-production"
			}

			// Debug: log received headers for internal auth troubleshooting
			// SECURITY: Never log secret values — only log whether they are present/match
			log.Debugf("Internal auth check: secret present=%v, secret matches=%v",
				internalSecret != "", internalSecret == expectedSecret)

			if internalSecret != "" && internalSecret == expectedSecret {
				userID := req.Header().Get("x-user-id")
				userEmail := req.Header().Get("x-user-email")
				userRolesHeader := req.Header().Get("x-user-roles")
				// Only the alerts transport sends x-user-email-verified, and only when the
				// session's address is verified. Other web callers send x-user-email for
				// their own reasons, so the address alone never proves verification.
				emailVerified := strings.EqualFold(strings.TrimSpace(req.Header().Get("x-user-email-verified")), "true")

				if userID != "" {
					// Start with api-user role by default
					roles := []string{"api-user"}

					// Parse roles from header if provided
					if userRolesHeader != "" {
						headerRoles := strings.SplitSeq(userRolesHeader, ",")
						for role := range headerRoles {
							role = strings.TrimSpace(role)
							if role != "" && role != "api-user" {
								roles = append(roles, role)
							}
						}
					}

					// Roles come from x-user-roles and nowhere else. This is the only way an
					// internal caller obtains "admin": the web tier asserts it after its own
					// verified-admin check (requireAdmin / isAdmin), and the shared
					// INTERNAL_SERVICE_SECRET is what makes that header trustworthy. Deriving
					// admin from x-user-email would not be: that header carries the address
					// alone, not whether the address was verified.
					// The website acting for its signed-in user is the customer's own use of
					// the site, so it is metered as browser access, not against the API
					// column. It is identified the way the rest of the platform identifies
					// first-party SSR: the internal secret plus the web's SSR user-agent
					// marker (see ratelimit.IsWebSSRUserAgent). The paid probe sends the
					// secret without that marker, so its API metering is unchanged.
					webOnBehalf := ratelimit.IsWebSSRUserAgent(req.Header().Get("User-Agent"))
					normalizedClaims := &Claims{
						UserID:        userID,
						Email:         userEmail,
						EmailVerified: emailVerified,
						Roles:         roles,
						AuthMethod:    AuthMethodInternal,
						IsBrowserAuth: webOnBehalf,
						WebOnBehalf:   webOnBehalf,
						// The alerts evaluator's entitlement lookups are the platform's own
						// reads, not the customer's API use, so they are not metered against
						// the owner's quota. See alertsJobUserAgentPrefix.
						RateLimitExempt: strings.HasPrefix(req.Header().Get("User-Agent"), alertsJobUserAgentPrefix),
					}

					// Look up subscription tier
					lookupTier(normalizedClaims)

					// Record internal auth method metric
					if shortedotel.AuthMethod != nil {
						shortedotel.AuthMethod.Add(ctx, 1,
							otelmetric.WithAttributes(attribute.String("method", "internal")),
						)
					}
					log.Debugf("Internal auth: user=%s, roles=%v, tier=%s", userEmail, roles, normalizedClaims.Tier)
					ctx = context.WithValue(ctx, userKey, normalizedClaims)

					// Check role requirement
					if requiredRole != "" && !hasRole(normalizedClaims, requiredRole) {
						return nil, connect.NewError(connect.CodePermissionDenied, fmt.Errorf("%s role required", requiredRole))
					}

					return next(ctx, req)
				}
			}

			// Internal-only procedures must authenticate via the internal service
			// secret. Reaching here means that branch did not authenticate the
			// request, so reject regardless of any user credential presented.
			if internalOnlyMethods[name] {
				return nil, connect.NewError(connect.CodePermissionDenied,
					fmt.Errorf("endpoint requires internal service authentication"))
			}

			// If it's public and doesn't require a specific role, allow unauthenticated
			// access — but IDENTIFY the caller first when they presented a credential.
			//
			// Access is not the question here; the method is public and the data is the
			// same either way. Metering is. extractIdentifierAndTier keys on the claims
			// this interceptor leaves in the context, so returning early without looking
			// at the Authorization header meters a token-bearing caller as `ip:<addr>`
			// at the anonymous 30/min instead of `user:<uid>` at their own tier. That is
			// the whole reason an OAuth/MCP credential appeared not to "work" against
			// this API: it worked, it was simply never read on the path that matters.
			//
			// ValidateIdentityToken, not ValidateConnectToken: an MCP-audience token is
			// a legitimate statement of WHO, and refusing it here would only mean
			// throttling a known user as a stranger. It confers nothing — this branch
			// has already established the method is public and role-free, and OAuth
			// tokens carry no roles regardless.
			//
			// A bad or foreign token falls through to anonymous rather than 401: public
			// is public, and a malformed header must not be able to deny access that
			// requires no credential at all.
			if visibility == optionsv1.Visibility_VISIBILITY_PUBLIC && requiredRole == "" {
				authMethod := "anonymous"
				if hdr := req.Header().Get("Authorization"); hdr != "" {
					tok := strings.TrimPrefix(hdr, "Bearer ")
					if idClaims, idErr := opts.TokenService.ValidateIdentityToken(tok); idErr == nil {
						bespokeTokenClaims(idClaims)
						lookupTier(idClaims)
						ctx = context.WithValue(ctx, userKey, idClaims)
						authMethod = "token-identity"
					}
				}
				if shortedotel.AuthMethod != nil {
					shortedotel.AuthMethod.Add(ctx, 1,
						otelmetric.WithAttributes(attribute.String("method", authMethod)),
					)
				}
				return next(ctx, req)
			}

			// Perform standard authentication via Authorization header
			authHeader := req.Header().Get("Authorization")
			if authHeader == "" {
				return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("authentication required for this endpoint"))
			}

			tokenString := strings.TrimPrefix(authHeader, "Bearer ")

			// 2. Try to validate our bespoke API token
			// ValidateConnectToken, not ValidateToken: it additionally requires
			// the token's audience to name THIS surface. An OAuth access token
			// minted for the /mcp resource is refused here, so a read-only MCP
			// consent cannot be spent on the Connect API — where MintToken would
			// upgrade it to a 30-day whole-API credential. Audience-less
			// pre-existing tokens are unaffected.
			claims, err := opts.TokenService.ValidateConnectToken(tokenString)
			if err == nil {
				// Record API token auth method metric
				if shortedotel.AuthMethod != nil {
					shortedotel.AuthMethod.Add(ctx, 1,
						otelmetric.WithAttributes(attribute.String("method", "token")),
					)
				}
				// Record that this is a bespoke token and withdraw admin from one issued before
				// the cut-over. See adminTokenNotBefore.
				bespokeTokenClaims(claims)
				// Always re-resolve tier from the subscription store — never trust the
				// tier embedded in the (30-day, non-revocable) token. A canceled or
				// downgraded subscription then loses paid limits immediately instead of
				// at token expiry. The lookup returns "free" for absent/inactive subs.
				lookupTier(claims)
				ctx = context.WithValue(ctx, userKey, claims)
				if requiredRole != "" && !hasRole(claims, requiredRole) {
					return nil, connect.NewError(connect.CodePermissionDenied, fmt.Errorf("%s role required", requiredRole))
				}
				return next(ctx, req)
			}

			// 3. Try to validate as a Firebase ID token
			app, fbErr := initFirebase()
			if fbErr == nil {
				firebaseClient, authErr := app.Auth(ctx)
				if authErr == nil {
					fbToken, verifyErr := firebaseClient.VerifyIDToken(ctx, tokenString)
					if verifyErr == nil {
						// Token is a valid Firebase ID token. Roles, including admin, come from
						// rolesForFirebaseClaims so the verified-email rule is tested without a live
						// Firebase token.
						roles := rolesForFirebaseClaims(fbToken.Claims)

						email := ""
						if e, ok := fbToken.Claims["email"].(string); ok {
							email = e
						}

						normalizedClaims := &Claims{
							UserID:        fbToken.UID,
							Email:         email,
							EmailVerified: emailVerifiedFromFirebaseClaims(fbToken.Claims),
							Roles:         roles,
							AuthMethod:    AuthMethodFirebase,
							IsBrowserAuth: true, // Firebase auth = browser access
						}

						// Look up subscription tier
						lookupTier(normalizedClaims)

						// Record Firebase auth method metric
						if shortedotel.AuthMethod != nil {
							shortedotel.AuthMethod.Add(ctx, 1,
								otelmetric.WithAttributes(attribute.String("method", "firebase")),
							)
						}
						log.Debugf("Firebase auth: user=%s, roles=%v, tier=%s", email, roles, normalizedClaims.Tier)
						ctx = context.WithValue(ctx, userKey, normalizedClaims)
						if requiredRole != "" && !hasRole(normalizedClaims, requiredRole) {
							return nil, connect.NewError(connect.CodePermissionDenied, fmt.Errorf("%s role required", requiredRole))
						}
						return next(ctx, req)
					}
				}
			}

			// 4. Try to validate as a Google service account token
			audience := os.Getenv("GCP_PROJECT_ID")
			if audience != "" {
				payload, gErr := idtoken.Validate(ctx, tokenString, audience)
				if gErr != nil {
					return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("invalid token"))
				}
				email := ""
				if e, ok := payload.Claims["email"].(string); ok {
					email = e
				}
				normalizedClaims := &Claims{
					UserID:     payload.Subject,
					Email:      email,
					Roles:      []string{},
					AuthMethod: AuthMethodServiceAccount,
				}

				// Look up subscription tier (service accounts typically don't have subscriptions)
				lookupTier(normalizedClaims)

				ctx = context.WithValue(ctx, userKey, normalizedClaims)
				if requiredRole != "" && !hasRole(normalizedClaims, requiredRole) {
					return nil, connect.NewError(connect.CodePermissionDenied, fmt.Errorf("%s role required", requiredRole))
				}
				return next(ctx, req)
			}

			return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("invalid token"))
		}
	}
}

func hasRole(claims *Claims, role string) bool {
	return slices.Contains(claims.Roles, role)
}

func hasRoleInList(roles []string, role string) bool {
	return slices.Contains(roles, role)
}

// rolesForFirebaseClaims returns the roles a verified Firebase ID token holds.
// Every authenticated user gets api-user, and the custom "roles" claim is carried
// over. Firebase sets that claim server-side, so a user cannot write it. admin is
// added only when the email is on adminEmails AND Firebase reports it verified.
//
// The verified check is the point. Email/password sign-up accepts any address
// without proof of ownership, so an unverified account registered under an admin's
// address before that admin signs up would otherwise inherit admin on this API and
// could mint a 30-day admin token. The web tier's admin-check applies the same rule
// to a uid.
func rolesForFirebaseClaims(claims map[string]any) []string {
	roles := []string{"api-user"}
	if r, ok := claims["roles"].([]any); ok {
		for _, role := range r {
			if rs, ok := role.(string); ok && rs != "api-user" {
				roles = append(roles, rs)
			}
		}
	}

	email, _ := claims["email"].(string)
	// A string "true" is not verified: only Firebase's boolean claim counts.
	verified, _ := claims["email_verified"].(bool)
	if verified && isAdminEmail(email) && !hasRoleInList(roles, "admin") {
		roles = append(roles, "admin")
		log.Infof("Granted admin role to verified account %s", email)
	}
	return roles
}

// emailVerifiedFromFirebaseClaims reports whether a verified Firebase ID token
// proves the address in its email claim. Only Firebase's boolean claim counts, the
// same strictness as rolesForFirebaseClaims: a string "true" does not.
func emailVerifiedFromFirebaseClaims(claims map[string]any) bool {
	verified, _ := claims["email_verified"].(bool)
	return verified
}

// isAdminEmail reports whether email is on adminEmails. Case and surrounding space
// are ignored, matching the web tier's isAdminEmail.
func isAdminEmail(email string) bool {
	normalized := strings.ToLower(strings.TrimSpace(email))
	if normalized == "" {
		return false
	}
	return slices.Contains(adminEmails, normalized)
}

// UserFromContext retrieves user claims from the context.
func UserFromContext(ctx context.Context) (*Claims, bool) {
	claims, ok := ctx.Value(userKey).(*Claims)
	return claims, ok
}
