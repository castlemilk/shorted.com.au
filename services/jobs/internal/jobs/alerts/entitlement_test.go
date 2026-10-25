package alerts

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsv1alpha1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
)

const stubSecret = "internal-secret-for-tests"

// stubBilling answers GetMySubscription from a table keyed by user id, and it can
// be made unavailable for the next few calls.
type stubBilling struct {
	shortsv1alpha1connect.UnimplementedBillingServiceHandler

	mu          sync.Mutex
	status      map[string]shortsv1alpha1.SubscriptionStatus
	unavailable int
	// failUser answers one owner's lookups with a code, as a per-user failure does
	// (an owner at their quota, say), until cleared.
	failUser map[string]connect.Code
	calls    int
	lastUA   string
}

func (s *stubBilling) GetMySubscription(_ context.Context, req *connect.Request[shortsv1alpha1.GetMySubscriptionRequest]) (*connect.Response[shortsv1alpha1.GetMySubscriptionResponse], error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	s.lastUA = req.Header().Get("User-Agent")
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
	return connect.NewResponse(&shortsv1alpha1.GetMySubscriptionResponse{HasSubscription: true, Status: st}), nil
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

func startBilling(t *testing.T, stub *stubBilling) string {
	t.Helper()
	return startShortsAPI(t, stub, "")
}

// TestEntitledExactlyWhenActiveTrialingOrInGrace pins the job's side of the entitlement
// rule. The API's side is pinned by the contract test in services/shorts.
func TestEntitledExactlyWhenActiveTrialingOrInGrace(t *testing.T) {
	cases := []struct {
		name       string
		resp       *shortsv1alpha1.GetMySubscriptionResponse
		entitled   bool
		wantStatus string
	}{
		{"active", &shortsv1alpha1.GetMySubscriptionResponse{HasSubscription: true, Status: shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_ACTIVE}, true, "ACTIVE"},
		{"trialing", &shortsv1alpha1.GetMySubscriptionResponse{HasSubscription: true, Status: shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_TRIALING}, true, "TRIALING"},
		{"past due", &shortsv1alpha1.GetMySubscriptionResponse{HasSubscription: true, Status: shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_PAST_DUE}, false, "PAST_DUE"},
		{"canceled", &shortsv1alpha1.GetMySubscriptionResponse{HasSubscription: true, Status: shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_CANCELED}, false, "CANCELED"},
		{"inactive", &shortsv1alpha1.GetMySubscriptionResponse{HasSubscription: true, Status: shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_INACTIVE}, false, "INACTIVE"},
		{"no subscription record", &shortsv1alpha1.GetMySubscriptionResponse{}, false, "NONE"},
		{"past due inside the grace stays entitled", &shortsv1alpha1.GetMySubscriptionResponse{
			HasSubscription:  true,
			Status:           shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_PAST_DUE,
			CurrentPeriodEnd: timestamppb.New(time.Now().Add(-13 * 24 * time.Hour)),
		}, true, "PAST_DUE"},
		{"past due past the grace is not entitled", &shortsv1alpha1.GetMySubscriptionResponse{
			HasSubscription:  true,
			Status:           shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_PAST_DUE,
			CurrentPeriodEnd: timestamppb.New(time.Now().Add(-15 * 24 * time.Hour)),
		}, false, "PAST_DUE"},
		{"unpaid is inactive, never entitled", &shortsv1alpha1.GetMySubscriptionResponse{
			HasSubscription:  true,
			Status:           shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_INACTIVE,
			CurrentPeriodEnd: timestamppb.New(time.Now().Add(24 * time.Hour)),
		}, false, "INACTIVE"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := entitlementOf(tc.resp)
			if got.Entitled != tc.entitled || got.Status != tc.wantStatus {
				t.Fatalf("entitlementOf = %+v, want entitled=%v status=%s", got, tc.entitled, tc.wantStatus)
			}
		})
	}
}

func TestCheckSendsInternalHeadersAndCachesPerRun(t *testing.T) {
	stub := &stubBilling{status: map[string]shortsv1alpha1.SubscriptionStatus{
		"u-paid": shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_ACTIVE,
	}}
	c := newEntitlementChecker(startBilling(t, stub), stubSecret)

	for i := range 3 {
		e, err := c.check(context.Background(), "u-paid")
		if err != nil || !e.Entitled {
			t.Fatalf("check %d: %+v %v", i, e, err)
		}
	}
	if stub.calls != 1 {
		t.Fatalf("the per-run cache must hold: %d calls", stub.calls)
	}
	if stub.lastUA != "shorted-alerts/1.0" {
		t.Fatalf("User-Agent = %q", stub.lastUA)
	}
}

func TestCheckRetriesUnavailableOnce(t *testing.T) {
	stub := &stubBilling{status: map[string]shortsv1alpha1.SubscriptionStatus{
		"u": shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_TRIALING,
	}, unavailable: 1}
	c := newEntitlementChecker(startBilling(t, stub), stubSecret)
	c.retryWait = 0
	e, err := c.check(context.Background(), "u")
	if err != nil || !e.Entitled {
		t.Fatalf("one unavailable answer must be retried: %+v %v", e, err)
	}
	if stub.calls != 2 {
		t.Fatalf("calls = %d, want 2", stub.calls)
	}
}

func TestCheckFailsWhenUnavailableTwice(t *testing.T) {
	stub := &stubBilling{status: map[string]shortsv1alpha1.SubscriptionStatus{}, unavailable: 2}
	c := newEntitlementChecker(startBilling(t, stub), stubSecret)
	c.retryWait = 0
	if _, err := c.check(context.Background(), "u"); err == nil {
		t.Fatal("a second unavailable answer must fail the lookup, not treat the user as unentitled")
	}
}

func TestCheckRejectsAWrongSecretInsteadOfGuessing(t *testing.T) {
	stub := &stubBilling{status: map[string]shortsv1alpha1.SubscriptionStatus{
		"u": shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_ACTIVE,
	}}
	c := newEntitlementChecker(startBilling(t, stub), "wrong-secret")
	if _, err := c.check(context.Background(), "u"); err == nil {
		t.Fatal("a rejected internal secret must fail the run, never default to entitled or unentitled")
	}
}
