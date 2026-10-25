package shorts

import (
	"context"
	"testing"

	"connectrpc.com/connect"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/ratelimit"
)

// These pin how a signed-in Premium customer's own website use is metered, and how
// their API tokens still are. The website's server-side calls for a user (the
// internal secret plus the SSR user-agent marker) are browser access: paid browser
// access is unlimited. A Premium API token stays on the API column, 60/min and
// 1,000/month as published.

const billingGetMySubscriptionProcedure = "/shorts.v1alpha1.BillingService/GetMySubscription"

const premiumWebSSRUserAgent = "shorted-web-ssr/1.0 (+https://shorted.com.au)"

// websiteCallClaims makes a website call for uid-premium with the given user agent
// and returns the claims the interceptor built.
func websiteCallClaims(t *testing.T, userAgent string) *Claims {
	t.Helper()
	t.Setenv("INTERNAL_SERVICE_SECRET", "test-internal-secret")
	var seen *Claims
	srv := adminRPC(t, AuthInterceptorOptions{
		SubscriptionLookup: func(string) (string, error) { return "premium", nil },
	}, &seen)
	_, err := callRPC[shortsv1alpha1.GetSyncStatusRequest, shortsv1alpha1.GetSyncStatusResponse](t, srv,
		getSyncStatusProcedure, &shortsv1alpha1.GetSyncStatusRequest{}, map[string]string{
			"x-internal-secret": "test-internal-secret",
			"x-user-id":         "uid-premium",
			"x-user-email":      "buyer@example.test",
			"x-user-roles":      "admin",
			"User-Agent":        userAgent,
		}, "")
	if err != nil {
		t.Fatalf("call: %v (code %v)", err, connect.CodeOf(err))
	}
	if seen == nil {
		t.Fatal("handler saw no claims")
	}
	return seen
}

// A Premium customer's website call is browser access, so it is never held to the
// API quota (60/min and 1,000/month). Browser access for a paid tier is unlimited.
func TestPremiumWebsiteCallIsMeteredAsBrowserAccessAndUnlimited(t *testing.T) {
	seen := websiteCallClaims(t, premiumWebSSRUserAgent)

	if !seen.GetIsBrowserAuth() || !seen.GetWebOnBehalf() {
		t.Fatalf("website call is not browser access: browser=%v webOnBehalf=%v",
			seen.GetIsBrowserAuth(), seen.GetWebOnBehalf())
	}
	cfg := ratelimit.DefaultConfig()
	limits := cfg.GetLimits(seen.GetTier())
	if limits.BrowserRequestsPerMinute != 0 || limits.BrowserRequestsPerMonth != 0 {
		t.Fatalf("premium browser access is capped at %d/min and %d/month; paid browser access is unlimited",
			limits.BrowserRequestsPerMinute, limits.BrowserRequestsPerMonth)
	}
}

// The paid probe holds the same internal secret but sends its own plain user-agent,
// and it measures the API column, so its calls stay API-metered.
func TestPaidProbeInternalCallStaysOnTheAPIColumn(t *testing.T) {
	seen := websiteCallClaims(t, "shorted-paid-probe/1.0")

	if seen.GetIsBrowserAuth() || seen.GetWebOnBehalf() {
		t.Fatalf("a call without the web marker was classified as website use (browser=%v webOnBehalf=%v)",
			seen.GetIsBrowserAuth(), seen.GetWebOnBehalf())
	}
	cfg := ratelimit.DefaultConfig()
	limits := cfg.GetLimits(seen.GetTier())
	if limits.RequestsPerMinute != 60 || limits.RequestsPerMonth != 1000 {
		t.Fatalf("premium API column is %d/min and %d/month, want the published 60 and 1,000",
			limits.RequestsPerMinute, limits.RequestsPerMonth)
	}
}

// A Premium API token is an API credential. Its calls are metered on the API column
// at the published Premium limits, and it is never classified as browser access.
func TestPremiumAPITokenStaysMeteredAtThePublishedAPIQuota(t *testing.T) {
	// Mint a token for a premium account, as the web's token page does.
	mint, svc, err := mintTokenFor(t, &Claims{
		UserID: "uid-premium", Email: "buyer@example.test", Roles: []string{"api-user"},
		Tier: "premium", TierResolved: true, AuthMethod: AuthMethodFirebase,
	})
	if err != nil {
		t.Fatalf("mint: %v", err)
	}

	var seen *Claims
	srv := serveRPC(t, billingGetMySubscriptionProcedure, AuthInterceptorOptions{
		TokenService:       svc,
		SubscriptionLookup: func(string) (string, error) { return "premium", nil },
	}, func(ctx context.Context, _ *connect.Request[shortsv1alpha1.GetMySubscriptionRequest]) (*connect.Response[shortsv1alpha1.GetMySubscriptionResponse], error) {
		seen, _ = UserFromContext(ctx)
		return connect.NewResponse(&shortsv1alpha1.GetMySubscriptionResponse{}), nil
	})
	_, err = callRPC[shortsv1alpha1.GetMySubscriptionRequest, shortsv1alpha1.GetMySubscriptionResponse](t, srv,
		billingGetMySubscriptionProcedure, &shortsv1alpha1.GetMySubscriptionRequest{}, nil, mint.GetToken())
	if err != nil {
		t.Fatalf("token call: %v (code %v)", err, connect.CodeOf(err))
	}
	if seen == nil {
		t.Fatal("handler saw no claims")
	}
	if seen.GetIsBrowserAuth() || seen.GetWebOnBehalf() {
		t.Fatalf("a Premium API token was classified as browser access (browser=%v webOnBehalf=%v)",
			seen.GetIsBrowserAuth(), seen.GetWebOnBehalf())
	}
	cfg := ratelimit.DefaultConfig()
	limits := cfg.GetLimits(seen.GetTier())
	if limits.RequestsPerMinute != 60 || limits.RequestsPerMonth != 1000 {
		t.Fatalf("a Premium API token is metered at %d/min and %d/month, want the published 60 and 1,000",
			limits.RequestsPerMinute, limits.RequestsPerMonth)
	}
}
