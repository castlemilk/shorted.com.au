// Package subscription holds the two entitlement rules every Go reader shares: the
// past-due grace and the tiers that carry premium features. The shorts API and the
// alerts job both import it, so the grace constant and the tier rule each live in
// one place. The web copies are web/src/lib/subscription-entitlement.ts and
// web/src/@/lib/chat-server-guards.ts (isPremiumTier in web/src/lib/stripe.ts).
package subscription

import "time"

// PastDueGrace is how long a past_due subscription keeps its paid access after its
// first failed charge, while Stripe retries the card. The anchor is the failure
// time (past_due_since), not the period end, because Stripe moves the period
// forward at every renewal it fails. Keep PAST_DUE_GRACE_MS in web in step.
const PastDueGrace = 14 * 24 * time.Hour

// PremiumFeatureTier reports whether tier carries the premium web features: AI chat,
// alerts and the dashboards. API Access is a paid API tier and is not one of them.
// This matches the web's isPremiumTier.
func PremiumFeatureTier(tier string) bool {
	switch tier {
	case "premium", "pro", "enterprise":
		return true
	}
	return false
}

// APITokenTier reports whether tier may mint API tokens. Premium is sold without API
// access, so it is not one of them; API Access and enterprise are.
func APITokenTier(tier string) bool {
	switch tier {
	case "api_access", "enterprise":
		return true
	}
	return false
}

// PastDueInGrace reports whether a past_due subscription whose first failed charge
// was at pastDueSince is still inside the grace at now. An unknown (zero) failure
// time grants no grace, because the window cannot be bounded.
func PastDueInGrace(pastDueSince, now time.Time) bool {
	if pastDueSince.IsZero() {
		return false
	}
	return now.Before(pastDueSince.Add(PastDueGrace))
}
