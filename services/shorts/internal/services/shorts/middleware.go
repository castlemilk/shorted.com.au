package shorts

import (
	"context"
	"net/http"
	"sync"

	firebase "firebase.google.com/go"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"google.golang.org/api/idtoken"
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

		// Lazily initialize Firebase only when authentication is needed
		app, err := initFirebase()
		if err != nil {
			log.Errorf("Error initializing Firebase: %v\n", err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		// First, try to validate as a Firebase ID token
		firebaseClient, err := app.Auth(ctx)
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
		audience := "shorted-dev-aba5688f"
		// If not a Firebase token, validate as a Google service account token
		payload, err := idtoken.Validate(ctx, idToken, audience)
		if err != nil {
			log.Errorf("Error verifying ID token: %v\n, audience: %s", err, audience)
			log.Errorf("Token: %s\n", idToken)
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		// Token is a valid Google service account token
		ctx = context.WithValue(r.Context(), "user", payload.Claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
