package alerts

import (
	"context"
	"strings"
	"testing"
)

// TestEntitlementLookupsCarryTheExemptAlertsMarker pins the job's user agent on the
// real lookup path. The shorts API skips the owner's per-user rate limit only for a
// User-Agent with the prefix "shorted-alerts/" (alertsJobUserAgentPrefix, which the
// API compares by strings.HasPrefix). Without the exemption an owner at their monthly
// quota fails the lookup, and the whole run exits with nothing committed.
func TestEntitlementLookupsCarryTheExemptAlertsMarker(t *testing.T) {
	billing := newStubBilling()
	billing.setStatus("u1", "SUBSCRIPTION_STATUS_ACTIVE")
	a := &alertRun{env: settings{shortsAPIURL: startShortsAPI(t, billing, ""), internalSecret: stubSecret}}

	ents, err := a.entitlements(context.Background(), []Candidate{
		{Monitor: Monitor{UserID: "u1", Email: "a@example.com"}},
	})
	if err != nil {
		t.Fatalf("entitlements: %v", err)
	}
	if !ents["u1"].Entitled {
		t.Fatalf("an active premium owner must be entitled: %+v", ents["u1"])
	}
	if ua := billing.userAgent(); !strings.HasPrefix(ua, "shorted-alerts/") {
		t.Fatalf("lookup User-Agent = %q: the API exempts only the shorted-alerts/ prefix, so the lookup would be metered", ua)
	}
}
