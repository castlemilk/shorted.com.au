package shorts

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	"github.com/castlemilk/shorted.com.au/services/gen/proto/go/options/v1"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"google.golang.org/api/idtoken"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	firebase "firebase.google.com/go"
	"sync"
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

// AuthInterceptor implements authentication and authorization using Connect interceptors.
func NewAuthInterceptor(tokenService *TokenService) connect.UnaryInterceptorFunc {
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

			log.Infof("Procedure: %s, Visibility: %v, RequiredRole: %s", procedure, visibility, requiredRole)

			// 1. Check for internal service authentication first (from server actions)
			// This allows minting tokens without an existing Authorization header
			internalSecret := req.Header().Get("X-Internal-Secret")
			// TODO: Use a proper secret from config
			if internalSecret == "dev-internal-secret" {
				userID := req.Header().Get("X-User-Id")
				userEmail := req.Header().Get("X-User-Email")
				if userID != "" {
					normalizedClaims := &Claims{
						UserID: userID,
						Email:  userEmail,
						Roles:  []string{},
					}
					// Admin check if needed
					if userEmail == "e2e-test@shorted.com.au" {
						normalizedClaims.Roles = append(normalizedClaims.Roles, "admin")
					}
					
					ctx = context.WithValue(ctx, userKey, normalizedClaims)
					return next(ctx, req)
				}
			}

			// If it's public and doesn't require a specific role, proceed
			if visibility == optionsv1.Visibility_VISIBILITY_PUBLIC && requiredRole == "" {
				return next(ctx, req)
			}

			// Perform standard authentication via Authorization header
			authHeader := req.Header().Get("Authorization")
			if authHeader == "" {
				return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("authentication required for this endpoint"))
			}

			tokenString := strings.TrimPrefix(authHeader, "Bearer ")

			// 2. Try to validate our bespoke API token
			claims, err := tokenService.ValidateToken(tokenString)
			if err == nil {
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
						// Normalize claims
						roles := []string{}
						if r, ok := fbToken.Claims["roles"].([]interface{}); ok {
							for _, role := range r {
								if rs, ok := role.(string); ok {
									roles = append(roles, rs)
								}
							}
						}
						
						normalizedClaims := &Claims{
							UserID: fbToken.UID,
							Email:  fbToken.Claims["email"].(string),
							Roles:  roles,
						}
						
						ctx = context.WithValue(ctx, userKey, normalizedClaims)
						if requiredRole != "" && !hasRole(normalizedClaims, requiredRole) {
							return nil, connect.NewError(connect.CodePermissionDenied, fmt.Errorf("%s role required", requiredRole))
						}
						return next(ctx, req)
					}
				}
			}

			// 4. Try to validate as a Google service account token
			audience := "shorted-dev-aba5688f"
			payload, gErr := idtoken.Validate(ctx, tokenString, audience)
			if gErr == nil {
				normalizedClaims := &Claims{
					UserID: payload.Subject,
					Email:  payload.Claims["email"].(string),
					Roles:  []string{},
				}
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

// UserFromContext retrieves user claims from the context.
func UserFromContext(ctx context.Context) (*Claims, bool) {
	claims, ok := ctx.Value(userKey).(*Claims)
	return claims, ok
}
