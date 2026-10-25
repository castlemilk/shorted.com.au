package shorts

import (
	"strings"
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
	Reason   string // machine-readable: internal_grant | internal_grant_unpaid_tier | active | past_due_grace | past_due_grace_ended | no_subscription | status_<status> | unpaid_tier | period_ended
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
// period can arrive late. Stripe redelivers a webhook it could not deliver for
// about three days, so a shorter grace would revoke paying customers during an
// ordinary one-to-three-day outage of our endpoint, before Stripe had the chance
// to redeliver. Anything lost beyond that window is healed by the daily Stripe
// reconcile.
const periodEndGrace = 72 * time.Hour

// pastDueGrace is how long a past_due row keeps its paid access while Stripe retries
// the failed card. The anchor is the row's current_period_end, the one date the row
// reliably holds: the failed invoice's own date is not stored. Stripe moves a
// subscription to unpaid or canceled when retries run out, and the status check
// ends the grace then, whichever comes first.
const pastDueGrace = 14 * 24 * time.Hour

// ResolveEntitlement decides a user's entitlement from their internal grant and
// their store row (sub is nil when there is none).
//
// A grant is checked first and wins even over a canceled row, so an operator's
// grant does not depend on what Stripe last said about the account. A grant on an
// unpaid tier (INTERNAL_TIER=free) is an explicit tier decision and stands over a
// paid row too. It is not entitlement: the paid features stay off, and the tier
// still sets the rate-limit tier.
func ResolveEntitlement(userID string, sub *shortsstore.APISubscription, now time.Time) Entitlement {
	if granted, ok := InternalTierFor(userID); ok {
		tier := normaliseRowValue(granted)
		if _, paid := paidTiers[tier]; !paid {
			return Entitlement{Tier: tier, Reason: "internal_grant_unpaid_tier", Source: "internal"}
		}
		return Entitlement{Entitled: true, Tier: tier, Reason: "internal_grant", Source: "internal"}
	}
	if sub == nil {
		return Entitlement{Tier: "free", Reason: "no_subscription", Source: "none"}
	}
	status := normaliseRowValue(sub.Status)
	if status != "active" && status != "trialing" && status != "past_due" {
		return Entitlement{Tier: "free", Reason: "status_" + status, Source: "stripe"}
	}
	tier := normaliseRowValue(sub.Tier)
	if _, ok := paidTiers[tier]; !ok {
		return Entitlement{Tier: "free", Reason: "unpaid_tier", Source: "stripe"}
	}
	if status == "past_due" {
		return pastDueEntitlement(tier, sub, now)
	}
	// An unparseable period end is unknown, not expired. Revoking a paying user
	// because a timestamp failed to parse would turn a formatting change into an
	// outage, and the status and the webhook remain the authority in that case.
	if sub.CurrentPeriodEnd != nil {
		if end, ok := parseStoreTimestamp(*sub.CurrentPeriodEnd); ok && end.Before(now.Add(-periodEndGrace)) {
			return Entitlement{Tier: "free", Reason: "period_ended", Source: "stripe"}
		}
	}
	return Entitlement{Entitled: true, Tier: tier, Reason: "active", Source: "stripe"}
}

// pastDueEntitlement is the grace rule for a past_due row. It needs a readable period
// end to anchor the grace; without one the grace cannot be bounded, so the row grants
// nothing rather than an open-ended grace.
func pastDueEntitlement(tier string, sub *shortsstore.APISubscription, now time.Time) Entitlement {
	if sub.CurrentPeriodEnd == nil {
		return Entitlement{Tier: "free", Reason: "status_past_due", Source: "stripe"}
	}
	end, ok := parseStoreTimestamp(*sub.CurrentPeriodEnd)
	if !ok {
		return Entitlement{Tier: "free", Reason: "status_past_due", Source: "stripe"}
	}
	if now.Before(end.Add(pastDueGrace)) {
		return Entitlement{Entitled: true, Tier: tier, Reason: "past_due_grace", Source: "stripe"}
	}
	return Entitlement{Tier: "free", Reason: "past_due_grace_ended", Source: "stripe"}
}

// normaliseRowValue folds the case and padding out of a status or tier. The
// store's own writers produce lowercase values, but rows written by hand have
// carried "Premium" or " active ", and the alerts gate that this replaced
// lower-cased its tier, so the rule does the same.
func normaliseRowValue(v string) string {
	return strings.ToLower(strings.TrimSpace(v))
}

// loadEntitlement resolves the entitlement, and reads the store only when no grant
// decides it. It returns the row it read, or nil for a grant.
//
// A grant is decided before the store is read, so the entitlement never depends on
// the database and a Stripe webhook cannot clobber it (see InternalTierFor). A
// store error is returned, never masked by a grant: a database outage must
// surface, not quietly promote every allowlisted caller.
func (s *ShortsServer) loadEntitlement(userID string, now time.Time) (*shortsstore.APISubscription, Entitlement, error) {
	if _, ok := InternalTierFor(userID); ok {
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
