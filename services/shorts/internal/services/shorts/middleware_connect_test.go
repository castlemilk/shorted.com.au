package shorts

import (
	"context"
	"errors"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/golang-jwt/jwt/v5"
)

func TestRolesForFirebaseClaimsGrantsAdminOnlyToAVerifiedAllowlistedEmail(t *testing.T) {
	cases := []struct {
		name      string
		claims    map[string]any
		wantAdmin bool
	}{
		{
			name:      "verified and allowlisted",
			claims:    map[string]any{"email": "ben@shorted.com.au", "email_verified": true},
			wantAdmin: true,
		},
		{
			name:      "case and surrounding space are ignored",
			claims:    map[string]any{"email": " Ben@Shorted.com.au ", "email_verified": true},
			wantAdmin: true,
		},
		{
			// The defect: an unverified email/password account registered under an
			// admin's address must not inherit the role.
			name:      "allowlisted but unverified",
			claims:    map[string]any{"email": "ben@shorted.com.au", "email_verified": false},
			wantAdmin: false,
		},
		{
			name:      "allowlisted with no email_verified claim",
			claims:    map[string]any{"email": "ben@shorted.com.au"},
			wantAdmin: false,
		},
		{
			// Only Firebase's boolean counts; a string "true" is not a verified token.
			name:      "email_verified as a string",
			claims:    map[string]any{"email": "ben@shorted.com.au", "email_verified": "true"},
			wantAdmin: false,
		},
		{
			name:      "verified but not allowlisted",
			claims:    map[string]any{"email": "someone@example.com", "email_verified": true},
			wantAdmin: false,
		},
		{
			name:      "no email claim at all",
			claims:    map[string]any{"email_verified": true},
			wantAdmin: false,
		},
		{
			// The e2e account was removed from the allowlist: nothing automated needs
			// it to be an admin on the production API.
			name:      "e2e test account is not an admin",
			claims:    map[string]any{"email": "e2e-test@shorted.com.au", "email_verified": true},
			wantAdmin: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			roles := rolesForFirebaseClaims(tc.claims)
			if got := hasRoleInList(roles, "admin"); got != tc.wantAdmin {
				t.Fatalf("admin = %v, want %v (roles %v)", got, tc.wantAdmin, roles)
			}
			if !hasRoleInList(roles, "api-user") {
				t.Fatalf("roles %v lack api-user", roles)
			}
		})
	}
}

func TestRolesForFirebaseClaimsKeepsCustomRolesWithoutDuplicatingAPIUser(t *testing.T) {
	roles := rolesForFirebaseClaims(map[string]any{
		"roles":          []any{"api-user", "reviewer"},
		"email":          "ben@shorted.com.au",
		"email_verified": false,
	})
	want := []string{"api-user", "reviewer"}
	if !reflect.DeepEqual(roles, want) {
		t.Fatalf("roles = %v, want %v", roles, want)
	}
}

// serveRPC mounts one unary handler behind the real auth interceptor, so tests
// exercise the same credential handling as production. A nil TokenService is
// replaced with the test deployment's.
func serveRPC[Req, Res any](
	t *testing.T,
	procedure string,
	opts AuthInterceptorOptions,
	fn func(context.Context, *connect.Request[Req]) (*connect.Response[Res], error),
) *httptest.Server {
	t.Helper()
	if opts.TokenService == nil {
		opts.TokenService = NewTokenService(testSecret, testAudience()...)
	}
	handler := connect.NewUnaryHandler(procedure, fn,
		connect.WithInterceptors(NewAuthInterceptorWithOptions(opts)))
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv
}

// callRPC sends one unary request to a server from serveRPC with the given headers.
func callRPC[Req, Res any](t *testing.T, srv *httptest.Server, procedure string, msg *Req, headers map[string]string, authorization string) (*connect.Response[Res], error) {
	t.Helper()
	client := connect.NewClient[Req, Res](srv.Client(), srv.URL+procedure)
	req := connect.NewRequest(msg)
	for k, v := range headers {
		req.Header().Set(k, v)
	}
	if authorization != "" {
		req.Header().Set("Authorization", "Bearer "+authorization)
	}
	return client.CallUnary(context.Background(), req)
}

const getSyncStatusProcedure = "/shorts.v1alpha1.MarketService/GetSyncStatus"

// errStoreDown stands in for a subscription store that cannot be reached.
var errStoreDown = errors.New("subscription store unavailable")

// adminRPC serves GetSyncStatus, which requires the admin role, and records the
// claims the interceptor attached.
func adminRPC(t *testing.T, opts AuthInterceptorOptions, seen **Claims) *httptest.Server {
	t.Helper()
	return serveRPC(t, getSyncStatusProcedure, opts,
		func(ctx context.Context, _ *connect.Request[shortsv1alpha1.GetSyncStatusRequest]) (*connect.Response[shortsv1alpha1.GetSyncStatusResponse], error) {
			claims, _ := UserFromContext(ctx)
			*seen = claims
			return connect.NewResponse(&shortsv1alpha1.GetSyncStatusResponse{}), nil
		})
}

