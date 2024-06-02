package shorts

import (
	"context"
	"net/http"

	firebase "firebase.google.com/go"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"google.golang.org/api/idtoken"
)

var firebaseApp *firebase.App

func init() {
	ctx := context.Background()
	app, err := firebase.NewApp(ctx, nil)
	if err != nil {
		log.Fatalf("error initializing app: %v\n", err)
	}
	firebaseApp = app
}

// Middleware to verify the ID token
func AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Bypass preflight requests
		if r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			http.Error(w, "No token provided", http.StatusUnauthorized)
			// next.ServeHTTP(w, r)
			return
		}

		idToken := authHeader[len("Bearer "):]
		ctx := context.Background()

		// First, try to validate as a Firebase ID token
		firebaseClient, err := firebaseApp.Auth(ctx)
		if err != nil {
			log.Errorf("Error getting Firebase Auth client: %v\n", err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		token, err := firebaseClient.VerifyIDToken(ctx, idToken)
		if err == nil {
			// Token is a valid Firebase ID token
			ctx := context.WithValue(r.Context(), "user", token.Claims)
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}

		log.Infof("Token is not a Firebase token: %v\n", err)

		// If not a Firebase token, validate as a Google service account token
		payload, err := idtoken.Validate(ctx, idToken, "shorted-dev-aba5688f")
		if err != nil {
			log.Errorf("Error verifying ID token: %v\n", err)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		// Token is a valid Google service account token
		ctx = context.WithValue(r.Context(), "user", payload.Claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
