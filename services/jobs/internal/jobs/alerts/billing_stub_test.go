package alerts

import (
	"context"
	"errors"
	"sync"

	"connectrpc.com/connect"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsv1alpha1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
)

const stubSecret = "internal-secret-for-tests"

// stubBilling answers GetMySubscription from a table keyed by user id, and it can
// be made unavailable for the next few calls. The end-to-end suite serves it through
// startShortsAPI; the entitlement rule and the lookup are tested in
// services/jobs/internal/entitlementcheck.
type stubBilling struct {
	shortsv1alpha1connect.UnimplementedBillingServiceHandler

	mu          sync.Mutex
	status      map[string]shortsv1alpha1.SubscriptionStatus
	unavailable int
	// failUser answers one owner's lookups with a code, as a per-user failure does
	// (an owner at their quota, say), until cleared.
	failUser map[string]connect.Code
}

func (s *stubBilling) GetMySubscription(_ context.Context, req *connect.Request[shortsv1alpha1.GetMySubscriptionRequest]) (*connect.Response[shortsv1alpha1.GetMySubscriptionResponse], error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if req.Header().Get("x-internal-secret") != stubSecret {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("bad internal secret"))
	}
	if s.unavailable > 0 {
		s.unavailable--
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("unavailable"))
	}
	if code, ok := s.failUser[req.Header().Get("x-user-id")]; ok {
		return nil, connect.NewError(code, errors.New("per-user failure"))
	}
	st, ok := s.status[req.Header().Get("x-user-id")]
	if !ok {
		return connect.NewResponse(&shortsv1alpha1.GetMySubscriptionResponse{}), nil
	}
	// A paying premium customer, as the API answers for a premium-feature row. The
	// alerts gate also requires the tier, so a stub without one would read as unpaid.
	return connect.NewResponse(&shortsv1alpha1.GetMySubscriptionResponse{
		HasSubscription: true,
		Status:          st,
		Tier:            shortsv1alpha1.SubscriptionTier_SUBSCRIPTION_TIER_PREMIUM,
	}), nil
}

func newStubBilling() *stubBilling {
	return &stubBilling{status: map[string]shortsv1alpha1.SubscriptionStatus{}}
}

// setStatus sets a user's subscription status by its proto name, such as
// "SUBSCRIPTION_STATUS_ACTIVE".
func (s *stubBilling) setStatus(user, name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status[user] = shortsv1alpha1.SubscriptionStatus(shortsv1alpha1.SubscriptionStatus_value[name])
}

// failFor makes every lookup for user fail with code, until clearFail.
func (s *stubBilling) failFor(user string, code connect.Code) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failUser == nil {
		s.failUser = map[string]connect.Code{}
	}
	s.failUser[user] = code
}

// clearFail restores one owner's lookups.
func (s *stubBilling) clearFail(user string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.failUser, user)
}

// setUnavailable makes the next n calls fail as Unavailable.
func (s *stubBilling) setUnavailable(n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.unavailable = n
}