// setAdminCutover moves adminTokenNotBefore for the duration of a test. The real
// cut-over is in the future, and tokens cannot be issued in the future.
func setAdminCutover(t *testing.T, at time.Time) {
	t.Helper()
	previous := adminTokenNotBefore
	adminTokenNotBefore = at
	t.Cleanup(func() { adminTokenNotBefore = previous })
}

// bespokeToken signs a token the way mint() does, with the audience this test
// deployment accepts. Fields the test sets are kept; a nil IssuedAt stays nil so a
// test can present a token with no issue time.
func bespokeToken(t *testing.T, claims Claims) string {
	t.Helper()
	if claims.ExpiresAt == nil {
		claims.ExpiresAt = jwt.NewNumericDate(time.Now().Add(time.Hour))
	}
	if claims.Issuer == "" {
		claims.Issuer = "shorted-api"
	}
	if claims.Audience == nil {
		claims.Audience = jwt.ClaimStrings(testAudience())
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testSecret))
	if err != nil {
		t.Fatalf("signing token: %v", err)
	}
	return signed
}

func TestInternalCallerGetsAdminOnlyFromTheAssertedRoleHeader(t *testing.T) {
	t.Setenv("INTERNAL_SERVICE_SECRET", "test-internal-secret")

	t.Run("an admin email with no roles header is not an admin", func(t *testing.T) {
		var seen *Claims
		srv := adminRPC(t, AuthInterceptorOptions{}, &seen)
		_, err := callRPC[shortsv1alpha1.GetSyncStatusRequest, shortsv1alpha1.GetSyncStatusResponse](t, srv,
			getSyncStatusProcedure, &shortsv1alpha1.GetSyncStatusRequest{}, map[string]string{
				"x-internal-secret": "test-internal-secret",
				"x-user-id":         "uid-admin",
				"x-user-email":      "ben@shorted.com.au",
			}, "")
		if connect.CodeOf(err) != connect.CodePermissionDenied {
			t.Fatalf("code = %v (%v), want PermissionDenied", connect.CodeOf(err), err)
		}
	})

	t.Run("the web tier's asserted admin role is honoured and recorded as internal", func(t *testing.T) {
		var seen *Claims
		srv := adminRPC(t, AuthInterceptorOptions{}, &seen)
		_, err := callRPC[shortsv1alpha1.GetSyncStatusRequest, shortsv1alpha1.GetSyncStatusResponse](t, srv,
			getSyncStatusProcedure, &shortsv1alpha1.GetSyncStatusRequest{}, map[string]string{
				"x-internal-secret": "test-internal-secret",
				"x-user-id":         "uid-admin",
				"x-user-email":      "ben@shorted.com.au",
				"x-user-roles":      "admin",
			}, "")
		if err != nil {
			t.Fatalf("GetSyncStatus: %v", err)
		}
		if seen == nil || !hasRole(seen, "admin") {
			t.Fatalf("claims %+v lack the asserted admin role", seen)
		}
		if seen.AuthMethod != AuthMethodInternal {
			t.Fatalf("AuthMethod = %q, want %q", seen.AuthMethod, AuthMethodInternal)
		}
	})

	t.Run("without the internal secret the roles header is ignored", func(t *testing.T) {
		var seen *Claims
		srv := adminRPC(t, AuthInterceptorOptions{}, &seen)
		_, err := callRPC[shortsv1alpha1.GetSyncStatusRequest, shortsv1alpha1.GetSyncStatusResponse](t, srv,
			getSyncStatusProcedure, &shortsv1alpha1.GetSyncStatusRequest{}, map[string]string{
				"x-internal-secret": "wrong-secret",
				"x-user-id":         "uid-admin",
				"x-user-email":      "ben@shorted.com.au",
				"x-user-roles":      "admin",
			}, "")
		if connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Fatalf("code = %v (%v), want Unauthenticated", connect.CodeOf(err), err)
		}
	})
}

func TestBespokeTokenKeepsAdminOnlyWhenIssuedAfterTheCutOver(t *testing.T) {
	// JWT iat is whole seconds, so the cut-over is whole seconds too. Otherwise a
	// token issued exactly at the cut-over would encode a second before it.
	cutover := time.Now().Truncate(time.Second).Add(-time.Hour)
	setAdminCutover(t, cutover)

	cases := []struct {
		name     string
		issuedAt *jwt.NumericDate
		wantErr  connect.Code // zero when admin should be honoured
	}{
		{
			// The defect: a token minted under the old email rule must not keep admin.
			name:     "issued before the cut-over loses admin",
			issuedAt: jwt.NewNumericDate(cutover.Add(-time.Minute)),
			wantErr:  connect.CodePermissionDenied,
		},
		{
			name:     "issued at the cut-over keeps admin",
			issuedAt: jwt.NewNumericDate(cutover),
		},
		{
			// No issue time counts as older than any cut-over: fail closed.
			name:     "no issue time loses admin",
			issuedAt: nil,
			wantErr:  connect.CodePermissionDenied,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var seen *Claims
			srv := adminRPC(t, AuthInterceptorOptions{}, &seen)
			token := bespokeToken(t, Claims{
				IssuedAt: tc.issuedAt,
				UserID:   "uid-admin",
				Email:    "ben@shorted.com.au",
				Roles:    []string{"api-user", "admin"},
			})
			_, err := callRPC[shortsv1alpha1.GetSyncStatusRequest, shortsv1alpha1.GetSyncStatusResponse](t, srv,
				getSyncStatusProcedure, &shortsv1alpha1.GetSyncStatusRequest{}, nil, token)
			if tc.wantErr == 0 {
				if err != nil {
					t.Fatalf("GetSyncStatus: %v, want admin honoured", err)
				}
				return
			}
			if connect.CodeOf(err) != tc.wantErr {
				t.Fatalf("code = %v (%v), want %v", connect.CodeOf(err), err, tc.wantErr)
			}
		})
	}
}

