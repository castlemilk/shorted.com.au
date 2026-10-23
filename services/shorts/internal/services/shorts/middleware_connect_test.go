package shorts

import (
	"context"
	"net/http/httptest"
	"reflect"
	"testing"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

func TestRolesForFirebaseClaimsGrantsAdminOnlyToAVerifiedAllowlistedEmail(t *testing.T) {
	cases := []struct {
		name      string
		claims    map[string]interface{}
		wantAdmin bool
	}{
		{
			name:      "verified and allowlisted",
			claims:    map[string]interface{}{"email": "ben@shorted.com.au", "email_verified": true},
			wantAdmin: true,
		},
		{
			name:      "case and surrounding space are ignored",
			claims:    map[string]interface{}{"email": " Ben@Shorted.com.au ", "email_verified": true},
			wantAdmin: true,
		},
		{
			// The defect: an unverified email/password account registered under an
			// admin's address must not inherit the role.
			name:      "allowlisted but unverified",
			claims:    map[string]interface{}{"email": "ben@shorted.com.au", "email_verified": false},
			wantAdmin: false,
		},
		{
			name:      "allowlisted with no email_verified claim",
			claims:    map[string]interface{}{"email": "ben@shorted.com.au"},
			wantAdmin: false,
		},
		{
			// Only Firebase's boolean counts; a string "true" is not a verified token.
			name:      "email_verified as a string",
			claims:    map[string]interface{}{"email": "ben@shorted.com.au", "email_verified": "true"},
			wantAdmin: false,
		},
		{
			name:      "verified but not allowlisted",
			claims:    map[string]interface{}{"email": "someone@example.com", "email_verified": true},
			wantAdmin: false,
		},
		{
			name:      "no email claim at all",
			claims:    map[string]interface{}{"email_verified": true},
			wantAdmin: false,
		},
		{
			// The e2e account was removed from the allowlist: nothing automated needs
			// it to be an admin on the production API.
			name:      "e2e test account is not an admin",
			claims:    map[string]interface{}{"email": "e2e-test@shorted.com.au", "email_verified": true},
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
	roles := rolesForFirebaseClaims(map[string]interface{}{
		"roles":          []interface{}{"api-user", "reviewer"},
		"email":          "ben@shorted.com.au",
		"email_verified": false,
	})
	want := []string{"api-user", "reviewer"}
	if !reflect.DeepEqual(roles, want) {
		t.Fatalf("roles = %v, want %v", roles, want)
	}
}

// internalCallerRPC serves a role-gated RPC through the real auth interceptor, so
// the internal-secret branch is exercised exactly as it is in production. The
// handler records the claims the interceptor attached to the context.
func internalCallerRPC(t *testing.T, seen **Claims) *httptest.Server {
	t.Helper()
	handler := connect.NewUnaryHandler(
		"/shorts.v1alpha1.MarketService/GetSyncStatus",
		func(ctx context.Context, _ *connect.Request[shortsv1alpha1.GetSyncStatusRequest]) (*connect.Response[shortsv1alpha1.GetSyncStatusResponse], error) {
			claims, _ := UserFromContext(ctx)
			*seen = claims
			return connect.NewResponse(&shortsv1alpha1.GetSyncStatusResponse{}), nil
		},
		connect.WithInterceptors(NewAuthInterceptorWithOptions(AuthInterceptorOptions{
			TokenService: NewTokenService(testSecret, testAudience()...),
		})),
	)
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv
}

func callGetSyncStatus(t *testing.T, srv *httptest.Server, headers map[string]string) error {
	t.Helper()
	client := connect.NewClient[shortsv1alpha1.GetSyncStatusRequest, shortsv1alpha1.GetSyncStatusResponse](
		srv.Client(), srv.URL+"/shorts.v1alpha1.MarketService/GetSyncStatus")
	req := connect.NewRequest(&shortsv1alpha1.GetSyncStatusRequest{})
	for k, v := range headers {
		req.Header().Set(k, v)
	}
	_, err := client.CallUnary(context.Background(), req)
	return err
}

func TestInternalCallerGetsAdminOnlyFromTheAssertedRoleHeader(t *testing.T) {
	t.Setenv("INTERNAL_SERVICE_SECRET", "test-internal-secret")

	t.Run("an admin email with no roles header is not an admin", func(t *testing.T) {
		var seen *Claims
		srv := internalCallerRPC(t, &seen)
		err := callGetSyncStatus(t, srv, map[string]string{
			"x-internal-secret": "test-internal-secret",
			"x-user-id":         "uid-admin",
			"x-user-email":      "ben@shorted.com.au",
		})
		if connect.CodeOf(err) != connect.CodePermissionDenied {
			t.Fatalf("code = %v (%v), want PermissionDenied", connect.CodeOf(err), err)
		}
	})

	t.Run("the web tier's asserted admin role is honoured", func(t *testing.T) {
		var seen *Claims
		srv := internalCallerRPC(t, &seen)
		err := callGetSyncStatus(t, srv, map[string]string{
			"x-internal-secret": "test-internal-secret",
			"x-user-id":         "uid-admin",
			"x-user-email":      "ben@shorted.com.au",
			"x-user-roles":      "admin",
		})
		if err != nil {
			t.Fatalf("GetSyncStatus: %v", err)
		}
		if seen == nil || !hasRole(seen, "admin") {
			t.Fatalf("claims %+v lack the asserted admin role", seen)
		}
	})

	t.Run("without the internal secret the roles header is ignored", func(t *testing.T) {
		var seen *Claims
		srv := internalCallerRPC(t, &seen)
		err := callGetSyncStatus(t, srv, map[string]string{
			"x-internal-secret": "wrong-secret",
			"x-user-id":         "uid-admin",
			"x-user-email":      "ben@shorted.com.au",
			"x-user-roles":      "admin",
		})
		if connect.CodeOf(err) != connect.CodeUnauthenticated {
			t.Fatalf("code = %v (%v), want Unauthenticated", connect.CodeOf(err), err)
		}
	})
}
