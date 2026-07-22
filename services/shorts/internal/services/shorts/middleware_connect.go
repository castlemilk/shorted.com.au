package shorts

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"

	"connectrpc.com/connect"
	firebase "firebase.google.com/go"
	"github.com/castlemilk/shorted.com.au/services/gen/proto/go/options/v1"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	shortedotel "github.com/castlemilk/shorted.com.au/services/pkg/otel"
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
var internalOnlyMethods = map[string]bool{
	"shorts.v1alpha1.ShortedStocksService.HandleStripeCheckoutCompleted":   true,
	"shorts.v1alpha1.ShortedStocksService.HandleStripeSubscriptionUpdated": true,
	// Same methods exposed via the per-domain BillingService split.
	"shorts.v1alpha1.BillingService.HandleStripeCheckoutCompleted":   true,
	"shorts.v1alpha1.BillingService.HandleStripeSubscriptionUpdated": true,
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

				if userID != "" {
					// Start with api-user role by default
					roles := []string{"api-user"}

					// Parse roles from header if provided
					if userRolesHeader != "" {
						headerRoles := strings.Split(userRolesHeader, ",")
						for _, role := range headerRoles {
							role = strings.TrimSpace(role)
							if role != "" && role != "api-user" {
								roles = append(roles, role)
							}
						}
					}

					// Auto-grant admin to specific emails
					adminEmails := []string{
						"e2e-test@shorted.com.au",
						"ben.ebsworth@gmail.com",
						"ben@shorted.com.au",
					}
					isAdmin := false
					for _, adminEmail := range adminEmails {
						if userEmail == adminEmail {
							if !hasRoleInList(roles, "admin") {
								roles = append(roles, "admin")
							}
							isAdmin = true
							break
						}
					}

					normalizedClaims := &Claims{
						UserID: userID,
						Email:  userEmail,
						Roles:  roles,
					}

					// Look up subscription tier
					lookupTier(normalizedClaims)

					// Record internal auth method metric
					if shortedotel.AuthMethod != nil {
						shortedotel.AuthMethod.Add(ctx, 1,
							otelmetric.WithAttributes(attribute.String("method", "internal")),
						)
					}
					log.Debugf("Internal auth: user=%s, roles=%v, tier=%s, isAdmin=%v", userEmail, roles, normalizedClaims.Tier, isAdmin)
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

			// If it's public and doesn't require a specific role, allow unauthenticated access
			if visibility == optionsv1.Visibility_VISIBILITY_PUBLIC && requiredRole == "" {
				if shortedotel.AuthMethod != nil {
					shortedotel.AuthMethod.Add(ctx, 1,
						otelmetric.WithAttributes(attribute.String("method", "anonymous")),
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
			claims, err := opts.TokenService.ValidateToken(tokenString)
			if err == nil {
				// Record API token auth method metric
				if shortedotel.AuthMethod != nil {
					shortedotel.AuthMethod.Add(ctx, 1,
						otelmetric.WithAttributes(attribute.String("method", "token")),
					)
				}
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
						// Token is a valid Firebase ID token
						// Start with api-user role for all authenticated users
						roles := []string{"api-user"}
						
						// Check for custom roles from Firebase claims
						if r, ok := fbToken.Claims["roles"].([]interface{}); ok {
							for _, role := range r {
								if rs, ok := role.(string); ok {
									if rs != "api-user" { // Don't duplicate api-user
										roles = append(roles, rs)
									}
								}
							}
						}
						
						// Auto-grant admin to specific emails
						email := ""
						if e, ok := fbToken.Claims["email"].(string); ok {
							email = e
							adminEmails := []string{
								"ben.ebsworth@gmail.com",
								"ben@shorted.com.au",
								"e2e-test@shorted.com.au",
							}
							for _, adminEmail := range adminEmails {
								if email == adminEmail && !hasRoleInList(roles, "admin") {
									roles = append(roles, "admin")
									log.Infof("Auto-granted admin role to %s", email)
									break
								}
							}
						}
						
						normalizedClaims := &Claims{
							UserID:        fbToken.UID,
							Email:         email,
							Roles:         roles,
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
			if audience == "" {
				audience = "shorted-dev-aba5688f" // dev fallback
			}
			payload, gErr := idtoken.Validate(ctx, tokenString, audience)
			if gErr == nil {
				email := ""
				if e, ok := payload.Claims["email"].(string); ok {
					email = e
				}
				normalizedClaims := &Claims{
					UserID: payload.Subject,
					Email:  email,
					Roles:  []string{},
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
	for _, r := range claims.Roles {
		if r == role {
			return true
		}
	}
	return false
}

func hasRoleInList(roles []string, role string) bool {
	for _, r := range roles {
		if r == role {
			return true
		}
	}
	return false
}

// UserFromContext retrieves user claims from the context.
func UserFromContext(ctx context.Context) (*Claims, bool) {
	claims, ok := ctx.Value(userKey).(*Claims)
	return claims, ok
}
