package shorts

import (
	"testing"

	"connectrpc.com/connect"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// The alerts evaluator's entitlement lookups are exempt from the owner's per-user
// rate limit only when the internal secret matches AND the caller is the evaluator.
// The user agent alone grants nothing: a caller without the secret never reaches
// the claims at all.
func TestInternalAlertsJobCallIsRateLimitExempt(t *testing.T) {
	t.Setenv("INTERNAL_SERVICE_SECRET", "test-internal-secret")
	cases := []struct {
		name string
		ua   string
		want bool
	}{
		{"the evaluator", "shorted-alerts/1.0", true},
		{"a look-alike agent", "shorted-alerts-impostor/1.0", false},
		{"the web tier", "shorted-web-ssr/1.0", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var seen *Claims
			srv := adminRPC(t, AuthInterceptorOptions{}, &seen)
			_, err := callRPC[shortsv1alpha1.GetSyncStatusRequest, shortsv1alpha1.GetSyncStatusResponse](t, srv,
				getSyncStatusProcedure, &shortsv1alpha1.GetSyncStatusRequest{}, map[string]string{
					"x-internal-secret": "test-internal-secret",
					"x-user-id":         "uid-owner",
					"x-user-roles":      "admin",
					"User-Agent":        tc.ua,
				}, "")
			if err != nil {
				t.Fatalf("call: %v (code %v)", err, connect.CodeOf(err))
			}
			if seen == nil {
				t.Fatal("handler saw no claims")
			}
			if got := seen.GetRateLimitExempt(); got != tc.want {
				t.Fatalf("GetRateLimitExempt() = %v, want %v", got, tc.want)
			}
		})
	}
}
