// Package entitlementcheck asks the shorts API whether a user is entitled to a
// premium feature, for the jobs that deliver to or act for customers. It is shared
// by the alerts job (`shorted alerts`); any other job that acts for a customer uses it too.
//
// The shorts API owns the rule (ResolveEntitlement: internal grants, then the Stripe
// row, then the period grace). The jobs ask it rather than re-implementing the rule,
// so the email gate and the paid features cannot disagree. The contract is pinned by
// services/shorts/internal/services/shorts/subscriptions_entitlement_contract_test.go,
// which reads this package's mapping in its comment.
//
// Side effects: a lookup is metered against the user's API quota unless the caller's
// User-Agent carries a prefix the API exempts from that limit (today only
// "shorted-alerts/", alertsJobUserAgentPrefix in
// services/shorts/internal/services/shorts/middleware_connect.go). A new caller
// registers its own prefix there before it uses the checker, or a lookup for an owner
// at quota fails. The caller also holds INTERNAL_SERVICE_SECRET, which opens the same
// internal-auth path that the namespace's DATABASE_URL already gives it access to.
package entitlementcheck

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

// Entitlement is the API's answer for one user.
type Entitlement struct {
	Entitled bool
	// Status is the subscription status as the API reports it (ACTIVE, CANCELED,
	// ...), or "NONE" when the user has no subscription record.
	Status string
}

// Of maps a GetMySubscription response to the premium-feature entitlement. Alerts
// are a premium web feature, so the rule is the API's premium-feature rule, applied
// to the same fields the API returns:
//
//   - ACTIVE or TRIALING on a premium-feature tier (premium, pro, enterprise).
//   - PAST_DUE on a premium-feature tier, while inside the grace from the first failed
//     charge (past_due_since). A past_due row with no failure time has no grace.
//
// API Access and FREE rows never get premium features, whatever their status: they are
// paid API access, not premium features. The grace length and the premium tiers come
// from services/pkg/subscription, the same package the API uses.
func Of(msg *shortsv1alpha1.GetMySubscriptionResponse) Entitlement {
	status := "NONE"
	if msg.GetHasSubscription() {
		status = strings.TrimPrefix(msg.GetStatus().String(), "SUBSCRIPTION_STATUS_")
	}
	premium := subscription.PremiumFeatureTier(protoTierName(msg.GetTier()))
	switch msg.GetStatus() {
	case shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_ACTIVE,
		shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_TRIALING:
		return Entitlement{Entitled: premium, Status: status}
	case shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_PAST_DUE:
		since := time.Time{}
		if ts := msg.GetPastDueSince(); ts != nil {
			since = ts.AsTime()
		}
		return Entitlement{Entitled: premium && subscription.PastDueInGrace(since, time.Now()), Status: status}
	}
	return Entitlement{Entitled: false, Status: status}
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

// Checker is a per-run cache over the billing client.
type Checker struct {
	client    shortsv1alpha1connect.BillingServiceClient
	secret    string
	userAgent string
	cache     map[string]Entitlement
	retryWait time.Duration
}

// NewChecker builds a client over the Cloud Run origin, not the public hostname. A
// lookup through Cloudflare would land in the anonymous per-IP bucket. userAgent is
// the caller's own marker (the API exempts the alerts job by its prefix), sent on
// every lookup.
func NewChecker(origin, secret, userAgent string) *Checker {
	return &Checker{
		client: shortsv1alpha1connect.NewBillingServiceClient(
			&http.Client{Timeout: 10 * time.Second},
			strings.TrimRight(origin, "/"),
		),
		secret:    secret,
		userAgent: userAgent,
		cache:     map[string]Entitlement{},
		retryWait: 2 * time.Second,
	}
}

// Check returns the user's entitlement. A lookup is retried once when the API is
// unavailable or times out, and any other error is returned to the caller.
//
// The headers are set on each request rather than by an interceptor, because
// x-user-id changes with every call.
func (c *Checker) Check(ctx context.Context, userID string) (Entitlement, error) {
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
		req.Header().Set("User-Agent", c.userAgent)
		resp, err = c.client.GetMySubscription(ctx, req)
		if err == nil || attempt == 1 || !retryableLookup(err) {
			break
		}
		select {
		case <-ctx.Done():
			return Entitlement{}, ctx.Err()
		case <-time.After(c.retryWait):
		}
	}
	if err != nil {
		return Entitlement{}, err
	}
	e := Of(resp.Msg)
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
