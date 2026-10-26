package alerts

import (
	"context"
	"net/http"
	"strings"
	"time"

	"connectrpc.com/connect"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsv1alpha1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
	"github.com/castlemilk/shorted.com.au/services/pkg/subscription"
)

// Entitlement is decided by the shorts API, which owns the rule (ResolveEntitlement:
// internal grants, then the Stripe row, then the period grace). The job asks it
// rather than re-implementing the rule, so the email gate and the paid features
// cannot disagree. The contract is pinned by
// services/shorts/internal/services/shorts/subscriptions_entitlement_contract_test.go,
// which reads this file's mapping in its comment.
//
// Side effects, both deliberate: each call is metered against that user's API
// quota, and the job holds INTERNAL_SERVICE_SECRET, which opens the same
// internal-auth path that the namespace's DATABASE_URL already gives it access to.

// entitlement is the API's answer for one user.
type entitlement struct {
	Entitled bool
	// Status is the subscription status as the API reports it (ACTIVE, CANCELED,
	// ...), or "NONE" when the user has no subscription record.
	Status string
}

// entitlementOf maps a GetMySubscription response to the alerts entitlement. Alerts
// are a premium web feature, so the rule is the API's premium-feature rule, applied
// to the same fields the API returns:
//
//   - ACTIVE or TRIALING on a premium-feature tier (premium, pro, enterprise).
//   - PAST_DUE on a premium-feature tier, while inside the grace from the first failed
//     charge (past_due_since). A past_due row with no failure time has no grace.
//
// API Access and FREE rows never get alerts, whatever their status: they are paid API
// access, not premium features. The grace length and the premium tiers come from
// services/pkg/subscription, the same package the API uses.
func entitlementOf(msg *shortsv1alpha1.GetMySubscriptionResponse) entitlement {
	status := "NONE"
	if msg.GetHasSubscription() {
		status = strings.TrimPrefix(msg.GetStatus().String(), "SUBSCRIPTION_STATUS_")
	}
	premium := subscription.PremiumFeatureTier(protoTierName(msg.GetTier()))
	switch msg.GetStatus() {
	case shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_ACTIVE,
		shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_TRIALING:
		return entitlement{Entitled: premium, Status: status}
	case shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_PAST_DUE:
		since := time.Time{}
		if ts := msg.GetPastDueSince(); ts != nil {
			since = ts.AsTime()
		}
		return entitlement{Entitled: premium && subscription.PastDueInGrace(since, time.Now()), Status: status}
	}
	return entitlement{Entitled: false, Status: status}
}

// protoTierName is the tier name the API stores and the rate-limit and feature rules
// key on, for a proto tier. An unknown or unspecified tier has no name, so it is not
// a premium tier.
func protoTierName(t shortsv1alpha1.SubscriptionTier) string {
	switch t {
	case shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_PREMIUM:
		return "premium"
	case shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_PRO:
		return "pro"
	case shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_ENTERPRISE:
		return "enterprise"
	case shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_API_ACCESS:
		return "api_access"
	case shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_FREE:
		return "free"
	}
	return ""
}

// entitlementChecker is a per-run cache over the billing client.
type entitlementChecker struct {
	client    shortsv1alpha1connect.BillingServiceClient
	secret    string
	cache     map[string]entitlement
	retryWait time.Duration
}

// newEntitlementChecker builds a client over the Cloud Run origin, not the public
// hostname. A lookup through Cloudflare would land in the anonymous per-IP bucket.
func newEntitlementChecker(origin, secret string) *entitlementChecker {
	return &entitlementChecker{
		client: shortsv1alpha1connect.NewBillingServiceClient(
			&http.Client{Timeout: 10 * time.Second},
			strings.TrimRight(origin, "/"),
		),
		secret:    secret,
		cache:     map[string]entitlement{},
		retryWait: 2 * time.Second,
	}
}

// check returns the user's entitlement. A lookup is retried once when the API is
// unavailable or times out, and any other error is returned to the caller.
//
// The headers are set on each request rather than by an interceptor, because
// x-user-id changes with every call.
func (c *entitlementChecker) check(ctx context.Context, userID string) (entitlement, error) {
	if e, ok := c.cache[userID]; ok {
		return e, nil
	}
	var (
		resp *connect.Response[shortsv1alpha1.GetMySubscriptionResponse]
		err  error
	)
	for attempt := range 2 {
		req := connect.NewRequest(&shortsv1alpha1.GetMySubscriptionRequest{})
		req.Header().Set("x-internal-secret", c.secret)
		req.Header().Set("x-user-id", userID)
		req.Header().Set("User-Agent", "shorted-alerts/1.0")
		resp, err = c.client.GetMySubscription(ctx, req)
		if err == nil || attempt == 1 || !retryableLookup(err) {
			break
		}
		select {
		case <-ctx.Done():
			return entitlement{}, ctx.Err()
		case <-time.After(c.retryWait):
		}
	}
	if err != nil {
		return entitlement{}, err
	}
	e := entitlementOf(resp.Msg)
	c.cache[userID] = e
	return e, nil
}

// retryableLookup is the one case worth a second try: the API was unavailable or
// the call timed out.
func retryableLookup(err error) bool {
	switch connect.CodeOf(err) {
	case connect.CodeUnavailable, connect.CodeDeadlineExceeded:
		return true
	}
	return false
}
