package shorts

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	"github.com/golang-jwt/jwt/v5"
	"go.uber.org/mock/gomock"
)

const mintTokenProcedure = "/shorts.v1alpha1.BillingService/MintToken"

// mintTokenFor runs MintToken as the interceptor would leave the caller: claims
// already carry the roles, tier and resolution the interceptor decided. The store is
// nil on purpose: MintToken must not read it, and a read would panic the test.
func mintTokenFor(t *testing.T, claims *Claims) (*shortsv1alpha1.MintTokenResponse, *TokenService, error) {
	t.Helper()
	ctrl := gomock.NewController(t)
	logger := mocks.NewMockLogger(ctrl)
	allowAnyLogs(logger)
	svc := NewTokenService(testSecret, testAudience()...)
	server := &ShortsServer{logger: logger, tokenService: svc}

	ctx := context.Background()
	if claims != nil {
		ctx = context.WithValue(ctx, userKey, claims)
	}
	resp, err := server.MintToken(ctx, connect.NewRequest(&shortsv1alpha1.MintTokenRequest{}))
	if err != nil {
		return nil, svc, err
	}
	return resp.Msg, svc, nil
}

func TestMintTokenIssuesAdminOnlyWhenTheCallerHoldsAdminOutsideABespokeToken(t *testing.T) {
	cases := []struct {
		name      string
		claims    *Claims
		wantErr   connect.Code // zero when the mint should succeed
		wantAdmin bool
		wantTier  string
	}{
		{
			name: "admin role from a verified Firebase login on a free account mints as pro with admin",
			claims: &Claims{UserID: "uid-admin", Email: "ben@shorted.com.au",
				Roles: []string{"api-user", "admin"}, Tier: "free", TierResolved: true, AuthMethod: AuthMethodFirebase},
			wantAdmin: true,
			wantTier:  "pro",
		},
		{
			name: "admin role asserted by the web tier mints as pro even when the lookup failed",
			claims: &Claims{UserID: "uid-admin", Email: "ben@shorted.com.au",
				Roles: []string{"api-user", "admin"}, AuthMethod: AuthMethodInternal},
			wantAdmin: true,
			wantTier:  "pro",
		},
		{
			name: "free account without the admin role is refused",
			claims: &Claims{UserID: "uid-free", Email: "free@example.com",
				Roles: []string{"api-user"}, Tier: "free", TierResolved: true, AuthMethod: AuthMethodFirebase},
			wantErr: connect.CodePermissionDenied,
		},
		{
			// The address alone grants nothing: the role is what MintToken reads.
			name: "admin email without the admin role is refused",
			claims: &Claims{UserID: "uid-admin", Email: "ben@shorted.com.au",
				Roles: []string{"api-user"}, Tier: "free", TierResolved: true, AuthMethod: AuthMethodFirebase},
			wantErr: connect.CodePermissionDenied,
		},
		{
			// An embedded tier from a failed lookup is not evidence of a subscription.
			name: "unresolved paid tier without the admin role is refused as unavailable",
			claims: &Claims{UserID: "uid-x", Email: "x@example.com",
				Roles: []string{"api-user"}, Tier: "pro", TierResolved: false, AuthMethod: AuthMethodToken},
			wantErr: connect.CodeUnavailable,
		},
		{
			name: "paid tier mints without the admin role",
			claims: &Claims{UserID: "uid-paid", Email: "paid@example.com",
				Roles: []string{"api-user"}, Tier: "pro", TierResolved: true, AuthMethod: AuthMethodToken},
			wantTier: "pro",
		},
		{
			// The renewal defect: admin carried by a bespoke token must not mint admin.
			name: "bespoke-token admin on a free account is refused",
			claims: &Claims{UserID: "uid-admin", Email: "ben@shorted.com.au",
				Roles: []string{"api-user", "admin"}, Tier: "free", TierResolved: true, AuthMethod: AuthMethodToken},
			wantErr: connect.CodePermissionDenied,
		},
		{
			name: "bespoke-token admin on a paid account mints without admin",
			claims: &Claims{UserID: "uid-admin", Email: "ben@shorted.com.au",
				Roles: []string{"api-user", "admin"}, Tier: "pro", TierResolved: true, AuthMethod: AuthMethodToken},
			wantTier: "pro",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			msg, svc, err := mintTokenFor(t, tc.claims)
			if tc.wantErr != 0 {
				if connect.CodeOf(err) != tc.wantErr {
					t.Fatalf("code = %v (%v), want %v", connect.CodeOf(err), err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("MintToken: %v", err)
			}
			claims, err := svc.ValidateToken(msg.Token)
			if err != nil {
				t.Fatalf("ValidateToken: %v", err)
			}
			if got := hasRole(claims, "admin"); got != tc.wantAdmin {
				t.Errorf("minted admin = %v, want %v (roles %v)", got, tc.wantAdmin, claims.Roles)
			}
			if claims.Tier != tc.wantTier {
				t.Errorf("minted tier = %q, want %q", claims.Tier, tc.wantTier)
			}
		})
	}
}

func TestMintTokenRefusesAnUnauthenticatedCaller(t *testing.T) {
	_, _, err := mintTokenFor(t, nil)
	if connect.CodeOf(err) != connect.CodeUnauthenticated {
		t.Fatalf("code = %v (%v), want Unauthenticated", connect.CodeOf(err), err)
	}
}

// TestMintTokenThroughTheInterceptor runs MintToken behind the real interceptor, so
// the tier resolution, the cut-over and the auth method are the ones production
// computes. The lookup decides each case's tier.
func TestMintTokenThroughTheInterceptor(t *testing.T) {
	t.Setenv("INTERNAL_SERVICE_SECRET", "test-internal-secret")
	// Tokens minted in these tests are issued now, so the cut-over sits before them.
	setAdminCutover(t, time.Now().Add(-time.Hour))

	ctrl := gomock.NewController(t)
	logger := mocks.NewMockLogger(ctrl)
	allowAnyLogs(logger)
	svc := NewTokenService(testSecret, testAudience()...)
	// The store is nil on purpose: MintToken must not read it.
	server := &ShortsServer{logger: logger, tokenService: svc}

	lookup := func(tier string, err error) SubscriptionLookup {
		return func(string) (string, error) { return tier, err }
	}
	issuedNow := jwt.NewNumericDate(time.Now())
	adminToken := bespokeToken(t, Claims{
		IssuedAt: issuedNow,
		UserID:   "uid-admin",
		Email:    "ben@shorted.com.au",
		Roles:    []string{"api-user", "admin"},
	})
	lapsedToken := bespokeToken(t, Claims{
		IssuedAt: issuedNow,
		UserID:   "uid-lapsed",
		Email:    "lapsed@example.com",
		Roles:    []string{"api-user"},
		Tier:     "pro",
	})

	cases := []struct {
		name      string
		lookup    SubscriptionLookup
		token     string
		headers   map[string]string
		wantErr   connect.Code
		wantAdmin bool
		wantTier  string
	}{
		{
			// The defect: a lapsed subscriber's old pro token mints during a store outage.
			name:    "a lapsed subscriber's old pro token is refused when the lookup fails",
			lookup:  lookup("", errStoreDown),
			token:   lapsedToken,
			wantErr: connect.CodeUnavailable,
		},
		{
			name:    "a lapsed subscriber's old pro token is refused once the lookup says free",
			lookup:  lookup("free", nil),
			token:   lapsedToken,
			wantErr: connect.CodePermissionDenied,
		},
		{
			name:     "a paying subscriber mints a non-admin token",
			lookup:   lookup("pro", nil),
			token:    lapsedToken,
			wantTier: "pro",
		},
		{
			// Admin renewal: an admin token on a free account must not mint an admin token.
			name:    "an admin token cannot renew admin on a free account",
			lookup:  lookup("free", nil),
			token:   adminToken,
			wantErr: connect.CodePermissionDenied,
		},
		{
			name:     "an admin token cannot renew admin on a paid account",
			lookup:   lookup("pro", nil),
			token:    adminToken,
			wantTier: "pro",
		},
		{
			name:      "the web tier's asserted admin mints as admin through a failed lookup",
			lookup:    lookup("", errStoreDown),
			headers:   map[string]string{"x-internal-secret": "test-internal-secret", "x-user-id": "uid-admin", "x-user-email": "ben@shorted.com.au", "x-user-roles": "admin"},
			wantAdmin: true,
			wantTier:  "pro",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := serveRPC(t, mintTokenProcedure, AuthInterceptorOptions{
				TokenService:       svc,
				SubscriptionLookup: tc.lookup,
			}, func(ctx context.Context, req *connect.Request[shortsv1alpha1.MintTokenRequest]) (*connect.Response[shortsv1alpha1.MintTokenResponse], error) {
				return server.MintToken(ctx, req)
			})

			resp, err := callRPC[shortsv1alpha1.MintTokenRequest, shortsv1alpha1.MintTokenResponse](t, srv,
				mintTokenProcedure, &shortsv1alpha1.MintTokenRequest{}, tc.headers, tc.token)
			if tc.wantErr != 0 {
				if connect.CodeOf(err) != tc.wantErr {
					t.Fatalf("code = %v (%v), want %v", connect.CodeOf(err), err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("MintToken: %v", err)
			}
			claims, err := svc.ValidateToken(resp.Msg.Token)
			if err != nil {
				t.Fatalf("ValidateToken: %v", err)
			}
			if got := hasRole(claims, "admin"); got != tc.wantAdmin {
				t.Errorf("minted admin = %v, want %v (roles %v)", got, tc.wantAdmin, claims.Roles)
			}
			if claims.Tier != tc.wantTier {
				t.Errorf("minted tier = %q, want %q", claims.Tier, tc.wantTier)
			}
		})
	}
}
