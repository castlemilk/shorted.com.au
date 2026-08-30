package shorts

import (
	"context"
	"fmt"

	"github.com/castlemilk/shorted.com.au/services/shorts/internal/oauth"
)

// firebaseIdentityVerifier establishes who is approving an OAuth authorization
// request, from the Firebase ID token the consent screen posts.
//
// It deliberately reuses the SAME path the Connect auth interceptor takes —
// initFirebase() → app.Auth(ctx) → VerifyIDToken (middleware_connect.go, step
// 3 of the auth chain) — rather than constructing a second Firebase client.
// One integration means one place where the project, the audience and the
// credential source are decided; two would be two places for them to drift, and
// a drift here is an identity check that silently stops checking.
//
// What it does NOT copy from the interceptor is role derivation, admin
// auto-granting and tier lookup. An authorization code carries a SUBJECT and a
// scope set; roles are re-derived and tier is re-resolved on every request from
// the subscription store, and duplicating either here would bake a stale
// entitlement into a grant.
type firebaseIdentityVerifier struct{}

var _ oauth.IdentityVerifier = firebaseIdentityVerifier{}

func (firebaseIdentityVerifier) VerifyIDToken(ctx context.Context, idToken string) (oauth.Identity, error) {
	app, err := initFirebase()
	if err != nil {
		return oauth.Identity{}, fmt.Errorf("initializing firebase: %w", err)
	}
	client, err := app.Auth(ctx)
	if err != nil {
		return oauth.Identity{}, fmt.Errorf("firebase auth client: %w", err)
	}
	token, err := client.VerifyIDToken(ctx, idToken)
	if err != nil {
		return oauth.Identity{}, fmt.Errorf("verifying ID token: %w", err)
	}
	email, _ := token.Claims["email"].(string)
	return oauth.Identity{UserID: token.UID, Email: email}, nil
}
