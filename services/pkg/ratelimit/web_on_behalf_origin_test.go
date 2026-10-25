package ratelimit

import (
	"context"
	"errors"
	"testing"

	"connectrpc.com/connect"
)

// recordingLimiter records the access class each request was checked as.
type recordingLimiter struct {
	browser []bool
}

func (r *recordingLimiter) Check(_ context.Context, _ string, _ string, isBrowser bool) (*Result, error) {
	r.browser = append(r.browser, isBrowser)
	return &Result{Allowed: true}, nil
}

func (r *recordingLimiter) Close() error { return nil }

// webClaims is a signed-in user's claims that the website made with the internal
// secret. It is browser access, and it carries no Origin, because the website calls
// this API server to server.
type webClaims struct{ tier string }

func (c webClaims) GetUserID() string      { return "uid-premium" }
func (c webClaims) GetTier() string        { return c.tier }
func (c webClaims) GetIsBrowserAuth() bool { return true }
func (c webClaims) GetWebOnBehalf() bool   { return true }

// plainClaims is a bearer-token caller: API access, no web marker.
type plainClaims struct{ tier string }

func (c plainClaims) GetUserID() string      { return "uid-premium" }
func (c plainClaims) GetTier() string        { return c.tier }
func (c plainClaims) GetIsBrowserAuth() bool { return false }

// testClaimsKey is the unexported context key for the claims under test. A typed key
// keeps it from colliding with any other package's context values.
type testClaimsKey struct{}

// checkWithClaims runs one request through the limiter with the given claims and
// headers, and returns the access class the limiter was given.
func checkWithClaims(t *testing.T, claims any, headers map[string]string) bool {
	t.Helper()
	limiter := &recordingLimiter{}
	cfg := DefaultConfig()
	cfg.Enabled = true
	interceptor := NewRateLimitInterceptor(limiter, cfg, testClaimsKey{})
	next := func(context.Context, connect.AnyRequest) (connect.AnyResponse, error) {
		return nil, errors.New("handler reached") // the limiter's verdict is what is tested
	}
	ctx := context.WithValue(context.Background(), testClaimsKey{}, claims)
	req := connect.NewRequest(&struct{}{})
	for k, v := range headers {
		req.Header().Set(k, v)
	}
	_, _ = interceptor(next)(ctx, req)
	if len(limiter.browser) != 1 {
		t.Fatalf("limiter checked %d times, want 1", len(limiter.browser))
	}
	return limiter.browser[0]
}

// The website's own call for a signed-in user has no Origin, and its user-agent is the
// SSR marker, not a browser's. It must still be metered as browser access. The Origin
// check would otherwise downgrade it to the API column.
func TestWebsiteCallWithoutOriginIsStillBrowserAccess(t *testing.T) {
	got := checkWithClaims(t, webClaims{tier: "premium"}, map[string]string{
		"User-Agent": "shorted-web-ssr/1.0 (+https://shorted.com.au)",
	})
	if !got {
		t.Fatal("a website call for a signed-in customer was downgraded to API access")
	}
}

// A bearer-token caller with no Origin and no browser claim is API access, as before.
func TestBearerTokenCallWithoutOriginStaysAPIAccess(t *testing.T) {
	got := checkWithClaims(t, plainClaims{tier: "premium"}, map[string]string{
		"User-Agent": "curl/8.0",
	})
	if got {
		t.Fatal("a bearer-token call was metered as browser access")
	}
}

// browserClaims is a Firebase browser login with no web-on-behalf marker: the claims
// alone say browser, and nothing says the website made the call.
type browserClaims struct{ tier string }

func (c browserClaims) GetUserID() string      { return "uid-premium" }
func (c browserClaims) GetTier() string        { return c.tier }
func (c browserClaims) GetIsBrowserAuth() bool { return true }

// Only the claims decide whether a call bypasses the Origin check. A user-agent that
// carries the SSR marker, with no Origin, on a Firebase browser claim that is not a
// web-on-behalf call, is a caller with a copied marker. It is downgraded to API access.
func TestBrowserClaimWithSSRUserAgentAndNoOriginIsDowngraded(t *testing.T) {
	got := checkWithClaims(t, browserClaims{tier: "premium"}, map[string]string{
		"User-Agent": "shorted-web-ssr/1.0 (+https://shorted.com.au)",
	})
	if got {
		t.Fatal("a browser claim with the SSR marker and no Origin kept browser access; only the claims flag may bypass the Origin check")
	}
}
