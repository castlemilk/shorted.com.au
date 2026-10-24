package mcp

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/ratelimit"
)

// Finding 2: the invalid-token challenge names the read scopes, so a client that
// re-authorises after an invalid token asks for them and not for alerts:write.
func TestInvalidTokenChallengeNamesTheReadScopes(t *testing.T) {
	// A token the verifier refuses: the bearer middleware answers 401 with a challenge that has
	// resource_metadata but no scope.
	srv := publicStack(t, stubClaims{err: errors.New("signature mismatch")}, &recordingAlerts{}, true)
	resp, _ := rpcCall(t, srv, "garbage", listToolsBody)
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	ch := resp.Header.Get("WWW-Authenticate")
	assert.Contains(t, ch, `resource_metadata="`)
	assert.Contains(t, ch, `scope="shorts:read housing:read economy:read politics:read"`)
	assert.NotContains(t, ch, "alerts:write", "the invalid-token challenge must not name the write scope")
}

// The wrapper adds scope= only where it is missing, and never touches a successful response.
func TestChallengeScopeWrapperChangesOnlyTheChallenge(t *testing.T) {
	cases := map[string]struct {
		status int
		header string
		want   string
	}{
		"401 without scope gets it":      {http.StatusUnauthorized, `Bearer resource_metadata="u"`, `Bearer resource_metadata="u", scope="shorts:read housing:read economy:read politics:read"`},
		"403 without scope gets it":      {http.StatusForbidden, `Bearer resource_metadata="u"`, `Bearer resource_metadata="u", scope="shorts:read housing:read economy:read politics:read"`},
		"401 with a scope is left alone": {http.StatusUnauthorized, `Bearer resource_metadata="u", scope="alerts:write"`, `Bearer resource_metadata="u", scope="alerts:write"`},
		"401 without resource_metadata":  {http.StatusUnauthorized, `Bearer error="x"`, `Bearer error="x"`},
		"200 is never touched":           {http.StatusOK, `Bearer resource_metadata="u"`, `Bearer resource_metadata="u"`},
	}
	for name, c := range cases {
		h := WithChallengeScope(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("WWW-Authenticate", c.header)
			w.WriteHeader(c.status)
		}))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/mcp", nil))
		assert.Equal(t, c.status, rec.Code, name)
		assert.Equal(t, c.want, rec.Header().Get("WWW-Authenticate"), name)
	}
}

// Finding 2: the quota-ceiling challenge (an anonymous caller at its limit) names the read
// scopes too, so a spec client that re-authorises after a quota refusal does not ask for the
// write scope. The caller spends its one allowed call, then the next is refused.
func TestQuotaChallengeNamesTheReadScopes(t *testing.T) {
	// A limiter with a two-call anonymous allowance, so the third call is the quota refusal.
	srv := quotaStack(t, 2)
	for i := 0; i < 2; i++ {
		resp, body := rpcCall(t, srv, "", toolCallBody(i+1, "list_top_shorts", `{"limit":1}`))
		require.Equal(t, http.StatusOK, resp.StatusCode, body)
	}
	resp, body := rpcCall(t, srv, "", toolCallBody(3, "list_top_shorts", `{"limit":1}`))
	// The refusal must be the QUOTA challenge: the body names the per-minute kind. An unrelated 401
	// would fail here instead of passing.
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode, body)
	require.Contains(t, body, `"kind":"per_minute"`, "the 401 must be the quota refusal, not another challenge")
	ch := resp.Header.Get("WWW-Authenticate")
	assert.Contains(t, ch, `error="insufficient_quota"`)
	assert.Contains(t, ch, `scope="shorts:read housing:read economy:read politics:read"`)
	assert.NotContains(t, ch, "alerts:write")
}

// quotaStack is the production composition with an anonymous per-minute allowance of perMinute.
func quotaStack(t *testing.T, perMinute int) *httptest.Server {
	t.Helper()
	cfg := ratelimit.DefaultConfig()
	cfg.Enabled = true
	anon := cfg.Tiers["anonymous"]
	anon.RequestsPerMinute = perMinute
	cfg.Tiers["anonymous"] = anon
	limiter := ratelimit.NewAppLimiter(cfg, memUsageStore{})
	t.Cleanup(func() { _ = limiter.Close() })
	h := HandlerWithAlerts(&fakeDataSource{}, &recordingAlerts{}, ProtectedResourceMetadataURL(conformanceOrigin))
	limited := ratelimit.NewHTTPMiddleware(limiter, cfg, RateLimitIdentity(nil),
		ratelimit.WithCost(RateLimitCost),
		ratelimit.WithRejection(RateLimitRejection(ProtectedResourceMetadataURL(conformanceOrigin))),
	)(h)
	srv := httptest.NewServer(WithChallengeScope(BatchGuard(limited)))
	t.Cleanup(srv.Close)
	return srv
}

// The quota challenge names the read scopes on its own, not only through WithChallengeScope.
// The builder is called directly, so a missing scope= in rejectRateLimited is caught here
// rather than papered over by the wrapper.
func TestQuotaChallengeBuilderNamesTheReadScopes(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	RateLimitRejection(ProtectedResourceMetadataURL(conformanceOrigin))(rec, req, &ratelimit.Result{}, ratelimit.RateLimitDetail{Kind: "per_minute", Message: "x"})
	ch := rec.Header().Get("WWW-Authenticate")
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Contains(t, ch, `scope="shorts:read housing:read economy:read politics:read"`)
	assert.NotContains(t, ch, "alerts:write")
}
