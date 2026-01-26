package shorts

import (
	"context"
	"fmt"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// HandleStripeCheckoutCompleted handles the completion of a Stripe checkout session.
// This is called by the webhook handler when a user completes payment.
func (s *ShortsServer) HandleStripeCheckoutCompleted(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.HandleStripeCheckoutCompletedRequest],
) (*connect.Response[shortsv1alpha1.HandleStripeCheckoutCompletedResponse], error) {
	// Validate required fields
	if req.Msg.UserId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("user_id is required"))
	}
	if req.Msg.UserEmail == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("user_email is required"))
	}
	if req.Msg.StripeCustomerId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("stripe_customer_id is required"))
	}

	s.logger.Infof("Processing checkout completion for user %s (%s)", req.Msg.UserId, req.Msg.UserEmail)

	// Map protobuf tier to string
	tier := mapTierToString(req.Msg.Tier)
	if tier == "" {
		tier = "pro" // Default to pro for completed checkouts
	}

	// Create/update subscription record
	sub := &shortsstore.APISubscription{
		UserID:               req.Msg.UserId,
		UserEmail:            req.Msg.UserEmail,
		StripeCustomerID:     req.Msg.StripeCustomerId,
		StripeSubscriptionID: req.Msg.StripeSubscriptionId,
		Status:               "active",
		Tier:                 tier,
		CancelAtPeriodEnd:    false,
	}

	if err := s.store.UpsertAPISubscription(sub); err != nil {
		s.logger.Errorf("Failed to upsert subscription for user %s: %v", req.Msg.UserId, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to save subscription"))
	}

	s.logger.Infof("Successfully created subscription for user %s with tier %s", req.Msg.UserId, tier)

	return connect.NewResponse(&shortsv1alpha1.HandleStripeCheckoutCompletedResponse{
		Success: true,
		Message: fmt.Sprintf("Subscription created for user %s", req.Msg.UserId),
	}), nil
}

// HandleStripeSubscriptionUpdated handles subscription lifecycle updates from Stripe.
// This is called for subscription.created, subscription.updated, and subscription.deleted events.
func (s *ShortsServer) HandleStripeSubscriptionUpdated(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.HandleStripeSubscriptionUpdatedRequest],
) (*connect.Response[shortsv1alpha1.HandleStripeSubscriptionUpdatedResponse], error) {
	// Validate required fields
	if req.Msg.StripeCustomerId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("stripe_customer_id is required"))
	}

	s.logger.Infof("Processing subscription update for customer %s: status=%s, deleted=%v",
		req.Msg.StripeCustomerId, req.Msg.Status.String(), req.Msg.IsDeleted)

	// Build update object
	update := &shortsstore.APISubscriptionUpdate{}

	// Map status
	status := mapStatusToString(req.Msg.Status)
	if status != "" {
		update.Status = &status
	}

	// Handle deleted subscriptions
	if req.Msg.IsDeleted {
		canceledStatus := "canceled"
		freeTier := "free"
		update.Status = &canceledStatus
		update.Tier = &freeTier
	} else {
		// Map tier
		tier := mapTierToString(req.Msg.Tier)
		if tier != "" {
			update.Tier = &tier
		}

		// Map period dates
		if req.Msg.CurrentPeriodStart != nil {
			periodStart := req.Msg.CurrentPeriodStart.AsTime().Format(time.RFC3339)
			update.CurrentPeriodStart = &periodStart
		}
		if req.Msg.CurrentPeriodEnd != nil {
			periodEnd := req.Msg.CurrentPeriodEnd.AsTime().Format(time.RFC3339)
			update.CurrentPeriodEnd = &periodEnd
		}

		// Map cancel at period end
		update.CancelAtPeriodEnd = &req.Msg.CancelAtPeriodEnd
	}

	// Perform the update
	if err := s.store.UpdateAPISubscriptionByCustomer(req.Msg.StripeCustomerId, update); err != nil {
		s.logger.Errorf("Failed to update subscription for customer %s: %v", req.Msg.StripeCustomerId, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to update subscription"))
	}

	s.logger.Infof("Successfully updated subscription for customer %s", req.Msg.StripeCustomerId)

	return connect.NewResponse(&shortsv1alpha1.HandleStripeSubscriptionUpdatedResponse{
		Success: true,
		Message: fmt.Sprintf("Subscription updated for customer %s", req.Msg.StripeCustomerId),
	}), nil
}

// GetMySubscription returns the current user's subscription status.
// Requires authentication.
func (s *ShortsServer) GetMySubscription(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.GetMySubscriptionRequest],
) (*connect.Response[shortsv1alpha1.GetMySubscriptionResponse], error) {
	// Extract user information from context (populated by AuthInterceptor)
	userClaims, ok := UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("user not authenticated"))
	}

	s.logger.Debugf("Getting subscription for user %s", userClaims.Email)

	// Look up subscription
	sub, err := s.store.GetAPISubscription(userClaims.UserID)
	if err != nil {
		s.logger.Errorf("Failed to get subscription for user %s: %v", userClaims.UserID, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get subscription"))
	}

	// Build response
	resp := &shortsv1alpha1.GetMySubscriptionResponse{
		HasSubscription: sub != nil,
	}

	if sub != nil {
		resp.Status = mapStringToStatus(sub.Status)
		resp.Tier = mapStringToTier(sub.Tier)
		resp.CancelAtPeriodEnd = sub.CancelAtPeriodEnd
		resp.StripeCustomerId = sub.StripeCustomerID

		// Parse period end if available
		if sub.CurrentPeriodEnd != nil && *sub.CurrentPeriodEnd != "" {
			if t, err := time.Parse(time.RFC3339, *sub.CurrentPeriodEnd); err == nil {
				resp.CurrentPeriodEnd = timestamppb.New(t)
			}
		}
	} else {
		// No subscription means free tier
		resp.Status = shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_INACTIVE
		resp.Tier = shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_FREE
	}

	return connect.NewResponse(resp), nil
}

// Helper functions for mapping between protobuf enums and strings

func mapTierToString(tier shortsv1alpha1.SubscriptionTier) string {
	switch tier {
	case shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_FREE:
		return "free"
	case shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_PRO:
		return "pro"
	case shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_ENTERPRISE:
		return "enterprise"
	default:
		return ""
	}
}

func mapStringToTier(tier string) shortsv1alpha1.SubscriptionTier {
	switch tier {
	case "free":
		return shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_FREE
	case "pro":
		return shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_PRO
	case "enterprise":
		return shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_ENTERPRISE
	default:
		return shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_UNSPECIFIED
	}
}

func mapStatusToString(status shortsv1alpha1.SubscriptionStatus) string {
	switch status {
	case shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_ACTIVE:
		return "active"
	case shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_TRIALING:
		return "trialing"
	case shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_PAST_DUE:
		return "past_due"
	case shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_CANCELED:
		return "canceled"
	case shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_INACTIVE:
		return "inactive"
	default:
		return ""
	}
}

func mapStringToStatus(status string) shortsv1alpha1.SubscriptionStatus {
	switch status {
	case "active":
		return shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_ACTIVE
	case "trialing":
		return shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_TRIALING
	case "past_due":
		return shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_PAST_DUE
	case "canceled":
		return shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_CANCELED
	case "inactive":
		return shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_INACTIVE
	default:
		return shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_UNSPECIFIED
	}
}
