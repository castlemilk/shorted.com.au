package shorts

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// webhookTestServer is newTestServer with the info log the webhook writes, which
// newTestServer's logger does not expect.
func webhookTestServer(t *testing.T, store ShortsStore) *ShortsServer {
	t.Helper()
	s := newTestServer(t, store)
	logger := mocks.NewMockLogger(gomock.NewController(t))
	logger.EXPECT().Infof(gomock.Any(), gomock.Any()).AnyTimes()
	logger.EXPECT().Errorf(gomock.Any(), gomock.Any()).AnyTimes()
	s.logger = logger
	return s
}

// A subscription-updated event carries the subscription the web resolved as the
// customer's best one. The store write must receive it, or the row keeps naming
// whichever subscription created it.
func TestHandleStripeSubscriptionUpdatedPassesTheResolvedSubscriptionID(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	var got *shortsstore.APISubscriptionUpdate
	store.EXPECT().UpdateAPISubscriptionByCustomer("cus_1", gomock.Any()).DoAndReturn(
		func(_ string, update *shortsstore.APISubscriptionUpdate) error {
			got = update
			return nil
		})

	s := webhookTestServer(t, store)
	_, err := s.HandleStripeSubscriptionUpdated(context.Background(), connect.NewRequest(&shortsv1alpha1.HandleStripeSubscriptionUpdatedRequest{
		StripeCustomerId:     "cus_1",
		StripeSubscriptionId: "sub_best",
		Status:               shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_ACTIVE,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || got.StripeSubscriptionID == nil || *got.StripeSubscriptionID != "sub_best" {
		t.Fatalf("update = %+v, want the resolved subscription id written", got)
	}
	if got.Status == nil || *got.Status != "active" {
		t.Fatalf("status = %v, want active", got.Status)
	}
}

// A deleted subscription that the web still names as the customer's best one is
// written as canceled under its own id, not dropped.
func TestHandleStripeSubscriptionUpdatedWritesTheIdOnDeletion(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	var got *shortsstore.APISubscriptionUpdate
	store.EXPECT().UpdateAPISubscriptionByCustomer("cus_1", gomock.Any()).DoAndReturn(
		func(_ string, update *shortsstore.APISubscriptionUpdate) error {
			got = update
			return nil
		})

	s := webhookTestServer(t, store)
	if _, err := s.HandleStripeSubscriptionUpdated(context.Background(), connect.NewRequest(&shortsv1alpha1.HandleStripeSubscriptionUpdatedRequest{
		StripeCustomerId:     "cus_1",
		StripeSubscriptionId: "sub_gone",
		IsDeleted:            true,
	})); err != nil {
		t.Fatal(err)
	}
	if got == nil || got.StripeSubscriptionID == nil || *got.StripeSubscriptionID != "sub_gone" || *got.Status != "canceled" {
		t.Fatalf("update = %+v, want canceled under sub_gone", got)
	}
}

// With no id on the event the update does not invent one.
func TestHandleStripeSubscriptionUpdatedLeavesTheIdAloneWhenBlank(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	var got *shortsstore.APISubscriptionUpdate
	store.EXPECT().UpdateAPISubscriptionByCustomer("cus_1", gomock.Any()).DoAndReturn(
		func(_ string, update *shortsstore.APISubscriptionUpdate) error {
			got = update
			return nil
		})

	s := webhookTestServer(t, store)
	if _, err := s.HandleStripeSubscriptionUpdated(context.Background(), connect.NewRequest(&shortsv1alpha1.HandleStripeSubscriptionUpdatedRequest{
		StripeCustomerId: "cus_1",
		Status:           shortsv1alpha1.SubscriptionStatus_SUBSCRIPTION_STATUS_ACTIVE,
	})); err != nil {
		t.Fatal(err)
	}
	if got == nil || got.StripeSubscriptionID != nil {
		t.Fatalf("update = %+v, want no subscription id", got)
	}
}
