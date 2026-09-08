package shorts

import (
	"context"
	"testing"
	"time"
)

// Anonymous is the default and the case that matters: every unauthenticated
// caller of these PUBLIC rpcs must be refused the internal series.
func TestAnonymousCallerCannotSeeInternalSeries(t *testing.T) {
	if callerMaySeeInternalSeries(context.Background()) {
		t.Fatal("a context with no claims granted access to internal-only series")
	}
}

func TestAdminRoleSeesInternalSeries(t *testing.T) {
	// The browser/session path: middleware_connect.go promotes the operator
	// emails (ben.ebsworth@gmail.com among them) to the admin role, and that is
	// the identity the site itself carries.
	ctx := context.WithValue(context.Background(), userKey,
		&Claims{UserID: "u1", Email: "ben.ebsworth@gmail.com", Roles: []string{"admin"}})
	if !callerMaySeeInternalSeries(ctx) {
		t.Fatal("an admin was refused the internal series")
	}
}

func TestAnAuthenticatedNonAdminCannotSeeInternalSeries(t *testing.T) {
	// A signed-in customer is still the public. Nothing about having an account
	// confers a licence to redistribute CBOE's index.
	ctx := context.WithValue(context.Background(), userKey,
		&Claims{UserID: "u2", Email: "someone@example.com", Roles: []string{"user"}})
	if callerMaySeeInternalSeries(ctx) {
		t.Fatal("an ordinary signed-in user was granted internal series")
	}
}

// The enterprise TIER must not be the gate. The internal grant resolves to
// `enterprise` by default, so a check for tier == enterprise would hand
// licence-restricted data to every paying enterprise customer — the exact
// mistake this function's comment warns about.
func TestPayingEnterpriseTierIsNotEnough(t *testing.T) {
	ctx := context.WithValue(context.Background(), userKey,
		&Claims{UserID: "paying-customer", Tier: "enterprise", Roles: []string{"user"}})
	if callerMaySeeInternalSeries(ctx) {
		t.Fatal("an enterprise SUBSCRIBER was granted internal series; the gate must be the operator allowlist, not the tier")
	}
}

func TestInternalTierAllowlistSeesInternalSeries(t *testing.T) {
	// The OAuth/API path: an access token carries neither roles nor email, so
	// the user-id allowlist is the only identifier available.
	t.Setenv(InternalTierUsersEnv, "operator-1")
	ctx := context.WithValue(context.Background(), userKey, &Claims{UserID: "operator-1"})
	if !callerMaySeeInternalSeries(ctx) {
		t.Fatal("an allowlisted operator id was refused")
	}

	other := context.WithValue(context.Background(), userKey, &Claims{UserID: "operator-2"})
	if callerMaySeeInternalSeries(other) {
		t.Fatal("a non-allowlisted id was granted")
	}
}

// THE CACHE IS THE LEAK PATH. These rpcs are cached by request parameters; if
// the flag is not a key dimension, the first operator request populates the
// cache with internal series and every anonymous caller is then served it from
// memory while the SQL gate still passes on every subsequent query.
func TestInternalFlagIsACacheKeyDimension(t *testing.T) {
	c := NewMemoryCache(time.Minute)

	if pub, priv := c.ListEconomicSeriesKey("cpi", "", "", "", "", 10, false),
		c.ListEconomicSeriesKey("cpi", "", "", "", "", 10, true); pub == priv {
		t.Error("ListEconomicSeriesKey ignores includeInternal — an operator response would be served to anonymous callers")
	}
	if pub, priv := c.GetEconomicSeriesKey([]string{"a"}, "2020-01-01", 10, false),
		c.GetEconomicSeriesKey([]string{"a"}, "2020-01-01", 10, true); pub == priv {
		t.Error("GetEconomicSeriesKey ignores includeInternal")
	}
	if pub, priv := c.ListSeriesCorrelationsKey("markets.x.aus", 24, 0.4, 10, false),
		c.ListSeriesCorrelationsKey("markets.x.aus", 24, 0.4, 10, true); pub == priv {
		t.Error("ListSeriesCorrelationsKey ignores includeInternal")
	}
}
