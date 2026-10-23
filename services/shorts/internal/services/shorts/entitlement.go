package shorts

import (
	"time"

	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// Entitlement is the answer to "is this user entitled to paid features?".
//
// WHY ONE RULE. The auth interceptor's tier lookup (also used by the MCP and OAuth
// resolvers), the subscription RPC, alerts and the web chat guard each decided
// this from their own rule. They disagreed: a user could hold paid API limits with
// no paid UI, or keep paid limits after their period had ended. Everything on the
// Go side that asks now goes through ResolveEntitlement.
type Entitlement struct {
	Entitled bool
	Tier     string // effective tier: the paid tier when entitled, "free" otherwise
	Reason   string // machine-readable: internal_grant | active | no_subscription | status_<status> | unpaid_tier | period_ended
	Source   string // "internal" | "stripe" | "none"
}

// paidTiers are the tiers that carry paid features. A row on any other tier is
// not a paid entitlement, whatever its status reads.
var paidTiers = map[string]struct{}{
	"premium":    {},
	"pro":        {},
	"enterprise": {},
	"api_access": {},
}

// periodEndGrace is how long past current_period_end a row still counts as entitled.
//
// Stripe moves the period forward at renewal, and the webhook carrying the new
// period can arrive late. Without a grace, every paying user would lose paid access
// at each renewal boundary until that webhook landed. A renewal webhook that never
// lands is healed by the daily reconcile, so the grace only has to cover ordinary
// delivery delay.
const periodEndGrace = 24 * time.Hour

// ResolveEntitlement decides a user's entitlement from their internal grant and
// their store row (sub is nil when there is none).
//
// The grant is checked first and wins even over a canceled row, so an operator's
// grant does not depend on what Stripe last said about the account.
func ResolveEntitlement(userID string, sub *shortsstore.APISubscription, now time.Time) Entitlement {
	if tier, ok := InternalTierFor(userID); ok {
		return Entitlement{Entitled: true, Tier: tier, Reason: "internal_grant", Source: "internal"}
	}
	if sub == nil {
		return Entitlement{Tier: "free", Reason: "no_subscription", Source: "none"}
	}
	if sub.Status != "active" && sub.Status != "trialing" {
		return Entitlement{Tier: "free", Reason: "status_" + sub.Status, Source: "stripe"}
	}
	if _, ok := paidTiers[sub.Tier]; !ok {
		return Entitlement{Tier: "free", Reason: "unpaid_tier", Source: "stripe"}
	}
	// An unparseable period end is unknown, not expired. Revoking a paying user
	// because a timestamp failed to parse would turn a formatting change into an
	// outage, and the status and the webhook remain the authority in that case.
	if sub.CurrentPeriodEnd != nil {
		if end, ok := parseStoreTimestamp(*sub.CurrentPeriodEnd); ok && end.Before(now.Add(-periodEndGrace)) {
			return Entitlement{Tier: "free", Reason: "period_ended", Source: "stripe"}
		}
	}
	return Entitlement{Entitled: true, Tier: sub.Tier, Reason: "active", Source: "stripe"}
}

// loadEntitlement reads the user's row and resolves the entitlement from it. The
// row is returned too, because GetMySubscription reports the real Stripe fields
// and not only the verdict.
//
// The grant is checked before the store is read, so a granted user does not need
// a row and a Stripe webhook cannot clobber the grant (see InternalTierFor). A
// store error is returned, never masked by a grant: a database outage must
// surface, not quietly promote every allowlisted caller.
func (s *ShortsServer) loadEntitlement(userID string, now time.Time) (*shortsstore.APISubscription, Entitlement, error) {
	if _, ok := InternalTierFor(userID); ok {
		// ResolveEntitlement returns the grant itself. This check only keeps the
		// store out of the grant path.
		return nil, ResolveEntitlement(userID, nil, now), nil
	}
	sub, err := s.store.GetAPISubscription(userID)
	if err != nil {
		return nil, Entitlement{}, err
	}
	return sub, ResolveEntitlement(userID, sub, now), nil
}

// subscriptionTier is the SubscriptionLookup shared by the auth interceptor and
// the MCP and OAuth tier resolvers, so the rate-limit tier follows the same rule
// as the paid features. An error is returned rather than a tier, and the caller
// treats that as no tier.
func (s *ShortsServer) subscriptionTier(userID string) (string, error) {
	_, ent, err := s.loadEntitlement(userID, time.Now())
	if err != nil {
		return "", err
	}
	return ent.Tier, nil
}
