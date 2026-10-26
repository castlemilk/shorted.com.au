package ratelimit

import (
	"context"
	"testing"

	"connectrpc.com/connect"
)

// exemptClaims is a caller the auth interceptor verified, with the exemption
// decided by the test.
type exemptClaims struct{ exempt bool }

func (c exemptClaims) GetUserID() string        { return "owner-1" }
func (c exemptClaims) GetTier() string          { return "free" }
func (c exemptClaims) GetIsBrowserAuth() bool   { return false }
func (c exemptClaims) GetRateLimitExempt() bool { return c.exempt }

// An exempt platform caller (the alerts evaluator's internal lookups) is not
// metered against the owner's quota, even when the limiter would refuse it. An
// ordinary authenticated caller is still metered.
func TestExemptClaimsSkipTheLimiter(t *testing.T) {
	cases := []struct {
		name       string
		claims     any
		wantCheck  bool
		wantCalled bool
	}{
		{"exempt platform caller", exemptClaims{exempt: true}, false, true},
		{"ordinary authenticated caller", exemptClaims{exempt: false}, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			lim := &countingLimiter{allow: 0} // refuses every check
			ic := NewRateLimitInterceptor(lim, enabledConfig(), DefaultUserClaimsKey)
			called := false
			next := ic(func(context.Context, connect.AnyRequest) (connect.AnyResponse, error) {
				called = true
				return connect.NewResponse(new(string)), nil
			})
			ctx := context.WithValue(context.Background(), DefaultUserClaimsKey, tc.claims)
			_, err := next(ctx, connect.NewRequest(new(string)))

			if got := lim.checks.Load() > 0; got != tc.wantCheck {
				t.Fatalf("limiter consulted = %v, want %v", got, tc.wantCheck)
			}
			if called != tc.wantCalled {
				t.Fatalf("handler reached = %v (err %v), want %v", called, err, tc.wantCalled)
			}
		})
	}
}