func TestBespokeTokenCannotChooseItsOwnAuthMethod(t *testing.T) {
	setAdminCutover(t, time.Now().Add(-time.Hour))

	// A token that tries to claim it was verified by the internal secret. The
	// interceptor must still record it as a bespoke token.
	var seen *Claims
	srv := adminRPC(t, AuthInterceptorOptions{}, &seen)
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"user_id":     "uid-1",
		"email":       "ben@shorted.com.au",
		"roles":       []string{"api-user", "admin"},
		"auth_method": AuthMethodInternal,
		"iat":         jwt.NewNumericDate(time.Now()),
		"exp":         jwt.NewNumericDate(time.Now().Add(time.Hour)),
		"aud":         jwt.ClaimStrings(testAudience()),
	}).SignedString([]byte(testSecret))
	if err != nil {
		t.Fatalf("signing token: %v", err)
	}

	if _, err := callRPC[shortsv1alpha1.GetSyncStatusRequest, shortsv1alpha1.GetSyncStatusResponse](t, srv,
		getSyncStatusProcedure, &shortsv1alpha1.GetSyncStatusRequest{}, nil, token); err != nil {
		t.Fatalf("GetSyncStatus: %v", err)
	}
	if seen == nil || seen.AuthMethod != AuthMethodToken {
		t.Fatalf("AuthMethod = %+v, want %q", seen, AuthMethodToken)
	}
}

func TestTierIsMarkedResolvedOnlyWhenTheLookupSucceeds(t *testing.T) {
	const mintProcedure = "/shorts.v1alpha1.BillingService/MintToken"
	token := bespokeToken(t, Claims{
		UserID: "uid-lapsed",
		Email:  "lapsed@example.com",
		Roles:  []string{"api-user"},
		// The tier an old token carries, from before the subscription lapsed.
		Tier: "pro",
	})

	capture := func(seen **Claims) func(context.Context, *connect.Request[shortsv1alpha1.MintTokenRequest]) (*connect.Response[shortsv1alpha1.MintTokenResponse], error) {
		return func(ctx context.Context, _ *connect.Request[shortsv1alpha1.MintTokenRequest]) (*connect.Response[shortsv1alpha1.MintTokenResponse], error) {
			claims, _ := UserFromContext(ctx)
			*seen = claims
			return connect.NewResponse(&shortsv1alpha1.MintTokenResponse{}), nil
		}
	}

	t.Run("a failed lookup is not resolved, and keeps the embedded tier for rate limiting", func(t *testing.T) {
		var seen *Claims
		srv := serveRPC(t, mintProcedure, AuthInterceptorOptions{
			SubscriptionLookup: func(string) (string, error) { return "", errStoreDown },
		}, capture(&seen))

		if _, err := callRPC[shortsv1alpha1.MintTokenRequest, shortsv1alpha1.MintTokenResponse](t, srv,
			mintProcedure, &shortsv1alpha1.MintTokenRequest{}, nil, token); err != nil {
			t.Fatalf("MintToken: %v", err)
		}
		if seen == nil || seen.TierResolved {
			t.Fatalf("TierResolved = %v after a failed lookup, want false", seen != nil && seen.TierResolved)
		}
		if seen.Tier != "pro" {
			t.Fatalf("Tier = %q, want the embedded tier kept for rate limiting", seen.Tier)
		}
	})

	t.Run("a successful lookup is resolved", func(t *testing.T) {
		var seen *Claims
		srv := serveRPC(t, mintProcedure, AuthInterceptorOptions{
			SubscriptionLookup: func(string) (string, error) { return "free", nil },
		}, capture(&seen))

		if _, err := callRPC[shortsv1alpha1.MintTokenRequest, shortsv1alpha1.MintTokenResponse](t, srv,
			mintProcedure, &shortsv1alpha1.MintTokenRequest{}, nil, token); err != nil {
			t.Fatalf("MintToken: %v", err)
		}
		if seen == nil || !seen.TierResolved || seen.Tier != "free" {
			t.Fatalf("claims %+v, want TierResolved with tier free", seen)
		}
	})
}
