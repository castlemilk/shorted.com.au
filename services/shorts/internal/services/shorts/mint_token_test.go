package shorts

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	"go.uber.org/mock/gomock"
)

// mintTokenFor runs MintToken as the interceptor would leave the caller: claims
// already carry the roles and tier the interceptor resolved. The store is nil on
// purpose: MintToken must not read it, and a read would panic the test.
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

func TestMintTokenIssuesAdminOnlyToAnAdminRole(t *testing.T) {
	cases := []struct {
		name      string
		claims    *Claims
		wantErr   connect.Code // zero when the mint should succeed
		wantAdmin bool
		wantTier  string
	}{
		{
			name:      "admin role on a free account mints as pro with admin",
			claims:    &Claims{UserID: "uid-admin", Email: "ben@shorted.com.au", Roles: []string{"api-user", "admin"}, Tier: "free"},
			wantAdmin: true,
			wantTier:  "pro",
		},
		{
			name:      "admin role with an unresolved tier mints as pro",
			claims:    &Claims{UserID: "uid-admin", Email: "ben@shorted.com.au", Roles: []string{"api-user", "admin"}, Tier: ""},
			wantAdmin: true,
			wantTier:  "pro",
		},
		{
			name:    "free account without the admin role is refused",
			claims:  &Claims{UserID: "uid-free", Email: "free@example.com", Roles: []string{"api-user"}, Tier: "free"},
			wantErr: connect.CodePermissionDenied,
		},
		{
			// The address alone grants nothing: the role is what MintToken reads.
			name:    "admin email without the admin role is refused",
			claims:  &Claims{UserID: "uid-admin", Email: "ben@shorted.com.au", Roles: []string{"api-user"}, Tier: "free"},
			wantErr: connect.CodePermissionDenied,
		},
		{
			// An empty tier means the subscription lookup failed. It is not paid.
			name:    "unresolved tier without the admin role is refused",
			claims:  &Claims{UserID: "uid-x", Email: "x@example.com", Roles: []string{"api-user"}, Tier: ""},
			wantErr: connect.CodePermissionDenied,
		},
		{
			name:     "paid tier mints without the admin role",
			claims:   &Claims{UserID: "uid-paid", Email: "paid@example.com", Roles: []string{"api-user"}, Tier: "pro"},
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
