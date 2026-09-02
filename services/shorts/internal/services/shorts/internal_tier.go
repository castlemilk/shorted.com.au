package shorts

import (
	"os"
	"strings"
)

// Internal tier grants: a way to give an operator API access to their own
// service without inventing a Stripe subscription for them.
//
// WHY THIS EXISTS. Tier is resolved solely from api_subscriptions, and the only
// writers of that table are the Stripe webhook handlers. So the sole way to lift
// an internal caller above `free` was to hand-write a row with an `active`
// status and no Stripe ids behind it — a subscription that billing believes in
// and Stripe has never heard of. That row is also load-bearing and fragile: the
// next HandleStripeSubscriptionUpdated for that user overwrites it, silently
// dropping a long-running job back to 60/min partway through.
//
// The obvious alternative does not work. There is already an adminEmails list in
// middleware_connect.go, but MintAccessToken is explicit that an OAuth access
// token carries neither roles nor email — roles because "a role is an operator
// grant, not something a consent screen can confer", email because nothing
// durable between the grant and the mint carries it. An OAuth caller is a user
// id and nothing else, so a grant keyed on email or role cannot reach one. This
// is keyed on user id because that is the only identifier that is always there.
//
// Configured rather than compiled: user ids are deployment data, not source, and
// an operator should be able to grant or revoke access without a release.
const (
	// InternalTierUsersEnv is a comma-separated list of user ids.
	InternalTierUsersEnv = "INTERNAL_TIER_USER_IDS"
	// InternalTierEnv names the tier those users receive. Defaults to enterprise.
	InternalTierEnv = "INTERNAL_TIER"

	defaultInternalTier = "enterprise"
)

// internalTierUsers parses the allowlist. Empty by default: a deployment that
// sets nothing grants nothing, so this cannot widen access by being merged.
func internalTierUsers() map[string]struct{} {
	raw := strings.TrimSpace(os.Getenv(InternalTierUsersEnv))
	if raw == "" {
		return nil
	}
	out := make(map[string]struct{})
	for _, id := range strings.Split(raw, ",") {
		if id = strings.TrimSpace(id); id != "" {
			out[id] = struct{}{}
		}
	}
	return out
}

// internalTier is the tier granted to allowlisted users.
func internalTier() string {
	if t := strings.TrimSpace(os.Getenv(InternalTierEnv)); t != "" {
		return t
	}
	return defaultInternalTier
}

// InternalTierFor returns the granted tier and true when userID is allowlisted.
//
// The caller applies this BEFORE consulting the subscription store, so an
// internal grant does not depend on a row existing and cannot be clobbered by a
// Stripe webhook. It is deliberately not a fallback after a failed lookup: a
// store error must still surface as an error rather than being masked by a
// grant, or a database outage would quietly promote every allowlisted caller
// and hide the outage.
func InternalTierFor(userID string) (string, bool) {
	if userID == "" {
		return "", false
	}
	if _, ok := internalTierUsers()[userID]; !ok {
		return "", false
	}
	return internalTier(), true
}
