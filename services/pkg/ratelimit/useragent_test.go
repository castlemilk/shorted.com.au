package ratelimit

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type uaClaimsKey struct{}

// callWithUserAgent runs one unauthenticated unary call through the
// interceptor and reports whether it reached the handler.
func callWithUserAgent(t *testing.T, ua string) (reached bool, err error) {
	t.Helper()
	icpt := UserAgentInterceptor(uaClaimsKey{})
	next := func(context.Context, connect.AnyRequest) (connect.AnyResponse, error) {
		reached = true
		return connect.NewResponse(&struct{}{}), nil
	}
	req := connect.NewRequest(&struct{}{})
	if ua != "" {
		req.Header().Set("User-Agent", ua)
	}
	_, err = icpt(next)(context.Background(), req)
	return reached, err
}

// TestUptimeCheckerUserAgentPasses pins the User-Agent Google's uptime checkers
// send. The shorts API uptime check (terraform/modules/shorts-api/uptime.tf)
// depends on it reaching the handler; a new blocked pattern that matches it
// would fail that check on every cache miss.
func TestUptimeCheckerUserAgentPasses(t *testing.T) {
	ua := "GoogleStackdriverMonitoring-UptimeChecks(https://cloud.google.com/monitoring)"
	reached, err := callWithUserAgent(t, ua)
	require.NoError(t, err)
	assert.True(t, reached, "the uptime checker's User-Agent must pass UserAgentInterceptor")
}

func TestScriptUserAgentsAreBlockedWhenUnauthenticated(t *testing.T) {
	for _, ua := range []string{"curl/8.4.0", "Python-urllib/3.12", "Go-http-client/2.0", ""} {
		reached, err := callWithUserAgent(t, ua)
		assert.False(t, reached, "ua %q should be blocked", ua)
		require.Error(t, err)
		assert.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
	}
}

func TestBrowserUserAgentPasses(t *testing.T) {
	reached, err := callWithUserAgent(t, "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15")
	require.NoError(t, err)
	assert.True(t, reached)
}
